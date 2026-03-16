"""WebSocket chat endpoint with action-based message routing."""

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from db.database import async_session_factory
from models.schemas import ChatRequest, StepQuestionRequest, RetryStepRequest
from services.chat_handler import ChatHandler
from ws.events import EventType, WSMessage
from ws.manager import manager

logger = logging.getLogger("aigen.ws_chat")

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/chat/{conv_id}")
async def websocket_chat(websocket: WebSocket, conv_id: str):
    await manager.connect(websocket, conv_id)
    streaming_task: asyncio.Task | None = None

    async def _run_stream(handler, coro_gen, cid):
        """Stream events from an async generator to the WebSocket."""
        try:
            async for event in coro_gen:
                ws_msg = WSMessage(type=event.type, data=event.data)
                await manager.send_event(cid, ws_msg)
        except asyncio.CancelledError:
            # Task was cancelled by stop action
            await manager.send_event(
                cid, WSMessage(type=EventType.DONE, data={"stopped": True})
            )
        except Exception as e:
            logger.error(f"Streaming error: {e}")
            await manager.send_event(
                cid, WSMessage(type=EventType.ERROR, data={"error": str(e)})
            )

    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action", "chat")
            handler = ChatHandler.get_instance()

            # Stop doesn't need a DB session
            if action == "stop":
                handler.stop(data.get("conv_id", conv_id))
                # Cancel the streaming task if running
                if streaming_task and not streaming_task.done():
                    streaming_task.cancel()
                    # CancelledError handler in _run_stream will send done
                else:
                    # No running task, send done directly
                    await manager.send_event(
                        conv_id,
                        WSMessage(type=EventType.DONE, data={"stopped": True}),
                    )
                continue

            if action == "chat":
                request = ChatRequest(
                    conv_id=data.get("conv_id", conv_id),
                    message=data.get("message", ""),
                    mode=data.get("mode"),
                    files=data.get("files"),
                    model_override=data.get("model_override"),
                    rerun=data.get("rerun", False),
                    rerun_steps=data.get("rerun_steps"),
                    rerun_goal=data.get("rerun_goal"),
                )

                async def _chat_gen(req=request):
                    async with async_session_factory() as db:
                        async for event in handler.handle_chat(req, db):
                            yield event

                streaming_task = asyncio.create_task(
                    _run_stream(handler, _chat_gen(), conv_id)
                )

            elif action == "step_question":
                request = StepQuestionRequest(
                    conv_id=data.get("conv_id", conv_id),
                    question=data.get("question", ""),
                    plan_goal=data.get("plan_goal"),
                    plan_steps=data.get("plan_steps"),
                    steps=data.get("steps"),
                )

                async def _step_question_gen(req=request):
                    async with async_session_factory() as db:
                        async for event in handler.handle_step_question(req, db):
                            yield event

                streaming_task = asyncio.create_task(
                    _run_stream(handler, _step_question_gen(), conv_id)
                )

            elif action == "retry_step":
                request = RetryStepRequest(
                    conv_id=data.get("conv_id", conv_id),
                    step_num=data.get("step_num", data.get("step_index", 0)),
                    step_name=data.get("step_name"),
                    original_result=data.get("original_result"),
                    user_edit=data.get("user_edit"),
                    previous_steps=data.get("previous_steps"),
                    plan_goal=data.get("plan_goal"),
                )

                async def _retry_step_gen(req=request):
                    async with async_session_factory() as db:
                        async for event in handler.handle_retry_step(req, db):
                            yield event

                streaming_task = asyncio.create_task(
                    _run_stream(handler, _retry_step_gen(), conv_id)
                )

            else:
                await manager.send_event(
                    conv_id,
                    WSMessage(
                        type=EventType.ERROR,
                        data={"error": f"Unknown action: {action}"},
                    ),
                )

    except WebSocketDisconnect:
        if streaming_task and not streaming_task.done():
            streaming_task.cancel()
        manager.disconnect(conv_id)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        if streaming_task and not streaming_task.done():
            streaming_task.cancel()
        try:
            await manager.send_event(
                conv_id,
                WSMessage(type=EventType.ERROR, data={"error": str(e)}),
            )
        except Exception:
            pass
        manager.disconnect(conv_id)
