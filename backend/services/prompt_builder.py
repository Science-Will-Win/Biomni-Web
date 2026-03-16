"""Prompt builder — decomposes Biomni's monolithic _generate_system_prompt() into composable sections.

Biomni A1._generate_system_prompt() builds one giant prompt with everything mixed in.
Here we split it into labeled sections so each mode (full, plan, code_gen, tool_select)
can pick only the sections it needs.

Sections (from A1._generate_system_prompt):
  [A] ROLE        — "You are Aigen R0..." identity
  [B] PLAN        — plan checklist format, step tracking rules
  [C] CODE_EXEC   — execute/observation/solution tags, R/Bash markers, code quality rules
  [D] PROTOCOL    — protocol generation instructions
  [E] SELF_CRITIC — self-critic feedback handling
  [F] CUSTOM_RES  — custom tools/data/software/know-how (dynamic)
  [G] ENV_RES     — function dictionary, data lake, software library (dynamic)

Mode → Sections mapping:
  full        (step execution)  : A + B + C + D + E + F + G
  plan        (plan generation) : A + B + G(subset)
  code_gen    (code generation) : A + C + G
  analyze     (plan analysis)   : standalone (Korean)

Token parameterization:
  All special tokens (think, execute, observation, solution) are derived from
  the `token_format` dict (populated from model_registry.yaml via behavior).
  Defaults match biomni-r0-32b / cloud model format (<execute>, <think>, etc.).
"""

from enum import Enum
from typing import Any, Dict, List, Optional


class PromptMode(str, Enum):
    FULL = "full"              # Step execution: A + B + C + D + E + F + G
    AGENT = "agent"            # Direct chat (no plan): A + C + D + E + F + G
    PLAN = "plan"
    ANALYZE = "analyze"


# ═══════════════════════════════════════════
# Token helpers
# ═══════════════════════════════════════════

def _closing_tag(open_tag: str) -> str:
    """Derive closing tag from opening tag.

    Examples:
        <execute>  → </execute>
        [EXECUTE]  → [/EXECUTE]
        [THINK]    → [/THINK]
    """
    if not open_tag:
        return ""
    if open_tag.startswith("["):
        return open_tag.replace("[", "[/", 1)
    elif open_tag.startswith("<"):
        return open_tag.replace("<", "</", 1)
    return open_tag


# ═══════════════════════════════════════════
# Section builders (token-parameterized)
# ═══════════════════════════════════════════

# ─── Section [A]: Role ───

_ROLE_BASE = """\
You are Aigen R0, helpful biomedical assistant assigned with the task of problem-solving.
You follow these instructions in all languages, and always respond to the user in the language they use or request.
To achieve this, you will be using an interactive coding environment equipped with a variety of tool functions, data, and softwares to assist you throughout the process."""


def _build_role_section(token_format: Optional[Dict] = None) -> str:
    """Build SECTION_ROLE with optional think-tag support."""
    tf = token_format or {}
    think_fmt = tf.get("think_format")

    if think_fmt:
        think_close = _closing_tag(think_fmt)
        return _ROLE_BASE + f"""

You may use {think_fmt}...{think_close} to reason step by step before responding. After thinking, provide your response."""
    return _ROLE_BASE


# Keep legacy constant for backward compatibility (settings API, etc.)
SECTION_ROLE = _ROLE_BASE


# ─── Section [B]: Plan rules ───

