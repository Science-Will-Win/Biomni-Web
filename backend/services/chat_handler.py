"""Chat Handler — Core chat processing service bridging Backend and original Biomni A1."""

import asyncio
import json
import logging
import re
from typing import AsyncGenerator, Dict, Any, List, Optional, Tuple
from uuid import UUID

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

from sqlalchemy import select

from config import get_settings
from db.models import Setting
from models.schemas import ChatEvent, ChatRequest, StepQuestionRequest, RetryStepRequest
from services.conversation_service import ConversationService
from services.biomni_tools import BiomniToolLoader, scan_data_lake
from biomni.agent.a1 import A1
from services.llm_service import get_llm_service, _PROVIDER_TO_SOURCE
from services.prompt_builder import PromptMode, build_prompt, _closing_tag

logger = logging.getLogger("biomni_backend.chat_handler")

def _ev(event_type: str, data: Dict[str, Any]) -> ChatEvent:
    return ChatEvent(type=event_type, data=data)


# ─── Biomni Import Fixer ───

def _fix_biomni_imports(code: str, mapping: Dict[str, str]) -> Tuple[str, List[str]]:
    """Fix wrong biomni imports using func_name → correct module mapping.

    Matches all ``from biomni... import func`` patterns and looks up each
    function name in the mapping to find the correct module path.

    Returns (fixed_code, list_of_correction_strings).
    """
    if not mapping:
        return code, []

    corrections: List[str] = []
    pattern = r'from (biomni(?:\.\w+)*) import ([\w\s,]+)'

    def _replacer(m: re.Match) -> str:
        original_module = m.group(1)
        imports_str = m.group(2)
        func_names = [f.strip() for f in imports_str.split(',') if f.strip()]

        groups: Dict[str, List[str]] = {}
        for fn in func_names:
            correct = mapping.get(fn)
            if correct and correct != original_module:
                corrections.append(f"{fn}: {original_module} → {correct}")
                groups.setdefault(correct, []).append(fn)
            else:
                groups.setdefault(original_module, []).append(fn)

        return '\n'.join(
            f"from {mod} import {', '.join(fns)}"
            for mod, fns in groups.items()
        )

    fixed = re.sub(pattern, _replacer, code)
    return fixed, corrections


# ─── Step Execute Helpers ───

def _extract_last_execute_block(text: str, behavior: Dict[str, Any]) -> str:
    """Extract the last <execute>...</execute> block from accumulated text."""
    exec_fmt = behavior.get("code_execute_format", "<execute>")
    close_tag = _closing_tag(exec_fmt)
    pattern = re.escape(exec_fmt) + r'([\s\S]*?)' + re.escape(close_tag)
    matches = re.findall(pattern, text)
    if matches:
        return matches[-1].strip()
    # Fallback patterns
    for alt_pat in [r'<execute>([\s\S]*?)</execute>', r'\[EXECUTE\]([\s\S]*?)\[/EXECUTE\]']:
        matches = re.findall(alt_pat, text, re.IGNORECASE)
        if matches:
            return matches[-1].strip()
    return ""


