"""Biomni framework tool loader — loads tool descriptions from biomni.utils.read_module2api().

Provides a singleton that caches the 224 Biomni tool descriptions at startup,
and formats selected tools for injection into the system prompt's Section [G].

Also provides training-format retrieval that matches the Phase 0 format from
data_formatting/output_formatted.json (the model was trained on this format).
"""

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, TypedDict

logger = logging.getLogger("aigen.biomni_tools")


class RetrievalResult(TypedDict):
    tools: List[Dict[str, Any]]
    data_lake: List[Dict[str, str]]
    libraries: List[Dict[str, str]]


def scan_data_lake(data_lake_path: str) -> List[Dict[str, str]]:
    """List top-level items in the data lake directory with schema info.

    Returns a list of {"name": ..., "description": ...} dicts.
    For CSV/TSV files, reads header row to provide column names.
    For directories, lists first few items.
    Returns empty list if directory doesn't exist.
    """
    if not data_lake_path:
        return []
    try:
        items = sorted(os.listdir(data_lake_path))
    except (OSError, FileNotFoundError):
        return []
    result = []
    for item in items:
        full_path = os.path.join(data_lake_path, item)
        desc = ""
        if os.path.isfile(full_path) and item.lower().endswith(('.csv', '.tsv', '.txt')):
            try:
                sep = '\t' if item.lower().endswith('.tsv') else ','
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                    header = f.readline().strip()
                if header:
                    cols = [c.strip().strip('"') for c in header.split(sep)]
                    desc = f"columns: {', '.join(cols[:20])}"
                    if len(cols) > 20:
                        desc += f" ... ({len(cols)} total)"
            except Exception:
                pass
        elif os.path.isdir(full_path):
            try:
                sub_items = sorted(os.listdir(full_path))[:5]
                if sub_items:
                    desc = f"directory containing: {', '.join(sub_items)}"
                    total = len(os.listdir(full_path))
                    if total > 5:
                        desc += f" ... ({total} items)"
            except Exception:
                pass
        result.append({"name": item, "description": desc})
    return result