def _build_plan_section(token_format: Optional[Dict] = None) -> str:
    """Build SECTION_PLAN with model-specific solution tag reference."""
    tf = token_format or {}
    sol_fmt = tf.get("solution_format")
    if sol_fmt:
        sol_close = _closing_tag(sol_fmt)
        sol_warning = f"Do NOT use {sol_fmt} for individual steps — {sol_fmt}...{sol_close} is only for the final answer after ALL steps are complete."
    else:
        sol_warning = "Do NOT provide a final answer for individual steps — only provide the overall answer after ALL steps are complete."

    return f"""
Given a task, make a plan first. The plan should be a numbered list of steps that you will take to solve the task. Be specific and detailed.
Format your plan as a checklist with empty checkboxes like this:
1. [ ] First step
2. [ ] Second step
3. [ ] Third step

Follow the plan step by step. After completing each step, update the checklist by replacing the empty checkbox with a checkmark:
1. [✓] First step (completed)
2. [ ] Second step
3. [ ] Third step

IMPORTANT: When you finish executing a step, you MUST mark it as [✓] in the checklist to signal step completion. {sol_warning}

If a step fails or needs modification, mark it with an X and explain why:
1. [✓] First step (completed)
2. [✗] Second step (failed because...)
3. [ ] Modified second step
4. [ ] Third step

Always show the updated plan after each step so the user can track progress.

At each turn, you should first provide your thinking and reasoning given the conversation history.

IMPORTANT: DO NOT repeat the same words, phrases, or sentences. Each sentence must add new information. If you find yourself repeating, stop and move to the next point."""


# Legacy constant (backward compat — uses default <solution> format)
SECTION_PLAN = _build_plan_section()


# ─── Section [B2]: Plan creation system prompt (structured output) ───
# Forces LLM to output [TOOL_CALLS]create_plan[ARGS]{JSON} directly.
# Ported from original prompts/PLAN_SYSTEM_PROMPT.txt


# ─── Section [C]: Code execution rules ───

def _build_code_exec_section(token_format: Optional[Dict] = None) -> str:
    """Build SECTION_CODE_EXEC with model-specific tokens."""
    tf = token_format or {}
    exec_open = tf.get("code_execute_format", "<execute>")
    exec_close = _closing_tag(exec_open)
    obs_open = tf.get("code_result_format", "<observation>")
    obs_close = _closing_tag(obs_open)
    sol_fmt = tf.get("solution_format")  # None if model doesn't support solution tags

    # Build solution option if the model supports it
    sol_section = ""
    sol_tag_ref = ""
    if sol_fmt:
        sol_close = _closing_tag(sol_fmt)
        sol_section = f"""
2) When you think it is ready, directly provide a solution that adheres to the required format for the given task to the user. Your solution should be enclosed using "{sol_fmt}" tag, for example: The answer is {sol_fmt} A {sol_close}. IMPORTANT: You must end the solution block with {sol_close} tag."""
        sol_tag_ref = f" or {sol_fmt}"

    options_text = "two options" if sol_fmt else "one option"

    return f"""
After that, you have {options_text}:

1) Interact with a programming environment and receive the corresponding output within {obs_open}{obs_close}. Your code should be enclosed using "{exec_open}" tag, for example: {exec_open} print("Hello World!") {exec_close}. IMPORTANT: You must end the code block with {exec_close} tag.
   - For Python code (default): {exec_open} print("Hello World!") {exec_close}
   - For R code: {exec_open} #!R\\nlibrary(ggplot2)\\nprint("Hello from R") {exec_close}
   - For Bash scripts and commands: {exec_open} #!BASH\\necho "Hello from Bash"\\nls -la {exec_close}
   - For CLI softwares, use Bash scripts.
{sol_section}

You have many chances to interact with the environment to receive the observation. So you can decompose your code into multiple steps.
Don't overcomplicate the code. Keep it simple and easy to understand.
When writing the code, please print out the steps and results in a clear and concise manner, like a research log.
When calling the existing python functions in the function dictionary, YOU MUST SAVE THE OUTPUT and PRINT OUT the result.
For example, result = understand_scRNA(XXX) print(result)
Otherwise the system will not be able to know what has been done.

For R code, use the #!R marker at the beginning of your code block to indicate it's R code.
For Bash scripts and commands, use the #!BASH marker in your execute block for both simple commands and multi-line scripts with variables, loops, conditionals, loops, and other Bash features.

In each response, you must include {exec_open}...{exec_close} to run code.
When you have completed ALL code execution for the current step, mark it as [✓] in the checklist instead of using {exec_open}.
{"For the FINAL step only, use " + sol_fmt + "..." + sol_close + " to provide the overall answer." if sol_fmt else ""}
Do not respond with empty messages.

CRITICAL: Every response MUST use {exec_open}...{exec_close} to execute code. Only use [✓] to mark a step complete AFTER all code execution is done. Do NOT skip code execution by marking [✓] directly. Do NOT write code as plain text or in markdown code blocks. ALWAYS wrap executable code inside {exec_open}...{exec_close} tags.

CRITICAL: The {exec_open}...{exec_close} block must contain ONLY executable code. Do NOT include explanations, reasoning, or commentary inside the code block. Write your reasoning BEFORE the {exec_open} tag, then put ONLY the code inside.

WRONG (reasoning mixed with code):
{exec_open}
Alright, I need to research gene functions. Let me import the module first.
from biomni.genomics import get_gene_info
result = get_gene_info("ATXN2")
print(result)
{exec_close}

CORRECT (reasoning before, only code inside):
I need to research gene functions using the genomics module.
{exec_open}
from biomni.genomics import get_gene_info
result = get_gene_info("ATXN2")
print(result)
{exec_close}

WRONG (checklist inside code block — causes syntax error):
{exec_open}
result = analyze_data()
print(result)
1. [✓] Analysis complete
{exec_close}

CORRECT (checklist AFTER code block, not inside):
{exec_open}
result = analyze_data()
print(result)
{exec_close}
1. [✓] Analysis complete"""



