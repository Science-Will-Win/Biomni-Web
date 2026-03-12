"""aigen_server — FastAPI application with 8 routers + WebSocket + DB."""

import os
import sys
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

# Load environment variables
load_dotenv(dotenv_path="../.env")

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

# --- Logging ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aigen")

# --- Routers ---
from routers import chat_sse, conversations, files, models_router, plan, settings, tools_router, ws_chat


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

    # Initialize Biomni Tool Loader (loads 224 tool descriptions from biomni framework)
    try:
        from services.biomni_tools import BiomniToolLoader
        biomni_loader = BiomniToolLoader.get_instance()
        biomni_loader.initialize()
    except Exception as e:
        logger.warning(f"BiomniToolLoader init failed: {e}")

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

# --- Static files ---
uploads_dir = os.getenv("UPLOADS_DIR", "/app/uploads")
if os.path.exists(uploads_dir):
    app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

if os.path.exists("/app/data"):
    app.mount("/data", StaticFiles(directory="/app/data"), name="data")

outputs_dir = os.getenv("OUTPUTS_DIR", "/app/outputs")
if os.path.exists(outputs_dir):
    app.mount("/api/outputs", StaticFiles(directory=outputs_dir), name="outputs")

# --- Register Routers ---
app.include_router(conversations.router)
app.include_router(chat_sse.router)
app.include_router(models_router.router)
app.include_router(settings.router)
app.include_router(tools_router.router)
app.include_router(files.router)
app.include_router(plan.router)
app.include_router(ws_chat.router)


# --- Health Check ---
@app.get("/health")
async def health_check():
    from sqlalchemy import text as sa_text
    from services.llm_service import get_llm_service
    from db.database import async_session_factory

    # Check SGLang server
    sglang_ok = await get_llm_service()._check_sglang_health()

    # Check DB
    db_ok = True
    try:
        async with async_session_factory() as session:
            await session.execute(sa_text("SELECT 1"))
    except Exception:
        db_ok = False

    return {"status": "ok", "sglang": sglang_ok, "db": db_ok}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