def _extract_observation(text: str) -> str:
    """Extract observation content from execute output text."""
    m = re.search(r'<observation>([\s\S]*?)</observation>', text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m = re.search(r'\[OBSERVATION\]([\s\S]*?)\[/OBSERVATION\]', text)
    if m:
        return m.group(1).strip()
    return text.strip() if text else ""


def _parse_checked_steps(full_response: str, steps: list) -> set:
    """Parse [✓] checklist from LLM response to detect completed step indices.

    The system prompt instructs the LLM to mark completed steps as [✓].
    This function detects those marks and returns matching step indices.

    Returns set of 0-based step indices that the LLM marked as completed.
    """
    checked: set = set()
    # Match patterns: "N. [✓] Step Name (...)" or just "[✓] Step Name"
    for m in re.finditer(r'\[✓\]\s*(.+?)(?:\s*\(|$)', full_response, re.MULTILINE):
        name = m.group(1).strip()
        for i, step in enumerate(steps):
            step_name = step.get("name", "")
            if not step_name:
                continue
            # Fuzzy match: check if step name is contained in either direction
            if step_name.lower() in name.lower() or name.lower() in step_name.lower():
                checked.add(i)
    return checked


def _parse_segments(full_response: str, behavior: Dict[str, Any]) -> List[Dict[str, str]]:
    """Parse full_response into ordered typed segments for interleaved rendering.

    Tries behavior-specified format + XML fallback + bracket fallback for each tag type
    to handle models that output different formats than configured.

    Returns list of {"type": "thinking"|"text"|"code"|"output"|"solution", "content": "..."}.
    """
    # For each tag type, try behavior format + XML + bracket fallbacks
    tag_types: Dict[str, List[str]] = {
        "thinking": [behavior.get("think_format") or "<think>", "<think>", "[THINK]"],
        "code": [behavior.get("code_execute_format") or "<execute>", "<execute>", "[EXECUTE]"],
        "output": [behavior.get("code_result_format") or "<observation>", "<observation>", "[OBSERVATION]"],
        "solution": [behavior.get("solution_format") or "<solution>", "<solution>", "[SOLUTION]"],
    }

    blocks: List[Tuple[int, int, str, str]] = []  # (start, end, type, inner)
    for seg_type, open_tags in tag_types.items():
        seen: set = set()
        for open_tag in open_tags:
            if open_tag in seen:
                continue
            seen.add(open_tag)
            close_tag = _closing_tag(open_tag)
            flags = re.IGNORECASE if open_tag.startswith("<") else 0
            pattern = re.escape(open_tag) + r'([\s\S]*?)' + re.escape(close_tag)
            for m in re.finditer(pattern, full_response, flags):
                # Prevent overlap with already-matched blocks
                overlaps = any(
                    b[0] <= m.start() < b[1] or b[0] < m.end() <= b[1]
                    for b in blocks
                )
                if not overlaps:
                    blocks.append((m.start(), m.end(), seg_type, m.group(1).strip()))

    blocks.sort(key=lambda x: x[0])

    segments: List[Dict[str, str]] = []
    pos = 0
    for start, end, seg_type, inner in blocks:
        # Text between blocks = reasoning
        gap = full_response[pos:start].strip()
        if gap:
            segments.append({"type": "text", "content": gap})
        if inner:
            segments.append({"type": seg_type, "content": inner})
        pos = end

    # Trailing text
    tail = full_response[pos:].strip()
    if tail:
        segments.append({"type": "text", "content": tail})

    return segments


def _build_step_result_from_response(
    full_response: str, step_result: Optional[Dict[str, Any]],
    behavior: Dict[str, Any], step: Dict[str, Any], has_error: bool,
) -> Tuple[Dict[str, Any], str, List[str]]:
    """Extract code blocks, execution, reasoning from full_response.

    Returns (final_result, tool_name, code_blocks).
    Shared between normal step completion and error recovery.
    """
    exec_fmt = behavior.get("code_execute_format", "<execute>")
    exec_close = _closing_tag(exec_fmt)
    code_pattern = re.escape(exec_fmt) + r'([\s\S]*?)' + re.escape(exec_close)
    code_blocks = re.findall(code_pattern, full_response)

    if not code_blocks:
        # Negative lookahead prevents matching across nested/unclosed execute tags
        for alt_pat, alt_flags in [
            (r'<execute>((?:(?!<execute>)[\s\S])*?)</execute>', re.IGNORECASE),
            (r'\[EXECUTE\]((?:(?!\[EXECUTE\])[\s\S])*?)\[/EXECUTE\]', 0),
        ]:
            code_blocks = re.findall(alt_pat, full_response, alt_flags)
            if code_blocks:
                break

    final_result: Dict[str, Any] = {}
    tool_name = "text"

    if step_result:
        final_result = {**step_result}
        tool_name = step.get("tool") or step_result.get("tool", "code_execution")
        raw_stdout = step_result.get("stdout", "")
        # Dynamic observation tag extraction
        obs_fmt = behavior.get("code_result_format") or "<observation>"
        obs_close = _closing_tag(obs_fmt)
        obs_match = re.search(re.escape(obs_fmt) + r'([\s\S]*?)' + re.escape(obs_close), raw_stdout)
        if not obs_match:
            # Fallback patterns
            obs_match = (
                re.search(r'<observation>([\s\S]*?)</observation>', raw_stdout, re.IGNORECASE)
                or re.search(r'\[OBSERVATION\]([\s\S]*?)\[/OBSERVATION\]', raw_stdout)
            )
        clean_stdout = obs_match.group(1).strip() if obs_match else raw_stdout.strip()
        clean_stdout = re.sub(r'</?(?:observation|execute)>', '', clean_stdout, flags=re.IGNORECASE)
        clean_stdout = re.sub(r'\[/?(?:OBSERVATION|EXECUTE)\]', '', clean_stdout).strip()
        if clean_stdout:
            final_result["execution"] = {"success": not has_error, "stdout": clean_stdout}
    else:
        final_result = {}
        tool_name = step.get("tool") or "text"

    if code_blocks:
        combined_code = "\n\n".join(b.strip() for b in code_blocks)
        final_result["code"] = combined_code
        if combined_code.lstrip().startswith("#!R"):
            final_result["language"] = "r"
        elif combined_code.lstrip().startswith("#!BASH"):
            final_result["language"] = "bash"
        else:
            final_result["language"] = "python"
        if not step.get("tool"):
            tool_name = "code_execution"

    return final_result, tool_name, code_blocks


# ─── Plan Parsing Utilities ───

def _parse_plan_response(response: str, user_message: str) -> Optional[Dict[str, Any]]:
    """Parse checklist plan from LLM response.

    Primary: numbered checklist with [ ] checkboxes and Goal: line.
    Fallback 1: extract plan from inside unclosed think block.
    Fallback 2: JSON tool_call format (backward compat for API models).
    """
    # Strip think blocks (closed pairs — including </thought> variant)
    cleaned = re.sub(r'\[THINK\][\s\S]*?\[/THINK\]', '', response)
    cleaned = re.sub(r'<think>[\s\S]*?</(?:think|thought)>', '', cleaned, flags=re.IGNORECASE)
    # Strip unclosed trailing think
    cleaned = re.sub(r'\[THINK\][\s\S]*$', '', cleaned)
    cleaned = re.sub(r'<think>[\s\S]*$', '', cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    # Primary: checklist / numbered list
    result = _extract_plan_from_text(cleaned, user_message)

    # Fallback 1: if cleaned is empty/failed, try INSIDE the unclosed think block
    if not result:
        think_match = re.search(
            r'(?:<think>|\[THINK\])([\s\S]*?)$', response, re.IGNORECASE
        )
        if think_match:
            think_content = think_match.group(1).strip()
            result = _extract_plan_from_text(think_content, user_message)
            if result:
                logger.info("Plan extracted from inside unclosed think block")

    # Fallback 2: JSON tool_call format
    if not result:
        result = _try_parse_tool_call(response, user_message)

    # Deduplicate steps by name (LLM sometimes repeats plan block)
    if result and result.get("steps"):
        seen: dict = {}
        for s in result["steps"]:
            seen[s["name"]] = s
        result["steps"] = list(seen.values())

    return result


def _validate_plan(data: dict) -> Optional[Dict[str, Any]]:
    """Validate and clean parsed plan data."""
    goal = re.sub(r'\*+', '', data.get("goal", "")).strip()
    goal = goal.lstrip("#").strip()
    steps = []
    for s in data.get("steps", []):
        if isinstance(s, dict) and s.get("name"):
            steps.append({
                "name": s["name"].strip()[:100],
                "description": s.get("description", "").strip()[:500],
            })
    if len(steps) < 4:
        return None
    return {"goal": goal, "steps": steps}



def _try_parse_tool_call(response: str, user_message: str) -> Optional[Dict[str, Any]]:
    """Extract plan from [TOOL_CALLS]create_plan[ARGS]{JSON} in ORIGINAL response.

    Searches raw response (before any think removal) for [ARGS] marker,
    then extracts balanced-brace JSON. Works regardless of preceding content
    ([THINK] blocks, explanatory text, etc.).
    """
    args_idx = response.find("[ARGS]")
    if args_idx < 0:
        return None

    after_args = response[args_idx + 6:]
    brace_start = after_args.find("{")
    if brace_start < 0:
        return None

    depth = 0
    for i, c in enumerate(after_args[brace_start:]):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if depth == 0:
            json_str = after_args[brace_start:brace_start + i + 1]
            try:
                data = json.loads(json_str)
                if data.get("steps"):
                    logger.info(f"Plan parsed via streaming [ARGS] detection: {len(data['steps'])} steps")
                    return _validate_plan(data)
            except json.JSONDecodeError:
                pass
            break

    return None


def _extract_plan_from_text(text: str, user_message: str) -> Optional[Dict[str, Any]]:
    """Natural language plan parser — fallback when structured parsing fails.

    Tries multiple strategies:
    1. JSON-like create_plan(...) patterns
    2. Numbered lists (1. ..., 2. ...)
    3. Bullet points (- ..., * ...)
    4. Bold items (**Step**: ...)
    """
    # Strip think blocks (closed pairs only — safe; includes </thought> variant)
    cleaned = re.sub(r'<think>[\s\S]*?</(?:think|thought)>', '', text, flags=re.IGNORECASE)
    cleaned = re.sub(r'\[THINK\][\s\S]*?\[/THINK\]', '', cleaned, flags=re.IGNORECASE)

    lines = cleaned.strip().split("\n")
    steps: list = []

    # Strategy 1: JSON-like create_plan arguments
    json_pat = re.compile(
        r'create_plan\s*[\({]\s*["\']?(?:name|goal)["\']?\s*[:=]',
        re.IGNORECASE,
    )
    if json_pat.search(text):
        brace_pat = re.compile(r'create_plan\s*\(?\s*(\{[\s\S]*?\})\s*\)?')
        for m in brace_pat.finditer(text):
            try:
                data = json.loads(m.group(1))
                if "steps" in data and isinstance(data["steps"], list):
                    raw_goal = data.get("goal", data.get("name", user_message[:200]))
                    goal = re.sub(r'\*+', '', str(raw_goal)).split("\n")[0].strip()
                    return {
                        "goal": goal or user_message[:200],
                        "steps": [
                            {
                                "name": s.get("name", f"Step {i+1}")[:100],
                                "description": s.get("description", "").split("\n")[0][:200],
                            }
                            for i, s in enumerate(data["steps"])
                        ],
                    }
            except (json.JSONDecodeError, AttributeError):
                pass

    # Helper: split "Name: description" or "Name - description"
    def _split_name_desc(txt: str) -> tuple:
        for sep in (":", "：", " - ", " – "):
            if sep in txt:
                parts = txt.split(sep, 1)
                name_part = parts[0].strip()
                desc_part = parts[1].strip() if len(parts) > 1 else ""
                if name_part and len(name_part) >= 3 and desc_part:
                    return (name_part[:100], desc_part.split("\n")[0][:500])
        # No separator found: smart truncation for long lines
        line = txt.split("\n")[0].strip()
        if len(line) <= 100:
            return (line, "")
        # Truncate at word boundary, preserve full text as description
        truncated = line[:97].rsplit(" ", 1)[0] + "..."
        return (truncated, line)

    # Helper: extract goal from lines before first step
    def _find_goal(lines_list: list, first_step_idx: int) -> str:
        # Priority 1: explicit "Goal:" line
        for i in range(first_step_idx):
            line = lines_list[i].strip()
            goal_match = re.match(r'^(?:Goal|목표)\s*[:：]\s*(.+)', line, re.IGNORECASE)
            if goal_match:
                goal = goal_match.group(1).strip()
                return goal

        # No "Goal:" pattern found → user_message fallback
        fallback = user_message[:200] if user_message else "Research Plan"
        return fallback.split("\n")[0].strip()

    # Helper: check if an explicit Goal:/목표: line exists before the given index
    def _has_goal_line(lines_list: list, before_idx: int) -> bool:
        for i in range(before_idx):
            if re.match(r'^(?:Goal|목표)\s*[:：]\s*(.+)', lines_list[i].strip(), re.IGNORECASE):
                return True
        return False

    # Helper: capture indented description from next line(s)
    def _capture_next_desc(lines_list: list, current_idx: int, step_pat) -> str:
        """Look at the next line; if indented or starts with '- ', capture as description."""
        if current_idx + 1 >= len(lines_list):
            return ""
        next_line = lines_list[current_idx + 1]
        if not next_line or step_pat.match(next_line):
            return ""
        stripped = next_line.strip()
        if stripped.startswith("- ") or stripped.startswith("* "):
            stripped = stripped[2:]
        # Must be indented (space/tab) or bullet sub-item
        if (next_line.startswith("   ") or next_line.startswith("\t")) and stripped:
            return stripped[:500]
        return ""

    # Strategy 2: Numbered list items
    numbered_pat = re.compile(
        r"^\s*(\d+)[.)]\s*(?:\[[ x✓✗]?\]\s*)?"
        r"(.+)",
        re.IGNORECASE,
    )
    first_step_idx = None
    for idx, line in enumerate(lines):
        m = numbered_pat.match(line)
        if m:
            step_text = m.group(2).strip().rstrip(".")
            if step_text and len(step_text) > 5 and not step_text.lower().startswith(("here", "now", "let", "wait", "the ")):
                if first_step_idx is None:
                    first_step_idx = idx
                name, desc = _split_name_desc(step_text)
                if not desc:
                    desc = _capture_next_desc(lines, idx, numbered_pat)
                steps.append({"name": name, "description": desc})

    if len(steps) >= 4 and _has_goal_line(lines, first_step_idx or 0):
        goal = _find_goal(lines, first_step_idx or 0)
        logger.info(f"Plan extracted from numbered list: {len(steps)} steps")
        return {"goal": goal, "steps": steps[:10]}

    # Strategy 2b: Checkbox-only items (no number prefix)
    steps = []
    first_step_idx = None
    checkbox_pat = re.compile(
        r"^\s*\[[ x✓✗]?\]\s+(.+)",
        re.IGNORECASE,
    )
    for idx, line in enumerate(lines):
        m = checkbox_pat.match(line)
        if m:
            step_text = m.group(1).strip().rstrip(".")
            if step_text and len(step_text) > 5:
                if first_step_idx is None:
                    first_step_idx = idx
                name, desc = _split_name_desc(step_text)
                if not desc:
                    desc = _capture_next_desc(lines, idx, checkbox_pat)
                steps.append({"name": name, "description": desc})

    if len(steps) >= 4 and _has_goal_line(lines, first_step_idx or 0):
        goal = _find_goal(lines, first_step_idx or 0)
        logger.info(f"Plan extracted from checkbox items: {len(steps)} steps")
        return {"goal": goal, "steps": steps[:10]}

    # Strategy 3: Bullet points
    steps = []
    first_step_idx = None
    bullet_pat = re.compile(r"^\s*[-*•]\s+(.+)", re.IGNORECASE)
    for idx, line in enumerate(lines):
        m = bullet_pat.match(line)
        if m:
            step_text = m.group(1).strip().rstrip(".")
            if step_text and len(step_text) > 5 and ":" not in step_text[:3]:
                if first_step_idx is None:
                    first_step_idx = idx
                name, desc = _split_name_desc(step_text)
                if not desc:
                    desc = _capture_next_desc(lines, idx, bullet_pat)
                steps.append({"name": name, "description": desc})

    if len(steps) >= 4 and _has_goal_line(lines, first_step_idx or 0):
        goal = _find_goal(lines, first_step_idx or 0)
        logger.info(f"Plan extracted from bullet points: {len(steps)} steps")
        return {"goal": goal, "steps": steps[:10]}

    # Strategy 4: Bold items **Name**: description
    steps = []
    first_step_idx = None
    bold_pat = re.compile(r"\*\*([^*]+)\*\*\s*[:：]?\s*(.*)")
    for idx, line in enumerate(lines):
        m = bold_pat.search(line)
        if m:
            name = m.group(1).strip()
            desc = m.group(2).strip() if m.group(2) else ""
            if name and len(name) > 3:
                if first_step_idx is None:
                    first_step_idx = idx
                steps.append({"name": name[:100], "description": desc})

    if len(steps) >= 4 and _has_goal_line(lines, first_step_idx or 0):
        goal = _find_goal(lines, first_step_idx or 0)
        logger.info(f"Plan extracted from bold items: {len(steps)} steps")
        return {"goal": goal, "steps": steps[:10]}

    return None


class ChatHandler:
    """Singleton. Routes requests to unmodified Biomni A1 agent and manages LangGraph streaming."""

    _instance: Optional["ChatHandler"] = None

    def __init__(self) -> None:
        self._active_agents: Dict[str, A1] = {}
        self._stop_flags: Dict[str, bool] = {}
        self._plan_states: Dict[str, dict] = {}
        self._import_mapping: Dict[str, str] = {}  # func_name → correct module

    def _ensure_import_fixer(self) -> None:
        """Build import mapping from tool registry (once)."""
        if self._import_mapping:
            return
        loader = BiomniToolLoader.get_instance()
        if not loader.is_initialized():
            return
        for module_name, tools in loader.get_module2api().items():
            for tool in tools:
                name = tool.get("name")
                if name:
                    self._import_mapping[name] = module_name
        if self._import_mapping:
            logger.info(f"Import mapping built ({len(self._import_mapping)} tools)")

    @classmethod
    def get_instance(cls) -> "ChatHandler":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _get_agent(self, session_id: str, db) -> A1:
        """세션별 원본 Biomni A1 에이전트를 가져오거나 생성합니다."""
        self._ensure_import_fixer()
        if session_id not in self._active_agents:
            settings = get_settings()
            base_data_path = getattr(settings, "BIOMNI_DATA_PATH", "../biomni_data")

            # LLM Service에서 현재 선택된 모델 정보 가져오기
            llm_svc = get_llm_service()
            active_info = llm_svc.get_current_model()
            model_name = active_info.name
            provider = active_info.provider

            source = _PROVIDER_TO_SOURCE.get(provider, "Custom")
            api_key = await llm_svc._resolve_api_key(provider, db)

            base_url = None
            mc = llm_svc._registry["models"].get(model_name, {})
            if mc.get("type") == "local":
                base_url = settings.VLLM_BASE_URL
                api_key = api_key or "EMPTY"

            # Update biomni default_config so internal tool LLM calls use the correct model/key
            try:
                from biomni.config import default_config as _biomni_cfg
                _biomni_cfg.llm = model_name
                _biomni_cfg.api_key = api_key
                if base_url:
                    _biomni_cfg.base_url = base_url
                    _biomni_cfg.source = source
            except ImportError:
                pass

            # 🚀 아무것도 수정하지 않은 원본 A1 인스턴스 생성!
            agent = A1(
                path=base_data_path,
                llm=model_name,
                source=source,
                base_url=base_url,
                api_key=api_key
            )

            # vLLM 호환성 패치: skip_special_tokens=False — [THINK]/[/THINK] 특수 토큰 출력
            if mc.get("type") == "local" and hasattr(agent, "llm"):
                llm = agent.llm
                if hasattr(llm, "model_kwargs"):
                    llm.model_kwargs = {
                        **(llm.model_kwargs or {}),
                        "extra_body": {
                            "skip_special_tokens": False,
                            "include_stop_str_in_output": True,
                        },
                    }
                    logger.info("Patched A1 LLM with vLLM extra_body (skip_special_tokens)")

            # Patch _traced_run_code to fix biomni imports before execution.
            # Module-level monkey-patch doesn't work because a1.py binds
            # run_python_repl via 'from ... import' (value copy, not reference).
            if self._import_mapping and not getattr(agent, '_import_patched', False):
                original_run = agent._traced_run_code
                mapping = self._import_mapping
                def _patched_traced_run(code: str, timeout: int):
                    fixed, corrections = _fix_biomni_imports(code, mapping)
                    if corrections:
                        logger.info(f"Import auto-fix: {corrections}")
                    return original_run(fixed, timeout)
                agent._traced_run_code = _patched_traced_run
                agent._import_patched = True
                logger.info("Import fixer applied to A1 agent instance")

            self._active_agents[session_id] = agent
            logger.info(f"Initialized Original A1 Agent for session {session_id} with model {model_name}")

        return self._active_agents[session_id]

    def stop(self, conv_id: str) -> bool:
        self._stop_flags[conv_id] = True
        # Schedule LLM abort in the event loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(self._abort_llm_request(conv_id))
        except RuntimeError:
            pass
        return True

    async def _abort_llm_request(self, conv_id: str) -> None:
        """Close HTTP client to abort in-flight LLM request, then discard agent."""
        agent = self._active_agents.get(conv_id)
        if not agent:
            return
        try:
            llm = getattr(agent, 'llm', None)
            if llm:
                client = getattr(llm, 'async_client', None) or getattr(llm, 'client', None)
                if client and hasattr(client, 'close'):
                    await client.close()
                    logger.info("LLM HTTP client closed to abort in-flight request")
        except Exception as e:
            logger.warning(f"Failed to abort LLM request: {e}")
        # Discard agent so next call creates a fresh one
        self._active_agents.pop(conv_id, None)

    # ─── Phase A: Plan Creation (별도 LLM 호출) ───

    async def _create_plan(
        self, conv_id: str, message: str, behavior: dict, db
    ) -> AsyncGenerator[ChatEvent, None]:
        """Phase A: 별도 LLM 호출로 plan 생성 (checklist 형식).

        Local 방식 복원: per-attempt ChatOpenAI with repetition_penalty + temperature decay.
        Local 모델: repetition_penalty 1.15→1.25→1.35, temperature decay 0.7^attempt
        API 모델: temperature decay만 적용 (repetition_penalty 불필요)
        """
        from langchain_openai import ChatOpenAI

        llm_service = get_llm_service()
        conv_svc = ConversationService(db)

        plan_prompt = build_prompt(PromptMode.PLAN, token_format=behavior)
        plan_messages = [SystemMessage(content=plan_prompt), HumanMessage(content=message)]

        # Base LLM에서 connection params 추출 (Local 방식)
        base_llm = await llm_service.get_llm_instance(db=db, max_tokens=2048)
        model_info = llm_service.get_current_model()
        is_local = model_info.type == "local"
        logger.info(
            f"Plan base_llm: model_name={getattr(base_llm, 'model_name', '?')}, "
            f"base_url={getattr(base_llm, 'openai_api_base', '?')}, "
            f"is_local={is_local}"
        )

        MAX_RETRIES = 2
        plan_data = None
        full_response = ""

        for attempt in range(MAX_RETRIES + 1):
            if self._stop_flags.get(conv_id):
                return

            rep_penalty = 1.15 + 0.1 * attempt
            base_temp = getattr(base_llm, 'temperature', 0.7) or 0.7
            temperature = max(0.1, base_temp * (0.7 ** attempt))

            # Local: per-attempt ChatOpenAI with repetition_penalty
            if is_local:
                plan_llm = ChatOpenAI(
                    model=base_llm.model_name,
                    temperature=temperature,
                    max_tokens=4096,
                    base_url=getattr(base_llm, 'openai_api_base', None),
                    api_key=getattr(base_llm, 'openai_api_key', None) or "EMPTY",
                    extra_body={
                        "skip_special_tokens": False,
                        "repetition_penalty": rep_penalty,
                    },
                )
            else:
                # API: get_llm_instance with overridden temperature
                plan_llm = await llm_service.get_llm_instance(
                    db=db, temperature=temperature, max_tokens=4096
                )

            logger.info(
                f"Plan attempt {attempt + 1}/{MAX_RETRIES + 1}: "
                f"temp={temperature:.2f}"
                + (f", rep_penalty={rep_penalty:.2f}" if is_local else "")
            )

            full_response = ""
            finish_reason = None
            chunk_count = 0
            plan_data = None
            try:
                async for chunk in plan_llm.astream(plan_messages):
                    chunk_count += 1
                    if self._stop_flags.get(conv_id):
                        return
                    token = chunk.content if hasattr(chunk, "content") else ""
                    if token:
                        full_response += token
                        yield _ev("token", {"token": token})

                    meta = getattr(chunk, "response_metadata", None)
                    if meta and isinstance(meta, dict):
                        fr = meta.get("finish_reason")
                        if fr:
                            finish_reason = fr
            except Exception as e:
                logger.error(f"Plan streaming error on attempt {attempt + 1}: {type(e).__name__}: {e}")
                if attempt < MAX_RETRIES:
                    yield _ev("plan_retry", {"attempt": attempt + 2, "max_attempts": MAX_RETRIES + 1})
                    continue
                raise

            logger.info(
                f"Plan attempt {attempt + 1} done: {len(full_response)} chars, "
                f"finish_reason={finish_reason}, chunks={chunk_count}"
            )

            # If truncated by max_tokens, retry with stronger params
            if finish_reason == "length" and not plan_data:
                logger.warning(f"Plan truncated (max_tokens) on attempt {attempt + 1}")
                if attempt < MAX_RETRIES:
                    yield _ev("plan_retry", {"attempt": attempt + 2, "max_attempts": MAX_RETRIES + 1})
                    continue

            # Full parse if not already detected during streaming
            if not plan_data:
                plan_data = _parse_plan_response(full_response, message)
            if plan_data and plan_data.get("steps"):
                has_think = bool(
                    re.search(r'\[THINK\]', full_response) or
                    re.search(r'<think>', full_response, re.IGNORECASE)
                )
                if has_think or attempt >= MAX_RETRIES:
                    logger.info(f"Plan created: {len(plan_data['steps'])} steps, think={has_think} (attempt {attempt + 1})")
                    break
                else:
                    logger.warning(f"Plan missing [THINK] on attempt {attempt + 1}, retrying...")
                    yield _ev("plan_retry", {"attempt": attempt + 2, "max_attempts": MAX_RETRIES + 1})
                    continue

            # Parse failed
            logger.warning(f"Plan parse failed on attempt {attempt + 1}. Raw: {full_response[:500]}")
            if attempt < MAX_RETRIES:
                yield _ev("plan_retry", {"attempt": attempt + 2, "max_attempts": MAX_RETRIES + 1})
                continue

        if not plan_data or not plan_data.get("steps"):
            logger.error(f"Plan parsing failed after {MAX_RETRIES + 1} attempts")
            yield _ev("token", {"token": "\n\n⚠️ Plan 생성에 실패했습니다. 다시 시도해주세요."})
            yield _ev("error", {"error": "Plan parsing failed"})
            return

        # Emit plan events → 프론트엔드 plan box 즉시 표시
        yield _ev("tool_call", {
            "tool_call": {
                "name": "create_plan",
                "arguments": plan_data,
                "status": "completed",
            }
        })

        # DB 저장 (think 블록 제외 — step 실행 시 LLM이 plan 생성 reasoning을 보면 안됨)
        plan_marker = f"[PLAN_CREATE]{json.dumps(plan_data, ensure_ascii=False)}"
        await conv_svc.add_message(UUID(conv_id), "assistant", plan_marker)

        # Initialize plan state for step execution
        self._plan_states[conv_id] = {
            "steps": plan_data["steps"],
            "goal": plan_data.get("goal", ""),
            "current_step": 0,
            "all_results": [],
        }

    # ─── Phase B: Step Execution Loop ───

    async def _run_step_loop(
        self, conv_id: str, history: List,
        behavior: dict, db
    ) -> AsyncGenerator[ChatEvent, None]:
        """Plan step execution loop — delegates each step to A1 agent orchestration.

        Flow: tool retrieval (once) → for each step: set A1 system_prompt → astream_events.
        A1's StateGraph handles generate→execute→observe loop internally.
        """
        plan_state = self._plan_states.get(conv_id)
        if not plan_state:
            yield _ev("error", {"error": "No plan state"})
            return

        llm_service = get_llm_service()
        conv_svc = ConversationService(db)
        steps = plan_state["steps"]

        # ── Tool retrieval (once per plan) ──
        yield _ev("tool_retrieval_start", {"tool_retrieval_start": True})

        app_settings = get_settings()
        data_lake_path = app_settings.BIOMNI_DATA_PATH or ""

        biomni_loader = BiomniToolLoader.get_instance()
        data_lake_items = scan_data_lake(data_lake_path)
        retrieved_tool_names: List[str] = []
        retrieved_data_lake_names: List[str] = []
        retrieved_library_names: List[str] = []
        selected_data_lake: List[Dict[str, Any]] = []
        selected_libraries: List[Dict[str, Any]] = []

        if biomni_loader.is_initialized():
            retrieval_query = plan_state["goal"] + "\n" + "\n".join(
                s.get("description", s.get("name", "")) for s in steps
            )
            use_llm_ret = behavior.get("use_llm_retrieval", False)
            if use_llm_ret:
                llm = await llm_service.get_llm_instance(db=db)
                retrieval_result = await biomni_loader.retrieval_with_llm(
                    retrieval_query, llm, max_tools=15,
                    data_lake_items=data_lake_items,
                )
            else:
                kw_tools = biomni_loader.keyword_search(retrieval_query, max_results=15)
                retrieval_result = {"tools": kw_tools, "data_lake": [], "libraries": []}

            selected_tools = retrieval_result["tools"]
            selected_data_lake = retrieval_result["data_lake"]
            selected_libraries = retrieval_result["libraries"]
            tool_desc = biomni_loader.format_tool_desc(selected_tools)
            retrieved_tool_names = [t.get("name", "?") for t in selected_tools]
            retrieved_data_lake_names = [d.get("name", "?") for d in selected_data_lake]
            retrieved_library_names = [l.get("name", "?") for l in selected_libraries]
            logger.info(
                f"Plan retrieval: {len(retrieved_tool_names)} tools, "
                f"{len(retrieved_data_lake_names)} data_lake, "
                f"{len(retrieved_library_names)} libraries"
            )
        else:
            tool_desc = ""

        plan_state["_retrieved_tool_desc"] = tool_desc
        plan_state["_retrieved_tool_names"] = retrieved_tool_names
        plan_state["_retrieved_data_lake_names"] = retrieved_data_lake_names
        plan_state["_retrieved_library_names"] = retrieved_library_names

        yield _ev("tool_retrieval_done", {"tool_retrieval_done": {
            "tools": retrieved_tool_names,
            "data_lake": retrieved_data_lake_names,
            "libraries": retrieved_library_names,
        }})

        # ── Get A1 agent ──
        agent = await self._get_agent(conv_id, db)

        # ── Set token format from behavior ──
        if hasattr(agent, 'set_token_format'):
            agent.set_token_format(behavior)

        # ── Patch LLM stop sequences to match token format ──
        # NOTE: [✓]/[✗] are NOT stop sequences — they'd interrupt plan creation.
        # Checklist completion is handled by LangGraph routing (a1.py checklist_done).
        if hasattr(agent, 'llm') and hasattr(agent, '_exec_close'):
            new_stops = [agent._exec_close]  # e.g. "[/EXECUTE]"
            if hasattr(agent, '_sol_close') and agent._sol_close:
                new_stops.append(agent._sol_close)
            # Defensive: if bracket format, also stop on angle-bracket variants
            # in case model hallucinates wrong format
            if agent._exec_close.startswith("["):
                for extra in ["</execute>", "</EXECUTE>"]:
                    if extra not in new_stops:
                        new_stops.append(extra)
            for attr in ('stop', 'stop_sequences'):
                if hasattr(agent.llm, attr):
                    setattr(agent.llm, attr, new_stops)
                    logger.info(f"Patched A1 LLM stop sequences: {new_stops}")
                    break

        # ── Ensure include_stop_str_in_output for local models ──
        _llm_svc = get_llm_service()
        _mc = _llm_svc._registry["models"].get(_llm_svc.get_current_model().name, {})
        if _mc.get("type") == "local" and hasattr(agent, 'llm') and hasattr(agent.llm, 'model_kwargs'):
            _eb = {**(agent.llm.model_kwargs or {}).get("extra_body", {})}
            _eb["include_stop_str_in_output"] = True
            agent.llm.model_kwargs = {**(agent.llm.model_kwargs or {}), "extra_body": _eb}

        # ── Extract token format variables for later use ──
        def _close_tag(tag: str) -> str:
            if tag.startswith("["):
                return tag.replace("[", "[/", 1)
            return tag.replace("<", "</", 1)

        exec_fmt = behavior.get("code_execute_format") or "<execute>"
        exec_close = _close_tag(exec_fmt)
        think_fmt = behavior.get("think_format") or "<think>"
        think_close = _close_tag(think_fmt)

        # ── Build available tools text ──
        available_tools_text = self._wrap_available_tools(tool_desc, behavior)

        for step_idx in range(plan_state["current_step"], len(steps)):
            # Skip steps already completed by LLM in a previous step's response
            if step_idx in plan_state.get("llm_completed_steps", set()):
                logger.info(f"Step {step_idx+1} skipped (already completed by LLM)")
                continue

            if self._stop_flags.get(conv_id):
                await self._save_plan_complete(conv_id, conv_svc, stopped=True)
                yield _ev("done", {"done": True, "stopped": True})
                return

            step = steps[step_idx]
            plan_state["current_step"] = step_idx

            yield _ev("step_start", {"step_start": {
                "step": step_idx + 1,
                "retrieved_tools": retrieved_tool_names,
            }})

            # ── Compute step shortcut (math operations — no LLM needed) ──
            step_tool = step.get("tool", "")
            if step_tool.startswith("compute_"):
                compute_result = self._compute_step(step)
                compute_result_data = {
                    "value": compute_result,
                    "reasoning": f"Computed {step.get('name', step_tool)}: {compute_result}",
                }
                yield _ev("tool_result", {"tool_result": {
                    "success": True,
                    "result": compute_result_data,
                    "tool": step_tool,
                    "step": step_idx + 1,
                }})
                plan_state["all_results"].append({
                    "step": step_idx + 1,
                    "tool": step_tool,
                    "success": True,
                    "result": compute_result_data,
                })
                history.append(AIMessage(
                    content=f"Step {step_idx+1} ({step.get('name', step_tool)}): result = {compute_result}"
                ))
                await self._save_plan_complete(conv_id, conv_svc)
                continue

            # ── Set A1 system prompt for this step ──
            dl_content = "\n".join(
                f"- {d.get('name', '')}: {d.get('description', '')}" if d.get("description")
                else f"- {d.get('name', '')}"
                for d in selected_data_lake
            )
            lib_content = "\n".join(
                f"- {l.get('name', '')}: {l.get('description', '')}" if l.get("description")
                else f"- {l.get('name', '')}"
                for l in selected_libraries
            )
            base_prompt = build_prompt(
                PromptMode.FULL,
                token_format=behavior,
                data_lake_path=data_lake_path,
                data_lake_content=dl_content,
                library_content=lib_content,
                is_retrieval=bool(tool_desc),
                is_step_execution=True,
            )
            if available_tools_text:
                base_prompt += "\n\n" + available_tools_text

            plan_checklist = self._build_plan_checklist(conv_id)
            if plan_checklist:
                base_prompt += "\n\n" + plan_checklist

            agent.system_prompt = base_prompt

            # ── Build step input ──
            total_steps = len(steps)
            step_context = self._build_step_context(step, step_idx, plan_state["all_results"],
                                                     total_steps=total_steps, all_steps=steps,
                                                     behavior=behavior)
            inputs = {
                "messages": history + [HumanMessage(content=step_context)],
                "next_step": None,
                "current_step_number": step_idx + 1,
                "is_final_step": step_idx == total_steps - 1,
            }
            config = {
                "recursion_limit": 50,
                "configurable": {"thread_id": f"{conv_id}_step_{step_idx}"},
            }

            # ── Stream A1 events ──
            full_response = ""
            step_result = None
            has_error = False
            exec_count = 0

            try:
                async for event in agent.app.astream_events(inputs, version="v2", config=config):
                    if self._stop_flags.get(conv_id):
                        await self._save_plan_complete(conv_id, conv_svc, stopped=True)
                        yield _ev("done", {"done": True, "stopped": True})
                        return

                    kind = event["event"]

                    # LLM token streaming
                    if kind == "on_chat_model_stream":
                        content = event["data"]["chunk"].content
                        chunk_text = ""
                        if isinstance(content, str):
                            chunk_text = content
                        elif isinstance(content, list):
                            chunk_text = "".join(
                                b.get("text", "") for b in content if isinstance(b, dict)
                            )
                        if chunk_text:
                            full_response += chunk_text

                    # Execute node started
                    elif kind == "on_chain_start" and event.get("name") == "execute":
                        yield _ev("tool_call", {
                            "tool_call": {
                                "name": "code_execution",
                                "arguments": {},
                                "status": "running",
                            }
                        })

                    # Execute node completed
                    elif kind == "on_chain_end" and event.get("name") == "execute":
                        output = event["data"].get("output", {})
                        last_msg = ""
                        if output and "messages" in output:
                            msgs = output["messages"]
                            # A1 uses .invoke() — no on_chat_model_stream events.
                            # msgs[-2] = AIMessage (code with <execute>...</execute>)
                            # msgs[-1] = HumanMessage (<observation>result</observation>)
                            if len(msgs) >= 2 and hasattr(msgs[-2], 'content'):
                                full_response += f"\n{msgs[-2].content}\n"
                            last_msg = msgs[-1].content if msgs else ""
                            full_response += f"\n{last_msg}\n"
                            step_result = {
                                "stdout": last_msg,
                                "tool": step.get("tool", "code_execution"),
                            }
                        # Detect errors in observation
                        stdout = (step_result or {}).get("stdout", "")
                        _obs_open = behavior.get("code_result_format") or "<observation>"
                        if f"{_obs_open}Error:" in stdout or f"{_obs_open}Traceback" in stdout:
                            has_error = True

                        # ── Emit intermediate execution result ──
                        exec_code = _extract_last_execute_block(full_response, behavior)
                        if exec_code and self._import_mapping:
                            exec_code, _ = _fix_biomni_imports(exec_code, self._import_mapping)
                        obs_text = _extract_observation(last_msg)
                        yield _ev("step_execute", {"step_execute": {
                            "step": step_idx + 1,
                            "code": exec_code,
                            "observation": obs_text,
                            "success": not has_error,
                            "iteration": exec_count,
                        }})
                        exec_count += 1

            except asyncio.CancelledError:
                logger.info(f"Step {step_idx+1} cancelled by user stop")
                await self._save_plan_complete(conv_id, conv_svc, stopped=True)
                raise
            except Exception as step_err:
                logger.error(f"Step {step_idx+1} A1 execution failed: {step_err}")
                # Build partial result from accumulated response
                partial_result, partial_tool, _ = _build_step_result_from_response(
                    full_response, step_result, behavior, step, has_error,
                )
                _err_data = {"error": f"A1 error: {step_err}", **partial_result}
                yield _ev("tool_result", {"tool_result": {
                    "success": False, "result": _err_data,
                    "tool": partial_tool if partial_tool != "text" else "step_error",
                    "step": step_idx + 1,
                }})
                plan_state["all_results"].append({
                    "step": step_idx + 1, "tool": "step_error",
                    "success": False, "result": _err_data,
                })
                history.append(AIMessage(content=f"Step {step_idx+1} failed: {step_err}"))
                continue

            # ── Build final step result (code + execution) ──
            final_result, tool_name, code_blocks = _build_step_result_from_response(
                full_response, step_result, behavior, step, has_error,
            )
            # Fix wrong biomni import paths in code
            if code_blocks and final_result.get("code"):
                combined_code, import_corrections = _fix_biomni_imports(
                    final_result["code"], self._import_mapping
                )
                if import_corrections:
                    final_result["import_corrections"] = import_corrections
                    logger.info(f"Step {step_idx+1} import corrections: {import_corrections}")
                final_result["code"] = combined_code
                logger.info(f"Step {step_idx+1}: code_blocks={len(code_blocks)}, has_code=True, tool={tool_name}")

            # ── Parse ordered segments for interleaved rendering ──
            segments = _parse_segments(full_response, behavior)
            if segments:
                final_result["segments"] = segments

            # ── Extract think blocks and reasoning text (flat fields for compat) ──
            think_pattern = re.escape(think_fmt) + r'([\s\S]*?)' + re.escape(think_close)
            think_matches = re.findall(think_pattern, full_response)
            # Fallback: try XML and bracket formats if behavior format didn't match
            if not think_matches:
                think_matches = re.findall(r'<think>([\s\S]*?)</think>', full_response, re.IGNORECASE)
            if not think_matches:
                think_matches = re.findall(r'\[THINK\]([\s\S]*?)\[/THINK\]', full_response)
            if think_matches:
                final_result["thinking"] = "\n".join(b.strip() for b in think_matches)

            # Reasoning = full_response minus think/execute/observation/solution blocks
            obs_fmt = behavior.get("code_result_format") or "<observation>"
            obs_close = _closing_tag(obs_fmt)
            reasoning = re.sub(think_pattern, '', full_response)
            # Fallback think strip
            reasoning = re.sub(r'<think>[\s\S]*?</think>', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[THINK\][\s\S]*?\[/THINK\]', '', reasoning)
            # Dynamic execute strip
            reasoning = re.sub(
                re.escape(exec_fmt) + r'[\s\S]*?' + re.escape(exec_close), '', reasoning
            )
            # Fallback execute strip (negative lookahead to avoid cross-block matching)
            reasoning = re.sub(r'<execute>(?:(?!<execute>)[\s\S])*?</execute>', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[EXECUTE\](?:(?!\[EXECUTE\])[\s\S])*?\[/EXECUTE\]', '', reasoning)
            # Dynamic observation strip
            reasoning = re.sub(
                re.escape(obs_fmt) + r'[\s\S]*?' + re.escape(obs_close), '', reasoning
            )
            # Fallback observation patterns
            reasoning = re.sub(r'<observation>[\s\S]*?</observation>', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[OBSERVATION\][\s\S]*?\[/OBSERVATION\]', '', reasoning)
            reasoning = re.sub(r'<solution>[\s\S]*?</solution>', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[SOLUTION\][\s\S]*?\[/SOLUTION\]', '', reasoning)
            # Incomplete/unclosed blocks
            reasoning = re.sub(r'<solution>[\s\S]*$', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[SOLUTION\][\s\S]*$', '', reasoning)
            reasoning = re.sub(r'<think>[\s\S]*$', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[THINK\][\s\S]*$', '', reasoning)
            reasoning = re.sub(r'<execute>[\s\S]*$', '', reasoning, flags=re.IGNORECASE)
            reasoning = re.sub(r'\[EXECUTE\][\s\S]*$', '', reasoning)
            reasoning = reasoning.strip()
            if reasoning:
                final_result["reasoning"] = reasoning

            # ── Extract solution block ──
            sol_fmt = behavior.get("solution_format") or "<solution>"
            sol_match = None
            if sol_fmt:
                sol_close = _closing_tag(sol_fmt)
                sol_match = re.search(
                    re.escape(sol_fmt) + r'([\s\S]*?)' + re.escape(sol_close), full_response
                )
                if not sol_match:
                    # Incomplete: opening tag but no closing
                    sol_match = re.search(re.escape(sol_fmt) + r'([\s\S]+)$', full_response)
            else:
                # Fallback: try both formats (complete + incomplete)
                sol_match = (
                    re.search(r'<solution>([\s\S]*?)</solution>', full_response, re.IGNORECASE)
                    or re.search(r'\[SOLUTION\]([\s\S]*?)\[/SOLUTION\]', full_response)
                    or re.search(r'<solution>([\s\S]+)$', full_response, re.IGNORECASE)
                    or re.search(r'\[SOLUTION\]([\s\S]+)$', full_response)
                )
            if sol_match:
                final_result["solution"] = sol_match.group(1).strip()

            # ── Determine step success ──
            # Success = solution exists OR LLM marked step with [✓]
            # (NOT based on code execution errors)
            checked = _parse_checked_steps(full_response, steps)
            step_checked = step_idx in checked
            has_solution = bool(final_result.get("solution"))
            step_success = has_solution or step_checked

            # ── Emit final tool_result for step completion ──
            # Always emit — contains code, reasoning, thinking, solution fields
            yield _ev("tool_result", {"tool_result": {
                "success": step_success,
                "result": final_result,
                "tool": tool_name,
                "step": step_idx + 1,
            }})

            # ── Step completion ──
            plan_state["all_results"].append({
                "step": step_idx + 1,
                "tool": tool_name,
                "success": step_success,
                "result": final_result,
            })
            # Fix imports in history too
            fixed_response, _ = _fix_biomni_imports(full_response, self._import_mapping)
            # Strip think blocks from history to save context and prevent LLM from seeing its own reasoning
            clean_response = re.sub(r'\[THINK\][\s\S]*?\[/THINK\]', '', fixed_response).strip()
            clean_response = re.sub(r'<think>[\s\S]*?</think>', '', clean_response, flags=re.IGNORECASE).strip()
            history.append(AIMessage(content=clean_response))

            # ── Incremental save to DB (survives backend restart) ──
            await self._save_plan_complete(conv_id, conv_svc)

            # ── Detect [✓] checklist marks for multi-step completion ──
            # LLM may mark future steps as completed in its response
            # (checked already parsed above for step success determination)
            newly_checked = {idx for idx in checked if idx > step_idx
                             and idx not in plan_state.get("llm_completed_steps", set())}
            if newly_checked:
                logger.info(
                    f"[{conv_id}] LLM checked steps beyond current ({step_idx+1}): "
                    f"{sorted(i+1 for i in newly_checked)}"
                )
                for skip_idx in sorted(newly_checked):
                    yield _ev("step_start", {"step_start": {
                        "step": skip_idx + 1,
                        "retrieved_tools": [],
                    }})
                    yield _ev("tool_result", {"tool_result": {
                        "success": True,
                        "result": {
                            "reasoning": f"Completed by LLM during step {step_idx + 1}",
                            "solution": "",
                        },
                        "tool": "llm_inline_completion",
                        "step": skip_idx + 1,
                    }})
                    plan_state["all_results"].append({
                        "step": skip_idx + 1,
                        "tool": "llm_inline_completion",
                        "success": True,
                        "result": {"reasoning": f"Completed by LLM during step {step_idx + 1}"},
                    })
                llm_done = plan_state.get("llm_completed_steps", set())
                plan_state["llm_completed_steps"] = llm_done | newly_checked

        # All steps done — run analysis as post-processing step
        plan_complete_data = await self._save_plan_complete(conv_id, conv_svc)

        # ── Analysis (non-streamed, separate post-execution step) ──
        try:
            analysis_text = await self._run_plan_analysis(plan_state, db=db)
            if analysis_text:
                plan_complete_data["analysis"] = analysis_text
                await conv_svc.update_plan_analysis(UUID(conv_id), analysis_text)
                logger.info(f"[{conv_id}] Plan analysis generated ({len(analysis_text)} chars)")
        except Exception as e:
            logger.warning(f"[{conv_id}] Plan analysis failed: {e}")

        yield _ev("done", {"done": True, "plan_complete": plan_complete_data})

    # ═══════════════════════════════════════════
    # Internal — helpers
    # ═══════════════════════════════════════════

    @staticmethod
    def _fix_role_alternation(messages: List) -> List:
        """Merge consecutive same-role messages for SGLang compatibility."""
        if not messages:
            return messages
        fixed = [messages[0]]
        for msg in messages[1:]:
            prev = fixed[-1]
            if type(msg) == type(prev):
                if isinstance(msg, HumanMessage):
                    fixed[-1] = HumanMessage(content=prev.content + "\n\n" + msg.content)
                else:
                    fixed[-1] = AIMessage(content=prev.content + "\n\n" + msg.content)
            else:
                fixed.append(msg)
        return fixed

    @staticmethod
    async def _get_max_context(db, behavior: dict = None) -> int:
        """Read max_context from DB settings, default 32768."""
        base_ctx = 32768
        try:
            result = await db.execute(
                select(Setting).where(Setting.key == "settings")
            )
            row = result.scalar_one_or_none()
            if row and row.value and "max_context" in row.value:
                base_ctx = row.value["max_context"]
        except Exception:
            pass
        if behavior and "ministral" in behavior.get("local_path", "").lower():
            return min(base_ctx, 10000)
        return base_ctx

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """Rough token estimate using UTF-8 byte length (~3 bytes per token)."""
        return len(text.encode("utf-8")) // 3 + 1

    @classmethod
    def _truncate_messages(cls, messages: List, max_tokens: int) -> List:
        """Trim oldest non-system messages to fit within max_tokens budget."""
        if not messages or max_tokens <= 0:
            return messages

        system_msgs = []
        history = []
        idx = 0
        while idx < len(messages) and isinstance(messages[idx], SystemMessage):
            system_msgs.append(messages[idx])
            idx += 1
        if idx < len(messages):
            history = list(messages[idx:])

        tail = [history.pop()] if history else []
        fixed_cost = sum(cls._estimate_tokens(m.content) for m in system_msgs + tail)
        remaining = max_tokens - fixed_cost

        if remaining <= 0:
            return system_msgs + tail

        kept = []
        for msg in reversed(history):
            cost = cls._estimate_tokens(msg.content)
            if remaining - cost < 0:
                break
            kept.append(msg)
            remaining -= cost

        kept.reverse()
        return system_msgs + kept + tail

    @staticmethod
    def _wrap_available_tools(tool_desc: str, behavior: dict) -> str:
        """Wrap tool descriptions with model-specific token or plain text."""
        if not tool_desc:
            return ""
        avail_fmt = behavior.get("available_tools_format")
        if avail_fmt:
            avail_close = _closing_tag(avail_fmt)
            return f"{avail_fmt}\n{tool_desc}\n{avail_close}"
        return f"AVAILABLE TOOLS:\n{tool_desc}"

    def _build_plan_checklist(self, conv_id: str) -> str:
        """Build plan checklist with current step statuses for system prompt injection."""
        plan_state = self._plan_states.get(conv_id)
        if not plan_state:
            return ""

        steps = plan_state["steps"]
        results = plan_state["all_results"]
        current_step = plan_state.get("current_step", 0)
        goal = plan_state.get("goal", "")

        result_map: Dict[int, dict] = {}
        for r in results:
            idx = r.get("step")
            if idx is not None:
                result_map[idx - 1] = r

        lines = [
            "# ACTIVE PLAN — FOLLOW THIS PLAN EXACTLY",
            "",
            "IMPORTANT: A plan already exists below. Do NOT create a new plan or remove/reorder steps.",
            "Execute ONLY the current step. You MUST mark it as [✓] when complete.",
            "",
        ]
        if goal:
            lines.append(f"Goal: {goal}")
            lines.append("")

        for i, step in enumerate(steps):
            name = step.get("name", f"Step {i + 1}")
            if i in result_map:
                r = result_map[i]
                if r.get("success"):
                    line = f"{i + 1}. [✓] {name} (completed)"
                    # Add brief result summary for context
                    result_data = r.get("result", {})
                    if isinstance(result_data, dict):
                        sol = result_data.get("solution", "")
                        if sol:
                            line += f" → {str(sol)[:50]}"
                    lines.append(line)
                else:
                    lines.append(f"{i + 1}. [✗] {name} (failed)")
            elif i == current_step:
                lines.append(f"{i + 1}. [→] {name} (current) ← EXECUTE THIS STEP NOW")
            else:
                lines.append(f"{i + 1}. [ ] {name}")

        return "\n".join(lines)

    def _compute_step(self, step: dict):
        """Execute a compute_* step directly (math operations, no LLM)."""
        import math as _math
        pv = step.get("portValues", {})
        op = step.get("tool", "").replace("compute_", "")

        # Get operands from portValues
        a = float(pv.get("a", pv.get("base", pv.get("value", 0))))
        b = float(pv.get("b", pv.get("exp", pv.get("base", 0))))

        ops = {
            "add": lambda: a + b,
            "subtract": lambda: a - b,
            "multiply": lambda: a * b,
            "divide": lambda: a / b if b != 0 else float("inf"),
            "power": lambda: a ** b,
            "sqrt": lambda: _math.sqrt(a) if a >= 0 else float("nan"),
            "log": lambda: _math.log(a, b) if a > 0 and b > 0 and b != 1 else float("nan"),
        }
        try:
            return ops.get(op, lambda: 0)()
        except Exception:
            return float("nan")

    def _build_step_context(self, step: dict, step_idx: int, prev_results: list,
                             total_steps: int = 0, all_steps: list = None,
                             behavior: dict = None) -> str:
        """Build step execution context string with semantic connection info."""
        name = step.get("name", f"Step {step_idx + 1}")
        desc = step.get("description", "")
        ref_ctx = self._build_ref_context(step)

        parts = [f"Execute step {step_idx + 1}: {name}."]
        if desc:
            parts.append(desc)
        if ref_ctx:
            parts.append(ref_ctx)

        # Step completion instruction
        is_final = (step_idx == total_steps - 1) if total_steps else False
        if is_final:
            sol_fmt = behavior.get("solution_format") if behavior else None
            if sol_fmt:
                sol_close = _closing_tag(sol_fmt)
                parts.append(
                    f"This is the FINAL step. When done, provide the overall answer "
                    f"using {sol_fmt}your answer{sol_close}."
                )
            else:
                parts.append(
                    "This is the FINAL step. When done, provide the overall answer directly."
                )
        else:
            parts.append(
                f"When this step is complete, mark it as done: "
                f"{step_idx + 1}. [✓] {name}"
            )

        # Semantic ref fields — categorized by source node type
        ref_tools = step.get("refTools")
        if ref_tools:
            parts.append(f"Additional available tools: {', '.join(ref_tools)}")

        ref_dl = step.get("refDataLake")
        if ref_dl and isinstance(ref_dl, list):
            dl_items = [f"- {d.get('name', '')}: {d.get('description', '')}" for d in ref_dl]
            parts.append("Available data for reference:\n" + "\n".join(dl_items))

        ref_libs = step.get("refLibraries")
        if ref_libs and isinstance(ref_libs, list):
            lib_items = [f"- {l.get('name', '')}: {l.get('description', '')}" for l in ref_libs]
            parts.append("Available libraries:\n" + "\n".join(lib_items))

        # Inject previous step result for continuity (always include last step)
        if step_idx > 0 and prev_results and len(prev_results) >= step_idx:
            prev = prev_results[step_idx - 1]
            prev_name = (all_steps[step_idx - 1].get("name", f"Step {step_idx}")
                         if all_steps else f"Step {step_idx}")
            parts.append(f"\n--- Previous Step Result (Step {step_idx}: {prev_name}) ---")
            result_data = prev.get("result", {})
            if isinstance(result_data, dict):
                for key in ("solution", "reasoning", "code", "stdout"):
                    val = result_data.get(key)
                    if val:
                        parts.append(f"  {key}: {str(val)[:500]}")

        # Referenced steps — inject actual results
        ref_steps = step.get("refSteps")
        if ref_steps and isinstance(ref_steps, list):
            for rs in ref_steps:
                step_id = rs.get("stepId")
                step_name = rs.get("name", "")
                parts.append(f"\n--- Referenced Step {step_id}: {step_name} ---")
                if step_id and prev_results:
                    try:
                        ref_idx = int(step_id) - 1
                        if 0 <= ref_idx < len(prev_results):
                            ref_result = prev_results[ref_idx]
                            result_data = ref_result.get("result", {})
                            if isinstance(result_data, dict):
                                for key in ("solution", "reasoning", "code", "stdout"):
                                    val = result_data.get(key)
                                    if val:
                                        parts.append(f"  {key}: {str(val)[:500]}")
                            elif result_data:
                                parts.append(f"  Result: {str(result_data)[:500]}")
                    except (ValueError, IndexError):
                        pass

        # Tool assignment (flow from Tool node, or node's own tool)
        tool_name = step.get("tool", "")
        if tool_name:
            parts.append(f"You MUST use the '{tool_name}' tool for this step.")
            tool_detail = self._get_tool_detail(tool_name)
            if tool_detail:
                parts.append(f"Tool signature: {tool_detail}")
        else:
            parts.append("Choose and call the appropriate tool(s).")

        # Semantic flow fields — mandatory usage directives
        flow_libs = step.get("flowLibraries")
        if flow_libs and isinstance(flow_libs, list):
            for lib in flow_libs:
                parts.append(f"You MUST use the '{lib.get('name', '')}' library for this step.")

        flow_data = step.get("flowData")
        if flow_data and isinstance(flow_data, list):
            for d in flow_data:
                parts.append(f"Use the following data: {d.get('name', '')}")

        return " ".join(parts[:3]) + ("\n" + "\n".join(parts[3:]) if len(parts) > 3 else "")

    @staticmethod
    def _get_tool_detail(tool_name: str) -> str:
        """Get detailed tool signature for step context."""
        loader = BiomniToolLoader.get_instance()
        if not loader.is_initialized():
            return ""
        for t in loader.get_all_tools():
            if t.get("name") == tool_name:
                module = t.get("module", "")
                params = ", ".join(
                    f"{p.get('name', '?')}: {p.get('type', 'Any')}"
                    for p in t.get("required_parameters", [])
                )
                desc = t.get("description", "")
                if len(desc) > 300:
                    desc = desc[:297] + "..."
                return f"{module}.{tool_name}({params}): {desc}"
        return ""

    def _build_ref_context(self, step: dict) -> str:
        """Build reference data context from step."""
        ref_data = step.get("reference_data") or step.get("references")
        if not ref_data:
            return ""
        if isinstance(ref_data, str):
            return f"\n[Reference Data]\n{ref_data}"
        if isinstance(ref_data, list):
            items = []
            for ref in ref_data:
                if isinstance(ref, dict):
                    items.append(f"- {ref.get('name', 'Unknown')}: {ref.get('description', '')}")
                else:
                    items.append(f"- {ref}")
            return "\n[Reference Data]\n" + "\n".join(items)
        return ""

    @staticmethod
    def _collect_file_refs(step: dict) -> List[str]:
        """Extract file paths from step reference data."""
        refs = []
        ref_data = step.get("reference_data") or step.get("references") or []
        if isinstance(ref_data, list):
            for ref in ref_data:
                if isinstance(ref, dict) and ref.get("path"):
                    refs.append(ref["path"])
                elif isinstance(ref, str) and ("/" in ref or "\\" in ref):
                    refs.append(ref)
        return refs

    async def _save_plan_complete(
        self, conv_id: str, conv_svc: ConversationService, stopped: bool = False
    ) -> dict:
        """Build and save PLAN_COMPLETE data to DB."""
        plan_state = self._plan_states.get(conv_id, {})
        # Extract codes from all_results for persistence
        codes = {}
        for r in plan_state.get("all_results", []):
            res = r.get("result", {})
            if isinstance(res, dict) and res.get("code"):
                sidx = r.get("step", 1) - 1
                code_entry = {
                    "code": res["code"],
                    "language": res.get("language", "python"),
                    "execution": res.get("execution"),
                    "fixAttempts": res.get("fix_attempts", 0),
                    "stepIndex": sidx,
                }
                if res.get("segments"):
                    code_entry["segments"] = res["segments"]
                codes[str(sidx)] = code_entry
        # Build retrieval result from plan_state (persists across restart)
        retrieval = None
        if plan_state.get("_retrieved_tool_names"):
            retrieval = {
                "tools": plan_state.get("_retrieved_tool_names", []),
                "dataLake": plan_state.get("_retrieved_data_lake_names", []),
                "libraries": plan_state.get("_retrieved_library_names", []),
            }
        plan_complete_data = {
            "goal": plan_state.get("goal", ""),
            "steps": plan_state.get("steps", []),
            "results": plan_state.get("all_results", []),
            "codes": codes,
            "retrievalResult": retrieval,
        }
        if stopped:
            plan_complete_data["stopped"] = True

        plan_json = json.dumps(plan_complete_data, ensure_ascii=False, default=str)
        await conv_svc.replace_last_plan_message(
            UUID(conv_id), f"[PLAN_COMPLETE]{plan_json}"
        )
        return plan_complete_data

    async def _run_plan_analysis(self, plan_state: dict, db) -> str:
        """Run analysis LLM on completed plan. Returns analysis markdown."""
        from routers.plan import ANALYZE_PLAN_SYSTEM_PROMPT

        goal = plan_state.get("goal", "")
        steps = plan_state.get("steps", [])
        all_results = plan_state.get("all_results", [])

        # Build step info
        steps_info = []
        for i, step in enumerate(steps):
            name = step.get("name", "Unknown")
            tool = step.get("tool", "unknown")
            desc = step.get("description", "")
            result = all_results[i] if i < len(all_results) else None

            step_info = f"Step {i+1}: {name} ({tool}) [✓ Completed]"
            step_info += f"\n  Description: {desc}"
            if result and isinstance(result, dict):
                res = result.get("result", {})
                if isinstance(res, dict):
                    if res.get("solution"):
                        step_info += f"\n  Result: {str(res['solution'])[:300]}"
                    elif res.get("reasoning"):
                        step_info += f"\n  Result: {str(res['reasoning'])[:300]}"
            steps_info.append(step_info)

        prompt = (
            f"Research Goal: {goal}\n\n"
            f"Research Steps:\n" + "\n".join(steps_info) +
            "\n\nPlease provide a detailed analysis and explanation of the above "
            "research plan. Include the purpose, method, and expected results of "
            "each step, and explain the overall research direction."
        )

        llm_service = get_llm_service()
        llm = await llm_service.get_llm_instance(db=db)
        messages = [
            SystemMessage(content=ANALYZE_PLAN_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]
        response = await llm.ainvoke(messages)
        return response.content if response.content else ""

    # ─── Main Chat Handler ───

    async def handle_chat(self, request: ChatRequest, db) -> AsyncGenerator[ChatEvent, None]:
        """메인 채팅 핸들러.

        Plan 모드 첫 턴: Phase A (별도 LLM으로 plan 생성) → Phase B (step 순차 실행)
        그 외: A1 LangGraph astream_events 스트리밍
        """
        conv_svc = ConversationService(db)
        conv_id = request.conv_id or str((await conv_svc.create_conversation(first_message=request.message)).id)
        self._stop_flags[conv_id] = False

        try:
            # 1. DB에 유저 메시지 저장
            await conv_svc.add_message(UUID(conv_id), "user", request.message)

            # 2. DB에서 전체 히스토리 로드
            history_msgs = await conv_svc.get_messages(UUID(conv_id))
            lc_history = []
            for msg in history_msgs:
                if msg.role == "user":
                    lc_history.append(HumanMessage(content=msg.content))
                elif msg.role == "assistant":
                    lc_history.append(AIMessage(content=msg.content))

            is_first_turn = len(lc_history) == 1

            # ── Phase A: Plan 모드 첫 턴 → 별도 LLM 호출로 plan 생성 ──
            if request.mode == "plan" and is_first_turn:
                llm_service = get_llm_service()
                behavior = await llm_service.resolve_model_behavior(db=db)

                async for event in self._create_plan(conv_id, request.message, behavior, db):
                    yield event
                    if event.type == "error":
                        return

                # Reload history from DB to include plan response (saved during _create_plan)
                # This matches Biomni's pattern where state["messages"] includes plan output
                history_msgs = await conv_svc.get_messages(UUID(conv_id))
                lc_history = []
                for msg in history_msgs:
                    if msg.role == "user":
                        lc_history.append(HumanMessage(content=msg.content))
                    elif msg.role == "assistant":
                        lc_history.append(AIMessage(content=msg.content))

                # Phase B: step 순차 실행
                try:
                    async for event in self._run_step_loop(conv_id, lc_history, behavior, db):
                        yield event
                except Exception as loop_err:
                    logger.exception("Step loop error")
                    # Save partial results so they survive conversation reload
                    if conv_id in self._plan_states:
                        conv_svc = ConversationService(db)
                        await self._save_plan_complete(conv_id, conv_svc, stopped=True)
                    yield _ev("error", {"error": f"Step loop error: {loop_err}"})
                return

            # ── Rerun: 프론트엔드에서 graph 수정 후 재실행 ──
            if request.rerun and request.rerun_steps:
                llm_service = get_llm_service()
                behavior = await llm_service.resolve_model_behavior(db=db)
                self._plan_states[conv_id] = {
                    "steps": request.rerun_steps,
                    "goal": request.rerun_goal or "",
                    "current_step": 0,
                    "all_results": [],
                }
                try:
                    async for event in self._run_step_loop(conv_id, lc_history, behavior, db):
                        yield event
                except Exception as loop_err:
                    logger.exception("Rerun step loop error")
                    if conv_id in self._plan_states:
                        conv_svc_rerun = ConversationService(db)
                        await self._save_plan_complete(conv_id, conv_svc_rerun, stopped=True)
                    yield _ev("error", {"error": f"Rerun step loop error: {loop_err}"})
                return

            # ── A1 LangGraph 스트리밍 (Agent 모드 or Plan 이후 턴) ──
            agent = await self._get_agent(conv_id, db)
            full_response = ""

            # 3. LangGraph 실행 입력 (원본 A1의 StateGraph를 그대로 탑니다)
            inputs = {"messages": lc_history, "next_step": None}
            config = {"recursion_limit": 500, "configurable": {"thread_id": conv_id}}

            # 4. LangChain v2 astream_events를 이용한 심층 스트리밍
            async for event in agent.app.astream_events(inputs, version="v2", config=config):
                if self._stop_flags.get(conv_id):
                    yield _ev("done", {"done": True, "stopped": True})
                    break

                kind = event["event"]

                # 💬 LLM이 토큰을 내뱉을 때
                if kind == "on_chat_model_stream":
                    content = event["data"]["chunk"].content
                    chunk_text = ""

                    if isinstance(content, str):
                        chunk_text = content
                    elif isinstance(content, list):
                        chunk_text = "".join(b.get("text", "") for b in content if isinstance(b, dict))

                    if chunk_text:
                        full_response += chunk_text
                        yield _ev("token", {"token": chunk_text})

                # 🚀 execute 노드 시작 → 프론트엔드에 "실행 중..." 표시
                elif kind == "on_chain_start" and event.get("name") == "execute":
                    yield _ev("tool_call", {
                        "tool_call": {"name": "code_execution", "status": "running"}
                    })

                # 🏁 특정 노드가 실행을 마쳤을 때의 상태(State) 후처리
                elif kind == "on_chain_end":
                    node_name = event["name"]

                    if node_name == "execute":
                        output = event["data"].get("output", {})
                        if output and "messages" in output:
                            last_msg = output["messages"][-1].content
                            if "<observation>" in last_msg:
                                formatted_obs = f"\n{last_msg}\n"
                                full_response += formatted_obs
                                yield _ev("token", {"token": formatted_obs})
                                logger.info(f"Execute observation captured: {len(last_msg)} chars")
                        yield _ev("tool_call", {
                            "tool_call": {"name": "code_execution", "status": "completed"}
                        })

            # 5. 최종 응답 DB 저장
            if full_response.strip():
                await conv_svc.add_message(UUID(conv_id), "assistant", full_response.strip())

            yield _ev("done", {"done": True})

        except Exception as e:
            logger.exception("Chat Handler Error")
            yield _ev("error", {"error": str(e)})
        finally:
            self._stop_flags.pop(conv_id, None)

    async def handle_step_question(self, request: StepQuestionRequest, db) -> AsyncGenerator[ChatEvent, None]:
        chat_req = ChatRequest(conv_id=request.conv_id, message=f"Question regarding current step: {request.question}")
        async for event in self.handle_chat(chat_req, db):
            yield event

    async def handle_retry_step(self, request: RetryStepRequest, db) -> AsyncGenerator[ChatEvent, None]:
        prompt = f"Please retry step {request.step_num}. Additional instruction: {request.user_edit}"
        chat_req = ChatRequest(conv_id=request.conv_id, message=prompt)
        async for event in self.handle_chat(chat_req, db):
            yield event
