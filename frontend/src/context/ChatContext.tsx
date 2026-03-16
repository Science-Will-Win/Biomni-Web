import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react';
import type { ChatMessage, ToolCallEvent, ToolResultEvent, PlanComplete } from '@/types';

// ─── Types ───

export interface StepQuestion {
  stepNum: number;
  tool: string;
  stepName: string;
  context: string;
  previousSteps?: string[];
  planGoal?: string;
  planSteps?: string[];
}

// ─── State ───

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  mode: 'agent' | 'plan';
  error: string | null;
  stepQuestions: StepQuestion[];
  planRetrying: boolean;
}

const initialState: ChatState = {
  conversationId: null,
  messages: [],
  isStreaming: false,
  mode: (localStorage.getItem('inferenceMode') as 'agent' | 'plan') || 'plan',
  error: null,
  stepQuestions: [],
  planRetrying: false,
};

// ─── Actions ───

export type ChatAction =
  | { type: 'SET_CONVERSATION'; payload: { id: string | null; messages: ChatMessage[] } }
  | { type: 'SET_CONVERSATION_ID'; payload: string }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'APPEND_TOKEN'; payload: string }
  | { type: 'ADD_TOOL_CALL'; payload: ToolCallEvent['tool_call'] }
  | { type: 'ADD_TOOL_RESULT'; payload: ToolResultEvent['tool_result'] }
  | { type: 'SET_CURRENT_STEP'; payload: number }
  | { type: 'SET_PLAN_COMPLETE'; payload: PlanComplete }
  | { type: 'SET_STREAMING'; payload: boolean }
  | { type: 'SET_MODE'; payload: 'agent' | 'plan' }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'UPDATE_MESSAGES'; payload: ChatMessage[] }
  | { type: 'REPLACE_LAST_ASSISTANT'; payload: string }
  | { type: 'TRUNCATE_FROM'; payload: number }
  | { type: 'ADD_STEP_QUESTION'; payload: StepQuestion }
  | { type: 'REMOVE_STEP_QUESTION'; payload: number }
  | { type: 'CLEAR_STEP_QUESTIONS' }
  | { type: 'PLAN_RETRY' };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_CONVERSATION':
      return {
        ...state,
        conversationId: action.payload.id,
        messages: action.payload.messages,
        error: null,
      };

    case 'SET_CONVERSATION_ID':
      return { ...state, conversationId: action.payload };

    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload], error: null };

    case 'APPEND_TOKEN': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: last.content + action.payload };
      }
      return { ...state, messages: msgs };
    }

    case 'ADD_TOOL_CALL': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        const toolCalls = [...(last.toolCalls || []), action.payload];
        msgs[msgs.length - 1] = { ...last, toolCalls };
      }
      return { ...state, messages: msgs };
    }

    case 'ADD_TOOL_RESULT': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        const toolResults = [...(last.toolResults || []), action.payload];
        msgs[msgs.length - 1] = { ...last, toolResults };
      }
      return { ...state, messages: msgs };
    }

    case 'SET_CURRENT_STEP': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, currentStep: action.payload };
      }
      return { ...state, messages: msgs };
    }

    case 'SET_PLAN_COMPLETE': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, planComplete: action.payload };
      }
      return { ...state, messages: msgs };
    }

    case 'SET_STREAMING':
      return {
        ...state,
        isStreaming: action.payload,
        ...(action.payload ? { planRetrying: false } : {}),
      };

    case 'SET_MODE':
      localStorage.setItem('inferenceMode', action.payload);
      return { ...state, mode: action.payload };

    case 'SET_ERROR':
      return { ...state, error: action.payload, isStreaming: false };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [], error: null };

    case 'UPDATE_MESSAGES':
      return { ...state, messages: action.payload };

    case 'REPLACE_LAST_ASSISTANT': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = { ...last, content: action.payload };
      }
      return { ...state, messages: msgs };
    }

    case 'TRUNCATE_FROM':
      return { ...state, messages: state.messages.slice(0, action.payload) };

    case 'ADD_STEP_QUESTION': {
      // Toggle: if already exists, remove it
      const exists = state.stepQuestions.some((q) => q.stepNum === action.payload.stepNum);
      if (exists) {
        return { ...state, stepQuestions: state.stepQuestions.filter((q) => q.stepNum !== action.payload.stepNum) };
      }
      return { ...state, stepQuestions: [...state.stepQuestions, action.payload] };
    }

    case 'REMOVE_STEP_QUESTION':
      return {
        ...state,
        stepQuestions: state.stepQuestions.filter((q) => q.stepNum !== action.payload),
      };

    case 'CLEAR_STEP_QUESTIONS':
      return { ...state, stepQuestions: [] };

    case 'PLAN_RETRY': {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        let content = last.content;
        // Close any open [THINK] block so it doesn't swallow next attempt's tokens
        if (/\[THINK\](?![\s\S]*\[\/THINK\])/.test(content)) {
          content += '\n[/THINK]';
        }
        if (/<think>(?![\s\S]*<\/think>)/i.test(content)) {
          content += '\n</think>';
        }
        msgs[msgs.length - 1] = { ...last, content };
      }
      return { ...state, messages: msgs, planRetrying: true };
    }

    default:
      return state;
  }
}

// ─── Context ───

interface ChatContextValue {
  state: ChatState;
  dispatch: Dispatch<ChatAction>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  return (
    <ChatContext.Provider value={{ state, dispatch }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}
