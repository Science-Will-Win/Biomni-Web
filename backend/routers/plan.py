from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from db.database import get_db
from models.schemas import PlanRequest, PlanResponse
from services.chat_handler import ChatHandler

router = APIRouter(prefix="/api/plan", tags=["plan"])

@router.post("/generate", response_model=PlanResponse)
async def generate_plan(request: PlanRequest, db: AsyncSession = Depends(get_db)):
    """A1 에이전트의 go_plan_only()를 이용해 실행 계획만 먼저 생성하여 프론트엔드에 전달합니다."""
    try:
        handler = ChatHandler.get_instance()
        # [수정됨] db 세션 추가 전달
        plan_text = await handler.generate_plan(prompt=request.prompt, conv_id=request.conv_id, db=db)
        return PlanResponse(plan=plan_text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate plan: {str(e)}")