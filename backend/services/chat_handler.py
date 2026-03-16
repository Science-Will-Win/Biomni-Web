"""Chat Handler — core chat processing service.

Ported from inference.py handle_chat() (lines 2582-3376).
LLM streaming, tool detection/execution, Plan state management, SSE event production.
"""

import json
import logging
import re
from typing import Any, AsyncGenerator, Dict, List, Optional
from uuid import UUID

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import get_settings
from db.models import Setting
from models.schemas import (
    ChatEvent,
    ChatRequest,
    ReplanRequest,
    RetryStepRequest,
    SSEEventType,
    StepQuestionRequest,
)
from services.conversation_service import ConversationService
from services.llm_service import get_llm_service
from services.prompt_builder import PromptMode, build_prompt
from services.tool_service import ToolService
from tools.tool_parser import parse_step_output

from langfuse import Langfuse
from langfuse.callback import CallbackHandler
from langfuse.decorators import observe, langfuse_context

logger = logging.getLogger("aigen.chat_handler")

MAX_TOOL_ITERATIONS = 10
MAX_RETRY_ATTEMPTS = 3

def get_langfuse_client() -> Optional[Langfuse]:
    settings = get_settings()
    if settings.LANGFUSE_PUBLIC_KEY and settings.LANGFUSE_SECRET_KEY:
        return Langfuse(
            public_key=settings.LANGFUSE_PUBLIC_KEY,
            secret_key=settings.LANGFUSE_SECRET_KEY,
            host=settings.LANGFUSE_HOST
        )
    return None

def _ev(event_type: str, data: Dict[str, Any]) -> ChatEvent:
    """Shortcut to create a ChatEvent."""
    return ChatEvent(type=event_type, data=data)


