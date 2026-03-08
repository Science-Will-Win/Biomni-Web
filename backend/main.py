import os
import re
import sys
import logging
import json
import uuid
import time
import requests
from datetime import datetime
from typing import Optional, List, Any, Dict
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
import asyncio
from dotenv import load_dotenv

# [로컬 개발용] 상위 폴더(.env)의 환경변수 로드
load_dotenv(dotenv_path="../.env")

# --- [Monkey Patching: 호환성 해결] ---
import langchain_core.callbacks
import langchain_core.callbacks.base
import langchain_core.agents
import langchain_core.documents
import langchain_core.messages
import langchain_core.outputs

sys.modules["langchain.callbacks"] = langchain_core.callbacks
sys.modules["langchain.callbacks.base"] = langchain_core.callbacks.base
sys.modules["langchain.schema"] = langchain_core.messages 
sys.modules["langchain.schema.agent"] = langchain_core.agents
sys.modules["langchain.schema.document"] = langchain_core.documents

# [Langfuse & LangChain Integrations]
from langchain_core.messages import SystemMessage, HumanMessage
from langfuse.decorators import observe, langfuse_context
from langfuse.callback import CallbackHandler

# --- [Biomni Import] ---
from biomni.agent.a1 import A1

load_dotenv(dotenv_path="../.env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("BiomniWeb")

app = FastAPI()

if os.path.exists("/app/data"):
    app.mount("/data", StaticFiles(directory="/app/data"), name="data")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

active_sessions: Dict[str, A1] = {}

def get_or_create_agent(session_id: str) -> A1:
    """세션 ID별로 에이전트를 생성하되, 데이터 경로는 공유하는 함수"""
    if session_id not in active_sessions:
        logger.info(f"Initializing new Biomni Agent for session: {session_id}")
        
        # 공용 베이스 폴더 경로만 사용
        base_data_path = os.getenv("BIOMNI_DATA_PATH", "../biomni_data")
        os.makedirs(base_data_path, exist_ok=True)
        
        try:
            # 개별 폴더(user_data_path) 대신 공용 폴더(base_data_path)를 바라보게 수정
            active_sessions[session_id] = A1(path=base_data_path)
            logger.info(f"Biomni Agent initialized successfully for {session_id}.")
        except Exception as e:
            logger.error(f"Failed to initialize Biomni Agent for {session_id}: {e}")
            raise HTTPException(status_code=500, detail="Agent initialization failed")
            
    return active_sessions[session_id]

class ChatRequest(BaseModel):
    message: str
    session_id: str = "default_session" # 클라이언트(또는 배치 스크립트)에서 세션 ID를 넘겨받음

class ChatResponse(BaseModel):
    response: str
    logs: List[Any]
    raw_data: List[Any] = []  # 원본 로그 데이터를 담을 필드 추가
    refined_data: Dict[str, Any] = {}

def sanitize_for_json(obj):
    """복잡한 AI 객체를 JSON으로 변환 가능한 기본 타입으로 분해하는 함수"""
    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple, set)):
        return [sanitize_for_json(i) for i in obj]
    elif hasattr(obj, "dict") and callable(getattr(obj, "dict")):
        try: return sanitize_for_json(obj.dict())
        except: pass
    elif hasattr(obj, "model_dump") and callable(getattr(obj, "model_dump")):
        try: return sanitize_for_json(obj.model_dump())
        except: pass
    elif isinstance(obj, (str, int, float, bool, type(None))):
        return obj
    return str(obj) # 변환할 수 없는 객체는 문자열로 강제 변환하여 에러 방지

