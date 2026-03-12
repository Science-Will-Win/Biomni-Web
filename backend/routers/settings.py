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
from config import get_settings as get_app_settings
from services.llm_service import get_llm_service
from services.prompt_builder import PromptMode, build_prompt, get_prompt_sections
from services.tool_service import ToolService

router = APIRouter(prefix="/api", tags=["settings"])

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
        use_compact_prompt=stored.get("use_compact_prompt", False),
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
    if request.use_compact_prompt is not None:
        current["use_compact_prompt"] = request.use_compact_prompt

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


@router.get("/system_prompt/composed")
async def get_composed_prompts(db: AsyncSession = Depends(get_db)):
    """Return composed system prompts for each mode using the current model's token_format.

    The generated prompts are model-dependent (think tags, execute tags, etc.).
    Custom edits are stored per model — switching models resets to that model's defaults.
    """
    svc = get_llm_service()
    model_name = svc.get_current_model().name
    behavior = await svc.resolve_model_behavior(db=db)
    token_format = {
        k: behavior.get(k)
        for k in (
            "think_format", "code_execute_format", "code_result_format",
            "tool_result_format", "solution_format", "tool_calls_format",
            "system_prompt",
        )
    }

    modes = [
        ("full", PromptMode.FULL),
        ("agent", PromptMode.AGENT),
        ("plan", PromptMode.PLAN),
    ]

    # Per-model custom prompts: {"model_name": {"full": "...", "agent": "...", "plan": "..."}}
    all_stored = await _get_setting(db, "system_prompt_modes") or {}
    model_stored = all_stored.get(model_name, {})

    is_code_gen = behavior.get("use_code_gen", False)

    # Load dynamic content for accurate viewer display
    tool_service = ToolService.get_instance()
    app_settings = get_app_settings()
    data_lake_path = app_settings.BIOMNI_DATA_PATH or ""

    # Use Biomni tools if available, fallback to tool_service
    from services.biomni_tools import BiomniToolLoader
    biomni_loader = BiomniToolLoader.get_instance()
    if biomni_loader.is_initialized():
        all_biomni = biomni_loader.get_all_tools()
        tool_desc = biomni_loader.format_tool_desc(all_biomni[:30])  # Preview first 30
        tool_desc += f"\n... ({len(all_biomni)} tools total, selected via retrieval at runtime)"
    else:
        tool_desc = tool_service.generate_tools_description()

    tool_schemas = tool_service.get_schemas(exclude_internal=True)

    import json as _json
    tools_preview = _json.dumps(tool_schemas, ensure_ascii=False, indent=2)
    if len(tools_preview) > 4000:
        tools_preview = tools_preview[:4000] + "\n... (truncated)"

    result = {}
    for key, mode in modes:
        sections = get_prompt_sections(mode, token_format, use_code_gen=is_code_gen)
        composed = build_prompt(
            mode,
            token_format=token_format,
            use_code_gen=is_code_gen,
            tool_desc=tool_desc,
            data_lake_path=data_lake_path,
        )
        # For FULL mode, show [AVAILABLE_TOOLS] status
        if mode == PromptMode.FULL:
            if is_code_gen:
                sections.insert(0, {
                    "label": "[AVAILABLE_TOOLS]",
                    "content": "(Skipped — code_gen models use [TOOL_CALLS] format from Code Gen Guide)",
                })
            else:
                sections.insert(0, {
                    "label": "[AVAILABLE_TOOLS] (injected at runtime)",
                    "content": tools_preview,
                })
        result[key] = {
            "composed": composed,
            "sections": sections,
            "custom": model_stored.get(key, ""),
        }
    result["model"] = model_name
    return result


@router.post("/system_prompt/composed")
async def save_composed_prompt(
    request: dict,
    db: AsyncSession = Depends(get_db),
):
    """Save a per-mode custom system prompt for the current model.

    Body: {"mode": "full"|"agent"|"plan", "prompt": "..."}
    Stored per model so switching models doesn't lose old edits.
    """
    mode = request.get("mode", "")
    prompt = request.get("prompt", "")
    if mode not in ("full", "agent", "plan"):
        raise HTTPException(status_code=400, detail="Invalid mode")

    svc = get_llm_service()
    model_name = svc.get_current_model().name

    all_stored = await _get_setting(db, "system_prompt_modes") or {}
    model_stored = all_stored.get(model_name, {})

    if prompt:
        model_stored[mode] = prompt
    else:
        model_stored.pop(mode, None)

    if model_stored:
        all_stored[model_name] = model_stored
    else:
        all_stored.pop(model_name, None)

    await _upsert_setting(db, "system_prompt_modes", all_stored)
    return StatusResponse(status="ok", message=f"System prompt for {mode} ({model_name}) updated")
