/**
 * TypeScript types mirroring backend Pydantic schemas (backend/models/schemas.py)
 */

// ─── Chat ───

export interface ChatRequest {
  conv_id?: string | null;
  message: string;
  mode?: string | null;
  files?: Array<Record<string, unknown>> | null;
  model_override?: string | null;
}

export interface StepQuestionRequest {
  conv_id: string;
  question: string;
  plan_goal?: string | null;
  plan_steps?: string[] | null;
  steps?: Array<Record<string, unknown>> | null;
}

export interface RetryStepRequest {
  conv_id: string;
  step_num: number;
  step_name?: string | null;
  original_result?: string | null;
  user_edit?: string | null;
  previous_steps?: Array<Record<string, unknown>> | null;
  plan_goal?: string | null;
}

export interface StopRequest {
  conv_id: string;
}

// ─── SSE Events ───

export interface TokenEvent {
  type: 'token';
  token: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  tool_call: {
    name: string;
    arguments: Record<string, unknown>;
    status?: string;
  };
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool_result: {
    success: boolean;
    result: unknown;
    tool: string;
    step?: number;
  };
}

export interface StepStartEvent {
  type: 'step_start';
  step_start: { step: number };
}

export interface DoneEvent {
  type: 'done';
  done: true;
  plan_complete?: PlanComplete;
  stopped?: boolean;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

export type SSEEvent =
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | StepStartEvent
  | DoneEvent
  | ErrorEvent;

export interface PlanComplete {
  goal: string;
  steps: PlanStep[];
  results: PlanStepResult[];
}

// ─── Conversations ───

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ConversationDetail {
  id: string;
  title: string;
  messages: MessageData[];
  settings: Record<string, unknown>;
}

export interface MessageData {
  id?: number;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface ConversationCreate {
  title?: string | null;
  first_message?: string | null;
}

export interface RenameRequest {
  title: string;
}

export interface TruncateRequest {
  message_index: number;
}

// ─── Models ───

export interface ModelInfo {
  name: string;
  display_name: string;
  type: string;
  provider: string;
  status: string;
}

export interface ModelSwitchRequest {
  model_name: string;
}

export interface ApiKeyRequest {
  provider: string;
  api_key: string;
}

export interface ApiKeyInfo {
  provider: string;
  is_set: boolean;
}

// ─── Settings ───

export interface SettingsResponse {
  temperature: number;
  max_tokens: number;
  top_k: number;
  max_context: number;
  model?: string | null;
  system_prompt?: string | null;
  refusal_threshold: number;
  refusal_max_retries: number;
  refusal_temp_decay: number;
  refusal_min_temp: number;
  refusal_recovery_tokens: number;
  use_compact_prompt: boolean;
}

export interface SettingsUpdateRequest {
  temperature?: number | null;
  max_tokens?: number | null;
  top_k?: number | null;
  max_context?: number | null;
  model?: string | null;
  system_prompt?: string | null;
  refusal_threshold?: number | null;
  refusal_max_retries?: number | null;
  refusal_temp_decay?: number | null;
  refusal_min_temp?: number | null;
  refusal_recovery_tokens?: number | null;
  use_compact_prompt?: boolean | null;
}

export interface SystemPromptResponse {
  prompt: string;
}

// ─── Tools ───

export interface ToolCallRequest {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export interface ExecuteCodeRequest {
  code: string;
  language: string;
  conv_id?: string;
  step_index?: number;
}

export interface NodeManifest {
  tools: Array<Record<string, unknown>>;
}

// ─── Files ───

export interface FileInfo {
  filename: string;
  size: number;
  type: string;
  uploaded_at?: string | null;
}

export interface FileUploadResponse {
  filename: string;
  text_content?: string | null;
}

// ─── Plan ───

export interface ReplanRequest {
  conv_id: string;
  steps: Array<Record<string, unknown>>;
  goal?: string | null;
}

export interface UpdatePlanAnalysisRequest {
  conv_id: string;
  step_num: number;
  analysis: string;
}

export interface PlanStep {
  name: string;
  description: string;
  status?: 'pending' | 'running' | 'completed' | 'error' | 'stopped';
  tool?: string;
}

export interface PlanStepResult {
  step: number;
  tool: string;
  success: boolean;
  result: unknown;
}

// ─── Generic ───

export interface StatusResponse {
  status: string;
  message?: string | null;
}

export interface ErrorResponse {
  detail: string;
}

// ─── Frontend-specific ───

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallEvent['tool_call'][];
  toolResults?: ToolResultEvent['tool_result'][];
  currentStep?: number;
  planComplete?: PlanComplete;
  isError?: boolean;
  files?: Array<Record<string, unknown>>;
}

export interface CodeData {
  code: string;
  language: string;
  execution?: Record<string, unknown>;
  fixAttempts?: number;
  stepIndex: number;
}

export interface DetailPanelData {
  goal: string;
  steps: PlanStep[];
  results: PlanStepResult[];
  codes: Record<number, string | CodeData>;
  analysis: string;
  currentStep: number;
}

export interface PendingFile {
  file: File;
  name: string;
  type: 'image' | 'audio' | 'document';
  previewUrl?: string;
  textContent?: string;
  uploadedFilename?: string;
}