# ─── Section [D]: Protocol generation ───

SECTION_PROTOCOL = """
PROTOCOL GENERATION:
If the user requests an experimental protocol, use search_protocols(), advanced_web_search_claude(), list_local_protocols(), and read_local_protocol() to generate an accurate protocol. Include details such as reagents (with catalog numbers if available), equipment specifications, replicate requirements, error handling, and troubleshooting - but ONLY include information found in these resources. Do not make up specifications, catalog numbers, or equipment details. Prioritize accuracy over completeness."""


# ─── Section [E]: Self-critic ───

SECTION_SELF_CRITIC = """
You may or may not receive feedbacks from human. If so, address the feedbacks by following the same procedure of multiple rounds of thinking, execution, and then coming up with a new solution."""



# ─── Section: Plan-only creation rules (structured tool call output) ───

def _build_plan_creation_section(token_format: Optional[Dict] = None) -> str:
    """Build plan creation prompt with checklist format and model-specific think tags."""
    tf = token_format or {}
    think_fmt = tf.get("think_format", "<think>")
    think_close = _closing_tag(think_fmt)

    return f"""You are Aigen R0, helpful biomedical assistant assigned with the task of problem-solving.
You follow these instructions in all languages, and always respond to the user in the language they use or request.
To achieve this, you will be using an interactive coding environment equipped with a variety of tool functions, data, and softwares to assist you throughout the process.

You MUST use {think_fmt}...{think_close} to reason step by step before creating your plan. Think carefully about the task, then provide your plan.

# RULES

- Start with a Goal line, then list numbered steps with empty checkboxes
- Goal: A concise noun phrase describing the overall objective
- Each step MUST have a SHORT NAME (3-5 words) followed by a COLON, then a detailed description
- The colon (:) separator between name and description is MANDATORY
- Step names MUST be short noun phrases (3-5 words ONLY), NOT full sentences
- NEVER write the entire description as the step name
- Your plan MUST include at least 4 steps
- Each step MUST perform a DISTINCT task — do NOT create steps that overlap or repeat similar work
- Before finalizing, check that no two steps cover the same activity (e.g., do not have both "literature review" and "gene function research" as separate steps if they do the same thing)
- Write the goal and step names/descriptions in the user's language

# FORMAT

Goal: [concise noun phrase describing the overall objective]

1. [ ] Data collection: Gather relevant datasets from public databases and repositories for analysis
2. [ ] Gene function analysis: Research the biological functions of each gene in relation to the target pathway
3. [ ] Statistical modeling: Apply statistical methods to identify significant patterns in the data
4. [ ] Results visualization: Create figures and plots to present the findings clearly

WRONG (DO NOT do this - missing colon separator, name too long):
1. [ ] Research the biological functions of each gene in relation to red blood cell development

CORRECT (short name + colon + description):
1. [ ] Gene function research: Research the biological functions of each gene in relation to red blood cell development

# IMPORTANT

After your {think_fmt} block, output ONLY the plan in the exact format above.
Each step MUST be: "number. [ ] Short Name: Detailed description"
Do not include any additional explanation, rationale, or commentary outside the plan."""