class ChatHandler:
    """Singleton. Chat processing, Plan state management."""

    _instance: Optional["ChatHandler"] = None

    def __init__(self) -> None:
        self._plan_states: Dict[str, dict] = {}
        self._stop_flags: Dict[str, bool] = {}

    @classmethod
    def get_instance(cls) -> "ChatHandler":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ═══════════════════════════════════════════
    # Public API
    # ═══════════════════════════════════════════\

    async def handle_chat(
        self, request: ChatRequest, db: AsyncSession
    ) -> AsyncGenerator[ChatEvent, None]:
        """Main chat entry point. Yields ChatEvent for SSE/WS streaming.

        Flow:
        1. Get or create conversation
        2. Process files, save user message
        3. Resolve model behavior
        4. Branch: agent → _stream_direct_chat, plan → _stream_plan_chat
        """
        conv_svc = ConversationService(db)
        llm_service = get_llm_service()

        # 1. 초기 세션/트레이스 설정
        langfuse_client = get_langfuse_client()
        trace = None
        lf_handler = None
        conv_id = request.conv_id

        try:
            if not conv_id:
                conv = await conv_svc.create_conversation(first_message=request.message)
                conv_id = str(conv.id)
            
            # [수정] 수동으로 Trace 생성 (데코레이터 대신 이 방식이 스트리밍에 더 안전합니다)
            if langfuse_client:
                trace = langfuse_client.trace(
                    name="Biomni Research Session",
                    session_id=conv_id,
                    input=request.message
                )
                # LangChain의 로깅을 이 Trace 하위로 묶어주는 핸들러 추출
                lf_handler = trace.get_langchain_handler()

            # 2. Process files + save user message
            file_text, processed_files = await self._process_files(request.files)
            full_message = (file_text + request.message) if file_text else request.message

            if request.conv_id:
                await conv_svc.add_message(
                    UUID(conv_id), "user", full_message,
                    files=processed_files if processed_files else None,
                )

            # 3. Load history + resolve behavior
            conv_detail = await conv_svc.get_conversation(UUID(conv_id))
            history = self._build_messages_from_history(
                conv_detail.messages if conv_detail else [], ""
            )
            behavior = await llm_service.resolve_model_behavior(request.model_override, db)
            self._stop_flags[conv_id] = False

            # 4. Rerun path — skip LLM plan creation, execute steps directly
            if request.rerun and request.rerun_steps:
                self._plan_states[conv_id] = {
                    "steps": request.rerun_steps,
                    "goal": request.rerun_goal or "",
                    "current_step": 0,
                    "all_results": [],
                }
                # Filter out old PLAN_COMPLETE messages
                history = [
                    m for m in history
                    if not isinstance(m, AIMessage) or "[PLAN_COMPLETE]" not in m.content
                ]
                async for event in self._run_step_loop(conv_id, history, behavior, db):
                    yield event
                return
            
            if request.rerun and request.rerun_steps:
                # ... 리런 로직 ...
                async for event in self._run_step_loop(conv_id, history, behavior, db, lf_handler):
                    yield event
                return

            # 5. Mode branch
            mode = request.mode or "plan"
            if mode == "agent":
                async for event in self._stream_direct_chat(
                    conv_id, history, behavior, db, lf_handler
                ):
                    yield event
            else:
                async for event in self._stream_plan_chat(
                    conv_id, full_message, history, behavior, db, lf_handler, trace
                ):
                    yield event

        except Exception as e:
            logger.exception("handle_chat error")
            yield _ev("error", {"error": str(e)})
        finally:
            if langfuse_client:
                langfuse_client.flush() # [중요] 데이터 강제 전송
            self._stop_flags.pop(conv_id, None)

    async def handle_replan(
        self, request: ReplanRequest, db: AsyncSession
    ) -> AsyncGenerator[ChatEvent, None]:
        """Replan — skip plan creation, run step loop directly.

        Ported from inference.py is_rerun=True path.
        """
        conv_id = request.conv_id
        conv_svc = ConversationService(db)
        llm_service = get_llm_service()

        try:
            # Initialize plan state directly
            self._plan_states[conv_id] = {
                "steps": request.steps,
                "goal": request.goal or "",
                "current_step": 0,
                "all_results": [],
            }

            # Save synthetic create_plan message
            plan_data = {"goal": request.goal or "", "steps": request.steps}
            plan_json = json.dumps(plan_data, ensure_ascii=False)
            synthetic_msg = f"[TOOL_CALLS]create_plan[ARGS]{plan_json}"
            await conv_svc.add_message(UUID(conv_id), "assistant", synthetic_msg)

            # Load history (excluding PLAN_COMPLETE messages)
            conv_detail = await conv_svc.get_conversation(UUID(conv_id))
            history = self._build_messages_from_history(
                conv_detail.messages if conv_detail else [], ""
            )
            behavior = await llm_service.resolve_model_behavior(db=db)
            self._stop_flags[conv_id] = False

            async for event in self._run_step_loop(conv_id, history, behavior, db):
                yield event

        except Exception as e:
            logger.exception("handle_replan error")
            yield _ev("error", {"error": str(e)})
        finally:
            self._cleanup(conv_id)

    async def handle_step_question(
        self, request: StepQuestionRequest, db: AsyncSession
    ) -> AsyncGenerator[ChatEvent, None]:
        """Handle user question during plan execution (no tools)."""
        conv_id = request.conv_id
        llm_service = get_llm_service()
        conv_svc = ConversationService(db)

        try:
            await conv_svc.add_message(UUID(conv_id), "user", request.question)

            plan_state = self._get_plan_state(conv_id)
            context_parts = [f"User question: {request.question}"]
            if plan_state:
                context_parts.append(f"Current plan goal: {plan_state.get('goal', '')}")
                context_parts.append(
                    f"Current step: {plan_state.get('current_step', 0) + 1}"
                )
            if request.plan_goal:
                context_parts.append(f"Plan goal: {request.plan_goal}")
            if request.plan_steps:
                context_parts.append(
                    "Plan steps:\n" + "\n".join(
                        f"{i+1}. {s}" for i, s in enumerate(request.plan_steps)
                    )
                )

            # Step questions are Q&A — use AGENT mode (no code execution tokens).
            # For use_code_gen models (e.g. ministral), FULL mode would inject
            # SECTION_CODE_EXEC with tokens the model can't generate.
            behavior = await llm_service.resolve_model_behavior(db=db)
            system_prompt = build_prompt(PromptMode.AGENT, token_format=behavior)
            messages = [SystemMessage(content=system_prompt)]

            conv_detail = await conv_svc.get_conversation(UUID(conv_id))
            messages.extend(
                self._build_messages_from_history(
                    conv_detail.messages if conv_detail else [], ""
                )
            )
            messages.append(HumanMessage(content="\n".join(context_parts)))
            messages = self._fix_role_alternation(messages)

            max_ctx = await self._get_max_context(db, behavior)
            messages = self._truncate_messages(messages, max_ctx)

            llm = await llm_service.get_llm_instance(db=db)
            full_response = ""
            async for chunk in llm.astream(messages):
                token = chunk.content if hasattr(chunk, "content") else str(chunk)
                if token:
                    full_response += token
                    yield _ev("token", {"token": token})

            await conv_svc.add_message(UUID(conv_id), "assistant", full_response)
            yield _ev("done", {"done": True})

        except Exception as e:
            logger.exception("handle_step_question error")
            yield _ev("error", {"error": str(e)})

    async def handle_retry_step(
        self, request: RetryStepRequest, db: AsyncSession
    ) -> AsyncGenerator[ChatEvent, None]:
        """Retry a specific step in the plan."""
        conv_id = request.conv_id
        llm_service = get_llm_service()
        conv_svc = ConversationService(db)

        try:
            plan_state = self._get_plan_state(conv_id)
            if not plan_state:
                # Reconstruct plan state from request
                if request.previous_steps:
                    steps = request.previous_steps
                else:
                    yield _ev("error", {"error": "No plan state found"})
                    return
                plan_state = {
                    "steps": steps,
                    "goal": request.plan_goal or "",
                    "current_step": request.step_num,
                    "all_results": [],
                }
                self._plan_states[conv_id] = plan_state
            else:
                plan_state["current_step"] = request.step_num

            # Apply user edit to step description if provided
            if request.user_edit and request.step_num < len(plan_state["steps"]):
                step = plan_state["steps"][request.step_num]
                step["description"] = (
                    step.get("description", "") + f"\n\nUser edit: {request.user_edit}"
                )

            # Trim results to before the retry step
            plan_state["all_results"] = [
                r for r in plan_state["all_results"]
                if r.get("step", 0) <= request.step_num
            ]

            conv_detail = await conv_svc.get_conversation(UUID(conv_id))
            history = self._build_messages_from_history(
                conv_detail.messages if conv_detail else [], ""
            )
            behavior = await llm_service.resolve_model_behavior(db=db)
            self._stop_flags[conv_id] = False

            async for event in self._run_step_loop(conv_id, history, behavior, db):
                yield event

        except Exception as e:
            logger.exception("handle_retry_step error")
            yield _ev("error", {"error": str(e)})
        finally:
            self._cleanup(conv_id)

    def stop(self, conv_id: str) -> bool:
        """Set stop flag for a conversation's streaming."""
        self._stop_flags[conv_id] = True
        return True

    # ═══════════════════════════════════════════
    # Internal — mode-specific streaming
    # ═══════════════════════════════════════════

    async def _stream_direct_chat(
        self, conv_id: str, history: List, behavior: dict, db: AsyncSession, lf_handler=None
    ) -> AsyncGenerator[ChatEvent, None]:
        """Agent mode — direct LLM streaming without tools."""
        llm_service = get_llm_service()
        conv_svc = ConversationService(db)

        system_prompt = build_prompt(PromptMode.AGENT, token_format=behavior)
        messages = [SystemMessage(content=system_prompt)] + history
        messages = self._fix_role_alternation(messages)

        max_ctx = await self._get_max_context(db, behavior)
        messages = self._truncate_messages(messages, max_ctx)

        llm = await llm_service.get_llm_instance(db=db)
        full_response = ""

        run_config = {"callbacks": [lf_handler]} if lf_handler else {}
        async for chunk in llm.astream(messages, config=run_config):
            if self._stop_flags.get(conv_id):
                yield _ev("done", {"done": True, "stopped": True})
                return
            token = chunk.content if hasattr(chunk, "content") else str(chunk)
            if token:
                full_response += token
                yield _ev("token", {"token": token})

        await conv_svc.add_message(UUID(conv_id), "assistant", full_response)
        yield _ev("done", {"done": True})

    # create_plan tool schema — matches original inference.py get_plan_schema()
    CREATE_PLAN_SCHEMA = {
        "type": "function",
        "function": {
            "name": "create_plan",
            "description": "Create a research plan with goal and steps",
            "parameters": {
                "type": "object",
                "properties": {
                    "goal": {"type": "string", "description": "Research goal (concise noun phrase)"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "Step name in Korean"},
                                "description": {"type": "string", "description": "Step description"},
                            },
                            "required": ["name", "description"],
                        },
                    },
                },
                "required": ["goal", "steps"],
            },
        },
    }

    async def _stream_plan_chat(
        self, conv_id: str, message: str, history: List,
        behavior: dict, db: AsyncSession, lf_handler=None
    ) -> AsyncGenerator[ChatEvent, None]:
        """Plan mode — Phase A: create plan, Phase B: execute steps.

        Creates a plan-specific LLM instance with tools parameter passed directly
        to SGLang via extra_body, matching original inference.py behavior.
        """
        from langchain_openai import ChatOpenAI

        llm_service = get_llm_service()
        tool_service = ToolService.get_instance()
        conv_svc = ConversationService(db)
        settings = get_settings()

        # ── Phase A: Plan Creation ──
        plan_prompt = build_prompt(
            PromptMode.PLAN,
            token_format=behavior,
            data_lake_path=settings.BIOMNI_DATA_PATH,
        )

        # Get base LLM to extract connection params
        base_llm = await llm_service.get_llm_instance(db=db, max_tokens=2048)

        plan_messages = [SystemMessage(content=plan_prompt), HumanMessage(content=message)]

        # Retry loop: if plan generation hits max_tokens (truncated), retry with stronger repetition penalty
        MAX_PLAN_RETRIES = 2
        plan_data = None
        full_response = ""

        for attempt in range(MAX_PLAN_RETRIES + 1):
            rep_penalty = 1.15 + 0.1 * attempt  # 1.15 → 1.25 → 1.35
            plan_llm = ChatOpenAI(
                model=base_llm.model_name,
                temperature=max(0.1, base_llm.temperature * (0.7 ** attempt)),
                max_tokens=2048,
                base_url=base_llm.openai_api_base,
                api_key=base_llm.openai_api_key or "EMPTY",
                extra_body={"skip_special_tokens": False, "repetition_penalty": rep_penalty},
            )

            full_response = ""
            finish_reason = None

            callbacks = [lf_handler] if lf_handler else []
            async for chunk in plan_llm.astream(plan_messages, config={"callbacks": callbacks}):
                if self._stop_flags.get(conv_id):
                    yield _ev("done", {"done": True, "stopped": True})
                    return

                token = chunk.content if hasattr(chunk, "content") else ""
                if token:
                    full_response += token
                    yield _ev("token", {"token": token})

                # Capture finish_reason from the last chunk
                meta = getattr(chunk, "response_metadata", None)
                if meta and isinstance(meta, dict):
                    fr = meta.get("finish_reason")
                    if fr:
                        finish_reason = fr

            logger.info(
                f"Plan attempt {attempt + 1}/{MAX_PLAN_RETRIES + 1}: "
                f"{len(full_response)} chars, finish_reason={finish_reason}, "
                f"rep_penalty={rep_penalty}"
            )

            # If truncated by max_tokens, retry
            if finish_reason == "length":
                logger.warning(f"Plan truncated (max_tokens), attempt {attempt + 1}")
                if attempt < MAX_PLAN_RETRIES:
                    yield _ev("token", {"token": "\n\n🔄 응답이 잘렸습니다. 다시 생성합니다...\n\n"})
                    continue
                # Last attempt also truncated — still try to parse what we got

            # Try parsing
            plan_data = self._parse_plan_tool_call(full_response, message)
            if plan_data and plan_data.get("steps"):
                logger.info(f"Plan extracted: goal='{plan_data['goal'][:60]}', {len(plan_data['steps'])} steps")
                break  # Success

            # Parse failed
            logger.warning(f"Plan parse failed on attempt {attempt + 1}. Raw: {full_response[:300]}")
            if attempt < MAX_PLAN_RETRIES:
                yield _ev("token", {"token": "\n\n🔄 Plan 파싱 실패. 다시 생성합니다...\n\n"})
                continue

        if not plan_data or not plan_data.get("steps"):
            logger.error(f"Plan parsing failed after {MAX_PLAN_RETRIES + 1} attempts. Raw: {full_response[:1000]}")
            yield _ev("token", {"token": "\n\n⚠️ Plan 생성에 실패했습니다. 다시 시도해주세요."})
            yield _ev("done", {"done": True})
            return

        # System calls create_plan directly (NOT the LLM)
        plan_result = await tool_service.execute_tool("create_plan", plan_data)
        if not plan_result.get("success"):
            yield _ev("error", {"error": f"Plan creation failed: {plan_result.get('error', '')}"})
            return

        # Emit create_plan events so frontend can initialize Detail Panel
        yield _ev("tool_call", {
            "tool_call": {
                "name": "create_plan",
                "arguments": plan_data,
                "status": "completed",
            }
        })
        yield _ev("tool_result", {
            "tool_result": {
                "success": True,
                "result": plan_result,
                "tool": "create_plan",
            }
        })

        result_data = plan_result.get("result", {})
        plan_steps = result_data.get("steps", [])
        plan_goal = result_data.get("goal", "")

        # Initialize plan state
        self._plan_states[conv_id] = {
            "steps": plan_steps,
            "goal": plan_goal,
            "current_step": 0,
            "all_results": [],
        }

        # Save plan message to DB
        await conv_svc.add_message(UUID(conv_id), "assistant", full_response)

        # Append AI response to history so step loop has correct role alternation
        history.append(AIMessage(content=full_response))

        # ── Phase B: Step Execution ──
        async for event in self._run_step_loop(conv_id, history, behavior, db, lf_handler):
            yield event

    async def _run_step_loop(
        self, conv_id: str, history: List,
        behavior: dict, db: AsyncSession, lf_handler=None, parent_trace=None
    ) -> AsyncGenerator[ChatEvent, None]:
        """Plan step execution loop — single call per step.

        Uses Biomni full prompt + [AVAILABLE_TOOLS] token (all tools).
        LLM thinks and selects tool during generation.
        Parsing determined by model type (tool_calls_format vs code_execute_format).
        """
        plan_state = self._plan_states.get(conv_id)
        if not plan_state:
            yield _ev("error", {"error": "No plan state"})
            return

        llm_service = get_llm_service()
        tool_service = ToolService.get_instance()
        conv_svc = ConversationService(db)
        steps = plan_state["steps"]
        uses_tool_calls = bool(behavior.get("tool_calls_format"))

        langfuse_client = get_langfuse_client()

        for step_idx in range(plan_state["current_step"], len(steps)):
            if self._stop_flags.get(conv_id):
                await self._save_plan_complete(conv_id, conv_svc, stopped=True)
                yield _ev("done", {"done": True, "stopped": True})
                return

            step = steps[step_idx]
            plan_state["current_step"] = step_idx

            llm = await llm_service.get_llm_instance(db=db)

            step_span = None
            step_handler = lf_handler
            
            if parent_trace:
                # 1. 각 Step을 Span으로 생성
                step_span = parent_trace.span(
                    name=f"Step {step_idx + 1}: {step.get('name')}",
                    input=step.get("description")
                )
                # 2. 이 Span 전용 핸들러 추출 (이게 있어야 LLM 답변이 이 Step 안으로 들어감)
                step_handler = step_span.get_langchain_handler()
            
            # ── Build prompt: Biomni full prompt + plan checklist ──
            app_settings = get_settings()
            use_cg = behavior.get("use_code_gen", False)
            data_lake_path = app_settings.BIOMNI_DATA_PATH or ""

            # Biomni tool retrieval — select relevant tools for this step
            # use_llm_retrieval=true models (trained on Phase 0 format) use LLM retrieval
            # All other models fall back to keyword-based search
            from services.biomni_tools import BiomniToolLoader
            biomni_loader = BiomniToolLoader.get_instance()
            if biomni_loader.is_initialized():
                step_query = step.get("description", step.get("name", ""))
                use_llm_ret = behavior.get("use_llm_retrieval", False)

                retrieval_span = None
                if step_span:
                    retrieval_span = step_span.span(
                        name="Tool Retrieval",
                        input={"query": step.get("description", ""), "use_llm": behavior.get("use_llm_retrieval", False)}
                    )

                try:
                    if use_llm_ret:
                        retrieval_llm = await llm_service.get_llm_instance(db=db)
                        selected_tools = await biomni_loader.retrieval_with_llm(
                            step_query, retrieval_llm, max_tools=15,
                        )
                    else:
                        selected_tools = biomni_loader.keyword_search(
                            step_query, max_results=15,
                        )
                        
                    tool_desc = biomni_loader.format_tool_desc(selected_tools)
                    retrieved_tool_names = [t.get("name", "?") for t in selected_tools]
                    
                    # [추가] 정상 종료 시 Span 기록
                    if retrieval_span:
                        retrieval_span.end(output={"retrieved": retrieved_tool_names})
                    
                        
                except Exception as e:
                    # [추가] 에러 발생 시 Span에 Error 기록
                    if retrieval_span:
                        retrieval_span.end(level="ERROR", status_message=str(e))
                    raise
            else:
                tool_desc = tool_service.generate_tools_description()
                retrieved_tool_names = []

            # Store retrieved tool info for code_gen context
            plan_state["_retrieved_tool_desc"] = tool_desc

            yield _ev("step_start", {"step_start": {
                "step": step_idx + 1,
                "retrieved_tools": retrieved_tool_names,
            }})

            # Retrieve use_compact_prompt from global DB settings
            try:
                db_settings_res = await db.execute(select(Setting).where(Setting.key == "settings"))
                db_settings_row = db_settings_res.scalar_one_or_none()
                is_compact = db_settings_row.value.get("use_compact_prompt", False) if (db_settings_row and db_settings_row.value) else False
            except Exception:
                is_compact = False

            exec_prompt = build_prompt(
                PromptMode.FULL,
                token_format=behavior,
                use_code_gen=use_cg,
                compact=is_compact,
                tool_desc=tool_desc,
                data_lake_path=data_lake_path,
            )

            # [AVAILABLE_TOOLS] — only for non-code_gen models (API models)
            if use_cg:
                # code_gen models use [TOOL_CALLS] format; CODE_GEN_GUIDE covers tool usage
                full_prompt = exec_prompt
            else:
                all_schemas = tool_service.get_schemas(exclude_internal=True)
                available_tools_text = self._build_available_tools_text(all_schemas)
                full_prompt = available_tools_text + "\n" + exec_prompt

            # Inject plan checklist into system prompt
            plan_checklist = self._build_plan_checklist(conv_id)
            if plan_checklist:
                full_prompt += "\n\n" + plan_checklist

            step_context = self._build_step_context(
                step, step_idx, plan_state["all_results"]
            )
            messages = (
                [SystemMessage(content=full_prompt)]
                + history
                + [HumanMessage(content=step_context)]
            )
            messages = self._fix_role_alternation(messages)

            max_ctx = await self._get_max_context(db, behavior)
            messages = self._truncate_messages(messages, max_ctx)

            # ── LLM call + parse + execute (no bind_tools) ──
            # Tool call models: 1 iteration. Execute models: up to 5 (execute→observe loop).
            max_iters = 2 if uses_tool_calls else 5
            step_messages = list(messages)
            step_done = False

            for iteration in range(max_iters):
                if self._stop_flags.get(conv_id):
                    await self._save_plan_complete(conv_id, conv_svc, stopped=True)
                    yield _ev("done", {"done": True, "stopped": True})
                    return

                full_response = ""
                try:
                    # [핵심 수정] run_config를 정의하고 astream에 전달하세요!
                    # step_handler를 전달해야 토큰들이 하나로 합쳐져서 보입니다.
                    run_config = {"callbacks": [step_handler]} if step_handler else {}
                    async for chunk in llm.astream(step_messages, config=run_config): # <--- config 추가!
                        if self._stop_flags.get(conv_id):
                            # ...
                            return
                        token = chunk.content if hasattr(chunk, "content") else str(chunk)
                        if token:
                            full_response += token
                            yield _ev("token", {"token": token})
                except Exception as stream_err:
                    logger.error(f"Step {step_idx+1} LLM streaming failed: {stream_err}")
                    _err_data = {"error": f"LLM error: {stream_err}"}
                    yield _ev("tool_result", {"tool_result": {
                        "success": False, "result": _err_data,
                        "tool": "step_error", "step": step_idx + 1,
                    }})
                    plan_state["all_results"].append({
                        "step": step_idx + 1, "tool": "step_error",
                        "success": False, "result": _err_data,
                    })
                    history.append(AIMessage(content=f"Step {step_idx+1} failed: {stream_err}"))
                    step_done = True
                    break  # exit iteration loop, proceed to next step

                # Model-type-specific parsing
                parse_result = parse_step_output(full_response, behavior)

                if parse_result.tool_calls:
                    # ── Tool call execution ──
                    last_tc = None
                    last_result = None
                    for tc in parse_result.tool_calls:
                        yield _ev("tool_call", {
                            "tool_call": {
                                "name": tc.name,
                                "arguments": tc.arguments,
                                "status": "running",
                            }
                        })

                        tool_span = None
                        if trace:
                            tool_span = trace.span(
                                name=f"Tool Execution: {tc.name}",
                                input=tc.arguments
                            )

                        # Biomni tool direct execution
                        if tc.name.startswith("biomni."):
                            result = await self._execute_biomni_tool(
                                tc.name, tc.arguments, conv_id, step_idx
                            )
                        else:
                            exec_args = dict(tc.arguments)
                            if tc.name == "code_gen":
                                exec_args["context"] = self._build_code_gen_context(
                                    step, step_idx, conv_id
                                )
                            try:
                                result = await tool_service.execute_tool(
                                    tc.name, exec_args,
                                    conv_id=conv_id, step_id=str(step_idx),
                                )
                            except Exception as tool_err:
                                logger.error(f"Tool {tc.name} execution failed: {tool_err}")
                                result = {"success": False, "error": str(tool_err)}

                        if tool_span:
                            # 성공 여부에 따라 에러 레벨 지정
                            level = "DEFAULT" if result.get("success", False) else "ERROR"
                            tool_span.end(
                                output=result,
                                level=level
                            )

                        yield _ev("tool_result", {
                            "tool_result": {
                                "success": result.get("success", False),
                                "result": result,
                                "tool": tc.name,
                                "step": step_idx + 1,
                            }
                        })
                        plan_state["all_results"].append({
                            "step": step_idx + 1,
                            "tool": tc.name,
                            "success": result.get("success", False),
                            "result": result,
                        })
                        last_tc = tc
                        last_result = result

                    history.append(AIMessage(content=full_response))
                    if last_tc and last_result:
                        formatted = tool_service.format_result(
                            last_tc.name, last_result, behavior
                        )
                        history.append(HumanMessage(content=formatted))
                    step_done = True
                    break

                elif parse_result.execute_blocks:
                    # ── <execute> code execution ──
                    from tools.code_executor import CodeExecutor
                    code_executor = CodeExecutor()

                    # Detect tool names used in code
                    known_tools = set(tool_service.list_tool_names())

                    obs = ""
                    last_tool_label = "code_gen"
                    for block in parse_result.execute_blocks:
                        # Scan code for known tool names
                        used_tools = [t for t in known_tools if t in block.code]
                        tool_label = used_tools[0] if used_tools else "code_gen"
                        last_tool_label = tool_label

                        code_span = None
                        if trace:
                            code_span = trace.span(
                                name="Run Sandbox Code",
                                input={"code": block.code, "language": block.language, "tool": tool_label}
                            )

                        exec_result = await code_executor.execute(
                            block.code, block.language,
                            conv_id=conv_id, step_id=str(step_idx),
                        )

                        if code_span:
                            code_span.end(
                                output={
                                    "stdout": exec_result.stdout,
                                    "stderr": exec_result.stderr,
                                    "success": exec_result.success
                                },
                                level="ERROR" if not exec_result.success else "DEFAULT"
                            )

                        obs = self._format_observation(exec_result, behavior)
                        yield _ev("tool_result", {
                            "tool_result": {
                                "success": exec_result.success,
                                "result": {
                                    "stdout": exec_result.stdout,
                                    "stderr": exec_result.stderr,
                                    "figures": getattr(exec_result, "figures", []),
                                    "tables": getattr(exec_result, "tables", []),
                                },
                                "tool": tool_label,
                                "step": step_idx + 1,
                            }
                        })

                    if parse_result.has_solution:
                        plan_state["all_results"].append({
                            "step": step_idx + 1,
                            "tool": last_tool_label,
                            "success": True,
                            "result": {"solution": parse_result.solution_text},
                        })
                        history.append(AIMessage(content=full_response))
                        step_done = True
                        break

                    # Continue execute→observe loop
                    step_messages.append(AIMessage(content=full_response))
                    step_messages.append(HumanMessage(content=obs))
                    continue

                elif parse_result.has_solution:
                    # Solution without execute
                    _result_data = {"solution": parse_result.solution_text}
                    yield _ev("tool_result", {"tool_result": {
                        "success": True,
                        "result": _result_data,
                        "tool": "solution",
                        "step": step_idx + 1,
                    }})
                    plan_state["all_results"].append({
                        "step": step_idx + 1,
                        "tool": "solution",
                        "success": True,
                        "result": _result_data,
                    })
                    history.append(AIMessage(content=full_response))
                    step_done = True
                    break

                else:
                    # No structured output — retry for tool call models, fallback otherwise
                    if uses_tool_calls and iteration == 0:
                        step_messages = step_messages + [
                            AIMessage(content=full_response),
                            HumanMessage(content="You MUST call a tool. Output [TOOL_CALLS]tool_name[ARGS]{...}"),
                        ]
                        continue
                    # Text fallback
                    _result_data = {"text": full_response}
                    yield _ev("tool_result", {"tool_result": {
                        "success": True,
                        "result": _result_data,
                        "tool": "text_fallback",
                        "step": step_idx + 1,
                    }})
                    plan_state["all_results"].append({
                        "step": step_idx + 1,
                        "tool": "text_fallback",
                        "success": True,
                        "result": _result_data,
                    })
                    history.append(AIMessage(content=full_response))
                    step_done = True
                    break

            if not step_done:
                # Max iterations reached without completion
                _error_data = {"error": "Max iterations reached"}
                yield _ev("tool_result", {"tool_result": {
                    "success": False,
                    "result": _error_data,
                    "tool": "text_fallback",
                    "step": step_idx + 1,
                }})
                plan_state["all_results"].append({
                    "step": step_idx + 1,
                    "tool": "text_fallback",
                    "success": False,
                    "result": _error_data,
                })
                history.append(AIMessage(content=full_response))

            if step_span:
                step_span.end()
        # All steps done — send plan_complete (analysis generated by frontend via /api/analyze_plan)
        plan_complete_data = await self._save_plan_complete(conv_id, conv_svc)
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
    async def _get_max_context(db: AsyncSession, behavior: dict = None) -> int:
        """Read max_context from DB settings, default 32768.
        Cap at 10000 for Ministral models to prevent OOM/garbled output."""
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
        """Rough token estimate using UTF-8 byte length.

        ~3 UTF-8 bytes per token works across all languages:
        - Latin (EN/FR/DE): 1 byte/char → ~4 chars/token (overestimates, safe)
        - CJK (KO/ZH/JA): 3 bytes/char → ~1 token/char (accurate)
        - Arabic/Hindi/Thai: 2-4 bytes/char → reasonable estimate
        """
        return len(text.encode("utf-8")) // 3 + 1

    @classmethod
    def _truncate_messages(cls, messages: List, max_tokens: int) -> List:
        """Trim oldest non-system messages to fit within max_tokens budget.

        Keeps: first SystemMessage, last HumanMessage (current query).
        Removes from oldest history messages first.
        """
        if not messages or max_tokens <= 0:
            return messages

        # Separate system prefix, history, and tail (last user message)
        system_msgs = []
        history = []
        idx = 0
        while idx < len(messages) and isinstance(messages[idx], SystemMessage):
            system_msgs.append(messages[idx])
            idx += 1
        if idx < len(messages):
            history = list(messages[idx:])

        # Always keep the last message (current user query)
        tail = [history.pop()] if history else []

        # Calculate fixed token cost (system + tail)
        fixed_cost = sum(cls._estimate_tokens(m.content) for m in system_msgs + tail)
        remaining = max_tokens - fixed_cost

        if remaining <= 0:
            # Even system + current query exceeds budget; send them anyway
            return system_msgs + tail

        # Add history from newest to oldest until budget exhausted
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
    def _build_available_tools_text(schemas: List[Dict]) -> str:
        """Build [AVAILABLE_TOOLS] token text from tool schemas."""
        if not schemas:
            return ""
        schemas_json = json.dumps(schemas, ensure_ascii=False)
        return f"[AVAILABLE_TOOLS]{schemas_json}[/AVAILABLE_TOOLS]"

    @staticmethod
    def _format_observation(exec_result, behavior: dict) -> str:
        """Wrap code execution result in model-specific observation tokens."""
        obs_fmt = behavior.get("code_result_format", "<observation>")
        if obs_fmt.startswith("["):
            obs_close = obs_fmt.replace("[", "[/", 1)
        elif obs_fmt.startswith("<"):
            obs_close = obs_fmt.replace("<", "</", 1)
        else:
            obs_close = obs_fmt
        content = exec_result.stdout or ""
        if exec_result.stderr:
            content += f"\nError:\n{exec_result.stderr}"
        return f"{obs_fmt}{content}{obs_close}"

    # ═══════════════════════════════════════════
    # Internal — context builders
    # ═══════════════════════════════════════════

    def _build_plan_checklist(self, conv_id: str) -> str:
        """Build plan checklist with current step statuses for system prompt injection."""
        plan_state = self._plan_states.get(conv_id)
        if not plan_state:
            return ""

        steps = plan_state["steps"]
        results = plan_state["all_results"]
        current_step = plan_state.get("current_step", 0)
        goal = plan_state.get("goal", "")

        # Build result lookup: step_index → result
        result_map: Dict[int, dict] = {}
        for r in results:
            idx = r.get("step")
            if idx is not None:
                result_map[idx - 1] = r  # step is 1-indexed in results

        lines = [f"# Current Plan: {goal}", ""]
        for i, step in enumerate(steps):
            name = step.get("name", f"Step {i + 1}")
            if i in result_map:
                r = result_map[i]
                if r.get("success"):
                    lines.append(f"{i + 1}. [✓] {name} (completed)")
                else:
                    lines.append(f"{i + 1}. [✗] {name} (failed)")
            elif i == current_step:
                lines.append(f"{i + 1}. [→] {name} (current)")
            else:
                lines.append(f"{i + 1}. [ ] {name}")

        return "\n".join(lines)

    def _build_step_context(
        self, step: dict, step_idx: int, prev_results: list
    ) -> str:
        """Build step execution context string.

        Ported from inference.py lines 3101-3108.
        Previous results are no longer included here — they are provided
        as a plan checklist in the system prompt instead.
        """
        name = step.get("name", f"Step {step_idx + 1}")
        desc = step.get("description", "")
        ref_ctx = self._build_ref_context(step)

        parts = [f"Execute step {step_idx + 1}: {name}."]
        if desc:
            parts.append(desc)
        if ref_ctx:
            parts.append(ref_ctx)
        tool_name = step.get("tool", "")
        if tool_name:
            parts.append(f"You MUST use the '{tool_name}' tool for this step.")
        else:
            parts.append("Choose and call the appropriate tool(s).")

        return " ".join(parts[:3]) + ("\n" + "\n".join(parts[3:]) if len(parts) > 3 else "")

    async def _execute_biomni_tool(
        self, dotted_name: str, arguments: dict, conv_id: str, step_idx: int,
    ) -> dict:
        """Execute a Biomni tool call directly via CodeExecutor.

        Converts biomni.tool.module.func_name + arguments into executable Python
        code, runs it, and returns the result.

        Example:
          biomni.tool.literature.query_pubmed + {"query": "BRCA1", "lang": "en"}
          →  from biomni.tool.literature import query_pubmed
             result = query_pubmed(query="BRCA1", lang="en")
             print(result)
        """
        from tools.code_executor import CodeExecutor

        parts = dotted_name.split(".")
        func_name = parts[-1]
        module_path = ".".join(parts[:-1])  # e.g. biomni.tool.literature

        # Build Python code from arguments
        args_parts = []
        for k, v in arguments.items():
            if isinstance(v, str):
                args_parts.append(f'{k}="{v}"')
            else:
                args_parts.append(f"{k}={v!r}")
        args_str = ", ".join(args_parts)

        code = (
            f"from {module_path} import {func_name}\n"
            f"result = {func_name}({args_str})\n"
            f"print(result)"
        )

        logger.info(f"[biomni_tool] Executing {dotted_name}({args_str})")

        executor = CodeExecutor()
        try:
            exec_result = await executor.execute(
                code=code, language="python",
                conv_id=conv_id, step_id=str(step_idx),
            )
            success = exec_result.return_code == 0
            result = {
                "success": success,
                "result": {
                    "stdout": exec_result.stdout or "",
                    "stderr": exec_result.stderr or "",
                    "code": code,
                    "tool_name": dotted_name,
                    "figures": getattr(exec_result, "figures", []) or [],
                    "tables": getattr(exec_result, "tables", []) or [],
                },
            }
            if not success:
                result["error"] = exec_result.stderr[:500] if exec_result.stderr else "Unknown error"
            logger.info(
                f"[biomni_tool] {dotted_name} {'OK' if success else 'FAIL'}: "
                f"stdout={len(exec_result.stdout or '')}c"
            )
            return result
        except Exception as e:
            logger.error(f"[biomni_tool] {dotted_name} execution error: {e}")
            return {"success": False, "error": str(e), "result": None}

    def _build_code_gen_context(
        self, step: dict, step_idx: int, conv_id: str
    ) -> str:
        """Build context for code_gen tool invocation.

        Ported from inference.py lines 3024-3049.
        """
        plan_state = self._plan_states.get(conv_id, {})
        settings = get_settings()

        parts = []

        # File references from step
        file_refs = self._collect_file_refs(step)
        if file_refs:
            parts.append(f"Referenced files: {', '.join(file_refs)}")

        # Previous results
        prev_results = plan_state.get("all_results", [])
        if prev_results:
            parts.append(f"Previous results: {json.dumps(prev_results, ensure_ascii=False, default=str)}")

        # Data directory
        data_dir = f"{settings.OUTPUTS_DIR}/{conv_id}"
        parts.append(f"Output directory: {data_dir}")

        # Retrieved Biomni tool descriptions (from tool retrieval)
        retrieved_desc = plan_state.get("_retrieved_tool_desc", "")
        if retrieved_desc:
            parts.append(f"Available Biomni functions:\n{retrieved_desc}")

        return "\n".join(parts)

    def _build_ref_context(self, step: dict) -> str:
        """Build reference data context from step.

        Ported from inference.py lines 602-625.
        """
        ref_data = step.get("reference_data") or step.get("references")
        if not ref_data:
            return ""

        if isinstance(ref_data, str):
            return f"\n[Reference Data]\n{ref_data}"

        if isinstance(ref_data, list):
            items = []
            for ref in ref_data:
                if isinstance(ref, dict):
                    items.append(
                        f"- {ref.get('name', 'Unknown')}: {ref.get('description', '')}"
                    )
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

    def _build_messages_from_history(
        self, db_messages: list, system_prompt: str
    ) -> List:
        """Convert DB message dicts to LangChain messages.

        Filters out [PLAN_COMPLETE] messages to avoid stale plan data.
        """
        messages = []
        for msg in db_messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            # Skip PLAN_COMPLETE messages
            if "[PLAN_COMPLETE]" in content:
                continue

            if role == "system":
                messages.append(SystemMessage(content=content))
            elif role == "user":
                messages.append(HumanMessage(content=content))
            elif role == "assistant":
                messages.append(AIMessage(content=content))

        return messages

    async def _process_files(
        self, files: Optional[List[Dict[str, Any]]]
    ) -> tuple[str, List]:
        """Process file list for message enrichment.

        Ported from inference.py lines 2601-2652.
        Returns (text_to_prepend, processed_files_list).
        """
        if not files:
            return "", []

        text_parts = []
        processed = []

        for f in files:
            file_type = f.get("type", "")
            name = f.get("name", "unknown")

            if file_type == "document":
                text_content = f.get("textContent", "")
                if text_content:
                    text_parts.append(f"[Document: {name}]\n{text_content}\n")
                processed.append({"type": "document", "name": name})

            elif file_type == "image":
                upload_id = f.get("uploadId", "")
                data = f.get("data", "")
                entry = {"type": "image", "name": name}
                if upload_id:
                    entry["uploadId"] = upload_id
                    text_parts.append(f"[Image: {name}]")
                elif data:
                    entry["data"] = data
                    text_parts.append(f"[Image: {name}]")
                processed.append(entry)

            elif file_type == "audio":
                data = f.get("data", "")
                entry = {"type": "audio", "name": name}
                if data:
                    entry["data"] = data
                text_parts.append(f"[Audio: {name}]")
                processed.append(entry)

        file_text = "\n".join(text_parts) + "\n" if text_parts else ""
        return file_text, processed

    def _get_plan_state(self, conv_id: str) -> dict:
        """Return plan state for conv_id. Empty dict if not found."""
        return self._plan_states.get(conv_id, {})

    async def _save_plan_complete(
        self, conv_id: str, conv_svc: ConversationService, stopped: bool = False
    ) -> dict:
        """Build and save PLAN_COMPLETE data to DB."""
        plan_state = self._plan_states.get(conv_id, {})
        plan_complete_data = {
            "goal": plan_state.get("goal", ""),
            "steps": plan_state.get("steps", []),
            "results": plan_state.get("all_results", []),
        }
        if stopped:
            plan_complete_data["stopped"] = True

        plan_json = json.dumps(plan_complete_data, ensure_ascii=False, default=str)
        await conv_svc.replace_last_plan_message(
            UUID(conv_id), f"[PLAN_COMPLETE]{plan_json}"
        )
        return plan_complete_data

    @staticmethod
    def _generate_plan_summary(plan_state: dict) -> str:
        """Generate a brief markdown summary of plan execution results."""
        goal = plan_state.get("goal", "")
        steps = plan_state.get("steps", [])
        results = plan_state.get("all_results", [])

        total = len(steps)
        success_count = sum(1 for r in results if r.get("success"))
        failed_count = total - success_count
        tools_used = sorted(set(r.get("tool", "unknown") for r in results))

        parts = [f"## 연구 목표\n{goal}\n"]
        parts.append(f"**전체 단계**: {total}개 · **성공**: {success_count}개 · **실패**: {failed_count}개")
        if tools_used:
            parts.append(f"**사용 도구**: {', '.join(tools_used)}\n")

        parts.append("## 단계별 결과\n")
        for r in results:
            step_num = r.get("step", "?")
            tool = r.get("tool", "unknown")
            ok = "✅" if r.get("success") else "❌"
            step_name = ""
            if step_num and isinstance(step_num, int) and step_num <= len(steps):
                step_name = steps[step_num - 1].get("name", "")
            parts.append(f"### Step {step_num}: {step_name} ({tool}) {ok}")
            result_data = r.get("result", {})
            if isinstance(result_data, dict):
                if "solution" in result_data:
                    parts.append(str(result_data["solution"])[:300])
                elif "text" in result_data:
                    parts.append(str(result_data["text"])[:300])
                elif "stdout" in result_data and result_data["stdout"]:
                    parts.append(f"```\n{str(result_data['stdout'])[:200]}\n```")
            parts.append("")

        return "\n".join(parts)

    def _parse_plan_tool_call(self, response: str, user_message: str) -> Optional[Dict[str, Any]]:
        """Parse plan JSON from LLM response.

        Handles multiple output formats:
        - [TOOL_CALLS]create_plan[ARGS]{JSON}
        - ```json {...} ``` code blocks
        - Natural language with embedded steps
        """
        # Pre-process: strip think tokens (completed and unclosed)
        cleaned = re.sub(r'\[THINK\][\s\S]*?\[/THINK\]', '', response)
        cleaned = re.sub(r'<think>[\s\S]*?</think>', '', cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r'\[THINK\][\s\S]*$', '', cleaned)
        cleaned = re.sub(r'<think>[\s\S]*$', '', cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.strip()

        # Strategy 0: JSON code block (```json ... ```)
        json_block = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', cleaned)
        if json_block:
            try:
                data = json.loads(json_block.group(1))
                if data.get("steps"):
                    logger.info(f"Plan parsed via JSON code block: {len(data['steps'])} steps")
                    return self._validate_plan_data(data)
            except json.JSONDecodeError:
                pass

        # Strategy 1: Find [ARGS] marker and parse JSON
        args_idx = cleaned.find("[ARGS]")
        if args_idx >= 0:
            json_str = cleaned[args_idx + 6:].strip()
            # Try direct parse
            try:
                data = json.loads(json_str)
                if data.get("steps"):
                    logger.info(f"Plan parsed via [ARGS]: {len(data['steps'])} steps")
                    return self._validate_plan_data(data)
            except json.JSONDecodeError:
                pass

            # Try balanced brace extraction
            brace_start = json_str.find("{")
            if brace_start >= 0:
                depth = 0
                for i, c in enumerate(json_str[brace_start:]):
                    if c == "{":
                        depth += 1
                    elif c == "}":
                        depth -= 1
                    if depth == 0:
                        try:
                            data = json.loads(json_str[brace_start:brace_start + i + 1])
                            if data.get("steps"):
                                logger.info(f"Plan parsed via brace match: {len(data['steps'])} steps")
                                return self._validate_plan_data(data)
                        except json.JSONDecodeError:
                            pass
                        break

        # Strategy 2: Regex extraction from partial/malformed JSON
        if args_idx >= 0:
            json_str = cleaned[args_idx + 6:].strip()
            goal_match = re.search(r'"goal"\s*:\s*"([^"]+)"', json_str)
            goal = goal_match.group(1) if goal_match else user_message[:80]
            step_matches = re.findall(
                r'\{"name"\s*:\s*"([^"]{1,50})"\s*,\s*"description"\s*:\s*"([^"]{1,200})"',
                json_str,
            )
            if step_matches:
                steps = [{"name": n.strip(), "description": d.strip()} for n, d in step_matches]
                logger.info(f"Plan parsed via regex recovery: {len(steps)} steps")
                return {"goal": goal, "steps": steps}

        # Strategy 3: Fallback to natural language parsing
        logger.warning("Structured plan parsing failed, trying text extraction")
        return self._extract_plan_from_text(cleaned, user_message)

    @staticmethod
    def _validate_plan_data(data: dict) -> Optional[Dict[str, Any]]:
        """Validate and clean plan data from JSON parsing."""
        goal = data.get("goal", "")
        # Enforce goal length
        if len(goal) > 80:
            goal = goal[:80].rsplit(" ", 1)[0] if " " in goal[:80] else goal[:80]
        # Strip markdown from goal
        goal = re.sub(r'\*+', '', goal).strip()
        goal = goal.lstrip("#").strip()

        steps = []
        for s in data.get("steps", []):
            if not isinstance(s, dict):
                continue
            name = s.get("name", "").strip()
            desc = s.get("description", "").strip()
            if name:
                clean_step = {"name": name[:50], "description": desc[:200]}
                steps.append(clean_step)

        return {"goal": goal, "steps": steps} if steps else None

    @staticmethod
    def _extract_plan_from_text(text: str, user_message: str) -> Optional[Dict[str, Any]]:
        """PRIMARY plan parser: extract goal + steps from LLM natural-language output.

        The LLM generates a plan as a checklist with a title line on top.
        This method extracts the goal (title) and steps from that text.

        Tries multiple strategies:
        1. JSON-like create_plan arguments embedded in text
        2. Numbered lists (1. ..., 2. ...)
        3. Bullet points (- ..., * ...)
        4. Bold/header items (**Step**: ...)

        Goal extraction: first meaningful non-list line before the checklist,
        excluding think blocks, markdown headers (#), and empty lines.
        """
        import re

        # Strip think blocks (both <think>...</think> and [THINK]...[/THINK])
        cleaned = re.sub(r'<think>[\s\S]*?</think>', '', text, flags=re.IGNORECASE)
        cleaned = re.sub(r'\[THINK\][\s\S]*?\[/THINK\]', '', cleaned, flags=re.IGNORECASE)

        lines = cleaned.strip().split("\n")
        steps: list = []

        # Strategy 1: Try to find JSON create_plan arguments in text
        json_pat = re.compile(
            r'create_plan\s*[\({]\s*["\']?(?:name|goal)["\']?\s*[:=]',
            re.IGNORECASE,
        )
        if json_pat.search(text):
            # Try to extract JSON object after create_plan
            brace_pat = re.compile(r'create_plan\s*\(?\s*(\{[\s\S]*?\})\s*\)?')
            for m in brace_pat.finditer(text):
                try:
                    data = json.loads(m.group(1))
                    if "steps" in data and isinstance(data["steps"], list):
                        raw_goal = data.get("goal", data.get("name", user_message[:80]))
                        # Enforce goal constraints: first line, max 80 chars, strip markdown
                        goal = re.sub(r'\*+', '', str(raw_goal)).split("\n")[0].strip()[:80]
                        return {
                            "goal": goal or user_message[:80],
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

        # ── Goal extraction helper ──
        def _extract_goal(lines_list: list, first_step_line_idx: int) -> str:
            """Find the plan title/goal from lines before the first step."""
            for i in range(first_step_line_idx):
                line = lines_list[i].strip()
                if not line:
                    continue
                # Skip markdown headers with just "#" prefix — extract text after "#"
                if line.startswith("#"):
                    line = line.lstrip("#").strip()
                # Strip markdown bold/italic formatting
                line = re.sub(r'\*+', '', line).strip()
                if not line or len(line) <= 3:
                    continue
                # Skip lines that look like meta/intro text
                if any(line.lower().startswith(w) for w in (
                    "here", "now", "let", "i will", "i'll", "below",
                    "다음", "아래", "이제", "먼저",
                )):
                    continue
                # Use first line only (no multiline goals)
                goal = line.split("\n")[0].strip()
                # Truncate to 80 chars max
                if len(goal) > 80:
                    goal = goal[:80].rsplit(" ", 1)[0] if " " in goal[:80] else goal[:80]
                return goal
            # Fallback: first 80 chars of user message
            fallback = user_message[:80] if user_message else "Research Plan"
            return fallback.split("\n")[0].strip()

        # Helper: split "Name: description" or "Name - description" patterns
        def _split_name_desc(text: str) -> tuple:
            """Split step text into (name, description) if colon/dash separator found."""
            for sep in (":", "：", " - ", " – "):
                if sep in text:
                    parts = text.split(sep, 1)
                    name_part = parts[0].strip()
                    desc_part = parts[1].strip() if len(parts) > 1 else ""
                    if name_part and len(name_part) >= 3 and desc_part:
                        # Truncate: name max 100, description max 200 (first line only)
                        desc_first_line = desc_part.split("\n")[0].strip()
                        return (name_part[:100], desc_first_line[:200])
            # First line only, max 100 chars for name
            first_line = text.split("\n")[0].strip()
            return (first_line[:100], "")

        # Strategy 2: Numbered list items
        numbered_pat = re.compile(
            r"^\s*(\d+)[.)]\s*(?:\[[ x✓✗]?\]\s*)?"  # number + optional checkbox
            r"(.+)",
            re.IGNORECASE,
        )
        first_step_idx = None
        for idx, line in enumerate(lines):
            m = numbered_pat.match(line)
            if m:
                step_text = m.group(2).strip().rstrip(".")
                # Filter out very short or meta-text lines
                if step_text and len(step_text) > 5 and not step_text.lower().startswith(("here", "now", "let", "wait", "the ")):
                    if first_step_idx is None:
                        first_step_idx = idx
                    name, desc = _split_name_desc(step_text)
                    steps.append({"name": name, "description": desc or step_text})

        if len(steps) >= 2:
            goal = _extract_goal(lines, first_step_idx or 0)
            return {
                "goal": goal,
                "steps": steps[:10],
            }

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
                    steps.append({"name": name, "description": desc or step_text})

        if len(steps) >= 2:
            goal = _extract_goal(lines, first_step_idx or 0)
            return {
                "goal": goal,
                "steps": steps[:10],
            }

        # Strategy 4: Bold items like **Data collection**:
        steps = []
        first_step_idx = None
        bold_pat = re.compile(r"\*\*([^*]+)\*\*\s*[:：]?\s*(.*)")
        for idx, line in enumerate(lines):
            m = bold_pat.search(line)
            if m:
                name = m.group(1).strip()
                desc = m.group(2).strip() if m.group(2) else name
                if name and len(name) > 3:
                    if first_step_idx is None:
                        first_step_idx = idx
                    steps.append({"name": name[:100], "description": desc or name})

        if len(steps) >= 2:
            goal = _extract_goal(lines, first_step_idx or 0)
            return {
                "goal": goal,
                "steps": steps[:10],
            }

        return None

    def _cleanup(self, conv_id: str) -> None:
        """Clean up plan state and stop flag for conv_id."""
        self._plan_states.pop(conv_id, None)
        self._stop_flags.pop(conv_id, None)
