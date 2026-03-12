"""LLM output parsing — tool call and execute block detection/extraction.

Supports two model types:
  - Tool call models (tool_calls_format set):  [TOOL_CALLS]name[ARGS]{...}
  - Execute models (tool_calls_format null):   <execute>code</execute>, <solution>...</solution>

Uses token_format dict (from LLMService.resolve_model_behavior()) to pick
the right parser based on model type.
"""

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger("aigen.tool_parser")


@dataclass
class ParsedToolCall:
    """A single parsed tool call."""

    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class ExecuteBlock:
    """A parsed <execute> code block."""

    code: str
    language: str  # "python", "r", "bash"


@dataclass
class ParseResult:
    """Result of parsing LLM output for tool calls or execute blocks."""

    remaining_text: str
    tool_calls: List[ParsedToolCall] = field(default_factory=list)
    execute_blocks: List[ExecuteBlock] = field(default_factory=list)
    has_solution: bool = False
    solution_text: str = ""


# ═══════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════


def parse_tool_calls(
    text: str, token_format: Optional[Dict[str, Any]] = None
) -> ParseResult:
    """Parse tool calls from LLM output.

    Priority:
    1. If token_format has tool_calls_format containing "[TOOL_CALLS]",
       try Mistral format first.
    2. Fall back to legacy formats (<tool_call>, [TOOL:], JSON blocks).

    Args:
        text: LLM output text.
        token_format: Model's token format dict from model_registry.yaml.

    Returns:
        ParseResult with remaining text and extracted tool calls.
    """
    # Determine if Mistral format should be tried first
    tcf = (token_format or {}).get("tool_calls_format", "") or ""
    if "[TOOL_CALLS]" in tcf or "[TOOL_CALLS]" in text:
        result = _parse_mistral_format(text)
        if result.tool_calls:
            return result

    return _parse_legacy_formats(text)


def detect_tool_call(
    text: str, token_format: Optional[Dict[str, Any]] = None
) -> bool:
    """Quick check: does text contain any tool call?"""
    tcf = (token_format or {}).get("tool_calls_format", "") or ""
    if "[TOOL_CALLS]" in tcf or "[TOOL_CALLS]" in text:
        if "[TOOL_CALLS]" in text and (
            "[ARGS]" in text or re.search(r"\[TOOL_CALLS\]\w+\{", text)
        ):
            return True

    return (
        "<tool_call>" in text
        or "[TOOL:" in text
        or '"tool_calls"' in text
    )


def parse_execute_blocks(
    text: str, token_format: Optional[Dict[str, Any]] = None
) -> ParseResult:
    """Parse <execute>...</execute> and <solution>...</solution> blocks.

    Uses model-specific tokens from token_format (code_execute_format, solution_format).
    Detects language via #!R and #!BASH markers in code.
    """
    tf = token_format or {}
    exec_open = tf.get("code_execute_format", "<execute>")
    exec_close = _closing_tag(exec_open)
    sol_fmt = tf.get("solution_format")

    execute_blocks: List[ExecuteBlock] = []
    remaining = text

    # Parse execute blocks
    exec_pattern = re.compile(
        re.escape(exec_open) + r"(.*?)" + re.escape(exec_close),
        re.DOTALL,
    )
    for match in exec_pattern.finditer(text):
        code = match.group(1).strip()
        lang = "python"
        if code.startswith("#!R"):
            lang = "r"
            code = code[3:].strip()
        elif code.startswith("#!BASH"):
            lang = "bash"
            code = code[6:].strip()
        execute_blocks.append(ExecuteBlock(code=code, language=lang))

    remaining = exec_pattern.sub("", remaining)

    # Check for solution
    has_solution = False
    solution_text = ""
    if sol_fmt:
        sol_close = _closing_tag(sol_fmt)
        sol_pattern = re.compile(
            re.escape(sol_fmt) + r"(.*?)" + re.escape(sol_close),
            re.DOTALL,
        )
        sol_match = sol_pattern.search(text)
        if sol_match:
            has_solution = True
            solution_text = sol_match.group(1).strip()
            remaining = sol_pattern.sub("", remaining)

    return ParseResult(
        remaining_text=remaining.strip(),
        execute_blocks=execute_blocks,
        has_solution=has_solution,
        solution_text=solution_text,
    )


