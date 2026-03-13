"""Chat Handler — Core chat processing service bridging Backend and original Biomni A1."""

import logging
from typing import AsyncGenerator, Dict, Any, Optional
from uuid import UUID

from langchain_core.messages import HumanMessage, AIMessage

from config import get_settings
from models.schemas import ChatEvent, ChatRequest, StepQuestionRequest, RetryStepRequest
from services.conversation_service import ConversationService
from biomni.agent.a1 import A1
from services.llm_service import get_llm_service, _PROVIDER_TO_SOURCE

logger = logging.getLogger("biomni_backend.chat_handler")

def _ev(event_type: str, data: Dict[str, Any]) -> ChatEvent:
    return ChatEvent(type=event_type, data=data)

class ChatHandler:
    """Singleton. Routes requests to unmodified Biomni A1 agent and manages LangGraph streaming."""

    _instance: Optional["ChatHandler"] = None

    def __init__(self) -> None:
        self._active_agents: Dict[str, A1] = {}
        self._stop_flags: Dict[str, bool] = {}

    @classmethod
    def get_instance(cls) -> "ChatHandler":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _get_agent(self, session_id: str, db) -> A1:
        """세션별 원본 Biomni A1 에이전트를 가져오거나 생성합니다."""
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
                base_url = settings.SGLANG_BASE_URL
                api_key = api_key or "EMPTY"

            # 🚀 아무것도 수정하지 않은 원본 A1 인스턴스 생성!
            agent = A1(
                path=base_data_path,
                llm=model_name,
                source=source,
                base_url=base_url,
                api_key=api_key
            )
            self._active_agents[session_id] = agent
            logger.info(f"Initialized Original A1 Agent for session {session_id} with model {model_name}")
            
        return self._active_agents[session_id]

    def stop(self, conv_id: str) -> bool:
        self._stop_flags[conv_id] = True
        return True

    async def generate_plan(self, prompt: str, conv_id: str, db) -> str:
        """A1의 기본 플랜 생성 호출 (독립적인 Plan API 요청용)"""
        agent = await self._get_agent(conv_id, db)
        import asyncio
        plan = await asyncio.to_thread(agent.go_plan_only, prompt)
        return plan

    async def handle_chat(self, request: ChatRequest, db) -> AsyncGenerator[ChatEvent, None]:
        """LangGraph의 astream_events를 이용해 원본 그래프 흐름을 토큰 단위로 감청(Streaming)합니다."""
        conv_svc = ConversationService(db)
        conv_id = request.conv_id or str((await conv_svc.create_conversation(first_message=request.message)).id)
        self._stop_flags[conv_id] = False

        try:
            # 1. DB에 유저 메시지 저장
            await conv_svc.add_message(UUID(conv_id), "user", request.message)
            
            # 2. DB에서 전체 히스토리 로드 (Graph의 라우팅 분기를 완벽하게 제어)
            # -> len(lc_history) == 1이면 Plan으로, > 1이면 Generate로 A1의 route_start가 알아서 분기함!
            history_msgs = await conv_svc.get_messages(UUID(conv_id))
            lc_history = []
            for msg in history_msgs:
                if msg.role == "user":
                    lc_history.append(HumanMessage(content=msg.content))
                elif msg.role == "assistant":
                    lc_history.append(AIMessage(content=msg.content))
            
            agent = await self._get_agent(conv_id, db)
            full_response = ""

            # 3. LangGraph 실행 입력 (원본 A1의 StateGraph를 그대로 탑니다)
            inputs = {"messages": lc_history, "next_step": None}
            config = {"recursion_limit": 500, "configurable": {"thread_id": conv_id}}

            # 4. LangChain v2 astream_events를 이용한 심층 스트리밍 (그래프 내부의 모든 일을 엿봄)
            async for event in agent.app.astream_events(inputs, version="v2", config=config):
                if self._stop_flags.get(conv_id):
                    yield _ev("done", {"done": True, "stopped": True})
                    break

                kind = event["event"]
                
                # 💬 LLM이 토큰을 내뱉을 때 (Plan 노드, Generate 노드 모두 해당)
                if kind == "on_chat_model_stream":
                    content = event["data"]["chunk"].content
                    chunk_text = ""
                    
                    # Claude의 리스트 포맷과 GPT의 스트링 포맷을 모두 안전하게 파싱 (에러 원천 차단)
                    if isinstance(content, str):
                        chunk_text = content
                    elif isinstance(content, list):
                        chunk_text = "".join(b.get("text", "") for b in content if isinstance(b, dict))
                        
                    if chunk_text:
                        full_response += chunk_text
                        yield _ev("token", {"token": chunk_text})

                # 🏁 특정 노드가 실행을 마쳤을 때의 상태(State) 후처리
                elif kind == "on_chain_end":
                    node_name = event["name"]
                    
                    if node_name == "execute":
                        # Execute 노드가 파이썬을 실행하고 <observation>을 State에 추가한 것을 감지
                        output = event["data"].get("output", {})
                        if output and "messages" in output:
                            last_msg = output["messages"][-1].content
                            if "<observation>" in last_msg:
                                formatted_obs = f"\n{last_msg}\n"
                                full_response += formatted_obs
                                yield _ev("token", {"token": formatted_obs})  # 프론트엔드가 태그를 파싱하도록 던져줌
                                
                    elif node_name == "plan":
                        # Plan 노드가 실행을 마친 상태
                        output = event["data"].get("output", {})
                        if output and "messages" in output:
                            # State에서 LLM이 실제로 내뱉은 가장 최근 메시지(Plan 내용)를 찾습니다.
                            # 'auto_proceed_msg'가 주입되었을 수도 있으므로, 바로 앞의 AIMessage를 찾아야 합니다.
                            plan_msg_content = ""
                            for msg in reversed(output["messages"]):
                                if hasattr(msg, "type") and msg.type == "ai":
                                    plan_msg_content = msg.content
                                    break
                                elif hasattr(msg, "role") and msg.role == "assistant":
                                    plan_msg_content = msg.content
                                    break
                            
                            if plan_msg_content:
                                import re
                                
                                # 1. <solution> 태그 안의 텍스트 추출 시도
                                solution_match = re.search(r"<solution>(.*?)</solution>", plan_msg_content, re.DOTALL | re.IGNORECASE)
                                target_text = solution_match.group(1) if solution_match else plan_msg_content

                                # 2. 정규식을 사용하여 마크다운 체크리스트 파싱
                                # 예: "1. [ ] Download data", "- [x] Process data" 등
                                steps = []
                                pattern = r"^(?:\d+\.|-|\*)\s*\[[ \w]\]\s*(.*)$"
                                
                                for line in target_text.split('\n'):
                                    match = re.match(pattern, line.strip())
                                    if match:
                                        step_name = match.group(1).strip()
                                        steps.append({"name": step_name, "description": step_name, "status": "pending"})

                                # 만약 체크리스트 포맷이 아니더라도, 줄바꿈 기준으로 적당히 파싱
                                if not steps:
                                    for line in target_text.split('\n'):
                                        clean_line = line.strip()
                                        if clean_line and len(clean_line) > 3 and clean_line[0].isdigit():
                                            steps.append({"name": clean_line, "description": clean_line, "status": "pending"})

                                # 3. 프론트엔드로 구조화된 plan_complete 이벤트 전송
                                if steps:
                                    plan_data = {
                                        "goal": "Execution Plan",
                                        "steps": steps
                                    }
                                    yield _ev("plan_complete", {"plan_complete": plan_data})

            # 5. 최종 응답 DB 저장
            if full_response.strip():
                await conv_svc.add_message(UUID(conv_id), "assistant", full_response.strip())

            yield _ev("done", {"done": True})

        except Exception as e:
            logger.exception("Original LangGraph Execution Error")
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