"""LLM Service — central LLM management layer.

Wraps Biomni's get_llm() to provide model switching, API key management,
execution mode resolution, and vLLM health checking.
"""

import logging
import os
from pathlib import Path
from typing import Any, Optional

import httpx
from langchain_core.language_models import BaseChatModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings, load_model_registry, get_models_dir
from db.database import async_session_factory
from db.models import Setting
from models.schemas import ApiKeyInfo, ModelInfo

logger = logging.getLogger("aigen.llm_service")

_PROVIDER_TO_SOURCE = {
    "vllm": "Custom",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Gemini",
}


class LLMService:
    """Singleton LLM management service."""

    _instance: Optional["LLMService"] = None

    _REGISTRY_PATH = Path(__file__).resolve().parent.parent / "model_registry.yaml"

    def __init__(self) -> None:
        self._registry: dict[str, Any] = {}
        self._registry_mtime: float = 0
        self._active_model: str = ""
        self._initialized: bool = False

    @classmethod
    def get_instance(cls) -> "LLMService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ─── Registry Hot-reload ───

    def _reload_registry_if_changed(self) -> None:
        """Reload model_registry.yaml if the file has been modified."""
        try:
            mtime = self._REGISTRY_PATH.stat().st_mtime
        except OSError:
            return
        if mtime != self._registry_mtime:
            self._registry = load_model_registry()
            self._registry_mtime = mtime
            logger.info("Model registry reloaded (file changed)")

    # ─── Initialization ───

    @staticmethod
    def _is_model_available(name: str, models: dict) -> bool:
        """Check if a model is actually usable (local folder exists, etc.)."""
        mc = models.get(name)
        if not mc:
            return False
        if mc["type"] == "local":
            local_path = mc.get("local_path")
            if not local_path:
                return False
            return (get_models_dir() / local_path).is_dir()
        return True  # API models are always "available" at init time

    async def ensure_initialized(self) -> None:
        """Load model_registry.yaml and restore active model from DB."""
        if self._initialized:
            return

        self._registry = load_model_registry()
        try:
            self._registry_mtime = self._REGISTRY_PATH.stat().st_mtime
        except OSError:
            pass
        settings = get_settings()

        # Try to restore active model from DB
        active = settings.ACTIVE_MODEL
        models = self._registry.get("models", {})
        try:
            async with async_session_factory() as db:
                result = await db.execute(
                    select(Setting).where(Setting.key == "active_model")
                )
                setting = result.scalar_one_or_none()
                if setting and setting.value.get("name"):
                    candidate = setting.value["name"]
                    # DB 후보도 availability 검증 (로컬 모델 폴더 존재 여부)
                    if candidate in models and self._is_model_available(candidate, models):
                        active = candidate
                    elif candidate in models:
                        logger.warning(f"DB active_model '{candidate}' is in registry but not available (folder missing?)")
        except Exception as e:
            logger.warning(f"Could not restore active model from DB: {e}")

        # Validate against registry AND actual availability
        models = self._registry.get("models", {})
        if active not in models or not self._is_model_available(active, models):
            # Fallback to first available model
            active = ""
            for name, mc in models.items():
                if self._is_model_available(name, models):
                    active = name
                    break
            if not active:
                active = next(iter(models)) if models else ""
                logger.warning(f"No available models found, using registry default: {active}")

        self._active_model = active
        self._initialized = True
        logger.info(f"LLMService initialized. Active model: {self._active_model}")

    # ─── Model Query / Switch ───

    def get_current_model(self) -> ModelInfo:
        """Return info about the currently active model."""
        self._reload_registry_if_changed()
        mc = self._registry["models"][self._active_model]
        display = mc.get("display_name") or (mc.get("local_path", self._active_model) if mc["type"] == "local" else self._active_model)
        return ModelInfo(
            name=self._active_model,
            display_name=display,
            type=mc["type"],
            provider=mc["provider"],
            status="active",
        )

    async def list_models(self, db: AsyncSession) -> list[ModelInfo]:
        """List all models with availability status.

        Local models are only listed if they have a local_path defined in
        the registry AND the corresponding folder exists under MODELS_DIR.
        """
        self._reload_registry_if_changed()
        models: list[ModelInfo] = []
        vllm_ok = await self._check_vllm_health()
        models_dir = get_models_dir()

        for name, mc in self._registry.get("models", {}).items():
            # Local models: require both local_path and physical folder
            if mc["type"] == "local":
                local_path = mc.get("local_path")
                if not local_path or not (models_dir / local_path).is_dir():
                    continue  # Skip: no folder or no local_path defined

            if name == self._active_model:
                status = "active"
            elif mc["type"] == "local":
                status = "available" if vllm_ok else "unavailable"
            else:
                key = await self._resolve_api_key(mc["provider"], db)
                status = "available" if key else "no_api_key"

            display = mc.get("display_name") or (mc.get("local_path", name) if mc["type"] == "local" else name)
            models.append(ModelInfo(
                name=name,
                display_name=display,
                type=mc["type"],
                provider=mc["provider"],
                status=status,
            ))
        return models

    async def switch_model(self, model_name: str, db: AsyncSession) -> ModelInfo:
        """Switch active model and persist to DB."""
        models = self._registry.get("models", {})
        if model_name not in models:
            raise KeyError(model_name)
        if not self._is_model_available(model_name, models):
            raise ValueError(f"Model '{model_name}' is not available (folder missing or not configured)")

        self._active_model = model_name

        # Upsert DB Setting
        result = await db.execute(
            select(Setting).where(Setting.key == "active_model")
        )
        setting = result.scalar_one_or_none()
        if setting:
            setting.value = {"name": model_name}
        else:
            db.add(Setting(key="active_model", value={"name": model_name}))
        await db.commit()

        logger.info(f"Switched active model to: {model_name}")
        return self.get_current_model()

    # ─── LLM Instance Creation ───

    async def get_llm_instance(
        self,
        model_name: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        db: AsyncSession | None = None,
    ) -> BaseChatModel:
        """Create a LangChain chat model via Biomni's get_llm()."""
        name = model_name or self._active_model
        mc = self._registry["models"][name]
        settings = get_settings()

        source = _PROVIDER_TO_SOURCE.get(mc["provider"])
        if source is None:
            raise ValueError(f"Unknown provider: {mc['provider']}")

        api_key = await self._resolve_api_key(mc["provider"], db)
        stop_seqs = mc.get("stop_sequences") or None

        # Resolve temperature, max_tokens, top_k: explicit param > DB settings > fallback
        resolved_temperature = temperature
        resolved_max_tokens = max_tokens
        resolved_top_k = None
        if db:
            try:
                result = await db.execute(
                    select(Setting).where(Setting.key == "settings")
                )
                row = result.scalar_one_or_none()
                if row and row.value:
                    stored = row.value
                    if resolved_temperature is None and "temperature" in stored:
                        resolved_temperature = stored["temperature"]
                    if resolved_max_tokens is None and "max_tokens" in stored:
                        resolved_max_tokens = stored["max_tokens"]
                    if "top_k" in stored:
                        resolved_top_k = stored["top_k"]
            except Exception:
                pass
        if resolved_temperature is None:
            resolved_temperature = 0.7
        if resolved_max_tokens is None:
            resolved_max_tokens = 32768
        if resolved_top_k is None:
            resolved_top_k = 50

        base_url = None
        if mc["type"] == "local":
            base_url = settings.VLLM_BASE_URL

        # For local vLLM models, create ChatOpenAI directly so we can pass
        # skip_special_tokens=False — needed to preserve [THINK]/[/THINK] tokens
        # that vLLM would otherwise strip from the response.
        if mc["type"] == "local":
            from langchain_openai import ChatOpenAI
            return ChatOpenAI(
                model=name,
                temperature=resolved_temperature,
                max_tokens=resolved_max_tokens,
                stop=stop_seqs,
                base_url=base_url,
                api_key=api_key or "EMPTY",
                extra_body={"skip_special_tokens": False, "top_k": resolved_top_k},
            )

        from biomni.llm import get_llm
        return get_llm(
            model=name,
            temperature=resolved_temperature,
            max_tokens=resolved_max_tokens,
            stop_sequences=stop_seqs,
            source=source,
            base_url=base_url,
            api_key=api_key,
        )

    # ─── Execution Mode Resolution ───

    async def resolve_model_behavior(
        self, model_name: str | None = None, db: AsyncSession | None = None
    ) -> dict:
        """Determine execution_mode/code_marker from model registry.

        Returns dict with:
            execution_mode, code_marker, mode_label,
            think_format, code_execute_format, code_result_format,
            tool_result_format, solution_format, tool_calls_format,
            refusal
        """
        name = model_name or self._active_model
        mc = self._registry["models"][name]

        if mc["type"] == "api":
            mode_label = "api_execute"
            execution_mode = "tool_select"
            code_marker = "execute"
        else:
            mode_label = "native_execute"
            execution_mode = "native"
            code_marker = "execute"

        # Build refusal config: start from registry, override with DB settings
        refusal = mc.get("refusal") or {}
        if refusal.get("enabled") and db:
            try:
                result = await db.execute(
                    select(Setting).where(Setting.key == "settings")
                )
                row = result.scalar_one_or_none()
                if row and row.value:
                    stored = row.value
                    override_keys = {
                        "refusal_threshold": "threshold",
                        "refusal_max_retries": "max_retries",
                        "refusal_temp_decay": "temp_decay",
                        "refusal_min_temp": "min_temp",
                        "refusal_recovery_tokens": "recovery_tokens",
                    }
                    for db_key, refusal_key in override_keys.items():
                        if db_key in stored:
                            refusal[refusal_key] = stored[db_key]
            except Exception:
                pass

        return {
            "execution_mode": execution_mode,
            "code_marker": code_marker,
            "mode_label": mode_label,

            "think_format": mc.get("think_format"),
            "code_execute_format": mc.get("code_execute_format"),
            "code_result_format": mc.get("code_result_format"),
            "tool_result_format": mc.get("tool_result_format"),
            "solution_format": mc.get("solution_format"),
            "tool_calls_format": mc.get("tool_calls_format"),
            "use_llm_retrieval": mc.get("use_llm_retrieval", True),
            "refusal": refusal if refusal else None,
            "system_prompt": mc.get("system_prompt"),
        }

    # ─── API Key Management ───

    async def _resolve_api_key(
        self, provider: str, db: AsyncSession | None
    ) -> str | None:
        """Resolve API key: DB first, then environment variable."""
        # 1) DB Setting
        if db:
            try:
                result = await db.execute(
                    select(Setting).where(Setting.key == f"api_key:{provider}")
                )
                setting = result.scalar_one_or_none()
                if setting and setting.value.get("key"):
                    return setting.value["key"]
            except Exception:
                pass

        # 2) Environment / Settings fallback
        settings = get_settings()
        env_map: dict[str, str] = {
            "openai": settings.OPENAI_API_KEY,
            "anthropic": settings.ANTHROPIC_API_KEY,
            "gemini": settings.GEMINI_API_KEY,
            "vllm": settings.CUSTOM_MODEL_API_KEY or "EMPTY",
        }
        value = env_map.get(provider, "")
        return value if value else None

    async def set_api_key(
        self, provider: str, api_key: str, db: AsyncSession
    ) -> None:
        """Save API key to DB and reflect in os.environ immediately."""
        # DB upsert
        result = await db.execute(
            select(Setting).where(Setting.key == f"api_key:{provider}")
        )
        setting = result.scalar_one_or_none()
        if setting:
            setting.value = {"key": api_key}
        else:
            db.add(Setting(key=f"api_key:{provider}", value={"key": api_key}))
        await db.commit()

        # Reflect in os.environ for immediate use
        env_key_map = {
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "gemini": "GEMINI_API_KEY",
        }
        if provider in env_key_map:
            os.environ[env_key_map[provider]] = api_key

        logger.info(f"API key for {provider} saved.")

    async def list_api_key_status(self, db: AsyncSession) -> list[ApiKeyInfo]:
        """Return whether each provider has an API key configured."""
        providers = ["openai", "anthropic", "gemini"]
        result = []
        for p in providers:
            key = await self._resolve_api_key(p, db)
            result.append(ApiKeyInfo(provider=p, is_set=bool(key)))
        return result

    # ─── vLLM Health Check ───

    async def _check_vllm_health(self) -> bool:
        """Check if the vLLM model server is reachable."""
        try:
            base = get_settings().VLLM_BASE_URL.replace("/v1", "")
            url = f"{base}/health"
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(url)
                return resp.status_code == 200
        except Exception:
            return False


def get_llm_service() -> LLMService:
    """Module-level factory for FastAPI dependency injection."""
    return LLMService.get_instance()
