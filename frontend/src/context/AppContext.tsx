import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react';
import type { ModelInfo, DetailPanelData, PlanStep, PlanStepResult, CodeData } from '@/types';

// ─── Modal Types ───

export type ModalType =
  | { kind: 'settings' }
  | { kind: 'system-prompt' }
  | { kind: 'rename'; convId: string; currentTitle?: string }
  | { kind: 'stop-confirm'; onConfirm: () => void }
  | null;

// ─── State ───

export interface AppState {
  sidebarOpen: boolean;
  detailPanelOpen: boolean;
  detailPanelWidth: string | null;
  detailPanelData: DetailPanelData | null;
  currentModel: ModelInfo | null;
  activeDetailTab: 'plan' | 'graph' | 'code' | 'outputs';
  activeModal: ModalType;
  conversationVersion: number;
}

const initialState: AppState = {
  sidebarOpen: localStorage.getItem('sidebarOpen') !== 'false',
  detailPanelOpen: localStorage.getItem('detailPanelOpen') !== 'false',
  detailPanelWidth: localStorage.getItem('detailPanelWidth'),
  detailPanelData: null,
  currentModel: null,
  activeDetailTab: 'plan',
  activeModal: null,
  conversationVersion: 0,
};

// ─── Actions ───

export type AppAction =
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_SIDEBAR'; payload: boolean }
  | { type: 'TOGGLE_DETAIL_PANEL' }
  | { type: 'SET_DETAIL_PANEL_OPEN'; payload: boolean }
  | { type: 'SET_DETAIL_PANEL_WIDTH'; payload: string }
  | { type: 'SET_DETAIL_PANEL_DATA'; payload: DetailPanelData }
  | { type: 'CLEAR_DETAIL_PANEL' }
  | { type: 'SET_CURRENT_MODEL'; payload: ModelInfo }
  | { type: 'SET_ACTIVE_DETAIL_TAB'; payload: AppState['activeDetailTab'] }
  | { type: 'UPDATE_STEP_STATUS'; payload: { stepIndex: number; status: PlanStep['status'] } }
  | { type: 'ADD_STEP_RESULT'; payload: PlanStepResult }
  | { type: 'SET_STEP_CODE'; payload: { stepIndex: number; code: string; language?: string; execution?: Record<string, unknown>; fixAttempts?: number; segments?: import('../types').CodeSegment[] } }
  | { type: 'SET_ANALYSIS'; payload: string }
  | { type: 'SET_CURRENT_STEP'; payload: number }
  | { type: 'UPDATE_STEP_TOOL'; payload: { stepIndex: number; toolName: string } }
  | { type: 'RESET_STEP_RESULTS' }
  | { type: 'MARK_RUNNING_STEPS_ERROR' }
  | { type: 'MARK_RUNNING_STEPS_STOPPED' }
  | { type: 'COMPLETE_PREVIOUS_RUNNING_STEPS'; payload: number }
  | { type: 'UPDATE_STEP_NAME'; payload: { stepIndex: number; name: string } }
  | { type: 'SET_RETRIEVED_TOOLS'; payload: string[] }
  | { type: 'SET_RETRIEVAL_RESULT'; payload: import('../types').CategorizedRetrieval }
  | { type: 'SET_TOOL_RETRIEVAL_STATUS'; payload: 'idle' | 'running' | 'done' }
  | { type: 'ADD_STEP_EXECUTION'; payload: { stepIndex: number; code: string; observation: string; success: boolean; iteration: number } }
  | { type: 'OPEN_MODAL'; payload: ModalType }
  | { type: 'CLOSE_MODAL' }
  | { type: 'BUMP_CONVERSATIONS' };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'TOGGLE_SIDEBAR': {
      const next = !state.sidebarOpen;
      localStorage.setItem('sidebarOpen', String(next));
      return { ...state, sidebarOpen: next };
    }

    case 'SET_SIDEBAR':
      localStorage.setItem('sidebarOpen', String(action.payload));
      return { ...state, sidebarOpen: action.payload };

    case 'TOGGLE_DETAIL_PANEL': {
      const nextOpen = !state.detailPanelOpen;
      localStorage.setItem('detailPanelOpen', String(nextOpen));
      return { ...state, detailPanelOpen: nextOpen };
    }

    case 'SET_DETAIL_PANEL_OPEN':
      localStorage.setItem('detailPanelOpen', String(action.payload));
      return { ...state, detailPanelOpen: action.payload };

    case 'SET_DETAIL_PANEL_WIDTH':
      localStorage.setItem('detailPanelWidth', action.payload);
      return { ...state, detailPanelWidth: action.payload };

    case 'SET_DETAIL_PANEL_DATA':
      return { ...state, detailPanelData: action.payload, detailPanelOpen: true };

    case 'CLEAR_DETAIL_PANEL':
      return { ...state, detailPanelData: null };

    case 'SET_CURRENT_MODEL':
      return { ...state, currentModel: action.payload };

    case 'SET_ACTIVE_DETAIL_TAB':
      return { ...state, activeDetailTab: action.payload };

    case 'UPDATE_STEP_STATUS': {
      if (!state.detailPanelData) return state;
      const steps = [...state.detailPanelData.steps];
      if (steps[action.payload.stepIndex]) {
        steps[action.payload.stepIndex] = {
          ...steps[action.payload.stepIndex],
          status: action.payload.status,
        };
      }
      return {
        ...state,
        detailPanelData: { ...state.detailPanelData, steps },
      };
    }

    case 'ADD_STEP_RESULT': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          results: [...state.detailPanelData.results, action.payload],
        },
      };
    }

    case 'SET_STEP_CODE': {
      if (!state.detailPanelData) return state;
      const { stepIndex, code, language, execution, fixAttempts, segments } = action.payload;
      const value: string | CodeData = language
        ? { code, language, execution, fixAttempts: fixAttempts || 0, stepIndex, ...(segments ? { segments } : {}) }
        : code;
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          codes: {
            ...state.detailPanelData.codes,
            [stepIndex]: value,
          },
        },
      };
    }

    case 'SET_ANALYSIS': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: { ...state.detailPanelData, analysis: action.payload },
      };
    }

    case 'SET_CURRENT_STEP': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: { ...state.detailPanelData, currentStep: action.payload },
      };
    }

    case 'UPDATE_STEP_TOOL': {
      if (!state.detailPanelData) return state;
      const steps = [...state.detailPanelData.steps];
      if (steps[action.payload.stepIndex]) {
        steps[action.payload.stepIndex] = {
          ...steps[action.payload.stepIndex],
          tool: action.payload.toolName,
        };
      }
      return {
        ...state,
        detailPanelData: { ...state.detailPanelData, steps },
      };
    }

    case 'RESET_STEP_RESULTS': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          steps: state.detailPanelData.steps.map(s => ({
            ...s,
            status: 'pending' as const,
            tool: undefined,
          })),
          results: [],
          codes: {},
          analysis: '',
          currentStep: 0,
        },
      };
    }

    case 'MARK_RUNNING_STEPS_ERROR': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          steps: state.detailPanelData.steps.map(s =>
            s.status === 'running' ? { ...s, status: 'error' as const } : s
          ),
        },
      };
    }

    case 'MARK_RUNNING_STEPS_STOPPED': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          toolRetrievalStatus: 'idle',
          steps: state.detailPanelData.steps.map(s =>
            s.status === 'running' ? { ...s, status: 'stopped' as const } : s
          ),
        },
      };
    }

    case 'COMPLETE_PREVIOUS_RUNNING_STEPS': {
      if (!state.detailPanelData) return state;
      const cutoff = action.payload; // 0-indexed: all steps before this index
      const steps = state.detailPanelData.steps.map((s, i) =>
        i < cutoff && s.status === 'running'
          ? { ...s, status: 'completed' as const }
          : s
      );
      return {
        ...state,
        detailPanelData: { ...state.detailPanelData, steps },
      };
    }

    case 'UPDATE_STEP_NAME': {
      if (!state.detailPanelData) return state;
      const steps = [...state.detailPanelData.steps];
      if (steps[action.payload.stepIndex]) {
        steps[action.payload.stepIndex] = { ...steps[action.payload.stepIndex], name: action.payload.name };
      }
      return { ...state, detailPanelData: { ...state.detailPanelData, steps } };
    }

    case 'SET_RETRIEVED_TOOLS': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: { ...state.detailPanelData, retrievedTools: action.payload },
      };
    }

    case 'SET_RETRIEVAL_RESULT': {
      if (!state.detailPanelData) return state;
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          retrievalResult: action.payload,
          retrievedTools: action.payload.tools,
        },
      };
    }

    case 'SET_TOOL_RETRIEVAL_STATUS': {
      const base = state.detailPanelData ?? {
        goal: '', steps: [], results: [], codes: {}, analysis: '', currentStep: 0,
      };
      return {
        ...state,
        detailPanelData: { ...base, toolRetrievalStatus: action.payload },
      };
    }

    case 'ADD_STEP_EXECUTION': {
      if (!state.detailPanelData) return state;
      const { stepIndex, code, observation, success, iteration } = action.payload;
      const prev = state.detailPanelData.stepExecutions || {};
      const stepExecs = [...(prev[stepIndex] || []), { code, observation, success, iteration }];
      return {
        ...state,
        detailPanelData: {
          ...state.detailPanelData,
          stepExecutions: { ...prev, [stepIndex]: stepExecs },
        },
      };
    }

    case 'OPEN_MODAL':
      return { ...state, activeModal: action.payload };

    case 'CLOSE_MODAL':
      return { ...state, activeModal: null };

    case 'BUMP_CONVERSATIONS':
      return { ...state, conversationVersion: state.conversationVersion + 1 };

    default:
      return state;
  }
}

// ─── Context ───

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
