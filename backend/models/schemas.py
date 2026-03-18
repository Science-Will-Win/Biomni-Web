"""Pydantic schemas for API request/response models."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ─── Chat ───

class ChatRequest(BaseModel):
    conv_id: Optional[str] = None
    message: str
    mode: Optional[str] = None  # "plan", "agent", etc.
    files: Optional[List[Dict[str, Any]]] = None
    model_override: Optional[str] = None
    rerun: bool = False
    rerun_steps: Optional[List[Dict[str, Any]]] = None
    rerun_goal: Optional[str] = None


class StepQuestionRequest(BaseModel):
    conv_id: str
    question: str
    plan_goal: Optional[str] = None
    plan_steps: Optional[List[str]] = None
    steps: Optional[List[Dict[str, Any]]] = None


class RetryStepRequest(BaseModel):
    conv_id: str
    step_num: int
    step_name: Optional[str] = None
    original_result: Optional[str] = None
    user_edit: Optional[str] = None
    previous_steps: Optional[List[Dict[str, Any]]] = None
    plan_goal: Optional[str] = None


class StopRequest(BaseModel):
    conv_id: str


class SSEEventType(str, Enum):
    TOKEN = "token"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    STEP_START = "step_start"
    PLAN_COMPLETE = "plan_complete"
    DONE = "done"
    ERROR = "error"


class ChatEvent(BaseModel):
    """Event yielded by ChatHandler for SSE/WS streaming."""
    type: str   # SSEEventType value
    data: Dict[str, Any]


# ─── Conversations ───

class ConversationSummary(BaseModel):
    id: UUID
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0


class ConversationDetail(BaseModel):
    id: UUID
    title: str
    messages: List[Dict[str, Any]] = []
    settings: Dict[str, Any] = {}


class ConversationCreate(BaseModel):
    title: Optional[str] = None
    first_message: Optional[str] = None


class RenameRequest(BaseModel):
    title: str


class TruncateRequest(BaseModel):
    message_index: int


# ─── Models ───

class ModelInfo(BaseModel):
    name: str
    display_name: str = ""  # Folder name for local models, same as name for API
    type: str  # "local" or "api"
    provider: str  # "vllm", "openai", "anthropic", "gemini"
    status: str = "available"


class ModelSwitchRequest(BaseModel):
    model_name: str
    force: bool = False


class ApiKeyRequest(BaseModel):
    provider: str
    api_key: str


class ApiKeyInfo(BaseModel):
    provider: str
    is_set: bool


# ─── Settings ───

class SettingsResponse(BaseModel):
    temperature: float = 0.7
    max_tokens: int = 32768
    top_k: int = 50
    max_context: int = 32768
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    # Refusal parameters (local models only)
    refusal_threshold: float = 0.7
    refusal_max_retries: int = 3
    refusal_temp_decay: float = 0.7
    refusal_min_temp: float = 0.3
    refusal_recovery_tokens: int = 50
    # Prompt options
    use_compact_prompt: bool = False


class SettingsUpdateRequest(BaseModel):
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_k: Optional[int] = None
    max_context: Optional[int] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    # Refusal parameters
    refusal_threshold: Optional[float] = None
    refusal_max_retries: Optional[int] = None
    refusal_temp_decay: Optional[float] = None
    refusal_min_temp: Optional[float] = None
    refusal_recovery_tokens: Optional[int] = None
    # Prompt options
    use_compact_prompt: Optional[bool] = None


class SystemPromptResponse(BaseModel):
    prompt: str


# ─── Tools ───

class ToolCallRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any] = {}


class ExecuteCodeRequest(BaseModel):
    code: str
    language: str = "python"
    conv_id: Optional[str] = None
    step_index: Optional[int] = None


class NodeManifest(BaseModel):
    tools: List[Dict[str, Any]] = []


# ─── Files ───

class FileInfo(BaseModel):
    filename: str
    size: int
    type: str
    uploaded_at: Optional[datetime] = None


class FileUploadResponse(BaseModel):
    filename: str
    text_content: Optional[str] = None


# ─── Plan ───

class PlanRequest(BaseModel):
    prompt: str
    conv_id: str

class PlanResponse(BaseModel):
    plan: str

class ReplanRequest(BaseModel):
    conv_id: str
    steps: List[Dict[str, Any]] = []
    goal: Optional[str] = None


class UpdatePlanAnalysisRequest(BaseModel):
    conv_id: str
    step_num: int
    analysis: str


class AnalyzePlanRequest(BaseModel):
    goal: str
    steps: List[Dict[str, Any]]
    current_step: int = 0


# ─── Generic Responses ───

class StatusResponse(BaseModel):
    status: str
    message: Optional[str] = None


class ErrorResponse(BaseModel):
    detail: str