# Legacy constant (regenerated with default think tags)
SECTION_PLAN_CREATION = _build_plan_creation_section()


# ─── Section: Analyze plan ───

SECTION_ANALYZE = """\
당신은 연구 계획 분석 전문가입니다.
주어진 연구 목표와 각 단계에 대해 자세하고 명확한 설명을 제공하세요.

분석 시 고려사항:
- 각 단계의 목적과 중요성을 설명
- 완료된 단계는 실제 결과를 포함
- 진행 중인 단계는 현재 상태 설명
- 대기 중인 단계는 예상 결과와 방법론 설명
- 전체적인 연구 흐름과 방향성 제시

출력 형식 (마크다운):

## 연구 목표
(목표에 대한 배경과 중요성 설명 - 2-3문장)

## 전체 연구 흐름

### Step N: step_name (tool_name) [상태]
(이 단계의 목적, 방법, 기대 결과)
- 완료된 경우: 실제 결과 요약
- 진행 중: 현재 수행 중인 작업
- 대기: 예상 방법론

## 예상 결과 및 활용
(최종 결과물과 활용 방안 - 2-3문장)"""


# ─── Section [F]: Custom resources (dynamic) ───

def _build_custom_resources_section(
    custom_tools: Optional[List[str]] = None,
    custom_data: Optional[List[str]] = None,
    custom_software: Optional[List[str]] = None,
    know_how_docs: Optional[List[str]] = None,
) -> str:
    """Build the custom resources section if any custom resources are provided."""
    parts = []

    if not any([custom_tools, custom_data, custom_software, know_how_docs]):
        return ""

    parts.append("""
PRIORITY CUSTOM RESOURCES
===============================
IMPORTANT: The following custom resources have been specifically added for your use.
    PRIORITIZE using these resources as they are directly relevant to your task.
    Always consider these FIRST and in the meantime using default resources.
""")

    if know_how_docs:
        docs_text = "\n\n".join(know_how_docs)
        parts.append(f"""
📚 KNOW-HOW DOCUMENTS (BEST PRACTICES & PROTOCOLS - ALREADY LOADED):
{docs_text}

IMPORTANT: These documents are ALREADY AVAILABLE in your context. You do NOT need to
retrieve them or "review" them as a separate step. You can DIRECTLY reference and use
the information from these documents to answer questions, provide protocols, suggest
parameters, and offer troubleshooting guidance.
""")

    if custom_tools:
        parts.append(f"""
🔧 CUSTOM TOOLS (USE THESE FIRST):
{chr(10).join(custom_tools)}
""")

    if custom_data:
        parts.append(f"""
📊 CUSTOM DATA (PRIORITIZE THESE DATASETS):
{chr(10).join(custom_data)}
""")

    if custom_software:
        parts.append(f"""
⚙️ CUSTOM SOFTWARE (USE THESE LIBRARIES):
{chr(10).join(custom_software)}
""")

    parts.append("===============================\n")
    return "".join(parts)


# ─── Section [G]: Environment resources (dynamic) ───

