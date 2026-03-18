import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { useAppContext } from '@/context/AppContext';
import { useSettings } from '@/context/SettingsContext';
import { useTranslation } from '@/i18n';
import { AVAILABLE_LANGUAGES } from '@/i18n';
import { listApiKeys, setApiKey } from '@/api/models';
import { updateSettings as updateBackendSettings } from '@/api/settings';
import type { ApiKeyInfo } from '@/types';

type Tab = 'general' | 'appearance' | 'api-keys';

interface DraftGeneral {
  language: string;
  userName: string;
  temperature: number;
  maxTokens: number;
  topK: number;
  maxAttachments: number;
  maxContext: number;
  refusalThreshold: number;
  refusalMaxRetries: number;
  refusalTempDecay: number;
  refusalMinTemp: number;
  refusalRecoveryTokens: number;
  useCompactPrompt: boolean;
}

interface DraftApiKeys {
  openai: string;
  anthropic: string;
  google: string;
}

export function SettingsModal() {
  const { dispatch: appDispatch } = useAppContext();
  const { settings, updateSettings, setTheme, setLanguage, setBgImage, setBgBlur, setBgOpacity } = useSettings();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('general');

  // Draft state for General tab (committed on Save)
  const [draft, setDraft] = useState<DraftGeneral>({
    language: settings.language,
    userName: settings.userName,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    topK: settings.topK,
    maxAttachments: settings.maxAttachments,
    maxContext: settings.maxContext,
    refusalThreshold: settings.refusalThreshold,
    refusalMaxRetries: settings.refusalMaxRetries,
    refusalTempDecay: settings.refusalTempDecay,
    refusalMinTemp: settings.refusalMinTemp,
    refusalRecoveryTokens: settings.refusalRecoveryTokens,
    useCompactPrompt: settings.useCompactPrompt,
  });

  // Draft state for API Keys tab
  const [apiDraft, setApiDraft] = useState<DraftApiKeys>({
    openai: '',
    anthropic: '',
    google: '',
  });
  const [apiKeyInfo, setApiKeyInfo] = useState<ApiKeyInfo[]>([]);

  useEffect(() => {
    listApiKeys().then(setApiKeyInfo).catch(() => {});
  }, []);

  const close = () => appDispatch({ type: 'CLOSE_MODAL' });

  const handleSave = async () => {
    // 1. Server settings
    await updateBackendSettings({
      temperature: draft.temperature,
      max_tokens: draft.maxTokens,
      top_k: draft.topK,
      max_context: draft.maxContext,
      refusal_threshold: draft.refusalThreshold,
      refusal_max_retries: draft.refusalMaxRetries,
      refusal_temp_decay: draft.refusalTempDecay,
      refusal_min_temp: draft.refusalMinTemp,
      refusal_recovery_tokens: draft.refusalRecoveryTokens,
      use_compact_prompt: draft.useCompactPrompt,
    }).catch(() => {});

    // 2. API keys (only non-empty)
    const providers = ['openai', 'anthropic', 'google'] as const;
    for (const p of providers) {
      if (apiDraft[p]) {
        await setApiKey(p, apiDraft[p]).catch(() => {});
      }
    }

    // 3. localStorage
    localStorage.setItem('user_name', draft.userName);
    localStorage.setItem('max_attachments', String(draft.maxAttachments));

    // 4. Language
    if (draft.language !== settings.language) {
      setLanguage(draft.language);
    }

    // 5. Context state update
    updateSettings({
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      topK: draft.topK,
      maxContext: draft.maxContext,
      userName: draft.userName,
      maxAttachments: draft.maxAttachments,
      refusalThreshold: draft.refusalThreshold,
      refusalMaxRetries: draft.refusalMaxRetries,
      refusalTempDecay: draft.refusalTempDecay,
      refusalMinTemp: draft.refusalMinTemp,
      refusalRecoveryTokens: draft.refusalRecoveryTokens,
      useCompactPrompt: draft.useCompactPrompt,
    });

    // 6. Close
    close();
  };

  return (
    <div className="modal active" onClick={close}>
      <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t('settings') !== 'settings' ? t('settings') : 'Settings'}</h3>
          <button className="modal-close" onClick={close}><X size={18} /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            <button
              className={`settings-nav-item ${activeTab === 'general' ? 'active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              {t('general') !== 'general' ? t('general') : 'General'}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              {t('appearance') !== 'appearance' ? t('appearance') : 'Appearance'}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'api-keys' ? 'active' : ''}`}
              onClick={() => setActiveTab('api-keys')}
            >
              API Keys
            </button>
          </nav>
          <div className="settings-content">
            {activeTab === 'general' && (
              <GeneralTab draft={draft} setDraft={setDraft} t={t} />
            )}
            {activeTab === 'appearance' && (
              <AppearanceTab
                settings={settings}
                setTheme={setTheme}
                setBgImage={setBgImage}
                setBgBlur={setBgBlur}
                setBgOpacity={setBgOpacity}
                t={t}
              />
            )}
            {activeTab === 'api-keys' && (
              <ApiKeysTab
                apiDraft={apiDraft}
                setApiDraft={setApiDraft}
                apiKeyInfo={apiKeyInfo}
                t={t}
              />
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn-cancel" onClick={close}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-save" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── General Tab ───

function GeneralTab({
  draft,
  setDraft,
  t,
}: {
  draft: DraftGeneral;
  setDraft: React.Dispatch<React.SetStateAction<DraftGeneral>>;
  t: (k: string) => string;
}) {
  const update = useCallback(
    (field: keyof DraftGeneral, value: string | number | boolean) => {
      setDraft((prev) => ({ ...prev, [field]: value }));
    },
    [setDraft],
  );

  return (
    <div className="settings-tab-content active">
      <div className="setting-item">
        <label className="setting-label">
          {t('language') !== 'language' ? t('language') : 'Language'}
        </label>
        <select
          className="modal-input"
          value={draft.language}
          onChange={(e) => update('language', e.target.value)}
        >
          {AVAILABLE_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.name}</option>
          ))}
        </select>
      </div>

      <div className="setting-item">
        <label className="setting-label">
          {t('user_name') !== 'user_name' ? t('user_name') : 'Display Name'}
        </label>
        <input
          type="text"
          className="modal-input"
          maxLength={10}
          value={draft.userName}
          onChange={(e) => update('userName', e.target.value)}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">Temperature</label>
        <input
          type="number"
          className="modal-input"
          min={0}
          max={2}
          step={0.1}
          value={draft.temperature}
          onChange={(e) => update('temperature', parseFloat(e.target.value) || 0)}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">Max Length</label>
        <input
          type="number"
          className="modal-input"
          min={256}
          step={256}
          value={draft.maxTokens}
          onChange={(e) => update('maxTokens', parseInt(e.target.value) || 256)}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">Top-K</label>
        <input
          type="number"
          className="modal-input"
          min={1}
          max={100}
          step={1}
          value={draft.topK}
          onChange={(e) => update('topK', parseInt(e.target.value) || 1)}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">
          {t('max_attachments') !== 'max_attachments' ? t('max_attachments') : 'Max Attachments'}: {draft.maxAttachments}
        </label>
        <input
          type="range"
          className="modal-range"
          min={1}
          max={10}
          step={1}
          value={draft.maxAttachments}
          onChange={(e) => update('maxAttachments', parseInt(e.target.value))}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">Max Context</label>
        <input
          type="number"
          className="modal-input"
          min={1024}
          max={262144}
          step={1024}
          value={draft.maxContext}
          onChange={(e) => update('maxContext', parseInt(e.target.value) || 1024)}
        />
      </div>

      <div className="setting-section-divider" />
      <div className="setting-section-title">Refusal (Local Models)</div>

      <div className="setting-item">
        <label className="setting-label">
          Threshold: {draft.refusalThreshold.toFixed(2)}
        </label>
        <input
          type="range"
          className="modal-range"
          min={0.3}
          max={2}
          step={0.05}
          value={draft.refusalThreshold}
          onChange={(e) => update('refusalThreshold', parseFloat(e.target.value))}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">Max Retries</label>
        <input
          type="number"
          className="modal-input"
          min={1}
          max={10}
          step={1}
          value={draft.refusalMaxRetries}
          onChange={(e) => update('refusalMaxRetries', parseInt(e.target.value) || 1)}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">
          Temp Decay: {draft.refusalTempDecay.toFixed(2)}
        </label>
        <input
          type="range"
          className="modal-range"
          min={0}
          max={1}
          step={0.05}
          value={draft.refusalTempDecay}
          onChange={(e) => update('refusalTempDecay', parseFloat(e.target.value))}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">
          Min Temperature: {draft.refusalMinTemp.toFixed(2)}
        </label>
        <input
          type="range"
          className="modal-range"
          min={0.1}
          max={1}
          step={0.05}
          value={draft.refusalMinTemp}
          onChange={(e) => update('refusalMinTemp', parseFloat(e.target.value))}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">Recovery Tokens</label>
        <input
          type="number"
          className="modal-input"
          min={10}
          max={200}
          step={10}
          value={draft.refusalRecoveryTokens}
          onChange={(e) => update('refusalRecoveryTokens', parseInt(e.target.value) || 10)}
        />
      </div>
    </div>
  );
}

