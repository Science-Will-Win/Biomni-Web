"""Settings and system prompt endpoints — 5 endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from db.models import Setting
from models.schemas import (
    SettingsResponse,
    SettingsUpdateRequest,
    StatusResponse,
    SystemPromptResponse,
)
from services.llm_service import get_llm_service
from services.prompt_builder import PromptMode, build_prompt

from dotenv import set_key
from pathlib import Path

router = APIRouter(prefix="/api", tags=["settings"])

# config.py 기준 .env 경로
ENV_PATH = Path("/app/biomni_repo/../.env")

# DB keys
_KEY_SETTINGS = "settings"
_KEY_SYSTEM_PROMPT = "system_prompt"


async def _get_setting(db: AsyncSession, key: str):
    """Get a setting value from DB, returns None if not found."""
    result = await db.execute(select(Setting).where(Setting.key == key))
    row = result.scalar_one_or_none()
    return row.value if row else None


async def _upsert_setting(db: AsyncSession, key: str, value: dict):
    """Insert or update a setting in DB."""
    result = await db.execute(select(Setting).where(Setting.key == key))
    row = result.scalar_one_or_none()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    await db.commit()


async def _delete_setting(db: AsyncSession, key: str):
    """Delete a setting from DB."""
    result = await db.execute(select(Setting).where(Setting.key == key))
    row = result.scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


@router.get("/settings", response_model=SettingsResponse)
async def get_settings(db: AsyncSession = Depends(get_db)):
    """Retrieve current global settings."""
    stored = await _get_setting(db, _KEY_SETTINGS) or {}

    # Current model name
    svc = get_llm_service()
    model_name = svc.get_current_model().name

    # Custom system prompt
    sp_data = await _get_setting(db, _KEY_SYSTEM_PROMPT)
    sp = sp_data.get("prompt") if sp_data else None

    return SettingsResponse(
        temperature=stored.get("temperature", 0.7),
        max_tokens=stored.get("max_tokens", 32768),
        top_k=stored.get("top_k", 50),
        max_context=stored.get("max_context", 32768),
        model=model_name,
        system_prompt=sp,
        refusal_threshold=stored.get("refusal_threshold", 0.7),
        refusal_max_retries=stored.get("refusal_max_retries", 3),
        refusal_temp_decay=stored.get("refusal_temp_decay", 0.7),
        refusal_min_temp=stored.get("refusal_min_temp", 0.3),
        refusal_recovery_tokens=stored.get("refusal_recovery_tokens", 50),
    )


@router.post("/settings", response_model=StatusResponse)
async def update_settings(
    request: SettingsUpdateRequest, db: AsyncSession = Depends(get_db)
):
    """Update global settings (partial update)."""
    current = await _get_setting(db, _KEY_SETTINGS) or {}

    if request.temperature is not None:
        current["temperature"] = request.temperature
    if request.max_tokens is not None:
        current["max_tokens"] = request.max_tokens
    if request.top_k is not None:
        current["top_k"] = request.top_k
    if request.max_context is not None:
        current["max_context"] = min(max(request.max_context, 1024), 262144)
    if request.refusal_threshold is not None:
        current["refusal_threshold"] = max(0.3, min(2.0, request.refusal_threshold))
    if request.refusal_max_retries is not None:
        current["refusal_max_retries"] = max(1, min(10, request.refusal_max_retries))
    if request.refusal_temp_decay is not None:
        current["refusal_temp_decay"] = max(0.0, min(1.0, request.refusal_temp_decay))
    if request.refusal_min_temp is not None:
        current["refusal_min_temp"] = max(0.1, min(1.0, request.refusal_min_temp))
    if request.refusal_recovery_tokens is not None:
        current["refusal_recovery_tokens"] = max(10, min(200, request.refusal_recovery_tokens))

    await _upsert_setting(db, _KEY_SETTINGS, current)

    # Switch model if requested
    if request.model is not None:
        svc = get_llm_service()
        await svc.switch_model(request.model, db)

    # Update system prompt if provided
    if request.system_prompt is not None:
        if request.system_prompt:
            await _upsert_setting(db, _KEY_SYSTEM_PROMPT, {"prompt": request.system_prompt})
        else:
            await _delete_setting(db, _KEY_SYSTEM_PROMPT)

    return StatusResponse(status="ok", message="Settings updated")


@router.get("/system_prompt", response_model=SystemPromptResponse)
async def get_system_prompt(db: AsyncSession = Depends(get_db)):
    """Retrieve current system prompt (custom or default)."""
    sp_data = await _get_setting(db, _KEY_SYSTEM_PROMPT)
    if sp_data and sp_data.get("prompt"):
        return SystemPromptResponse(prompt=sp_data["prompt"])
    return SystemPromptResponse(prompt=build_prompt(PromptMode.FULL))


@router.get("/system_prompt/default", response_model=SystemPromptResponse)
async def get_default_system_prompt():
    """Retrieve default system prompt (ignores custom)."""
    return SystemPromptResponse(prompt=build_prompt(PromptMode.FULL))


@router.post("/system_prompt", response_model=StatusResponse)
async def set_system_prompt(
    request: SystemPromptResponse, db: AsyncSession = Depends(get_db)
):
    """Set or reset custom system prompt. Empty string resets to default."""
    if request.prompt:
        await _upsert_setting(db, _KEY_SYSTEM_PROMPT, {"prompt": request.prompt})
        return StatusResponse(status="ok", message="System prompt updated")
    else:
        await _delete_setting(db, _KEY_SYSTEM_PROMPT)
        return StatusResponse(status="ok", message="System prompt reset to default")

@router.post("/api_keys")
async def update_api_key(provider: str, api_key: str):
    # 예: provider가 "OPENAI"라면 OPENAI_API_KEY 수정
    env_key = f"{provider.upper()}_API_KEY"
    set_key(str(ENV_PATH), env_key, api_key)
    return {"status": "ok", "message": f"{env_key} updated in .env"}
