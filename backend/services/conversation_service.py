"""Conversation CRUD service — async SQLAlchemy implementation."""

import json as json_module
import logging
import re
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from db.models import Conversation, Message
from models.schemas import ConversationDetail, ConversationSummary

logger = logging.getLogger("aigen.conversation_service")


class ConversationService:
    """Async database-backed conversation CRUD service.

    Instantiated per-request with an injected AsyncSession.
    """

    def __init__(self, db: AsyncSession):
        self._db = db

    # ─── REST endpoint methods (7) ───

    async def list_conversations(self) -> list[ConversationSummary]:
        """List all conversations with message counts, sorted by updated_at desc."""
        stmt = (
            select(
                Conversation.id,
                Conversation.title,
                Conversation.created_at,
                Conversation.updated_at,
                func.count(Message.id).label("message_count"),
            )
            .outerjoin(Message, Message.conversation_id == Conversation.id)
            .group_by(Conversation.id)
            .order_by(Conversation.updated_at.desc())
        )
        result = await self._db.execute(stmt)
        return [
            ConversationSummary(
                id=row.id,
                title=row.title,
                created_at=row.created_at,
                updated_at=row.updated_at,
                message_count=row.message_count,
            )
            for row in result.all()
        ]

    async def get_conversation(self, conv_id: UUID) -> ConversationDetail | None:
        """Get a conversation with all messages. Returns None if not found."""
        stmt = select(Conversation).where(Conversation.id == conv_id)
        result = await self._db.execute(stmt)
        conv = result.scalar_one_or_none()
        if conv is None:
            return None

        msg_stmt = (
            select(Message)
            .where(Message.conversation_id == conv_id)
            .order_by(Message.id.asc())
        )
        msg_result = await self._db.execute(msg_stmt)
        messages = msg_result.scalars().all()

        return ConversationDetail(
            id=conv.id,
            title=conv.title,
            messages=[self._message_to_dict(m) for m in messages],
            settings=conv.settings or {},
        )

    async def create_conversation(
        self, title: str | None = None, first_message: str | None = None
    ) -> ConversationDetail:
        """Create a new conversation, optionally with a first user message."""
        conv = Conversation(title=title or "New Chat", settings={})
        self._db.add(conv)
        await self._db.flush()

        messages = []
        if first_message:
            msg = Message(
                conversation_id=conv.id,
                role="user",
                content=first_message,
            )
            self._db.add(msg)
            if conv.title == "New Chat":
                conv.title = self._generate_title(first_message)
            messages.append({"role": "user", "content": first_message})

        await self._db.commit()
        await self._db.refresh(conv)

        return ConversationDetail(
            id=conv.id,
            title=conv.title,
            messages=messages,
            settings=conv.settings or {},
        )

    async def delete_conversation(self, conv_id: UUID) -> bool:
        """Delete a conversation and all its messages (cascade)."""
        conv = await self._get_conversation_or_raise(conv_id)
        await self._db.delete(conv)
        await self._db.commit()
        return True

    async def rename_conversation(self, conv_id: UUID, new_title: str) -> bool:
        """Update the conversation title."""
        conv = await self._get_conversation_or_raise(conv_id)
        conv.title = new_title
        conv.updated_at = datetime.utcnow()
        await self._db.commit()
        return True

    async def truncate_messages(self, conv_id: UUID, from_index: int) -> bool:
        """Delete messages from from_index onward (keep 0..from_index-1)."""
        await self._get_conversation_or_raise(conv_id)

        stmt = (
            select(Message.id)
            .where(Message.conversation_id == conv_id)
            .order_by(Message.id.asc())
        )
        result = await self._db.execute(stmt)
        msg_ids = [row[0] for row in result.all()]

        if from_index < 0 or from_index >= len(msg_ids):
            return False

        ids_to_delete = msg_ids[from_index:]
        if ids_to_delete:
            del_stmt = delete(Message).where(Message.id.in_(ids_to_delete))
            await self._db.execute(del_stmt)

        conv_stmt = select(Conversation).where(Conversation.id == conv_id)
        conv_result = await self._db.execute(conv_stmt)
        conv = conv_result.scalar_one_or_none()
        if conv:
            conv.updated_at = datetime.utcnow()

        await self._db.commit()
        return True

    async def clear_conversation(self, conv_id: UUID) -> bool:
        """Clear all messages and reset title to 'New Chat'."""
        conv = await self._get_conversation_or_raise(conv_id)

        del_stmt = delete(Message).where(Message.conversation_id == conv_id)
        await self._db.execute(del_stmt)

        conv.title = "New Chat"
        conv.updated_at = datetime.utcnow()
        await self._db.commit()
        return True

    # ─── Phase A5 ChatHandler methods (3) ───

    async def add_message(
        self,
        conv_id: UUID,
        role: str,
        content: str,
        files: list | None = None,
        metadata: dict | None = None,
    ) -> Message:
        """Add a message to a conversation. Auto-generates title from first user message."""
        conv = await self._get_conversation_or_raise(conv_id)

        msg_metadata = metadata or {}
        if files:
            msg_metadata["files"] = files

        msg = Message(
            conversation_id=conv_id,
            role=role,
            content=content,
            metadata_=msg_metadata,
        )
        self._db.add(msg)

        if role == "user" and conv.title == "New Chat":
            conv.title = self._generate_title(content)

        conv.updated_at = datetime.utcnow()
        await self._db.commit()
        await self._db.refresh(msg)
        return msg

    async def replace_last_plan_message(self, conv_id: UUID, new_content: str) -> bool:
        """Replace the last assistant message containing [PLAN_CREATE] (or legacy [TOOL_CALLS]...create_plan)."""
        # Try new marker first, then legacy
        for marker in ("[PLAN_CREATE]", "[PLAN_COMPLETE]"):
            stmt = (
                select(Message)
                .where(
                    Message.conversation_id == conv_id,
                    Message.role == "assistant",
                    Message.content.contains(marker),
                )
                .order_by(Message.id.desc())
                .limit(1)
            )
            result = await self._db.execute(stmt)
            msg = result.scalar_one_or_none()
            if msg is not None:
                msg.content = new_content
                await self._touch_updated_at(conv_id)
                await self._db.commit()
                return True
        # Legacy fallback
        stmt = (
            select(Message)
            .where(
                Message.conversation_id == conv_id,
                Message.role == "assistant",
                Message.content.contains("[TOOL_CALLS]"),
                Message.content.contains("create_plan"),
            )
            .order_by(Message.id.desc())
            .limit(1)
        )
        result = await self._db.execute(stmt)
        msg = result.scalar_one_or_none()
        if msg is None:
            return False

        msg.content = new_content
        await self._touch_updated_at(conv_id)
        await self._db.commit()
        return True

    async def update_plan_analysis(self, conv_id: UUID, analysis_text: str) -> bool:
        """Append analysis text to the last [PLAN_COMPLETE] message."""
        stmt = (
            select(Message)
            .where(
                Message.conversation_id == conv_id,
                Message.role == "assistant",
                Message.content.contains("[PLAN_COMPLETE]"),
            )
            .order_by(Message.id.desc())
            .limit(1)
        )
        result = await self._db.execute(stmt)
        msg = result.scalar_one_or_none()
        if msg is None:
            return False

        content = msg.content
        tag = "[PLAN_COMPLETE]"
        match_idx = content.find(tag)
        if match_idx == -1:
            return False

        json_str = content[match_idx + len(tag) :].strip()
        try:
            plan_json = json_module.loads(json_str)
            plan_json["analysis"] = analysis_text
            prefix = content[:match_idx]
            msg.content = prefix + tag + json_module.dumps(plan_json, ensure_ascii=False)
        except json_module.JSONDecodeError:
            return False

        await self._touch_updated_at(conv_id)
        await self._db.commit()
        return True

    # ─── Private helpers ───

    async def _get_conversation_or_raise(self, conv_id: UUID) -> Conversation:
        """Fetch conversation or raise 404."""
        stmt = select(Conversation).where(Conversation.id == conv_id)
        result = await self._db.execute(stmt)
        conv = result.scalar_one_or_none()
        if conv is None:
            raise HTTPException(status_code=404, detail=f"Conversation {conv_id} not found")
        return conv

    async def _touch_updated_at(self, conv_id: UUID) -> None:
        """Update the conversation's updated_at timestamp."""
        stmt = select(Conversation).where(Conversation.id == conv_id)
        result = await self._db.execute(stmt)
        conv = result.scalar_one_or_none()
        if conv:
            conv.updated_at = datetime.utcnow()

    @staticmethod
    def _generate_title(content: str) -> str:
        """Generate conversation title from first user message.

        Strips [Image: ...] and [Audio: ...] references, takes first 50 chars.
        """
        title_text = content
        title_text = re.sub(r"\[Image: [^\]]+\]\s*", "", title_text)
        title_text = re.sub(r"\[Audio: [^\]]+\]\s*", "", title_text)
        title_text = title_text.strip()

        if title_text:
            return title_text[:50] + ("..." if len(title_text) > 50 else "")
        return "Image Chat"

    @staticmethod
    def _message_to_dict(msg: Message) -> dict:
        """Convert a Message ORM object to a dict for ConversationDetail."""
        d = {"role": msg.role, "content": msg.content}
        if msg.metadata_:
            if msg.metadata_.get("files"):
                d["files"] = msg.metadata_["files"]
            extra = {k: v for k, v in msg.metadata_.items() if k != "files"}
            if extra:
                d["metadata"] = extra
        return d
    
    async def get_messages(self, conv_id: UUID) -> list[Message]:
        """Fetch all messages for a given conversation ordered by ID."""
        stmt = (
            select(Message)
            .where(Message.conversation_id == conv_id)
            .order_by(Message.id.asc())
        )
        result = await self._db.execute(stmt)
        return list(result.scalars().all())