// ─── Appearance Tab ───

function AppearanceTab({
  settings,
  setTheme,
  setBgImage,
  setBgBlur,
  setBgOpacity,
  t,
}: {
  settings: ReturnType<typeof useSettings>['settings'];
  setTheme: (t: string) => void;
  setBgImage: (url: string | null) => void;
  setBgBlur: (v: number) => void;
  setBgOpacity: (v: number) => void;
  t: (k: string) => string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setBgImage(reader.result as string);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div className="settings-tab-content active">
      <div className="setting-item">
        <label className="setting-label">
          {t('theme') !== 'theme' ? t('theme') : 'Theme'}
        </label>
        <div className="theme-buttons">
          <button
            className={`theme-btn ${settings.theme === 'soft-minimal' ? 'active' : ''}`}
            onClick={() => setTheme('soft-minimal')}
          >
            Soft Minimal
          </button>
          <button
            className={`theme-btn ${settings.theme === 'cyber-edge' ? 'active' : ''}`}
            onClick={() => setTheme('cyber-edge')}
          >
            Cyber Edge
          </button>
        </div>
      </div>

      <div className="setting-item">
        <label className="setting-label">Background Image</label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleImageSelect}
        />
        <div className="bg-image-controls">
          <button
            className="modal-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Select Image
          </button>
          <button
            className="modal-btn"
            onClick={() => setBgImage(null)}
            disabled={!settings.bgImage}
          >
            Clear
          </button>
        </div>
        {settings.bgImage && (
          <div className="bg-preview">
            <img src={settings.bgImage} alt="Background preview" />
          </div>
        )}
      </div>

      <div className="setting-item">
        <label className="setting-label">
          Background Blur: {settings.bgBlur}px
        </label>
        <input
          type="range"
          className="modal-range"
          min={0}
          max={60}
          step={1}
          value={settings.bgBlur}
          onChange={(e) => setBgBlur(parseInt(e.target.value))}
        />
      </div>

      <div className="setting-item">
        <label className="setting-label">
          Background Opacity: {settings.bgOpacity}%
        </label>
        <input
          type="range"
          className="modal-range"
          min={0}
          max={100}
          step={1}
          value={settings.bgOpacity}
          onChange={(e) => setBgOpacity(parseInt(e.target.value))}
        />
      </div>
    </div>
  );
}

