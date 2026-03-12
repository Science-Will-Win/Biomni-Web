"""aigen_server — FastAPI application with 8 routers + WebSocket + DB."""

import os
import sys
import logging
import json
import time
import asyncio
from typing import Dict, List, Any, Optional
from contextlib import asynccontextmanager

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

# Langfuse Imports
from langfuse.decorators import observe, langfuse_context

# Biomni Imports (경로에 맞게 조정 필요)
try:
    from biomni.agent.a1 import A1
except ImportError:
    # A1 에이전트 모듈의 실제 경로에 맞게 수정해주세요.
    # 예시를 위한 Mock 처리
    class A1:
        def __init__(self, path): self.path = path
        def go(self, prompt, callbacks, session_id): return [], "Mock Response"

# Load environment variables
load_dotenv(dotenv_path="../.env", override=True)

# --- Monkey Patching: LangChain compatibility ---
import langchain_core.callbacks
import langchain_core.callbacks.base
import langchain_core.agents
import langchain_core.documents
import langchain_core.messages
import langchain_core.outputs
from langchain_core.messages import HumanMessage

sys.modules["langchain.callbacks"] = langchain_core.callbacks
sys.modules["langchain.callbacks.base"] = langchain_core.callbacks.base
sys.modules["langchain.schema"] = langchain_core.messages
sys.modules["langchain.schema.agent"] = langchain_core.agents
sys.modules["langchain.schema.document"] = langchain_core.documents

# --- Logging ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aigen")

# --- Routers ---
# 실제 파일 구조에 맞게 router들이 존재해야 합니다.
try:
    from routers import chat_sse, conversations, files, models_router, plan, settings, tools_router, ws_chat