@app.post("/api/chat", response_model=ChatResponse)
@observe(name="Biomni Chat Interaction")
async def chat_endpoint(request: ChatRequest):
    # 1. 매 요청마다 .env 강제 재로드 (환경변수 실시간 반영)
    load_dotenv(dotenv_path="../.env", override=True)
    
    # 2. 세션 ID에 맞는 독립된 에이전트 호출
    current_agent = get_or_create_agent(request.session_id)
    
    logger.info(f"[Session: {request.session_id}] Received request: {request.message}")
    
    try:
        langfuse_handler = langfuse_context.get_current_langchain_handler()
        
        # 3. ThreadPool을 사용하여 비동기 블로킹(Blocking) 방지 -> 병렬 처리 가능
        response_log, response_content = await run_in_threadpool(
            current_agent.go, 
            prompt=request.message, 
            callbacks=[langfuse_handler], 
            session_id=request.session_id
        )
        
        langfuse_context.update_current_trace(
            output=str(response_content),
            metadata={"full_log_length": len(response_log), "session_id": request.session_id}
        )

        langfuse_context.flush()
        trace_id = langfuse_context.get_current_trace_id()
        time.sleep(3) 
        
        langfuse_host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com").rstrip("/")
        public_key = os.getenv("LANGFUSE_PUBLIC_KEY")
        secret_key = os.getenv("LANGFUSE_SECRET_KEY")
        
        api_url = f"{langfuse_host}/api/public/traces/{trace_id}"
        api_response = requests.get(api_url, auth=(public_key, secret_key))
        
        if api_response.status_code == 200:
            full_trace_data = api_response.json()
            
            def find_system_content(obj):
                if isinstance(obj, dict):
                    if obj.get("type") in ["system", "system_message"] and "content" in obj:
                        return str(obj["content"])
                    if isinstance(obj.get("id"), list) and obj.get("id") and obj.get("id")[-1] == "SystemMessage":
                        return str(obj.get("kwargs", {}).get("content", ""))
                    if obj.get("role") == "system" and "content" in obj:
                        return str(obj["content"])
                    for k, v in obj.items():
                        res = find_system_content(v)
                        if res: return res
                elif isinstance(obj, (list, tuple)):
                    for item in obj:
                        res = find_system_content(item)
                        if res: return res
                return ""

            messages = []
            
            # 1. System Message (맨 처음에 한 번만)
            extracted_sys_content = find_system_content(full_trace_data)
            sys_content = extracted_sys_content
            messages.append({"type": "system", "content": sys_content})
            
            # 2. LangGraph span 찾기
            observations = full_trace_data.get("observations", [])
            observations.sort(key=lambda x: x.get("startTime", "")) 
            
            langgraph_messages = []
            for obs in observations:
                obs_name = obs.get("name", "").lower()
                
                # --- [추가됨] Tool Retrieval 스팬 추출 ---
                if "tool retrieval" in obs_name or "tool_retrieval" in obs_name:
                    req_val = obs.get("input", "")
                    res_val = obs.get("output", "")
                    
                    if req_val:
                        messages.append({"type": "tool_retrieval", "content": str(req_val)})
                    if res_val:
                        messages.append({"type": "Result", "content": str(res_val)})
                        
                # --- [기존] LangGraph 스팬 추출 ---
                elif obs_name == "langgraph":
                    obs_output = obs.get("output", {})
                    if isinstance(obs_output, dict) and "messages" in obs_output:
                        langgraph_messages = obs_output["messages"]
                    elif isinstance(obs.get("input"), dict) and "messages" in obs["input"]:
                        langgraph_messages = obs["input"]["messages"]
            
            # 3. [핵심] 어떠한 조건 검사나 덮어쓰기 없이, 발생한 턴을 100% 순차적으로 추가!
            for msg in langgraph_messages:
                m_type = msg.get("type", "")
                m_content = msg.get("content", "")
                
                if not m_content:
                    continue
                
                if m_type == "system":
                    # 시스템 프롬프트는 1번 과정에서 이미 넣었으므로 중복 방지를 위해 패스
                    continue
                elif m_type == "human":
                    messages.append({"type": "human", "content": m_content})
                elif m_type == "ai":
                    if m_content.startswith("<observation>"):
                        messages.append({"type": "Result", "content": m_content})
                    else:
                        messages.append({"type": "LLM", "content": m_content})
                else:
                    messages.append({"type": m_type, "content": m_content})

            refined_data = {
                "trace_id": trace_id,
                "final_answer": str(response_content),
                "messages": messages
            }

        safe_logs = sanitize_for_json(response_log)
        return {
            "response": str(response_content),
            "logs": safe_logs,
            "raw_data": safe_logs,  # 중요하다고 하신 원본 로그 데이터
            "refined_data": refined_data if 'refined_data' in locals() else {}
        }
    
    except Exception as e:
        logger.error(f"Error during execution: {e}")
        langfuse_context.update_current_trace(tags=["ERROR"], metadata={"error": str(e)})
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    """배치 처리가 끝난 후 메모리 누수를 방지하기 위해 세션(에이전트)을 삭제합니다."""
    if session_id in active_sessions:
        del active_sessions[session_id]
        logger.info(f"Session {session_id} cleaned up successfully.")
        return {"status": "success", "message": "Session deleted"}
    return {"status": "not_found"}

@app.post("/api/chat_stream")
async def chat_stream_endpoint(request: ChatRequest):
    # 환경변수 실시간 갱신 및 에이전트 할당
    load_dotenv(dotenv_path="../.env", override=True)
    current_agent = get_or_create_agent(request.session_id)
    
    logger.info(f"[Stream] Session: {request.session_id} Started for: {request.message}")
    
    async def event_generator():
        inputs = {"messages": [HumanMessage(content=request.message)], "next_step": None}
        config = {"recursion_limit": 500, "configurable": {"thread_id": request.session_id}}
        
        try:
            # LangGraph의 astream을 사용하여 각 노드(plan, generate, execute) 실행이 끝날 때마다 결과 획득
            async for event in current_agent.app.astream(inputs, stream_mode="updates", config=config):
                for node_name, node_data in event.items():
                    if "messages" in node_data:
                        for msg in node_data["messages"]:
                            content = msg.content if hasattr(msg, "content") else str(msg)
                            
                            # 내부 시스템용 진행 트리거 메시지는 화면에 노출하지 않음
                            if "Plan established. Please proceed" in content:
                                continue
                            
                            if content.strip():
                                chunk = {
                                    "node": node_name,
                                    "content": content
                                }
                                # SSE 규격에 맞추어 클라이언트에 전송
                                yield f"data: {json.dumps(chunk)}\n\n"
                                await asyncio.sleep(0.1) # 버퍼 밀림 방지
                                
            # 모든 그래프 실행이 끝나면 종료 신호 전송
            yield f"data: {json.dumps({'node': 'END', 'content': '[DONE]'})}\n\n"
            
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'node': 'ERROR', 'content': f'Error: {str(e)}'})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)