"""Model management endpoints — 5 endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from models.schemas import ApiKeyInfo, ApiKeyRequest, ModelInfo, ModelSwitchRequest, StatusResponse
from services.llm_service import get_llm_service
from services.docker_model_manager import get_docker_manager

router = APIRouter(prefix="/api", tags=["models"])


@router.get("/model")
async def get_current_model():
    svc = get_llm_service()
    return svc.get_current_model()


@router.get("/models", response_model=list[ModelInfo])
async def list_models(db: AsyncSession = Depends(get_db)):
    svc = get_llm_service()
    return await svc.list_models(db)


@router.post("/model/switch", response_model=StatusResponse)
async def switch_model(
    request: ModelSwitchRequest, db: AsyncSession = Depends(get_db)
):
    svc = get_llm_service()
    try:
        svc._reload_registry_if_changed()
        mc = svc._registry.get("models", {}).get(request.model_name)
        if not mc:
            raise KeyError(request.model_name)

        # Local model → swap vLLM container if needed
        if mc.get("type") == "local":
            mgr = get_docker_manager()
            if mgr.current_model != request.model_name or request.force:
                local_path = mc.get("local_path", request.model_name)
                await mgr.swap_model(request.model_name, local_path, force=request.force)

        model = await svc.switch_model(request.model_name, db)
        return StatusResponse(status="ok", message=f"Switched to {model.name}")
    except KeyError:
        raise HTTPException(
            status_code=404, detail=f"Model '{request.model_name}' not found"
        )
    except TimeoutError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model swap failed: {e}")


@router.get("/api-keys", response_model=list[ApiKeyInfo])
async def list_api_keys(db: AsyncSession = Depends(get_db)):
    svc = get_llm_service()
    return await svc.list_api_key_status(db)


@router.post("/api-keys", response_model=StatusResponse)
async def set_api_key(
    request: ApiKeyRequest, db: AsyncSession = Depends(get_db)
):
    svc = get_llm_service()
    await svc.set_api_key(request.provider, request.api_key, db)
    return StatusResponse(
        status="ok", message=f"API key for {request.provider} saved"
    )