class BiomniToolLoader:
    """Singleton that loads and manages Biomni framework tool descriptions."""

    _instance: Optional["BiomniToolLoader"] = None

    def __init__(self) -> None:
        self._module2api: Dict[str, List[Dict[str, Any]]] = {}
        self._all_tools: List[Dict[str, Any]] = []
        self._initialized = False

    @classmethod
    def get_instance(cls) -> "BiomniToolLoader":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def initialize(self) -> None:
        """Load all Biomni tool descriptions. Called once at server startup."""
        if self._initialized:
            return
        try:
            from biomni.utils import read_module2api

            self._module2api = read_module2api()
            for module_name, tools in self._module2api.items():
                for tool in tools:
                    # Tag each tool with its module for import paths
                    tool.setdefault("module", module_name)
                self._all_tools.extend(tools)
            self._initialized = True
            logger.info(
                f"BiomniToolLoader initialized: {len(self._module2api)} modules, "
                f"{len(self._all_tools)} tools"
            )
        except Exception as e:
            logger.warning(f"BiomniToolLoader initialization failed: {e}")
            self._initialized = False

    def is_initialized(self) -> bool:
        return self._initialized

    def get_all_tools(self) -> List[Dict[str, Any]]:
        """Return flat list of all tool descriptions (for retrieval input)."""
        return self._all_tools

    def get_module2api(self) -> Dict[str, List[Dict[str, Any]]]:
        """Return the raw module2api dict."""
        return self._module2api

    def format_tool_desc(self, tools: List[Dict[str, Any]]) -> str:
        """Format selected tools as Section [G] Function Dictionary text.

        Each line: ``- module.func_name(param1: type, param2: type): description``
        """
        if not tools:
            return ""
        lines = []
        for t in tools:
            module = t.get("module", "unknown")
            name = t.get("name", "unknown")
            desc = t.get("description", "")
            # Truncate long descriptions
            if len(desc) > 300:
                desc = desc[:297] + "..."
            params = ", ".join(
                f"{p.get('name', '?')}: {p.get('type', 'Any')}"
                for p in t.get("required_parameters", [])
            )
            lines.append(f"- {module}.{name}({params}): {desc}")
        return "\n".join(lines)

    def keyword_search(
        self, query: str, max_results: int = 15
    ) -> List[Dict[str, Any]]:
        """Simple keyword-based tool search as fallback when LLM retrieval fails.

        Scores each tool by counting how many query keywords appear in the
        tool's name, description, and module name.
        """
        if not self._all_tools:
            return []

        # Tokenize query into lowercase keywords (3+ chars), remove stop words
        _STOP = {
            "the", "and", "for", "with", "from", "that", "this", "are",
            "was", "were", "has", "have", "been", "will", "can", "may",
            "use", "using", "used", "based", "data", "find", "identify",
            "search", "analyze", "perform", "check", "review", "related",
        }
        keywords = [
            w.lower()
            for w in re.split(r"\W+", query)
            if len(w) >= 3 and w.lower() not in _STOP
        ]
        if not keywords:
            return []

        scored: List[tuple] = []
        for tool in self._all_tools:
            name = tool.get("name", "").lower()
            desc = tool.get("description", "").lower()
            module = tool.get("module", "").lower()

            score = 0
            for kw in keywords:
                if kw in name:
                    score += 3  # name match is strongest signal
                elif kw in module:
                    score += 2  # module match (e.g., "literature")
                elif kw in desc:
                    score += 1  # description match
            if score > 0:
                scored.append((score, tool))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [t for _, t in scored[:max_results]]

    # ─── Training-format retrieval (matches Phase 0 training data) ───

    def build_retrieval_prompt(
        self, user_query: str, plan_context: str = "",
        data_lake_items: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """Build a retrieval system prompt matching the training data format.

        This produces the EXACT same format as tool_retrieval_sys_prompt.txt
        that the model was trained on (Phase 0 in output_formatted.json).
        """
        lines = [
            "You are an expert biomedical research assistant. Your task is to select the relevant resources to help answer a user's query. Also, when using tools, make sure to explain the reasons for using these tools and explain it concisely and rigorously.",
            "",
            f"USER QUERY: {user_query}",
            "",
        ]
        if plan_context:
            lines.extend([
                "PLAN CONTEXT:",
                plan_context,
                "",
            ])
        lines.extend([
            "Below are the available resources. For each category, select items that are directly or indirectly relevant to answering the query.",
            "Be generous in your selection - include resources that might be useful for the task, even if they're not explicitly mentioned in the query.",
            "It's better to include slightly more resources than to miss potentially useful ones.",
            "",
            "AVAILABLE TOOLS:",
        ])
        for idx, tool in enumerate(self._all_tools):
            name = tool.get("name", "unknown")
            desc = tool.get("description", "")
            if len(desc) > 200:
                desc = desc[:197] + "..."
            lines.append(f"{idx}. {name}: {desc}")

        lines.append("")
        lines.append("AVAILABLE DATA LAKE ITEMS:")
        if data_lake_items:
            for idx, item in enumerate(data_lake_items):
                name = item.get("name", "unknown")
                desc = item.get("description", "")
                if desc:
                    lines.append(f"{idx}. {name}: {desc}")
                else:
                    lines.append(f"{idx}. {name}")
        else:
            lines.append("(none)")
        lines.append("")
        lines.append("AVAILABLE SOFTWARE LIBRARIES:")
        lines.append("(none)")
        lines.append("")
        lines.append(
            "For each category, respond with ONLY the indices of the relevant items in the following format:\n"
            "TOOLS: [list of indices]\n"
            "DATA_LAKE: [list of indices]\n"
            "LIBRARIES: [list of indices]\n"
            "\n"
            "For example:\n"
            "TOOLS: [0, 3, 5, 7, 9]\n"
            "DATA_LAKE: []\n"
            "LIBRARIES: []\n"
            "\n"
            "If a category has no relevant items, use an empty list.\n"
            "\n"
            "IMPORTANT GUIDELINES:\n"
            "1. Be generous but not excessive\n"
            "2. ALWAYS prioritize database tools for general queries\n"
            "3. Include all literature search tools for search/review queries\n"
            "4. For wet lab queries, ALWAYS include molecular biology tools\n"
            "5. When in doubt, include rather than exclude"
        )
        return "\n".join(lines)

    @staticmethod
    def _parse_indices(match_str: str, items: list, max_count: int) -> list:
        """Parse comma-separated indices from a regex match group."""
        indices = []
        for idx_str in match_str.split(","):
            idx_str = idx_str.strip()
            if idx_str.isdigit():
                idx = int(idx_str)
                if 0 <= idx < len(items):
                    indices.append(idx)
        return [items[i] for i in indices[:max_count]]

    async def retrieval_with_llm(
        self, query: str, llm: Any, max_tools: int = 15,
        plan_context: str = "",
        data_lake_items: Optional[List[Dict[str, str]]] = None,
    ) -> RetrievalResult:
        """Run tool retrieval using the training-data-compatible prompt format.

        Parses TOOLS, DATA_LAKE, and LIBRARIES indices from LLM response.
        Falls back to keyword_search on failure.
        """
        from langchain_core.messages import HumanMessage

        data_lake_items = data_lake_items or []
        prompt = self.build_retrieval_prompt(query, plan_context, data_lake_items)

        try:
            if hasattr(llm, "ainvoke"):
                response = await llm.ainvoke([HumanMessage(content=prompt)])
                content = response.content if hasattr(response, "content") else str(response)
            elif hasattr(llm, "invoke"):
                response = llm.invoke([HumanMessage(content=prompt)])
                content = response.content if hasattr(response, "content") else str(response)
            else:
                content = str(llm(prompt))

            logger.info(f"Retrieval LLM response ({len(content)} chars): {content[:200]}")

            # Parse TOOLS: [indices]
            selected_tools: List[Dict[str, Any]] = []
            tools_match = re.search(r"TOOLS:\s*\[(.*?)\]", content, re.IGNORECASE)
            if tools_match and tools_match.group(1).strip():
                selected_tools = self._parse_indices(
                    tools_match.group(1), self._all_tools, max_tools
                )

            # Parse DATA_LAKE: [indices]
            selected_data_lake: List[Dict[str, str]] = []
            dl_match = re.search(r"DATA_LAKE:\s*\[(.*?)\]", content, re.IGNORECASE)
            if dl_match and dl_match.group(1).strip() and data_lake_items:
                selected_data_lake = self._parse_indices(
                    dl_match.group(1), data_lake_items, 20
                )

            # Parse LIBRARIES: [indices] (empty for now, but ready)
            selected_libraries: List[Dict[str, str]] = []
            lib_match = re.search(r"LIBRARIES:\s*\[(.*?)\]", content, re.IGNORECASE)
            if lib_match and lib_match.group(1).strip():
                # No library items to map yet; placeholder for future
                pass

            if selected_tools:
                logger.info(
                    f"LLM retrieval: {len(selected_tools)} tools, "
                    f"{len(selected_data_lake)} data_lake, "
                    f"{len(selected_libraries)} libraries"
                )
                return RetrievalResult(
                    tools=selected_tools,
                    data_lake=selected_data_lake,
                    libraries=selected_libraries,
                )

            # Try parsing as JSON fallback
            try:
                parsed = json.loads(content)
                if isinstance(parsed, dict) and "tools" in parsed:
                    tool_names = {t.get("name") for t in parsed["tools"] if isinstance(t, dict)}
                    selected = [t for t in self._all_tools if t.get("name") in tool_names]
                    if selected:
                        logger.info(f"LLM retrieval selected {len(selected)} tools by JSON")
                        return RetrievalResult(
                            tools=selected[:max_tools],
                            data_lake=[],
                            libraries=[],
                        )
            except (json.JSONDecodeError, TypeError):
                pass

            logger.warning("LLM retrieval: could not parse response, falling back to keyword search")
        except Exception as e:
            logger.warning(f"LLM retrieval failed: {e}")

        fallback_tools = self.keyword_search(query, max_results=max_tools)
        return RetrievalResult(tools=fallback_tools, data_lake=[], libraries=[])