def parse_step_output(
    text: str, token_format: Optional[Dict[str, Any]] = None
) -> ParseResult:
    """Parse step LLM output based on model type.

    - Tool call models (tool_calls_format set): parse for [TOOL_CALLS]
    - Execute models (tool_calls_format null): parse for <execute>/<solution>

    Does NOT try both — model type determines the parser.
    """
    if (token_format or {}).get("tool_calls_format"):
        return parse_tool_calls(text, token_format)
    else:
        return parse_execute_blocks(text, token_format)


def format_tool_result_for_model(
    tool_name: str,
    result: Dict[str, Any],
    token_format: Optional[Dict[str, Any]] = None,
) -> str:
    """Format tool result string for LLM context injection.

    Uses token_format["tool_result_format"] to pick wrapping tags:
      - "[TOOL_RESULTS]":  [TOOL_RESULTS]...[/TOOL_RESULTS]
      - "<observation>":   <observation>...</observation>
      - else:              plain text
    """
    trf = (token_format or {}).get("tool_result_format", "") or ""
    content = _result_to_content_string(tool_name, result)

    if "[TOOL_RESULTS]" in trf:
        return f"[TOOL_RESULTS]{content}[/TOOL_RESULTS]"
    elif "<observation>" in trf:
        return f"<observation>{content}</observation>"
    else:
        return content


# ═══════════════════════════════════════════
# Token helpers
# ═══════════════════════════════════════════


def _closing_tag(open_tag: str) -> str:
    """Derive closing tag: '<execute>' → '</execute>', '[EXECUTE]' → '[/EXECUTE]'."""
    if not open_tag:
        return ""
    if open_tag.startswith("["):
        return open_tag.replace("[", "[/", 1)
    elif open_tag.startswith("<"):
        return open_tag.replace("<", "</", 1)
    return open_tag


# ═══════════════════════════════════════════
# Internal parsers
# ═══════════════════════════════════════════

# Mistral/Ministral format patterns
# [\w.]+ to support dotted names like biomni.tool.literature.query_pubmed
_MISTRAL_PATTERN_WITH_ARGS = re.compile(
    r"\[TOOL_CALLS\]([\w.]+)\[ARGS\](\{.*?\})(?=\[TOOL_CALLS\]|$|\s*$)",
    re.DOTALL,
)
_MISTRAL_PATTERN_NO_ARGS = re.compile(
    r"\[TOOL_CALLS\]([\w.]+)(\{.*?\})(?=\[TOOL_CALLS\]|$|\s*$)",
    re.DOTALL,
)
# Biomni tool pattern: [TOOL_CALLS]biomni.tool.module.func {json} (space separated)
_BIOMNI_TOOL_PATTERN = re.compile(
    r"\[TOOL_CALLS\](biomni\.tool\.[\w.]+)\s+(\{.*?\})(?=\[TOOL_CALLS\]|$|\s*$)",
    re.DOTALL,
)


def _parse_mistral_format(text: str) -> ParseResult:
    """Parse [TOOL_CALLS]name[ARGS]{...} format.

    Also handles Biomni tool calls like:
      [TOOL_CALLS]biomni.tool.literature.query_pubmed {"query": "..."}
    These are auto-converted to code_gen calls with executable Python code.
    """
    tool_calls: List[ParsedToolCall] = []
    remaining = text

    # Try with [ARGS] first
    matches = _MISTRAL_PATTERN_WITH_ARGS.findall(text)
    pattern = _MISTRAL_PATTERN_WITH_ARGS

    if not matches:
        # Try Biomni space-separated pattern before no-args
        matches = _BIOMNI_TOOL_PATTERN.findall(text)
        pattern = _BIOMNI_TOOL_PATTERN

    if not matches:
        matches = _MISTRAL_PATTERN_NO_ARGS.findall(text)
        pattern = _MISTRAL_PATTERN_NO_ARGS

    for name, args_str in matches:
        try:
            arguments = json.loads(args_str)
        except json.JSONDecodeError:
            arguments = {"raw": args_str}

        tool_calls.append(
            ParsedToolCall(
                id=f"call_{len(tool_calls)}", name=name, arguments=arguments
            )
        )

    remaining = pattern.sub("", remaining).strip()
    return ParseResult(remaining_text=remaining, tool_calls=tool_calls)



