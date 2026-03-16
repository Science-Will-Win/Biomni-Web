import { useState, useEffect, useMemo } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { useTranslation } from '@/i18n';
import { executeCode, toolCall } from '@/api/tools';
import { listStepOutputs, getStepOutputUrl } from '@/api/files';
import { highlightCodeSyntax } from '@/utils/codeHighlight';
import type { CodeData } from '@/types';

export function CodeTab() {
  const { state, dispatch: appDispatch } = useAppContext();
  const { state: chatState } = useChatContext();
  const { t } = useTranslation();
  const data = state.detailPanelData;
  const convId = chatState.conversationId;

  const [selectedStep, setSelectedStep] = useState<'all' | number>('all');
  const [regenerating, setRegenerating] = useState(false);

  const stepIndices = useMemo(() =>
    Object.keys(data?.codes || {}).map(Number).sort((a, b) => a - b),
    [data?.codes],
  );

  if (!data || stepIndices.length === 0) {
    return (
      <div className="detail-empty-state">
        <p>{t('no_code') !== 'no_code' ? t('no_code') : 'No code generated yet.'}</p>
      </div>
    );
  }

  const handleCopyAll = async () => {
    const allCode = stepIndices.map(idx => {
      const cd = data.codes[idx];
      return typeof cd === 'string' ? cd : cd?.code || '';
    }).join('\n\n');
    await navigator.clipboard.writeText(allCode);
  };

  const handleRegenerate = async () => {
    if (selectedStep === 'all' || selectedStep == null || !convId) return;
    const step = data.steps[selectedStep];
    if (!step) return;
    setRegenerating(true);
    try {
      const result = await toolCall({
        tool_name: 'code_gen',
        arguments: {
          task: step.description || step.name,
          language: 'python',
          conv_id: convId,
          step_index: selectedStep,
          force: true,
        },
      });
      const res = result?.result as Record<string, unknown> | undefined;
      if (res?.code) {
        appDispatch({
          type: 'SET_STEP_CODE',
          payload: {
            stepIndex: selectedStep,
            code: String(res.code),
            language: String(res.language || 'python'),
            execution: res.execution as Record<string, unknown> | undefined,
            fixAttempts: (res.fix_attempts as number) || 0,
          },
        });
      }
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="detail-code-content">
      {/* Step selector: All + per-step buttons */}
      <div className="code-step-selector">
        <button
          className={`code-step-btn${selectedStep === 'all' ? ' active' : ''}`}
          onClick={() => setSelectedStep('all')}
        >
          {t('label.all') || 'All'}
        </button>
        {stepIndices.map(idx => {
          const stepTool = data.steps[idx]?.tool || '';
          return (
            <button
              key={idx}
              className={`code-step-btn${selectedStep === idx ? ' active' : ''}`}
              onClick={() => setSelectedStep(idx)}
            >
              Step {idx + 1}{stepTool ? `: ${stepTool}` : ''}
            </button>
          );
        })}
      </div>

      {/* Code blocks */}
      {selectedStep === 'all' ? (
        stepIndices.map(idx => (
          <CodeBlock key={idx} stepIndex={idx} data={data} convId={convId} />
        ))
      ) : (
        <CodeBlock stepIndex={selectedStep} data={data} convId={convId} />
      )}

      {/* Bottom actions */}
      <div className="code-actions">
        <button className="code-copy-btn" onClick={handleCopyAll}>Copy</button>
        <button
          className="code-regen-btn"
          onClick={handleRegenerate}
          disabled={selectedStep === 'all' || regenerating}
        >
          {regenerating ? 'Regenerating...' : 'Regenerate'}
        </button>
      </div>
    </div>
  );
}

// ─── CodeBlock ───

interface CodeBlockProps {
  stepIndex: number;
  data: import('@/types').DetailPanelData;
  convId: string | null;
}

function CodeBlock({ stepIndex, data, convId }: CodeBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [execResult, setExecResult] = useState<Record<string, unknown> | null>(null);
  const [savedFigures, setSavedFigures] = useState<string[]>([]);

  const codeData = data.codes[stepIndex];
  const code = typeof codeData === 'string' ? codeData : (codeData as CodeData)?.code || '';
  const language = typeof codeData === 'object' && codeData !== null ? (codeData as CodeData).language || 'python' : 'python';
  const execution = typeof codeData === 'object' && codeData !== null ? (codeData as CodeData).execution : undefined;
  const stepTool = data.steps[stepIndex]?.tool || '';
  const title = `Step ${stepIndex + 1}${stepTool ? `: ${stepTool}` : ''}`;

  // Show existing execution result
  useEffect(() => {
    if (execution) setExecResult(execution);
  }, [execution]);

  // Load saved figures
  useEffect(() => {
    if (!convId) return;
    let cancelled = false;
    listStepOutputs(convId, stepIndex)
      .then(r => { if (!cancelled) setSavedFigures(r.figures || []); })
      .catch(() => { if (!cancelled) setSavedFigures([]); });
    return () => { cancelled = true; };
  }, [convId, stepIndex]);

  const handleRun = async () => {
    setRunning(true);
    setExecResult(null);
    try {
      const result = await executeCode({
        code, language, conv_id: convId || undefined, step_index: stepIndex,
      });
      setExecResult(result);
      if (convId) {
        const outputs = await listStepOutputs(convId, stepIndex).catch(() => ({ figures: [] }));
        setSavedFigures((outputs as { figures?: string[] }).figures || []);
      }
    } catch (err) {
      setExecResult({ success: false, stderr: String(err) });
    } finally {
      setRunning(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const highlightedHtml = useMemo(() => highlightCodeSyntax(code, language), [code, language]);

  // Merge figures
  const execFigures = (execResult?.figures as string[]) || [];
  const allFigures = [...execFigures, ...savedFigures.filter(f => !execFigures.includes(f))];

  return (
    <div className="code-block" data-step={stepIndex}>
      <div className="code-block-header">
        <span className="code-block-title">{title}</span>
        <span className="code-block-lang">{language}</span>
        <button className="code-run-btn" onClick={handleRun} disabled={running}>
          {running ? (t('label.running') || 'Running...') : (t('label.run') || 'Run')}
        </button>
        <button className={`code-copy-btn${copied ? ' copied' : ''}`} onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="code-block-body" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />

      {/* Execution results */}
      <CodeResultSection result={execResult} figures={allFigures} convId={convId} stepIndex={stepIndex} />
    </div>
  );
}

// ─── CodeResultSection ───

function CodeResultSection({ result, figures, convId, stepIndex }: {
  result: Record<string, unknown> | null;
  figures: string[];
  convId: string | null;
  stepIndex: number;
}) {
  if (!result && figures.length === 0) return null;

  const stdout = result?.stdout as string | undefined;
  const stderr = result?.stderr as string | undefined;
  const hasContent = !!(stdout || stderr?.trim() || figures.length > 0);

  return (
    <div className="code-result" style={{ display: 'block' }}>
      {!hasContent && result && (
        <div className={`code-exec-status ${result.success !== false ? 'success' : 'failure'}`}>
          {result.success !== false ? 'Execution completed (no output)' : 'Execution failed'}
        </div>
      )}
      {result?.success === false && hasContent && (
        <div className="code-exec-status failure">Execution failed</div>
      )}

      {stdout && (
        <div className="code-result-stdout">
          <pre className="code-stdout">{stdout}</pre>
        </div>
      )}

      {figures.length > 0 && (
        <div className="code-result-figures">
          {figures.map((f, i) => (
            <img
              key={i}
              src={convId ? getStepOutputUrl(convId, stepIndex, f) : f}
              className="code-result-img"
              alt={`Figure ${i + 1}`}
              loading="lazy"
            />
          ))}
        </div>
      )}

      {stderr?.trim() && (
        <div className="code-result-stderr">
          <pre className="code-error">{stderr}</pre>
        </div>
      )}
    </div>
  );
}
