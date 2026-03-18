// ============================================
// Node Detail Modal — shows on double-click on node body
// Graph-tab local, not global AppContext modal
// ============================================

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '@/i18n';
import type { NodeData } from '../types';
import { getNodeDef } from '../node-registry';

interface NodeDetailModalProps {
  node: NodeData;
  onClose: () => void;
  onTitleChange: (nodeId: string, title: string) => void;
  onDescriptionChange: (nodeId: string, desc: string) => void;
  onPortValueChange?: (nodeId: string, portName: string, value: unknown) => void;
}

export function NodeDetailModal({ node, onClose, onTitleChange, onDescriptionChange, onPortValueChange }: NodeDetailModalProps) {
  const { t } = useTranslation();
  const def = getNodeDef(node.type);
  const [title, setTitle] = useState(node.title);
  const [desc, setDesc] = useState(node.description || '');
  const overlayRef = useRef<HTMLDivElement>(null);

  // Sync when node changes externally
  useEffect(() => { setTitle(node.title); }, [node.title]);
  useEffect(() => { setDesc(node.description || ''); }, [node.description]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const isStep = node.type === 'step' || node.type.startsWith('step');
  const isTool = node.type.startsWith('tool_');
  const isLibrary = node.type === 'library' || node.type.startsWith('lib_');
  const isDataLake = node.type === 'data' || node.type.startsWith('dl_');

  const descFromDef = def?.defaultConfig.description;
  const lang = document.documentElement.lang || 'en';
  const descText = descFromDef
    ? (descFromDef[lang] || descFromDef.en || Object.values(descFromDef)[0] || '')
    : '';

  return (
    <div className="ng-detail-overlay" ref={overlayRef}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}>
      <div className="ng-detail-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="ng-detail-header">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              onTitleChange(node.id, e.target.value);
            }}
          />
          <button className="ng-detail-close" onClick={onClose}>&times;</button>
        </div>

        {/* Body */}
        <div className="ng-detail-body">
          {/* Type & Status */}
          <div className="ng-detail-section">
            <div className="ng-detail-label">{t('graph.detail.type')}</div>
            <div className="ng-detail-value">{node.type}</div>
          </div>
          <div className="ng-detail-section">
            <div className="ng-detail-label">{t('graph.detail.status')}</div>
            <div className="ng-detail-value">{node.status}</div>
          </div>

          {/* Step: node info + editable description */}
          {isStep && (
            <>
              {descText && (
                <div className="ng-detail-section">
                  <div className="ng-detail-label">{t('graph.detail.node_info')}</div>
                  <div className="ng-detail-value">{descText}</div>
                </div>
              )}
              <div className="ng-detail-section">
                <div className="ng-detail-label">{t('graph.detail.description')}</div>
                <textarea
                  className="ng-detail-desc-input"
                  value={desc}
                  onChange={(e) => {
                    setDesc(e.target.value);
                    onDescriptionChange(node.id, e.target.value);
                  }}
                  placeholder={t('graph.detail.step_desc_placeholder')}
                />
              </div>
            </>
          )}

          {/* Tool: description + parameters with editing */}
          {isTool && (
            <>
              {node.tool && (
                <div className="ng-detail-section">
                  <div className="ng-detail-label">{t('graph.detail.tool')}</div>
                  <div className="ng-detail-value">{node.tool}</div>
                </div>
              )}
              {descText && (
                <div className="ng-detail-section">
                  <div className="ng-detail-label">{t('graph.detail.description')}</div>
                  <div className="ng-detail-value">{descText}</div>
                </div>
              )}
              {def && (
                <ToolParamsSection
                  def={def}
                  portValues={node.portValues}
                  nodeId={node.id}
                  onPortValueChange={onPortValueChange}
                />
              )}
            </>
          )}

          {/* Library: description */}
          {isLibrary && descText && (
            <div className="ng-detail-section">
              <div className="ng-detail-label">{t('graph.detail.description')}</div>
              <div className="ng-detail-value">{descText}</div>
            </div>
          )}

          {/* DataLake: description */}
          {isDataLake && (
            <>
              {descText && (
                <div className="ng-detail-section">
                  <div className="ng-detail-label">{t('graph.detail.description')}</div>
                  <div className="ng-detail-value">{descText}</div>
                </div>
              )}
              {node.portValues?.out && (
                <div className="ng-detail-section">
                  <div className="ng-detail-label">{t('graph.detail.dataset')}</div>
                  <div className="ng-detail-value">
                    {JSON.stringify(node.portValues.out, null, 2)}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Generic: portValues */}
          {!isStep && !isTool && !isLibrary && !isDataLake && node.portValues && Object.keys(node.portValues).length > 0 && (
            <div className="ng-detail-section">
              <div className="ng-detail-label">{t('graph.detail.port_values')}</div>
              <div className="ng-detail-value" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 11 }}>
                {JSON.stringify(node.portValues, null, 2)}
              </div>
            </div>
          )}

          {/* Result text if any */}
          {node.resultText && (
            <div className="ng-detail-section">
              <div className="ng-detail-label">{t('graph.detail.result')}</div>
              <div className="ng-detail-value" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 11, maxHeight: 200, overflowY: 'auto' }}>
                {node.resultText}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Tool Parameters Sub-section (with descriptions + editable inputs) ----

function ToolParamsSection({ def, portValues, nodeId, onPortValueChange }: {
  def: ReturnType<typeof getNodeDef>;
  portValues?: Record<string, unknown>;
  nodeId: string;
  onPortValueChange?: (nodeId: string, portName: string, value: unknown) => void;
}) {
  const { t } = useTranslation();
  if (!def) return null;
  const inPorts = def.ports.filter(p => p.dir === 'in' && p.name !== 'in');
  if (inPorts.length === 0) return null;

  return (
    <div className="ng-detail-section">
      <div className="ng-detail-label">{t('graph.detail.parameters')}</div>
      <div className="ng-detail-params-list">
        {inPorts.map(port => {
          const val = portValues?.[port.name];
          return (
            <div key={port.name} className="ng-detail-param-row">
              <div className="ng-detail-param-header">
                <span className={port.required ? 'ng-detail-param-required' : ''}>
                  {port.label || port.name}
                </span>
                <span className="ng-detail-param-type">({port.type})</span>
                {port.required && <span className="ng-detail-param-required">*</span>}
              </div>
              {port.description && (
                <div className="ng-detail-param-desc">{port.description}</div>
              )}
              {port.type === 'boolean' ? (
                <label className="ng-detail-param-checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(val)}
                    onChange={() => onPortValueChange?.(nodeId, port.name, !val)}
                  />
                </label>
              ) : (port.type === 'data' || port.type === 'any') ? (
                <div className="ng-detail-param-readonly">
                  {val != null ? String(val) : '—'}
                </div>
              ) : (
                <input
                  className="ng-detail-param-input"
                  value={val != null ? String(val) : ''}
                  placeholder={port.label || port.name}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (port.type === 'int') {
                      const num = raw === '' ? 0 : parseInt(raw);
                      onPortValueChange?.(nodeId, port.name, isNaN(num) ? 0 : num);
                    } else {
                      onPortValueChange?.(nodeId, port.name, raw);
                    }
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