def _build_env_resources_section(
    tool_desc: str = "",
    data_lake_path: str = "",
    data_lake_content: str = "",
    library_content: str = "",
    is_retrieval: bool = False,
) -> str:
    """Build the environment resources section with dynamic content."""
    if is_retrieval:
        function_intro = "Based on your query, I've identified the following most relevant functions that you can use in your code:"
        data_lake_intro = "Based on your query, I've identified the following most relevant datasets:"
        library_intro = "Based on your query, I've identified the following most relevant libraries that you can use:"
        import_instruction = ("IMPORTANT: When using any function, you MUST first import it from its exact module as listed in the dictionary.\n"
                              "DO NOT import functions from 'biomni_data'. 'biomni_data' is a directory for datasets, not a python module.\n"
                              "For example: from [module_name] import [function_name]")
    else:
        function_intro = "In your code, you will need to import the function location using the following dictionary of functions:"
        data_lake_intro = "You can write code to understand the data, process and utilize it for the task. Here is the list of datasets:"
        library_intro = "The environment supports a list of libraries that can be directly used. Do not forget the import statement:"
        import_instruction = "IMPORTANT: DO NOT import functions from 'biomni_data'. It is a local directory, not a python module."

    parts = [f"""

Environment Resources:

- Function Dictionary:
{function_intro}
---
{tool_desc}
---

{import_instruction}
"""]

    if data_lake_content:
        parts.append(f"""
- Biological data lake
You can access a biological data lake at the following path: {data_lake_path}.
{data_lake_intro}
Each item is listed with its description to help you understand its contents.
----
{data_lake_content}
----
""")

    if library_content:
        parts.append(f"""
- Software Library:
{library_intro}
Each library is listed with its description to help you understand its functionality.
----
{library_content}
----
""")

    parts.append("""
- Note on using R packages and Bash scripts:
  - R packages: Use subprocess.run(['Rscript', '-e', 'your R code here']) in Python, or use the #!R marker in your execute block.
  - Bash scripts and commands: Use the #!BASH marker in your execute block for both simple commands and complex shell scripts with variables, loops, conditionals, etc.
""")
    return "".join(parts)


# ═══════════════════════════════════════════
# Compact prompt for small reasoning models
# ═══════════════════════════════════════════

def _build_compact_step_prompt(
    token_format: Optional[Dict] = None,
    tool_desc: str = "",
    data_lake_path: str = "",
) -> str:
    """Build a minimal system prompt for small reasoning models (3B/7B).

    These models get confused by long, complex prompts. This compact version
    keeps only the essential instructions:
    - Brief role
    - How to call code_gen (the only tool they need)
    - Available functions (from retrieval)
    - Anti-repetition rule
    """
    tf = token_format or {}
    think_fmt = tf.get("think_format", "")
    think_close = _closing_tag(think_fmt) if think_fmt else ""

    think_inst = ""
    if think_fmt:
        think_inst = f"Use {think_fmt}...{think_close} to think before responding.\n"

    functions_block = ""
    if tool_desc:
        functions_block = f"""
# AVAILABLE FUNCTIONS
Import these in your code_gen task description:
{tool_desc}
"""

    data_block = ""
    if data_lake_path:
        data_block = f"\nData lake path: {data_lake_path}\n"

    return f"""\
You are Aigen R0, a biomedical research assistant.
{think_inst}
# HOW TO RESPOND

Call code_gen to execute code for analysis. Format:
[TOOL_CALLS]code_gen[ARGS]{{"task": "detailed description of what to do", "language": "python"}}

Write a SPECIFIC task description including:
- What data to load or search for
- What analysis to perform
- What to print or visualize

If no code is needed, respond with a clear text answer.
{functions_block}{data_block}
# RULES
- DO NOT repeat words or phrases. Each sentence must add new information.
- Be concise and focused on the current step.
- When using biomni functions, specify the full import path (e.g., from biomni.tool.literature import query_pubmed).
"""


# ═══════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════