def _parse_legacy_formats(text: str) -> ParseResult:
    """Parse <tool_call>, [TOOL:], and JSON block formats."""
    tool_calls: List[ParsedToolCall] = []
    remaining = text

    # Pattern 1: ```json { "tool_calls": [...] } ```
    json_block_pat = r"```json\s*(\{[\s\S]*?\"tool_calls\"[\s\S]*?\})\s*```"
    for match in re.findall(json_block_pat, text):
        try:
            data = json.loads(match)
            if "tool_calls" in data:
                for call in data["tool_calls"]:
                    func = call.get("function", {})
                    raw_args = func.get("arguments", call.get("arguments", {}))
                    if isinstance(raw_args, str):
                        raw_args = json.loads(raw_args)
                    tool_calls.append(
                        ParsedToolCall(
                            id=call.get("id", f"call_{len(tool_calls)}"),
                            name=func.get("name", call.get("name", "")),
                            arguments=raw_args,
                        )
                    )
            remaining = remaining.replace(f"```json{match}```", "")
        except json.JSONDecodeError:
            pass

    # Pattern 2: <tool_call>{...}</tool_call>
    tool_call_pat = r"<tool_call>\s*(\{[\s\S]*?\})\s*</tool_call>"
    for match in re.findall(tool_call_pat, text):
        try:
            data = json.loads(match)
            tool_calls.append(
                ParsedToolCall(
                    id=data.get("id", f"call_{len(tool_calls)}"),
                    name=data.get("name", ""),
                    arguments=data.get("arguments", {}),
                )
            )
            remaining = remaining.replace(f"<tool_call>{match}</tool_call>", "")
        except json.JSONDecodeError:
            pass

    # Pattern 3: [TOOL: name] { arguments }
    simple_pat = r"\[TOOL:\s*(\w+)\]\s*(\{[\s\S]*?\})"
    for name, args_str in re.findall(simple_pat, text):
        try:
            arguments = json.loads(args_str)
            tool_calls.append(
                ParsedToolCall(
                    id=f"call_{len(tool_calls)}",
                    name=name,
                    arguments=arguments,
                )
            )
            remaining = re.sub(
                rf"\[TOOL:\s*{name}\]\s*{re.escape(args_str)}", "", remaining
            )
        except json.JSONDecodeError:
            pass

    # Pattern 4: Bare tool name + JSON — e.g. create_plan{"goal":...} or <start>create_plan{...}
    # Small models often output this instead of proper [TOOL_CALLS] format
    if not tool_calls:
        bare_pat = r"(?:<[^>]*>)?\s*(\w+)\s*(\{[\s\S]*\})"
        for m in re.finditer(bare_pat, text):
            name_candidate = m.group(1)
            # Only accept known tool names to avoid false positives
            if name_candidate in (
                "create_plan", "code_gen",
                "pubmed_search", "ncbi_gene",
                "crispr_designer", "protocol_builder",
            ):
                try:
                    args_str = m.group(2)
                    # Find matching brace end
                    depth = 0
                    end = -1
                    for i, c in enumerate(args_str):
                        if c == "{":
                            depth += 1
                        elif c == "}":
                            depth -= 1
                        if depth == 0:
                            end = i
                            break
                    if end > 0:
                        arguments = json.loads(args_str[: end + 1])
                        tool_calls.append(
                            ParsedToolCall(
                                id=f"call_{len(tool_calls)}",
                                name=name_candidate,
                                arguments=arguments,
                            )
                        )
                except (json.JSONDecodeError, IndexError):
                    pass

    return ParseResult(remaining_text=remaining.strip(), tool_calls=tool_calls)


# ═══════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════


def _result_to_content_string(tool_name: str, result: Dict[str, Any]) -> str:
    """Convert tool result dict to a human-readable string."""
    if not result.get("success", False):
        return f"[Tool Error] {result.get('error', 'Unknown error')}"

    inner = result.get("result", {})
    lines = [f"[Tool Result: {tool_name}]"]

    if result.get("thought"):
        lines.append(f"Thought: {result['thought']}")
    if result.get("action"):
        lines.append(f"Action: {result['action']}")

    if isinstance(inner, dict):
        if inner.get("title"):
            lines.append(f"Result: {inner['title']}")
        if inner.get("details"):
            for detail in inner["details"]:
                lines.append(f"  • {detail}")
        if inner.get("stdout"):
            lines.append(f"Output:\n{inner['stdout']}")
        if inner.get("figures"):
            lines.append(f"Figures: {', '.join(inner['figures'])}")
        if inner.get("tables"):
            lines.append(f"Tables: {', '.join(inner['tables'])}")
    else:
        lines.append(f"Result: {inner}")

    return "\n".join(lines)
