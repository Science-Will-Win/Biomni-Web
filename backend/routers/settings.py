"""Settings and system prompt endpoints."""

import os
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
    """Return composed system prompts for each mode using the current model's token_format."""
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

    # Per-model custom prompts
    all_stored = await _get_setting(db, "system_prompt_modes") or {}
    model_stored = all_stored.get(model_name, {})

    # Load dynamic content for accurate viewer display
    app_settings = get_app_settings()
    data_lake_path = os.path.join(
        app_settings.BIOMNI_DATA_PATH or "", "biomni_data", "data_lake"
    )

    from services.biomni_tools import BiomniToolLoader
    biomni_loader = BiomniToolLoader.get_instance()
    if biomni_loader.is_initialized():
        all_biomni = biomni_loader.get_all_tools()
        tool_desc = biomni_loader.format_tool_desc(all_biomni[:30])
        tool_desc += f"\n... ({len(all_biomni)} tools total, selected via retrieval at runtime)"
    else:
        tool_desc = "(Biomni tools not loaded)"

    result = {}
    for key, mode in modes:
        sections = get_prompt_sections(mode, token_format)
        composed = build_prompt(
            mode,
            token_format=token_format,
            tool_desc=tool_desc,
            data_lake_path=data_lake_path,
        )
        result[key] = {
            "composed": composed,
            "sections": sections,
            "custom": model_stored.get(key, ""),
        }
    # Tool retrieval prompt — 3-part split: editable_top / readonly_middle / editable_bottom
    if biomni_loader.is_initialized():
        retrieval_prompt = biomni_loader.build_retrieval_prompt(
            user_query="{user_query}",
            plan_context="{plan_context}",
        )
        # Split into 3 parts based on markers
        # Middle = AVAILABLE TOOLS through end of last auto-generated section
        top_marker = "\nAVAILABLE TOOLS:"
        top_idx = retrieval_prompt.find(top_marker)
        # Find end of middle: last auto-generated section (KNOW-HOW or LIBRARIES)
        kh_marker = "AVAILABLE KNOW-HOW DOCUMENTS"
        lib_marker = "AVAILABLE SOFTWARE LIBRARIES:"
        last_section_marker = kh_marker if kh_marker in retrieval_prompt else lib_marker
        last_idx = retrieval_prompt.find(last_section_marker)
        if top_idx >= 0 and last_idx >= 0:
            # Find end: double newline after last auto section
            mid_end = retrieval_prompt.find("\n\n", last_idx)
            if mid_end < 0:
                mid_end = len(retrieval_prompt)
            else:
                mid_end += 2
            editable_top = retrieval_prompt[:top_idx].rstrip("\n") + "\n"
            readonly_middle = retrieval_prompt[top_idx:mid_end].strip("\n") + "\n"
            editable_bottom = retrieval_prompt[mid_end:].strip("\n")
        else:
            editable_top = retrieval_prompt
            readonly_middle = ""
            editable_bottom = ""
    else:
        editable_top = (
            "You are an expert biomedical research assistant. Your task is to select "
            "the relevant resources to help answer a user's query. Also, when using tools, "
            "make sure to explain the reasons for using these tools and explain it concisely and rigorously."
        )
        readonly_middle = "\n(Biomni tools not loaded — tool list will appear here at runtime)\n"
        editable_bottom = ""

    # Load custom top/bottom if saved (separated by ===AUTO_TOOLS=== marker)
    custom_raw = model_stored.get("tool_retrieval", "")
    custom_top = ""
    custom_bottom = ""
    if custom_raw and "===AUTO_TOOLS===" in custom_raw:
        parts = custom_raw.split("===AUTO_TOOLS===", 1)
        custom_top = parts[0].strip("\n")
        custom_bottom = parts[1].strip("\n") if len(parts) > 1 else ""
    elif custom_raw:
        custom_top = custom_raw  # backward compat: old format = top only

    result["tool_retrieval"] = {
        "composed": editable_top + "\n" + readonly_middle + "\n" + editable_bottom,
        "sections": [
            {"label": "Instruction (editable)", "content": editable_top},
            {"label": "Tool/Data/Library List (auto-generated)", "content": readonly_middle},
            {"label": "Output Format & Guidelines (editable)", "content": editable_bottom},
        ],
        "custom": custom_raw,
        "editable_top": custom_top or editable_top,
        "readonly_middle": readonly_middle,
        "editable_bottom": custom_bottom or editable_bottom,
        "default_top": editable_top,
        "default_bottom": editable_bottom,
    }

    result["model"] = model_name
    return result


@router.post("/system_prompt/composed")
async def save_composed_prompt(
    request: dict,
    db: AsyncSession = Depends(get_db),
):
    """Save a per-mode custom system prompt for the current model."""
    mode = request.get("mode", "")
    prompt = request.get("prompt", "")
    if mode not in ("full", "agent", "plan", "tool_retrieval"):
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