def build_prompt(
    mode: PromptMode,
    *,
    # Token format (from model_registry.yaml via resolve_model_behavior())
    token_format: Optional[Dict[str, Any]] = None,
    # Whether the model uses code_gen tool instead of native [EXECUTE] blocks
    use_code_gen: bool = False,
    # Compact mode for small reasoning models (3B, 7B) — shorter prompt
    compact: bool = False,
    # Dynamic content (from A1 instance at runtime)
    tool_desc: str = "",
    data_lake_path: str = "",
    data_lake_content: str = "",
    library_content: str = "",
    is_retrieval: bool = False,
    self_critic: bool = False,
    # Custom resources
    custom_tools: Optional[List[str]] = None,
    custom_data: Optional[List[str]] = None,
    custom_software: Optional[List[str]] = None,
    know_how_docs: Optional[List[str]] = None,
    # Code gen specific
    file_schemas: str = "",
    # Step execution — omit SECTION_PLAN to prevent model from creating a new plan
    is_step_execution: bool = False,
) -> str:
    """Build a system prompt for the given mode.

    Args:
        mode: Which prompt variant to build.
        token_format: Model-specific token format dict from resolve_model_behavior().
            Contains keys like think_format, code_execute_format, code_result_format,
            solution_format, tool_calls_format. Used to parameterize special tokens
            in the prompt sections. Defaults produce biomni-r0-32b / cloud format.
        tool_desc: Formatted tool descriptions from A1.module2api.
        data_lake_path: Path to data lake directory.
        data_lake_content: Formatted data lake items.
        library_content: Formatted library items.
        is_retrieval: Whether this is post-retrieval (affects intro text).
        self_critic: Whether to include self-critic instructions.
        custom_tools/data/software/know_how_docs: Custom resources.
        file_schemas: Pre-read file schemas (for code_gen mode).

    Returns:
        Complete system prompt string.
    """
    if mode == PromptMode.FULL:
        # Compact mode for small reasoning models — minimal prompt
        if compact and use_code_gen:
            return _build_compact_step_prompt(token_format, tool_desc, data_lake_path)

        # Full prompt = A + B + C + D + E(optional) + F + G  (step execution)
        # For use_code_gen models: replace Section [C] with code_gen guide
        parts = [
            _build_role_section(token_format),
        ]
        if not is_step_execution:
            parts.append(_build_plan_section(token_format))
        parts.append(_build_code_exec_section(token_format))
        parts.append(SECTION_PROTOCOL)
        if self_critic:
            parts.append(SECTION_SELF_CRITIC)
        parts.append(_build_custom_resources_section(custom_tools, custom_data, custom_software, know_how_docs))
        parts.append(_build_env_resources_section(tool_desc, data_lake_path, data_lake_content, library_content, is_retrieval))
        return "\n".join(parts)

    elif mode == PromptMode.AGENT:
        # Agent mode: use model's own system_prompt if available (e.g. SYSTEM_PROMPT.txt),
        # otherwise fall back to role section only.
        tf = token_format or {}
        model_prompt = tf.get("system_prompt")
        if model_prompt and model_prompt.strip():
            return model_prompt.strip()
        return _build_role_section(token_format)

    elif mode == PromptMode.PLAN:
        # Model-aware plan prompt with correct think token format
        return _build_plan_creation_section(token_format)

    elif mode == PromptMode.ANALYZE:
        # Analyze = standalone Korean prompt
        return SECTION_ANALYZE

    else:
        raise ValueError(f"Unknown prompt mode: {mode}")


def get_prompt_sections(
    mode: PromptMode,
    token_format: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, str]]:
    """Return labeled sections for a given mode (for the System Prompt Viewer).

    Each section is a dict with 'label' and 'content' keys.
    Dynamic sections (F, G) are shown as placeholders since they depend on runtime state.
    """
    sections: List[Dict[str, str]] = []

    if mode == PromptMode.FULL:
        sections.append({"label": "[A] Role", "content": _build_role_section(token_format)})
        sections.append({"label": "[B] Plan Rules", "content": SECTION_PLAN})
        sections.append({"label": "[C] Code Execution", "content": _build_code_exec_section(token_format)})
        sections.append({"label": "[D] Protocol Generation", "content": SECTION_PROTOCOL})
        sections.append({"label": "[E] Self-Critic", "content": SECTION_SELF_CRITIC})
        sections.append({"label": "[F] Custom Resources", "content": "(Dynamic — populated at runtime with custom tools, data, software, and know-how documents)"})
        sections.append({"label": "[G] Environment Resources", "content": "(Dynamic — populated at runtime with function dictionary, data lake, and software library)"})

    elif mode == PromptMode.AGENT:
        tf = token_format or {}
        model_prompt = tf.get("system_prompt")
        if model_prompt and model_prompt.strip():
            sections.append({"label": "Model System Prompt", "content": model_prompt.strip()})
        else:
            sections.append({"label": "[A] Role", "content": _build_role_section(token_format)})

    elif mode == PromptMode.PLAN:
        sections.append({"label": "Plan Creation (Structured Output)", "content": _build_plan_creation_section(token_format)})

    elif mode == PromptMode.ANALYZE:
        sections.append({"label": "Analyze (Korean)", "content": SECTION_ANALYZE})

    return sections
