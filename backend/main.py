"""aigen_server — Lightweight API Gateway for Biomni A1"""

import os
import sys
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from pydantic import BaseModel
from biomni.memory.graph_memory import GraphMemory

# A1이 사용할 수 있도록 환경변수 강제 로드
load_dotenv(dotenv_path="../.env", override=True)

# --- Monkey Patching: LangChain compatibility ---
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("biomni_backend")

class FeedbackRequest(BaseModel):
    task_name: str
    tool_name: str
    is_correct: bool
    answer: str

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: DB init and LLM Service init."""
    logger.info("Starting Biomni API Gateway...")
    try:
        from db.database import init_db
        await init_db()
        logger.info("Database initialized successfully.")
    except Exception as e:
        logger.warning(f"Database init skipped: {e}")

    # [수정됨] LLM Service를 초기화하여 Active Model 상태를 복구합니다.
    try:
        from services.llm_service import get_llm_service
        llm_svc = get_llm_service()
        await llm_svc.ensure_initialized()
        logger.info("LLM Service initialized successfully.")
    except Exception as e:
        logger.error(f"LLM Service init failed: {e}")

    try:
        from services.biomni_tools import BiomniToolLoader
        biomni_loader = BiomniToolLoader.get_instance()
        biomni_loader.initialize()
        logger.info("BiomniToolLoader initialized successfully.")
    except Exception as e:
        logger.warning(f"BiomniToolLoader init skipped: {e}")

    # Initialize Biomni Tool Loader (loads 224 tool descriptions from biomni framework)
    try:
        from services.biomni_tools import BiomniToolLoader
        biomni_loader = BiomniToolLoader.get_instance()
        biomni_loader.initialize()
    except Exception as e:
        logger.warning(f"BiomniToolLoader init failed: {e}")

    yield

    logger.info("Shutting down...")
    try:
        from db.database import close_db
        await close_db()
    except Exception:
        pass

app = FastAPI(
    title="Biomni A1 Backend",
    description="API Gateway bridging Frontend to Biomni A1 core agent",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    from services.llm_service import get_llm_service
    from db.database import async_session_factory
    from sqlalchemy import text

    # vLLM health
    svc = get_llm_service()
    vllm_ok = await svc._check_vllm_health()

    # DB health
    db_ok = False
    try:
        async with async_session_factory() as db:
            await db.execute(text("SELECT 1"))
            db_ok = True
    except Exception:
        pass

    return {"status": "ok", "vllm": vllm_ok, "db": db_ok}

@app.post("/api/feedback")
def submit_feedback(req: FeedbackRequest):
    try:
        # 도커 내부이므로 GraphMemory 정상 호출됨
        graph_db = GraphMemory()
        graph_db.update_insight_feedback(
            task_name=req.task_name,
            tool_name=req.tool_name,
            is_correct=req.is_correct,
            response=req.answer
        )
        return {"status": "success", "message": "GraphDB feedback applied"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

uploads_dir = os.getenv("UPLOADS_DIR", "/app/uploads")
if os.path.exists(uploads_dir):
    app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

# --- 라우터 등록 ---
from routers import (
    chat_sse,
    conversations,
    files,
    models_router,
    plan,
    settings,
    tools_router,
    ws_chat
)

# 프론트엔드에서 404가 발생했던 모든 필수 라우터 연결
app.include_router(conversations.router)
app.include_router(chat_sse.router)
app.include_router(models_router.router)
app.include_router(plan.router)
app.include_router(settings.router)
app.include_router(files.router)
app.include_router(tools_router.router)
app.include_router(ws_chat.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)