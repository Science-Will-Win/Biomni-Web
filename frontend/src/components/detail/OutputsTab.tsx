import { useState, useEffect, useMemo } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { listStepOutputs, getStepOutputUrl } from '@/api/files';
import { useTranslation } from '@/i18n';
import { MarkdownContent } from '@/utils/MarkdownContent';
import { highlightCodeSyntax } from '@/utils/codeHighlight';
import { SpecialTokenBlock } from '@/components/chat/SpecialTokenBlock';
import { recoverBrokenChars } from '@/utils/textClean';
import type { PlanStepResult } from '@/types';

/** Strip special tokens from result text fields. */
function stripSpecialTokens(s: string): string {
  return recoverBrokenChars(s
    // Strip execute blocks: closed, or unclosed (up to next observation/execute/end)
    .replace(/<execute>[\s\S]*?<\/execute>/gi, '')
    .replace(/<execute>[\s\S]*?(?=<observation>|<execute>|$)/gi, '')
    .replace(/\[EXECUTE\][\s\S]*?\[\/EXECUTE\]/g, '')
    .replace(/\[EXECUTE\][\s\S]*?(?=\[OBSERVATION\]|\[EXECUTE\]|$)/g, '')
    // Strip observation tags (extract inner content)
    .replace(/<observation>([\s\S]*?)<\/observation>/gi, '$1')
    .replace(/\[OBSERVATION\]([\s\S]*?)\[\/OBSERVATION\]/g, '$1')
    // Strip empty/unclosed observation tags
    .replace(/<observation>[\s\S]*$/gi, '')
    .replace(/\[OBSERVATION\][\s\S]*$/g, '')
    // Strip solution/think blocks
    .replace(/<solution>[\s\S]*?<\/solution>/gi, '')
    .replace(/\[SOLUTION\][\s\S]*?\[\/SOLUTION\]/g, '')
    .replace(/<solution>[\s\S]*$/gi, '')
    .replace(/\[SOLUTION\][\s\S]*$/g, '')
    .replace(/\[THINK\][\s\S]*?\[\/THINK\]/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\/think>/gi, ''));
}

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

  if (!data || (data.results.length === 0 && data.steps.length === 0)) {
    return (
      <div className="detail-empty-state">
        <p>{t('empty.outputs_hint') !== 'empty.outputs_hint'
          ? t('empty.outputs_hint')
          : 'Step results will appear here.'}</p>
      </div>
    );
  }

  // Group results by step number
  const grouped = new Map<number, PlanStepResult[]>();
  data.results.forEach((result) => {
    const stepNum = result.step || 1;
    if (!grouped.has(stepNum)) grouped.set(stepNum, []);
    grouped.get(stepNum)!.push(result);
  });

  return (
    <div className="detail-outputs-content">
      {/* Plan checklist */}
      {data.steps.length > 0 && (
        <div className="output-plan-checklist">
          {data.goal && <div className="output-plan-goal">{data.goal}</div>}
          <ul className="output-plan-steps">
            {data.steps.map((step, i) => (
              <li key={i} className={`output-plan-step ${step.status || 'pending'}`}>
                <span className="step-check">
                  {step.status === 'completed' ? '\u2713' : step.status === 'error' ? '\u2717' : step.status === 'running' ? '\u2192' : '\u25CB'}
                </span>
                <div className="step-info">
                  <span className="step-name">{step.name}</span>
                  {step.description && <span className="step-desc">{step.description}</span>}
                </div>
              </li>
            ))}
          </ul>
          {(() => {
            const r = data.retrievalResult;
            const fallback = data.retrievedTools;
            if (r) {
              return (
                <div className="output-retrieved-tools">
                  {r.tools.length > 0 && (
                    <>
                      <div className="output-retrieved-tools-label">{t('label.retrieved_tools')}</div>
                      <div className="output-retrieved-tools-list">
                        {r.tools.map((tool, i) => (
                          <span key={`t-${i}`} className="output-tool-tag">{tool}</span>
                        ))}
                      </div>
                    </>
                  )}
                  {r.dataLake.length > 0 && (
                    <>
                      <div className="output-retrieved-tools-label">{t('label.retrieved_data_lake')}</div>
                      <div className="output-retrieved-tools-list">
                        {r.dataLake.map((item, i) => (
                          <span key={`dl-${i}`} className="output-tool-tag output-tool-tag--data-lake">{item}</span>
                        ))}
                      </div>
                    </>
                  )}
                  {r.libraries.length > 0 && (
                    <>
                      <div className="output-retrieved-tools-label">{t('label.retrieved_libraries')}</div>
                      <div className="output-retrieved-tools-list">
                        {r.libraries.map((lib, i) => (
                          <span key={`lib-${i}`} className="output-tool-tag output-tool-tag--library">{lib}</span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            }
            if (fallback && fallback.length > 0) {
              return (
                <div className="output-retrieved-tools">
                  <div className="output-retrieved-tools-label">Retrieved Tools</div>
                  <div className="output-retrieved-tools-list">
                    {fallback.map((tool, i) => (
                      <span key={i} className="output-tool-tag">{tool}</span>
                    ))}
                  </div>
                </div>
              );
            }
            return null;
          })()}
        </div>
      )}
      {/* Grouped step results */}
      {Array.from(grouped.entries()).map(([stepNum, results]) => {
        const step = data.steps[stepNum - 1];
        return (
          <GroupedStepOutputSection
            key={stepNum}
            index={stepNum}
            stepName={step?.name || 'Step'}
            toolName={step?.tool || results[0]?.tool || ''}
            results={results}
            convId={convId}
          />
        );
      })}
    </div>
  );
}

interface GroupedStepOutputSectionProps {
  index: number;
  stepName: string;
  toolName: string;
  results: PlanStepResult[];
  convId: string | null;
}

function GroupedStepOutputSection({ index, stepName, toolName, results, convId }: GroupedStepOutputSectionProps) {
  const [figures, setFigures] = useState<string[]>([]);

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

  const hasError = results.some((r) => !r.success);

  return (
    <div className="output-step-section" data-step={index}>
      <div className="output-step-header">
        <span className="output-step-number">{index}</span>
        <span className="output-step-title">{stepName}</span>
        {toolName && <span className="output-step-tool">{toolName}</span>}
        {hasError && <span className="output-step-error">Error</span>}
      </div>
      {results.map((result, i) => (
        <div key={i} className="output-content">
          <ToolResultDetail result={result.result} />
        </div>
      ))}
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
    return <pre className="result-text">{stripSpecialTokens(result)}</pre>;
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

  // ── Segments-based rendering (interleaved) ──
  const segments = Array.isArray(r.segments) ? r.segments as Array<{ type: string; content: string }> : null;
  const defaultLang = (r.language as string) || 'python';

  if (segments && segments.length > 0) {
    segments.forEach((seg, i) => {
      if (!seg.content) return;
      switch (seg.type) {
        case 'thinking':
          parts.push(
            <SpecialTokenBlock key={`seg-${i}`} label="Thinking" content={seg.content} variant="think" isStreaming={false} />,
          );
          break;
        case 'planning':
          parts.push(
            <SpecialTokenBlock key={`seg-${i}`} label="Planning" content={seg.content} variant="think" isStreaming={false} />,
          );
          break;
        case 'text':
          parts.push(
            <div key={`seg-${i}`} className="output-reasoning"><MarkdownContent text={seg.content} /></div>,
          );
          break;
        case 'code':
          parts.push(
            <OutputCodeBlock key={`seg-${i}`} code={seg.content} language={defaultLang} />,
          );
          break;
        case 'output':
          parts.push(
            <pre key={`seg-${i}`} className="result-stdout">{recoverBrokenChars(seg.content)}</pre>,
          );
          break;
        case 'solution':
          parts.push(
            <div key={`seg-${i}`} className="output-solution"><MarkdownContent text={seg.content} /></div>,
          );
          break;
      }
    });
  } else {
    // ── Fallback: flat fields (backward compat) ──
    if (r.thinking && typeof r.thinking === 'string') {
      const cleanThinking = stripSpecialTokens(r.thinking as string).trim();
      if (cleanThinking) {
        parts.push(
          <SpecialTokenBlock key="thinking" label="Thinking" content={cleanThinking} variant="think" isStreaming={false} />,
        );
      }
    }

    if (r.reasoning && typeof r.reasoning === 'string') {
      const cleanReasoning = stripSpecialTokens(r.reasoning as string).trim();
      if (cleanReasoning) {
        parts.push(<div key="reasoning" className="output-reasoning"><MarkdownContent text={cleanReasoning} /></div>);
      }
    }

    if (r.code && typeof r.code === 'string') {
      parts.push(
        <OutputCodeBlock key="code" code={r.code as string} language={defaultLang} />,
      );
    }

    if (r.execution && typeof r.execution === 'object') {
      const exec = r.execution as Record<string, unknown>;
      const execStdout = typeof exec.stdout === 'string' ? stripSpecialTokens(exec.stdout as string).trim() : '';
      if (execStdout) {
        parts.push(<pre key="exec-stdout" className="result-stdout">{execStdout}</pre>);
      }
    } else if (r.stdout && typeof r.stdout === 'string') {
      const cleanStdout = stripSpecialTokens(r.stdout as string).trim();
      if (cleanStdout) {
        parts.push(<pre key="stdout" className="result-stdout">{cleanStdout}</pre>);
      }
    }
  }

  // Solution
  if (r.solution && typeof r.solution === 'string') {
    const cleanSolution = stripSpecialTokens(r.solution as string).trim();
    if (cleanSolution) {
      parts.push(
        <div key="solution" className="output-solution"><MarkdownContent text={cleanSolution} /></div>,
      );
    }
  }

  // Stderr
  if (r.stderr && typeof r.stderr === 'string' && r.stderr.trim()) {
    parts.push(
      <pre key="stderr" className="result-stderr">{r.stderr}</pre>,
    );
  }

  // Summary (Markdown rendered) — strip observation tags
  if (r.summary && typeof r.summary === 'string') {
    parts.push(<div key="summary" className="output-summary"><MarkdownContent text={stripSpecialTokens(r.summary as string)} /></div>);
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
    // Skip rendering if result only has metadata fields (stdout was stripped empty, tool, etc.)
    const meaningfulKeys = Object.keys(r).filter(k => k !== 'tool' && k !== 'success' && k !== 'step');
    const hasOnlyMeta = meaningfulKeys.every(k => {
      const v = r[k];
      if (typeof v === 'string') return stripSpecialTokens(v).trim() === '';
      return false;
    });
    if (hasOnlyMeta) return null;
    return <pre className="result-json">{JSON.stringify(result, null, 2)}</pre>;
  }

  return <>{parts}</>;
}

/** Code block with syntax highlighting (same style as CodeTab). */
function OutputCodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const cleanCode = useMemo(() => recoverBrokenChars(code), [code]);
  const highlightedHtml = useMemo(() => highlightCodeSyntax(cleanCode, language), [cleanCode, language]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(cleanCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-title">Code</span>
        <span className="code-block-lang">{language}</span>
        <button className={`code-copy-btn${copied ? ' copied' : ''}`} style={{ marginLeft: 'auto' }} onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="code-block-body" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
    </div>
  );
}
