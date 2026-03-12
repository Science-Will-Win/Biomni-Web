import { useState, useEffect } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { listStepOutputs, getStepOutputUrl } from '@/api/files';
import { useTranslation } from '@/i18n';
import { MarkdownContent } from '@/utils/MarkdownContent';
import type { PlanStepResult } from '@/types';

/**
 * OutputsTab — renders per-step tool results as they arrive.
 * Ported from original UI/app.js renderOutputs() + renderToolResultDetail().
 */
export function OutputsTab() {
  const { state: appState } = useAppContext();
  const { state: chatState } = useChatContext();
  const { t } = useTranslation();
  const data = appState.detailPanelData;
  const convId = chatState.conversationId;

  if (!data || data.results.length === 0) {
    return (
      <div className="detail-empty-state">
        <p>{t('empty.outputs_hint') !== 'empty.outputs_hint'
          ? t('empty.outputs_hint')
          : 'Step results will appear here.'}</p>
      </div>
    );
  }

  return (
    <div className="detail-outputs-content">
      {data.results.map((result, i) => {
        const step = data.steps[result.step - 1] || data.steps[i];
        return (
          <StepOutputSection
            key={`${result.step}-${i}`}
            index={result.step || i + 1}
            stepName={step?.name || 'Step'}
            toolName={result.tool || step?.tool || ''}
            result={result}
            convId={convId}
          />
        );
      })}
    </div>
  );
}

interface StepOutputSectionProps {
  index: number;
  stepName: string;
  toolName: string;
  result: PlanStepResult;
  convId: string | null;
}

function StepOutputSection({ index, stepName, toolName, result, convId }: StepOutputSectionProps) {
  const [figures, setFigures] = useState<string[]>([]);

  // Also fetch file-based outputs (figures) for this step
  useEffect(() => {
    if (!convId) return;
    let cancelled = false;
    listStepOutputs(convId, index - 1)
      .then((res) => {
        if (!cancelled) setFigures(res.figures || []);
      })
      .catch(() => {
        if (!cancelled) setFigures([]);
      });
    return () => { cancelled = true; };
  }, [convId, index]);

  return (
    <div className="output-step-section">
      <div className="output-step-header">
        <span className="output-step-number">{index}</span>
        <span className="output-step-title">{stepName}</span>
        {toolName && <span className="output-step-tool">{toolName}</span>}
        {!result.success && (
          <span className="output-step-error">Error</span>
        )}
      </div>
      <div className="output-content">
        <ToolResultDetail result={result.result} />
        {/* File-based figures */}
        {figures.map((fn) => (
          <div key={fn} className="output-figure">
            <img
              src={convId ? getStepOutputUrl(convId, index - 1, fn) : ''}
              alt={fn}
              loading="lazy"
              style={{ maxWidth: '100%', borderRadius: 'var(--radius-md)' }}
            />
            <div className="output-figure-label">{fn}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Renders tool result detail — ported from original UI/app.js:5065-5117.
 */
function ToolResultDetail({ result }: { result: unknown }) {
  if (!result) return <div className="output-no-result">No result data.</div>;

  const r = result as Record<string, unknown>;

  // Check if it's just a string
  if (typeof result === 'string') {
    return <pre className="result-text">{result}</pre>;
  }

  const parts: JSX.Element[] = [];

  // Title
  if (r.title && typeof r.title === 'string') {
    parts.push(<div key="title" className="output-title">{r.title}</div>);
  }

  // Error
  if (r.error && typeof r.error === 'string') {
    parts.push(<div key="error" className="output-error">{r.error}</div>);
  }

  // Details list
  if (Array.isArray(r.details)) {
    parts.push(
      <ul key="details" className="output-details">
        {(r.details as unknown[]).map((d, i) => (
          <li key={i}>{String(d)}</li>
        ))}
      </ul>,
    );
  }

  // Tables (gene_table, paper_list, efficiency_data, or generic table)
  const tableFields = ['gene_table', 'paper_list', 'efficiency_data', 'table'];
  for (const field of tableFields) {
    if (Array.isArray(r[field]) && (r[field] as unknown[]).length > 0) {
      const rows = r[field] as Record<string, unknown>[];
      const columns = Object.keys(rows[0]);
      parts.push(
        <div key={field} className="output-table-wrapper">
          <div className="output-table-label">{field.replace(/_/g, ' ')}</div>
          <table className="output-table">
            <thead>
              <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(0, 10).map((row, ri) => (
                <tr key={ri}>
                  {columns.map((c) => <td key={c}>{String(row[c] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 10 && (
            <div className="output-table-more">... and {rows.length - 10} more rows</div>
          )}
        </div>,
      );
    }
  }

  // Stdout (code execution output)
  if (r.stdout && typeof r.stdout === 'string') {
    parts.push(
      <pre key="stdout" className="result-stdout">{r.stdout}</pre>,
    );
  }

  // Stderr
  if (r.stderr && typeof r.stderr === 'string' && r.stderr.trim()) {
    parts.push(
      <pre key="stderr" className="result-stderr">{r.stderr}</pre>,
    );
  }

  // Code
  if (r.code && typeof r.code === 'string') {
    parts.push(
      <pre key="code" className="result-code">{r.code}</pre>,
    );
  }

  // Summary (Markdown rendered)
  if (r.summary && typeof r.summary === 'string') {
    parts.push(<div key="summary" className="output-summary"><MarkdownContent text={r.summary as string} /></div>);
  }

  // Text (Markdown rendered)
  if (r.text && typeof r.text === 'string') {
    parts.push(<div key="text" className="output-text"><MarkdownContent text={r.text as string} /></div>);
  }

  // Meta info (duration, tokens)
  const meta: string[] = [];
  if (typeof r.duration === 'number') meta.push(`${r.duration.toFixed(1)}s`);
  if (typeof r.tokens === 'number') meta.push(`${r.tokens} tokens`);
  if (meta.length > 0) {
    parts.push(<div key="meta" className="output-meta">{meta.join(' | ')}</div>);
  }

  // Fallback: unwrap nested result objects (e.g., {success, result: {actual data}})
  if (parts.length === 0) {
    if (r.result && typeof r.result === 'object') {
      return <ToolResultDetail result={r.result} />;
    }
    return <pre className="result-json">{JSON.stringify(result, null, 2)}</pre>;
  }

  return <>{parts}</>;
}
