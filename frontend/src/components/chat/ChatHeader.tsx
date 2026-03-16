import { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { useAppContext } from '@/context/AppContext';
import { getCurrentModel, listModels, switchModel } from '@/api/models';
import { useTranslation } from '@/i18n';
import { MODEL_REGISTRY } from '@/config/models';
import type { ModelInfo } from '@/types';

export function ChatHeader() {
  const { state, dispatch } = useAppContext();
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  // Load current model on mount
  useEffect(() => {
    getCurrentModel()
      .then((model) => dispatch({ type: 'SET_CURRENT_MODEL', payload: model }))
      .catch(() => {});
  }, [dispatch]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.model-selector')) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [dropdownOpen]);

  const lastModels = useRef<ModelInfo[]>(MODEL_REGISTRY);

  const handleOpenDropdown = () => {
    if (dropdownOpen) {
      setDropdownOpen(false);
      return;
    }

    // Immediately open with cached/fallback data
    const currentName = state.currentModel?.name;
    setModels(
      lastModels.current.map((m) => ({
        ...m,
        status: m.name === currentName ? 'active' : m.status,
      })),
    );
    setDropdownOpen(true);

    // Background fetch with 2s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    listModels(controller.signal)
      .then((list) => {
        clearTimeout(timeoutId);
        lastModels.current = list;
        setModels(list);
      })
      .catch(() => {
        clearTimeout(timeoutId);
      });
  };

  const handleSelectModel = async (modelName: string) => {
    setDropdownOpen(false);
    setSwitching(true);
    try {
      await switchModel(modelName);
      const updated = await getCurrentModel();
      dispatch({ type: 'SET_CURRENT_MODEL', payload: updated });
    } catch {
      // Silently fail
    } finally {
      setSwitching(false);
    }
  };

  const localModels = models.filter((m) => m.type === 'local');
  const apiModels = models.filter((m) => m.type === 'api');

  const isActive = (m: ModelInfo) =>
    m.name === state.currentModel?.name;
  const isDisabled = (m: ModelInfo) =>
    m.status !== 'available' && m.status !== 'active';

  return (
    <header className="chat-header">
      <div className="model-info">
        <span className="model-label">MODEL:</span>
        <div className="model-selector" onClick={handleOpenDropdown}>
          <span className="model-name">
            {switching
              ? t('switching_model')
              : state.currentModel
                ? (state.currentModel.display_name || state.currentModel.name)
                : '—'}
          </span>
          <button className="model-dropdown-btn" type="button">
            <ChevronDown size={14} />
          </button>
          {dropdownOpen && (
            <div className="model-dropdown" onClick={(e) => e.stopPropagation()}>
              {models.length === 0 ? (
                <div className="model-dropdown-item disabled">
                  <span>Failed to load models</span>
                </div>
              ) : (
                <>
                  {localModels.length > 0 && (
                    <>
                      <div className="model-dropdown-section">LOCAL MODELS</div>
                      {localModels.map((m) => (
                        <div
                          key={m.name}
                          className={`model-dropdown-item${isActive(m) ? ' active' : ''}${isDisabled(m) ? ' disabled' : ''}`}
                          onClick={() => !isDisabled(m) && !isActive(m) && handleSelectModel(m.name)}
                        >
                          <span>{m.display_name || m.name}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {localModels.length > 0 && apiModels.length > 0 && (
                    <div className="model-dropdown-divider" />
                  )}
                  {apiModels.length > 0 && (
                    <>
                      <div className="model-dropdown-section">API MODELS</div>
                      {apiModels.map((m) => (
                        <div
                          key={m.name}
                          className={`model-dropdown-item${isActive(m) ? ' active' : ''}${isDisabled(m) ? ' disabled' : ''}`}
                          onClick={() => !isDisabled(m) && !isActive(m) && handleSelectModel(m.name)}
                        >
                          <span>{m.display_name || m.name}</span>
                          <span className="provider-badge">{m.provider}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