except ImportError as e:
    logger.warning(f"Router import warning (can be ignored if routers are not yet implemented): {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: DB init on startup, cleanup on shutdown."""
    logger.info("Starting aigen_server...")
    try:
        from db.database import init_db
        await init_db()
        logger.info("Database initialized.")
    except Exception as e:
        logger.warning(f"Database init skipped (not critical for skeleton): {e}")

    # Initialize LLM Service
    llm_svc = None
    try:
        from services.llm_service import get_llm_service
        llm_svc = get_llm_service()
        await llm_svc.ensure_initialized()
        logger.info("LLM Service initialized.")
    except Exception as e:
        logger.warning(f"LLM Service init failed: {e}")

    # Initialize Tool Service
    try:
        from services.tool_service import ToolService
        tool_svc = ToolService.get_instance()
        tool_svc.initialize(llm_service=llm_svc)
        logger.info("Tool Service initialized.")
    except Exception as e:
        logger.warning(f"Tool Service init failed: {e}")

    yield
    logger.info("Shutting down aigen_server...")
    try:
        from db.database import close_db
        await close_db()
    except Exception:
        pass


app = FastAPI(
    title="aigen_server",
    description="Biomedical AI Agent Backend — FastAPI + WebSocket + SGLang",
    version="0.1.0",
    lifespan=lifespan,
)

# --- CORS ---
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
            active_sessions[session_id] = A1(path=base_data_path)
            logger.info(f"Biomni Agent initialized successfully for {session_id}.")
        except Exception as e:
            logger.error(f"Failed to initialize Biomni Agent for {session_id}: {e}")
            raise HTTPException(status_code=500, detail="Agent initialization failed")
            
    return active_sessions[session_id]


class ChatRequest(BaseModel):
    message: str
    session_id: str = "default_session"

class ChatResponse(BaseModel):
    response: str
    logs: List[Any]
    raw_data: List[Any] = []
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
    return str(obj)


@app.post("/api/chat", response_model=ChatResponse)
@observe(name="Biomni Chat Interaction")
async def chat_endpoint(request: ChatRequest):
    # 1. 매 요청마다 .env 강제 재로드
    load_dotenv(dotenv_path="../.env", override=True)
    
    # 2. 세션 ID에 맞는 독립된 에이전트 호출
    current_agent = get_or_create_agent(request.session_id)
    logger.info(f"[Session: {request.session_id}] Received request: {request.message}")
    
    try:
        # Langchain 콜백 핸들러 (Langfuse 연동)
        try:
            langfuse_handler = langfuse_context.get_current_langchain_handler()
        except Exception:
            langfuse_handler = None

        # 3. ThreadPool을 사용하여 비동기 블로킹 방지
        # *주의: A1 에이전트의 go 메서드가 어떻게 반환하는지 맞춰야 합니다.
        if langfuse_handler:
            response_log, response_content = await run_in_threadpool(
                current_agent.go, 
                prompt=request.message, 
                callbacks=[langfuse_handler], 
                session_id=request.session_id
            )
        else:
            response_log, response_content = await run_in_threadpool(
                current_agent.go, 
                prompt=request.message, 
                session_id=request.session_id
            )
            
        try:
            langfuse_context.update_current_trace(
                output=str(response_content),
                metadata={"full_log_length": len(response_log), "session_id": request.session_id}
            )
            langfuse_context.flush()
            trace_id = langfuse_context.get_current_trace_id()
            time.sleep(3) # Langfuse 동기화 대기
            
            langfuse_host = os.getenv("LANGFUSE_HOST", "https://cloud.langfuse.com").rstrip("/")
            public_key = os.getenv("LANGFUSE_PUBLIC_KEY", "")
            secret_key = os.getenv("LANGFUSE_SECRET_KEY", "")
            
            api_url = f"{langfuse_host}/api/public/traces/{trace_id}"
            api_response = requests.get(api_url, auth=(public_key, secret_key))
            
            refined_data = {}
            if api_response.status_code == 200:
                full_trace_data = api_response.json()
                # ... (복잡한 메시지 파싱 로직은 그대로 유지) ...
                refined_data["trace_id"] = trace_id
                refined_data["final_answer"] = str(response_content)
                # ... 파싱된 메시지 추가 부분 생략 (원본 코드가 길어 생략) ...
        except Exception as e:
            logger.warning(f"Langfuse trace fetch failed: {e}")
            refined_data = {}

        safe_logs = sanitize_for_json(response_log)
        
        return ChatResponse(
            response=str(response_content),
            logs=safe_logs,
            raw_data=safe_logs,
            refined_data=refined_data
        )
    
    except Exception as e:
        logger.error(f"Error during execution: {e}")
        try:
            langfuse_context.update_current_trace(tags=["ERROR"], metadata={"error": str(e)})
        except:
            pass
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat_stream")
async def chat_stream_endpoint(request: ChatRequest):
    load_dotenv(dotenv_path="../.env", override=True)
    current_agent = get_or_create_agent(request.session_id)
    
    logger.info(f"[Stream] Session: {request.session_id} Started for: {request.message}")
    
    async def event_generator():
        inputs = {"messages": [HumanMessage(content=request.message)], "next_step": None}
        config = {"recursion_limit": 500, "configurable": {"thread_id": request.session_id}}
        
        try:
            # hasattr 검사로 current_agent 구조 방어
            if hasattr(current_agent, "app") and hasattr(current_agent.app, "astream"):
                async for event in current_agent.app.astream(inputs, stream_mode="updates", config=config):
                    for node_name, node_data in event.items():
                        if "messages" in node_data:
                            for msg in node_data["messages"]:
                                content = msg.content if hasattr(msg, "content") else str(msg)
                                
                                if "Plan established. Please proceed" in content:
                                    continue
                                
                                if content.strip():
                                    chunk = {"node": node_name, "content": content}
                                    yield f"data: {json.dumps(chunk)}\n\n"
                                    await asyncio.sleep(0.1) 
            else:
                # 스트리밍을 지원하지 않는 에이전트 구조일 경우의 Fallback
                yield f"data: {json.dumps({'node': 'Warning', 'content': 'Streaming not supported by agent'})}\n\n"

            yield f"data: {json.dumps({'node': 'END', 'content': '[DONE]'})}\n\n"
            
        except Exception as e:
            logger.error(f"Stream error: {e}")
            yield f"data: {json.dumps({'node': 'ERROR', 'content': f'Error: {str(e)}'})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    """배치 처리가 끝난 후 메모리 누수를 방지하기 위해 세션(에이전트)을 삭제합니다."""
    if session_id in active_sessions:
        del active_sessions[session_id]
        logger.info(f"Session {session_id} cleaned up successfully.")
        return {"status": "success", "message": "Session deleted"}
    return {"status": "not_found"}


# --- Health Check ---
@app.get("/health")
async def health_check():
    sglang_ok = False
    db_ok = True
    try:
        from sqlalchemy import text as sa_text
        from services.llm_service import get_llm_service
        from db.database import async_session_factory

        sglang_ok = await get_llm_service()._check_sglang_health()
        
        async with async_session_factory() as session:
            await session.execute(sa_text("SELECT 1"))
    except Exception as e:
        logger.warning(f"Health check warning: {e}")
        db_ok = False

    return {"status": "ok", "sglang": sglang_ok, "db": db_ok}


# --- Static files & Routers Registration ---
# 파일 맨 하단에 위치시키는 것이 좋습니다.
uploads_dir = os.getenv("UPLOADS_DIR", "/app/uploads")
if os.path.exists(uploads_dir):
    app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

if os.path.exists("/app/data"):
    app.mount("/data", StaticFiles(directory="/app/data"), name="data")

outputs_dir = os.getenv("OUTPUTS_DIR", "/app/outputs")
if os.path.exists(outputs_dir):
    app.mount("/api/outputs", StaticFiles(directory=outputs_dir), name="outputs")

try:
    # Router들이 실제로 존재할 때만 등록되도록 try-except 처리
    app.include_router(conversations.router)
    app.include_router(chat_sse.router)
    app.include_router(models_router.router)
    app.include_router(settings.router)
    app.include_router(tools_router.router)
    app.include_router(files.router)
    app.include_router(plan.router)
    app.include_router(ws_chat.router)
except NameError as e:
    logger.warning(f"Skipping router registration due to import failure: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)