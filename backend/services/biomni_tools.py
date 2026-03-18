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
from langfuse.decorators import observe

logger = logging.getLogger("aigen.biomni_tools")


class RetrievalResult(TypedDict):
    tools: List[Dict[str, Any]]
    data_lake: List[Dict[str, str]]
    libraries: List[Dict[str, str]]
    know_how: List[Dict[str, str]]


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
        self._data_lake_dict: Dict[str, str] = {}
        self._library_dict: Dict[str, str] = {}
        self._know_how_docs: List[Dict[str, str]] = []
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
            # Load data_lake and library registries from Biomni env_desc
            try:
                from biomni.env_desc import data_lake_dict, library_content_dict
                self._data_lake_dict = data_lake_dict
                self._library_dict = library_content_dict
                logger.info(
                    f"Loaded env_desc: {len(data_lake_dict)} data_lake, "
                    f"{len(library_content_dict)} libraries"
                )
            except ImportError:
                logger.warning("biomni.env_desc not available — data_lake/libraries empty")

            # Load know-how documents
            try:
                from biomni.know_how.loader import KnowHowLoader
                kh_loader = KnowHowLoader()
                self._know_how_docs = kh_loader.get_document_summaries()
                logger.info(f"Loaded {len(self._know_how_docs)} know-how documents")
            except (ImportError, Exception) as kh_err:
                logger.warning(f"Know-how loader not available: {kh_err}")

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
        """Format selected tools using Biomni's textify_api_dict format.

        Produces detailed output with Import file, Method, Required/Optional
        Parameters, descriptions, and default values — matching the format
        the model was trained on.
        """
        if not tools:
            return ""
        try:
            from biomni.utils import textify_api_dict
            # Group tools by module (same structure as read_module2api output)
            grouped: Dict[str, List[Dict[str, Any]]] = {}
            for t in tools:
                module = t.get("module", "unknown")
                grouped.setdefault(module, []).append(t)
            return textify_api_dict(grouped)
        except ImportError:
            # Fallback: simple one-line format if biomni not available
            lines = []
            for t in tools:
                module = t.get("module", "unknown")
                name = t.get("name", "unknown")
                desc = t.get("description", "")
                if len(desc) > 300:
                    desc = desc[:297] + "..."
                params = ", ".join(
                    f"{p.get('name', '?')}: {p.get('type', 'Any')}"
                    for p in t.get("required_parameters", [])
                )
                lines.append(f"- {module}.{name}({params}): {desc}")
            return "\n".join(lines)

    _KEYWORD_STOP = {
        "the", "and", "for", "with", "from", "that", "this", "are",
        "was", "were", "has", "have", "been", "will", "can", "may",
        "use", "using", "used", "based", "data", "find", "identify",
        "search", "analyze", "perform", "check", "review", "related",
    }

    def _extract_keywords(self, query: str) -> List[str]:
        """Tokenize query into lowercase keywords (3+ chars), remove stop words."""
        return [
            w.lower()
            for w in re.split(r"\W+", query)
            if len(w) >= 3 and w.lower() not in self._KEYWORD_STOP
        ]

    def keyword_search(
        self, query: str, max_results: int = 15
    ) -> List[Dict[str, Any]]:
        """Simple keyword-based tool search as fallback when LLM retrieval fails.

        Scores each tool by counting how many query keywords appear in the
        tool's name, description, and module name.
        """
        if not self._all_tools:
            return []

        keywords = self._extract_keywords(query)
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

    def _keyword_search_dict(
        self, query_keywords: List[str], source: Dict[str, str], max_results: int = 10
    ) -> List[Dict[str, str]]:
        """Keyword-match items from a name→description dict (data_lake, libraries)."""
        if not source or not query_keywords:
            return []
        scored: List[tuple] = []
        for name, desc in source.items():
            text = f"{name} {desc}".lower()
            score = sum(2 if kw in name.lower() else 1 for kw in query_keywords if kw in text)
            if score > 0:
                scored.append((score, {"name": name, "description": desc}))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored[:max_results]]

    # ─── Training-format retrieval (matches Phase 0 training data) ───

    # Default top/bottom sections for retrieval prompt (split at AVAILABLE TOOLS)
    _DEFAULT_TOP = (
        "You are an expert biomedical research assistant. Your task is to select the relevant resources to help answer a user's query.\n"
        "\n"
        "USER QUERY: {user_query}\n"
        "\n"
        "{plan_context_block}"
        "Below are the available resources. For each category, select items that are directly or indirectly relevant to answering the query.\n"
        "Be generous in your selection - include resources that might be useful for the task, even if they're not explicitly mentioned in the query.\n"
        "It's better to include slightly more resources than to miss potentially useful ones.\n"
        "\n"
        "You MUST output ONLY in the #OUTPUT FORMAT shown at the end. No other text."
    )

    _DEFAULT_BOTTOM = (
        "#OUTPUT FORMAT\n"
        "Respond with ONLY the indices. No explanation, no markdown, no reasoning.\n"
        "\n"
        "TOOLS: [comma-separated indices]\n"
        "DATA_LAKE: [comma-separated indices]\n"
        "LIBRARIES: [comma-separated indices]\n"
        "KNOW_HOW: [comma-separated indices]\n"
        "\n"
        "#EXAMPLE\n"
        "TOOLS: [0, 3, 5, 7, 9, 12, 15, 18, 20]\n"
        "DATA_LAKE: [1, 2, 4]\n"
        "LIBRARIES: [0, 2, 4, 5, 8]\n"
        "KNOW_HOW: [0, 1]\n"
        "\n"
        "#GUIDELINES\n"
        "- Be generous: include all potentially relevant resources\n"
        "- ALWAYS prioritize database tools for general queries\n"
        "- Include all literature search tools\n"
        "- For wet lab/sequence queries, ALWAYS include molecular biology tools\n"
        "- For data lake, include datasets that could provide useful information\n"
        "- For libraries, include those providing functions needed for analysis\n"
        "- For know-how, include relevant protocols and best practices\n"
        "- When in doubt, include rather than exclude\n"
        "- Empty category = empty list, e.g. DATA_LAKE: []"
    )

    def build_retrieval_prompt(
        self, user_query: str, plan_context: str = "",
        data_lake_items: Optional[List[Dict[str, str]]] = None,
        top_override: Optional[str] = None,
        bottom_override: Optional[str] = None,
    ) -> str:
        """Build a retrieval system prompt matching the training data format.

        This produces the EXACT same format as tool_retrieval_sys_prompt.txt
        that the model was trained on (Phase 0 in output_formatted.json).

        top_override / bottom_override: custom user edits from DB.
        """
        # --- Top section ---
        plan_context_block = ""
        if plan_context:
            plan_context_block = f"PLAN CONTEXT:\n{plan_context}\n\n"

        top_template = top_override if top_override else self._DEFAULT_TOP
        top = top_template.replace("{user_query}", user_query)
        top = top.replace("{plan_context_block}", plan_context_block)
        # Clean up leftover placeholder if no plan_context
        top = top.replace("{plan_context}", plan_context or "")

        # --- Middle section (auto-generated from env_desc + tools) ---
        lines = ["", "AVAILABLE TOOLS:"]
        for idx, tool in enumerate(self._all_tools):
            name = tool.get("name", "unknown")
            desc = tool.get("description", "")
            if len(desc) > 200:
                desc = desc[:197] + "..."
            lines.append(f"{idx}. {name}: {desc}")

        # DATA LAKE: use env_desc registry, merge with scan results for custom data
        lines.append("")
        lines.append("AVAILABLE DATA LAKE ITEMS:")
        dl_items = list(self._data_lake_dict.items())
        # Merge scan results not in registry
        registered_names = set(self._data_lake_dict.keys())
        if data_lake_items:
            for item in data_lake_items:
                if item.get("name") not in registered_names:
                    dl_items.append((item["name"], item.get("description", "")))
        if dl_items:
            for idx, (name, desc) in enumerate(dl_items):
                if desc:
                    lines.append(f"{idx}. {name}: {desc}")
                else:
                    lines.append(f"{idx}. {name}")
        else:
            lines.append("(none)")

        # LIBRARIES: use env_desc registry
        lines.append("")
        lines.append("AVAILABLE SOFTWARE LIBRARIES:")
        if self._library_dict:
            for idx, (name, desc) in enumerate(self._library_dict.items()):
                lines.append(f"{idx}. {name}: {desc}")
        else:
            lines.append("(none)")

        # KNOW-HOW: documents from KnowHowLoader
        lines.append("")
        lines.append("AVAILABLE KNOW-HOW DOCUMENTS (Best Practices & Protocols):")
        if self._know_how_docs:
            for idx, doc in enumerate(self._know_how_docs):
                name = doc.get("name", "unknown")
                desc = doc.get("description", "")
                lines.append(f"{idx}. {name}: {desc}")
        else:
            lines.append("(none)")

        middle = "\n".join(lines)

        # --- Bottom section ---
        bottom = bottom_override if bottom_override else self._DEFAULT_BOTTOM

        return top + "\n" + middle + "\n\n" + bottom

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

    @observe(as_type="span", name="tool_retrieval_with_llm")
    async def retrieval_with_llm(
        self, query: str, llm: Any, max_tools: int = 15,
        plan_context: str = "",
        data_lake_items: Optional[List[Dict[str, str]]] = None,
        top_override: Optional[str] = None,
        bottom_override: Optional[str] = None,
    ) -> RetrievalResult:
        """Run tool retrieval using the training-data-compatible prompt format.

        Parses TOOLS, DATA_LAKE, and LIBRARIES indices from LLM response.
        Falls back to keyword_search on failure.
        """
        langfuse_context.update_current_span(input={"query": query, "plan_context": plan_context})

        from langchain_core.messages import HumanMessage

        data_lake_items = data_lake_items or []
        prompt = self.build_retrieval_prompt(
            query, plan_context, data_lake_items,
            top_override=top_override, bottom_override=bottom_override,
        )

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

            # Build reference lists matching build_retrieval_prompt index order
            dl_list = [{"name": n, "description": d} for n, d in self._data_lake_dict.items()]
            registered_names = set(self._data_lake_dict.keys())
            for item in data_lake_items:
                if item.get("name") not in registered_names:
                    dl_list.append(item)
            lib_list = [{"name": n, "description": d} for n, d in self._library_dict.items()]

            # --- Strategy 1: Strict regex (TOOLS: [0, 3, 5] or TOOLS: 0, 3, 5) ---
            def _strict_parse(cat_key: str, items: list, max_n: int) -> list:
                m = re.search(rf"{cat_key}:\s*\[(.*?)\]", content, re.IGNORECASE)
                if not m:
                    m = re.search(rf"{cat_key}:\s*([0-9][\d\s,]*)", content, re.IGNORECASE)
                if m and m.group(1).strip() and items:
                    return self._parse_indices(m.group(1), items, max_n)
                return []

            selected_tools = _strict_parse("TOOLS", self._all_tools, max_tools)
            selected_data_lake = _strict_parse("DATA_LAKE", dl_list, 20)
            selected_libraries = _strict_parse("LIBRARIES", lib_list, 30)
            selected_know_how = _strict_parse("KNOW_HOW", self._know_how_docs, 5)

            if selected_tools or selected_data_lake or selected_libraries or selected_know_how:
                logger.info(
                    f"LLM retrieval (strict): {len(selected_tools)} tools, "
                    f"{len(selected_data_lake)} data_lake, "
                    f"{len(selected_libraries)} libraries, "
                    f"{len(selected_know_how)} know_how"
                )
                
                result = RetrievalResult(
                    tools=selected_tools,
                    data_lake=selected_data_lake,
                    libraries=selected_libraries,
                    know_how=selected_know_how,
                )
                # Langfuse에 반환된 도구 개수 등 메타데이터 기록
                langfuse_context.update_current_span(output={
                    "tools_count": len(selected_tools),
                    "data_lake_count": len(selected_data_lake)
                })
                return result

            # --- Strategy 2: Flexible extraction from free-form output ---
            categories = ["TOOLS", "DATA_LAKE", "LIBRARIES", "KNOW_HOW"]
            tool_idxs = self._extract_indices_flexible(
                content, "TOOLS", ["DATA_LAKE", "LIBRARIES", "KNOW_HOW"], len(self._all_tools)
            )
            dl_idxs = self._extract_indices_flexible(
                content, "DATA_LAKE", ["LIBRARIES", "KNOW_HOW", "TOOLS"], len(dl_list)
            )
            lib_idxs = self._extract_indices_flexible(
                content, "LIBRARIES", ["KNOW_HOW", "TOOLS", "DATA_LAKE"], len(lib_list)
            )
            kh_idxs = self._extract_indices_flexible(
                content, "KNOW_HOW", ["TOOLS", "DATA_LAKE", "LIBRARIES"], len(self._know_how_docs)
            )

            if tool_idxs or dl_idxs or lib_idxs or kh_idxs:
                selected_tools = [self._all_tools[i] for i in tool_idxs[:max_tools]]
                selected_data_lake = [dl_list[i] for i in dl_idxs[:20]] if dl_list else []
                selected_libraries = [lib_list[i] for i in lib_idxs[:30]] if lib_list else []
                selected_know_how = [self._know_how_docs[i] for i in kh_idxs[:5]] if self._know_how_docs else []
                logger.info(
                    f"LLM retrieval (flexible): {len(selected_tools)} tools, "
                    f"{len(selected_data_lake)} data_lake, "
                    f"{len(selected_libraries)} libraries, "
                    f"{len(selected_know_how)} know_how"
                )
                return RetrievalResult(
                    tools=selected_tools,
                    data_lake=selected_data_lake,
                    libraries=selected_libraries,
                    know_how=selected_know_how,
                )

            # --- Strategy 3: JSON fallback ---
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
                            know_how=[],
                        )
            except (json.JSONDecodeError, TypeError):
                pass

            logger.warning(
                f"LLM retrieval: could not parse response, falling back to keyword search. "
                f"Full response:\n{content}"
            )
        except Exception as e:
            logger.warning(f"LLM retrieval failed: {e}")

        fallback_tools = self.keyword_search(query, max_results=max_tools)
        kw = self._extract_keywords(query)
        fallback_dl = self._keyword_search_dict(kw, self._data_lake_dict, max_results=10)
        fallback_libs = self._keyword_search_dict(kw, self._library_dict, max_results=10)
        logger.info(
            f"Keyword fallback: {len(fallback_tools)} tools, "
            f"{len(fallback_dl)} data_lake, {len(fallback_libs)} libraries"
        )
        return RetrievalResult(
            tools=fallback_tools,
            data_lake=fallback_dl,
            libraries=fallback_libs,
            know_how=[],
        )
