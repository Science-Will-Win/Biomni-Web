"""aigen_server — Lightweight API Gateway for Biomni A1"""

import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

# A1이 사용할 수 있도록 환경변수 강제 로드
load_dotenv(dotenv_path="../.env", override=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("biomni_backend")

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
    return {"status": "ok", "agent": "Biomni A1 Active"}

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
app.include_router(tools_router.router)
app.include_router(files.router)
app.include_router(ws_chat.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)