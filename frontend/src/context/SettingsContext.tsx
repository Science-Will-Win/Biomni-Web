import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import { getSettings } from '@/api/settings';
import {
  I18nContext,
  AVAILABLE_LANGUAGES,
  getLocaleData,
  translate,
} from '@/i18n';

// ─── Helpers ───

const SUPPORTED_CODES = new Set(AVAILABLE_LANGUAGES.map((l) => l.code));

/** Detect browser language, return supported code or 'en' */
function detectBrowserLanguage(): string {
  const raw = navigator.language || '';          // e.g. 'ko-KR', 'en-US', 'ja'
  const base = raw.split('-')[0].toLowerCase();  // 'ko', 'en', 'ja'
  return SUPPORTED_CODES.has(base) ? base : 'en';
}

// ─── Settings State ───

export interface SettingsState {
  // Server-persisted
  temperature: number;
  maxTokens: number;
  topK: number;
  maxContext: number;
  // Refusal (server-persisted)
  refusalThreshold: number;
  refusalMaxRetries: number;
  refusalTempDecay: number;
  refusalMinTemp: number;
  refusalRecoveryTokens: number;
  useCompactPrompt: boolean;
  // localStorage-only
  theme: string;
  language: string;
  userName: string;
  maxAttachments: number;
  bgImage: string | null;
  bgBlur: number;
  bgOpacity: number;
  // Loading flag
  loaded: boolean;
}

const getInitialSettings = (): SettingsState => ({
  temperature: 0.7,
  maxTokens: 32768,
  topK: 50,
  maxContext: 32768,
  refusalThreshold: 0.7,
  refusalMaxRetries: 3,
  refusalTempDecay: 0.7,
  refusalMinTemp: 0.3,
  refusalRecoveryTokens: 50,
  useCompactPrompt: false,
  theme: localStorage.getItem('ui_theme') || 'soft-minimal',
  language: localStorage.getItem('ui_language') || detectBrowserLanguage(),
  userName: localStorage.getItem('user_name') || '',
  maxAttachments: parseInt(localStorage.getItem('max_attachments') || '5', 10),
  bgImage: localStorage.getItem('bgImage') || null,
  bgBlur: parseInt(localStorage.getItem('bgBlur') || '30', 10),
  bgOpacity: parseInt(localStorage.getItem('bgOpacity') || '80', 10),
  loaded: false,
});

type SettingsAction =
  | { type: 'SET_ALL'; payload: Partial<SettingsState> }
  | { type: 'SET_THEME'; payload: string }
  | { type: 'SET_LANGUAGE'; payload: string }
  | { type: 'SET_BG_IMAGE'; payload: string | null }
  | { type: 'SET_BG_BLUR'; payload: number }
  | { type: 'SET_BG_OPACITY'; payload: number }
  | { type: 'SET_LOADED' };

function applyBgImage(dataUrl: string | null) {
  const bgLayer = document.getElementById('backgroundLayer');
  if (!bgLayer) return;
  bgLayer.style.backgroundImage = dataUrl ? `url(${dataUrl})` : '';
}

function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case 'SET_ALL':
      return { ...state, ...action.payload };
    case 'SET_THEME': {
      localStorage.setItem('ui_theme', action.payload);
      document.documentElement.setAttribute('data-theme', action.payload);
      return { ...state, theme: action.payload };
    }
    case 'SET_LANGUAGE':
      localStorage.setItem('ui_language', action.payload);
      return { ...state, language: action.payload };
    case 'SET_BG_IMAGE': {
      if (action.payload) {
        localStorage.setItem('bgImage', action.payload);
      } else {
        localStorage.removeItem('bgImage');
      }
      applyBgImage(action.payload);
      return { ...state, bgImage: action.payload };
    }
    case 'SET_BG_BLUR': {
      localStorage.setItem('bgBlur', String(action.payload));
      document.documentElement.style.setProperty('--bg-blur', action.payload + 'px');
      return { ...state, bgBlur: action.payload };
    }
    case 'SET_BG_OPACITY': {
      localStorage.setItem('bgOpacity', String(action.payload));
      document.documentElement.style.setProperty('--bg-opacity', String(action.payload / 100));
      return { ...state, bgOpacity: action.payload };
    }
    case 'SET_LOADED':
      return { ...state, loaded: true };
    default:
      return state;
  }
}

// ─── Context ───

interface SettingsContextValue {
  settings: SettingsState;
  updateSettings: (partial: Partial<SettingsState>) => void;
  setTheme: (theme: string) => void;
  setLanguage: (lang: string) => void;
  setBgImage: (dataUrl: string | null) => void;
  setBgBlur: (value: number) => void;
  setBgOpacity: (value: number) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, dispatch] = useReducer(settingsReducer, getInitialSettings());
  const [lang, setLangState] = useState(settings.language);

  // Apply theme on mount
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  // Apply background settings on mount
  useEffect(() => {
    applyBgImage(settings.bgImage);
    document.documentElement.style.setProperty('--bg-blur', settings.bgBlur + 'px');
    document.documentElement.style.setProperty('--bg-opacity', String(settings.bgOpacity / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load server settings on mount
  useEffect(() => {
    getSettings()
      .then((res) => {
        dispatch({
          type: 'SET_ALL',
          payload: {
            temperature: res.temperature,
            maxTokens: res.max_tokens,
            topK: res.top_k,
            maxContext: res.max_context,
            refusalThreshold: res.refusal_threshold,
            refusalMaxRetries: res.refusal_max_retries,
            refusalTempDecay: res.refusal_temp_decay,
            refusalMinTemp: res.refusal_min_temp,
            refusalRecoveryTokens: res.refusal_recovery_tokens,
            useCompactPrompt: res.use_compact_prompt,
          },
        });
        dispatch({ type: 'SET_LOADED' });
      })
      .catch(() => {
        dispatch({ type: 'SET_LOADED' });
      });
  }, []);

  const updateSettings = useCallback((partial: Partial<SettingsState>) => {
    dispatch({ type: 'SET_ALL', payload: partial });
  }, []);

  const setTheme = useCallback((theme: string) => {
    dispatch({ type: 'SET_THEME', payload: theme });
  }, []);

  const setLanguage = useCallback((newLang: string) => {
    dispatch({ type: 'SET_LANGUAGE', payload: newLang });
    setLangState(newLang);
  }, []);

  const setBgImage = useCallback((dataUrl: string | null) => {
    dispatch({ type: 'SET_BG_IMAGE', payload: dataUrl });
  }, []);

  const setBgBlur = useCallback((value: number) => {
    dispatch({ type: 'SET_BG_BLUR', payload: value });
  }, []);

  const setBgOpacity = useCallback((value: number) => {
    dispatch({ type: 'SET_BG_OPACITY', payload: value });
  }, []);

  // i18n
  const locale = getLocaleData(lang);
  const fallback = getLocaleData('en');
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(locale, fallback, key, params),
    [locale, fallback],
  );

  const i18nValue = {
    lang,
    t,
    setLang: setLanguage,
    availableLanguages: AVAILABLE_LANGUAGES,
  };

  return (
    <SettingsContext.Provider
      value={{ settings, updateSettings, setTheme, setLanguage, setBgImage, setBgBlur, setBgOpacity }}
    >
      <I18nContext.Provider value={i18nValue}>
        {children}
      </I18nContext.Provider>
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