// ─── API Keys Tab ───

function ApiKeysTab({
  apiDraft,
  setApiDraft,
  apiKeyInfo,
  t,
}: {
  apiDraft: DraftApiKeys;
  setApiDraft: React.Dispatch<React.SetStateAction<DraftApiKeys>>;
  apiKeyInfo: ApiKeyInfo[];
  t: (k: string) => string;
}) {
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const providers = ['openai', 'anthropic', 'google'] as const;

  const toggleVisibility = (provider: string) => {
    setVisibility((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  return (
    <div className="settings-tab-content active">
      {providers.map((provider) => {
        const info = apiKeyInfo.find((k) => k.provider === provider);
        const isVisible = visibility[provider] || false;
        return (
          <div key={provider} className="setting-item">
            <label className="setting-label">
              {provider.charAt(0).toUpperCase() + provider.slice(1)} API Key
              {info?.is_set && <span className="key-status set"> (Set)</span>}
            </label>
            <div className="api-key-input-group">
              <input
                className="modal-input"
                type={isVisible ? 'text' : 'password'}
                placeholder={info?.is_set ? '••••••••' : `Enter ${provider} API key`}
                value={apiDraft[provider]}
                onChange={(e) =>
                  setApiDraft((prev) => ({ ...prev, [provider]: e.target.value }))
                }
              />
              <button
                className="api-key-toggle"
                onClick={() => toggleVisibility(provider)}
                type="button"
              >
                {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
