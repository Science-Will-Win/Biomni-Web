import { useState, useEffect } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { useTranslation } from '@/i18n';
import { truncateConversation } from '@/api/conversations';
import { listStepOutputs, getStepOutputUrl } from '@/api/files';
import { MarkdownContent } from '@/utils/MarkdownContent';
import type { ToolCallEvent, ToolResultEvent, DetailPanelData, PlanStepResult } from '@/types';

interface Props {
  toolCalls: ToolCallEvent['tool_call'][];
  toolResults?: ToolResultEvent['tool_result'][];
  messageIndex: number;
}

interface PlanStepDisplay {
  name: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'stopped';
  tool?: string;
}

/** Map backend tool identifiers to human-readable labels */
const TOOL_LABELS: Record<string, string> = {
  code_gen: '코드 생성',
  create_plan: '플랜 생성',
  web_search: '웹 검색',
};

function getToolLabel(tool?: string): string {
  if (!tool) return '';
  return TOOL_LABELS[tool] ?? tool;
}

/**
 * Plan Steps Box — renders create_plan tool call as a summary plan card
 * in the chat message.
 */
export function PlanStepsBox({ toolCalls, toolResults, messageIndex }: Props) {
  const { state: appState, dispatch: appDispatch } = useAppContext();
  const { state: chatState, dispatch: chatDispatch } = useChatContext();
  const { sendMessage, sendRaw } = useWebSocket();
  const { t } = useTranslation();

  // Find create_plan tool call
  const createPlanCall = toolCalls.find((tc) => tc.name === 'create_plan');
  if (!createPlanCall) return null;

  const args = createPlanCall.arguments as {
    goal?: string;
    steps?: Array<{ name: string; description?: string }>;
  };

  if (!args?.steps?.length) return null;

  // Merge with live detail panel data for step statuses + tools
  const panelSteps = appState.detailPanelData?.steps;
  const panelResults = appState.detailPanelData?.results;

  const steps: PlanStepDisplay[] = args.steps.map((s, i) => {
    const liveStatus = panelSteps?.[i]?.status;
    const liveTool = panelSteps?.[i]?.tool;
    const stepResult = toolResults?.find((tr) => tr.step === i + 1);

    let status: PlanStepDisplay['status'] = 'pending';
    if (liveStatus) {
      status = liveStatus;
    } else if (stepResult) {
      status = stepResult.success ? 'completed' : 'error';
    }

    return {
      name: s.name,
      description: s.description || '',
      status,
      tool: liveTool || stepResult?.tool,
    };
  });

  // Merge results from two sources: props (message history) + AppContext (live)
  const getStepResults = (stepNum: number): PlanStepResult[] => {
    const fromState = panelResults?.filter(r => r.step === stepNum) || [];
    if (fromState.length > 0) return fromState;
    return (toolResults?.filter(tr => tr.step === stepNum) || []).map(tr => ({
      step: tr.step ?? 0,
      tool: tr.tool,
      success: tr.success,
      result: tr.result,
    }));
  };

  const handleMoreDetail = () => {
    const planData: DetailPanelData = {
      goal: args.goal || 'Plan',
      steps: steps.map(s => ({
        name: s.name,
        description: s.description,
        status: s.status,
        tool: s.tool,
      })),
      results: (toolResults || [])
        .filter(tr => tr.step != null && tr.step > 0)
        .map(tr => ({
          step: tr.step!,
          tool: tr.tool,
          success: tr.success,
          result: tr.result,
        })),
      codes: {},
      analysis: '',
      currentStep: steps.length,
    };
    toolResults?.forEach(tr => {
      const res = tr.result as Record<string, unknown> | undefined;
      if (res && typeof res === 'object' && res.code && tr.step != null) {
        planData.codes[tr.step - 1] = {
          code: String(res.code),
          language: String(res.language || 'python'),
          execution: res.execution as Record<string, unknown> | undefined,
          fixAttempts: (res.fix_attempts as number) || 0,
          stepIndex: tr.step - 1,
          ...(Array.isArray(res.segments) ? { segments: res.segments as import('@/types').CodeSegment[] } : {}),
        };
      }
    });
    // Preserve existing retrieval result and tool retrieval status
    const existing = appState.detailPanelData;
    if (existing?.retrievalResult) {
      planData.retrievalResult = existing.retrievalResult;
    }
    if (existing?.retrievedTools) {
      planData.retrievedTools = existing.retrievedTools;
    }
    if (existing?.toolRetrievalStatus) {
      planData.toolRetrievalStatus = existing.toolRetrievalStatus;
    }
    // Preserve step executions
    if (existing?.stepExecutions) {
      planData.stepExecutions = existing.stepExecutions;
    }
    appDispatch({ type: 'SET_DETAIL_PANEL_DATA', payload: planData });
    appDispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'outputs' });
  };

  // Check if this plan box is currently active
  const isActive = appState.detailPanelData?.goal === (args.goal || 'Plan') &&
    appState.detailPanelData?.steps?.length === steps.length;

  // Step action handlers
  const handleRetryStep = (stepIndex: number) => {
    const convId = chatState.conversationId;
    if (!convId) return;
    sendRaw('chat', {
      conv_id: convId,
      message: '',
      mode: 'plan',
      rerun: true,
      rerun_steps: [{ name: steps[stepIndex].name, description: steps[stepIndex].description }],
      rerun_goal: args.goal || '',
      retry_step: stepIndex + 1,
    });
  };

  const handleAskStep = (stepIndex: number) => {
    const step = steps[stepIndex];
    const stepResults = getStepResults(stepIndex + 1);
    const context = stepResults.map(r => JSON.stringify(r.result)).join('\n').slice(0, 500);

    // Collect previous step results summary
    const previousSteps = (panelResults || [])
      .filter(r => r.step < stepIndex + 1 && r.step > 0)
      .map(r => {
        const res = r.result as Record<string, unknown> | null;
        return `Step ${r.step}: ${res?.title || res?.summary || 'completed'}`;
      });

    const planGoal = args.goal || '';
    const planStepNames = steps.map(s => s.name);

    chatDispatch({
      type: 'ADD_STEP_QUESTION',
      payload: {
        stepNum: stepIndex + 1,
        tool: step.tool || '',
        stepName: step.name,
        context,
        previousSteps,
        planGoal,
        planSteps: planStepNames,
      },
    });
  };

  const handleEditStep = (stepIndex: number) => {
    // Edit step result — stored in localStorage
    const key = `step-edit-${chatState.conversationId}-${stepIndex}`;
    const stepResults = getStepResults(stepIndex + 1);
    const currentText = stepResults.map(r => {
      const res = r.result as Record<string, unknown> | string;
      if (typeof res === 'string') return res;
      return res?.summary || res?.text || JSON.stringify(res, null, 2);
    }).join('\n');

    const edited = prompt('Edit step result:', localStorage.getItem(key) || String(currentText));
    if (edited !== null) {
      localStorage.setItem(key, edited);
    }
  };

  // Goal action handlers
  const handleAskPlan = () => {
    chatDispatch({
      type: 'ADD_STEP_QUESTION',
      payload: {
        stepNum: 0,
        tool: '',
        stepName: args.goal || 'Plan',
        context: '',
        planGoal: args.goal || '',
        planSteps: steps.map(s => s.name),
      },
    });
  };

  const handleRegenPlan = async () => {
    const convId = chatState.conversationId;
    if (!convId) return;

    const userIdx = messageIndex - 1;
    const userMsg = chatState.messages[userIdx];
    if (!userMsg || userMsg.role !== 'user') return;

    await truncateConversation(convId, userIdx).catch(() => {});
    chatDispatch({ type: 'TRUNCATE_FROM', payload: userIdx });
    appDispatch({ type: 'CLEAR_DETAIL_PANEL' });

    const files = userMsg.files?.map((f) => ({
      file: new File([], (f.name as string) || ''),
      name: (f.name as string) || '',
      type: (f.type as 'image' | 'audio' | 'document') || 'document',
      uploadedFilename: (f.uploadId as string) || '',
    }));
    sendMessage(userMsg.content, files);
  };

  // Extract solution text from results (merge live toolResults + restored panelResults)
  const allResults = [
    ...(toolResults || []),
    ...(panelResults || []).filter(pr =>
      !(toolResults || []).some(tr => tr.step === pr.step)
    ),
  ].map(tr => ({
    step: tr.step ?? 0, tool: tr.tool, success: tr.success, result: tr.result,
  }));
  const solutionResult = [...allResults].reverse().find(r => {
    const d = r.result as Record<string, unknown> | null;
    return d && typeof d === 'object' && typeof (d as Record<string, unknown>).solution === 'string';
  });
  let solutionText = solutionResult
    ? String((solutionResult.result as Record<string, unknown>).solution)
    : null;

  // Fallback: parse [SOLUTION]...[/SOLUTION] or <solution>...</solution> from text_fallback results
  if (!solutionText) {
    const lastText = [...allResults].reverse().find(r => {
      const d = r.result as Record<string, unknown> | null;
      return d && typeof d === 'object' && typeof (d as Record<string, unknown>).text === 'string';
    });
    if (lastText) {
      const text = String((lastText.result as Record<string, unknown>).text);
      const m = text.match(/\[SOLUTION\]([\s\S]*?)\[\/SOLUTION\]/)
             || text.match(/<solution>([\s\S]*?)<\/solution>/i)
             || text.match(/<solution>([\s\S]+)$/i)
             || text.match(/\[SOLUTION\]([\s\S]+)$/);
      if (m) solutionText = m[1].trim();
    }
  }

  const toolRetrievalStatus = appState.detailPanelData?.toolRetrievalStatus;
  const retrievalResult = appState.detailPanelData?.retrievalResult;

  // Analysis status
  const analysisStatus = (() => {
    if (appState.detailPanelData?.analysis) return 'done';
    const lastStep = steps[steps.length - 1];
    if (lastStep?.status === 'stopped') return 'stopped';
    const allDone = steps.every(s => s.status === 'completed' || s.status === 'error');
    if (allDone && steps.length > 0) return 'running';
    return 'pending';
  })();

  return (
    <div
      className={`plan-steps-box${isActive ? ' plan-box-active' : ''}`}
      onClick={handleMoreDetail}
    >
      <div className="plan-goal plan-goal-row">
        <span className="plan-goal-text">{args.goal || 'Plan'}</span>
        <div className="plan-goal-actions">
          <button
            className="plan-ref-btn"
            onClick={(e) => { e.stopPropagation(); handleAskPlan(); }}
            title={t('tooltip.plan_ref') || 'Ask about this plan'}
          >
            ?
          </button>
          <button
            className="plan-regen-btn"
            onClick={(e) => { e.stopPropagation(); handleRegenPlan(); }}
            title={t('tooltip.regenerate_plan') || 'Regenerate plan'}
          >
            ↻
          </button>
        </div>
        <div className={`plan-tool-retrieval-row${toolRetrievalStatus === 'running' ? ' running' : ''}${toolRetrievalStatus === 'done' ? ' done' : ''}`}>
          {(toolRetrievalStatus === 'running' || toolRetrievalStatus === 'done') && (
            <>
              {toolRetrievalStatus === 'running' && <span className="analyzing-spinner" />}
              {toolRetrievalStatus === 'done' && <span className="analyzing-check">✓</span>}
              <span>{t('label.tool_retrieval')}</span>
            </>
          )}
        </div>
      </div>
      <div className="plan-steps">
        {steps.map((step, i) => (
          <PlanStepItem
            key={i}
            step={step}
            index={i}
            stepResults={getStepResults(i + 1)}
            onRetry={handleRetryStep}
            onAsk={handleAskStep}
            onEdit={handleEditStep}
            convId={chatState.conversationId}
          />
        ))}
      </div>
      {/* Analysis row */}
      <div className={`plan-analyzing-row${analysisStatus === 'done' ? ' plan-analyzing-done' : ''}${analysisStatus === 'stopped' ? ' plan-analyzing-stopped' : ''}`}>
        {analysisStatus === 'done' && <span className="analyzing-check">✓</span>}
        {analysisStatus === 'running' && <span className="analyzing-spinner" />}
        {analysisStatus === 'pending' && <span className="analyzing-icon">◎</span>}
        {analysisStatus === 'stopped' && <span className="analyzing-icon">◼</span>}
        <span>{analysisStatus === 'done' ? (t('status.analysis_complete') || 'Analysis Complete') : 'Analysis'}</span>
      </div>
      {solutionText && (
        <div className="plan-solution-box" onClick={(e) => e.stopPropagation()}>
          <span className="section-label-minimal" style={{ color: 'var(--accent-green, #4CAF50)' }}>Solution</span>
          <div className="step-brief-summary"><MarkdownContent text={solutionText} /></div>
        </div>
      )}
    </div>
  );
}

// ─── PlanStepItem ───

interface PlanStepItemProps {
  step: PlanStepDisplay;
  index: number;
  stepResults: PlanStepResult[];
  onRetry: (index: number) => void;
  onAsk: (index: number) => void;
  onEdit: (index: number) => void;
  convId: string | null;
}

function PlanStepItem({ step, index, stepResults, onRetry, onAsk, onEdit, convId }: PlanStepItemProps) {
  const [expanded, setExpanded] = useState(true);
  const { dispatch: appDispatch } = useAppContext();
  const hasResults = stepResults.length > 0;

  // Indicator: running keeps the number (CSS handles animation), others use symbols
  const indicator = (() => {
    switch (step.status) {
      case 'completed': return '✓';
      case 'error': return '!';
      case 'stopped': return '◼';
      case 'running': return index + 1;
      default: return index + 1;
    }
  })();

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasResults) setExpanded(!expanded);
  };

  return (
    <div className={`plan-step ${step.status}`} onClick={(e) => e.stopPropagation()}>
      <div className="step-header">
        <div className="step-header-main" onClick={handleToggle} style={{ cursor: hasResults ? 'pointer' : 'default' }}>
          <div className="step-indicator">{indicator}</div>
          <div className="step-content">
            <div className="step-name">{step.name}</div>
            {step.description && (
              <div className="step-description">{step.description}</div>
            )}
            {step.tool && (
              <div className="step-tool">{getToolLabel(step.tool)}</div>
            )}
          </div>
        </div>
        {/* step-actions: always rendered, CSS opacity controls visibility */}
        <div className="step-actions">
          <button className="step-action-btn" onClick={(e) => { e.stopPropagation(); onRetry(index); }} title="Retry">↻</button>
          <button className="step-action-btn" onClick={(e) => { e.stopPropagation(); onEdit(index); }} title="Edit">✎</button>
          <button className="step-action-btn" onClick={(e) => { e.stopPropagation(); onAsk(index); }} title="Ask">?</button>
        </div>
        {/* step-toggle: always rendered, visibility controlled by hasResults */}
        <div
          className="step-toggle"
          style={{ visibility: hasResults ? 'visible' : 'hidden' }}
          onClick={handleToggle}
        >
          {expanded ? '▲' : '▼'}
        </div>
      </div>
      {/* Inline step result */}
      {hasResults && (
        <div className="step-result" style={{ display: expanded ? 'block' : 'none' }}>
          <StepResultContent results={stepResults} stepIndex={index} convId={convId} appDispatch={appDispatch} />
        </div>
      )}
    </div>
  );
}

// ─── Result Meta Line (shared) ───

function ResultMetaLine({ obj, stepIndex, appDispatch, t }: {
  obj: Record<string, unknown>;
  stepIndex: number;
  appDispatch: React.Dispatch<import('@/context/AppContext').AppAction>;
  t: (key: string) => string;
}) {
  const duration = typeof obj.duration === 'number' ? `${obj.duration.toFixed(1)}s` : undefined;
  const tokens = typeof obj.tokens === 'number' ? `${obj.tokens} tokens` : undefined;
  const metaText = [duration, tokens].filter(Boolean).join(' · ');

  const handleMoreDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    appDispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'outputs' });
    setTimeout(() => {
      const el = document.querySelector(`.output-step-section[data-step="${stepIndex + 1}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  return (
    <div className="result-meta-line">
      <button className="step-more-detail-btn" onClick={handleMoreDetail}>
        {t('label.more_detail') || 'More detail'}
      </button>
      {metaText && <span className="result-meta-minimal">{metaText}</span>}
    </div>
  );
}

// ─── Step Result Rendering ───

interface StepResultContentProps {
  results: PlanStepResult[];
  stepIndex: number;
  convId: string | null;
  appDispatch: React.Dispatch<import('@/context/AppContext').AppAction>;
}

function StepResultContent({ results, stepIndex, convId, appDispatch }: StepResultContentProps) {
  return (
    <>
      {results.map((r, i) => (
        <div key={i}>
          {i > 0 && <hr className="tool-result-divider" />}
          <SingleResultView result={r} stepIndex={stepIndex} convId={convId} appDispatch={appDispatch} />
        </div>
      ))}
    </>
  );
}

interface SingleResultViewProps {
  result: PlanStepResult;
  stepIndex: number;
  convId: string | null;
  appDispatch: React.Dispatch<import('@/context/AppContext').AppAction>;
}

function SingleResultView({ result, stepIndex, convId, appDispatch }: SingleResultViewProps) {
  const { t } = useTranslation();
  const data = result.result as Record<string, unknown> | string | null | undefined;

  // Error result
  if (!result.success) {
    if (!data) return <div className="step-error">Error</div>;
    const errMsg = typeof data === 'object' && data !== null && 'error' in data
      ? String((data as Record<string, unknown>).error)
      : typeof data === 'string' ? data : JSON.stringify(data);
    return <div className="step-error">{errMsg}</div>;
  }

  // String result
  if (typeof data === 'string') {
    const truncated = data.length > 300 ? data.slice(0, 300) + '...' : data;
    return <div className="result-text">{truncated}</div>;
  }

  // Object result
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;

    // Think block
    const thinkContent = obj.thought || obj.thinking;
    const thinkBlock = thinkContent && typeof thinkContent === 'string'
      ? <ThinkBlock content={thinkContent} />
      : null;

    // Text fallback result (skip if code exists — handled below)
    if (typeof obj.text === 'string' && !obj.code) {
      let displayText = (obj.text as string)
        // Strip execute blocks: closed, or unclosed (up to next observation/execute/end)
        .replace(/<execute>[\s\S]*?<\/execute>/gi, '')
        .replace(/<execute>[\s\S]*?(?=<observation>|<execute>|$)/gi, '')
        .replace(/\[EXECUTE\][\s\S]*?\[\/EXECUTE\]/g, '')
        .replace(/\[EXECUTE\][\s\S]*?(?=\[OBSERVATION\]|\[EXECUTE\]|$)/g, '')
        // Strip observation tags (extract inner content or remove)
        .replace(/<observation>[\s\S]*?<\/observation>/gi, '')
        .replace(/\[OBSERVATION\][\s\S]*?\[\/OBSERVATION\]/g, '')
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
        .replace(/<\/think>/gi, '')
        .trim();
      if (!displayText) {
        return thinkBlock ? <div className="step-section-minimal">{thinkBlock}</div> : null;
      }
      const truncated = displayText.length > 500 ? displayText.slice(0, 500) + '...' : displayText;
      return (
        <div className="step-section-minimal">
          {thinkBlock}
          <div className="step-brief-summary"><MarkdownContent text={truncated} /></div>
          <ResultMetaLine obj={obj} stepIndex={stepIndex} appDispatch={appDispatch} t={t} />
        </div>
      );
    }

    // Solution result
    if (typeof obj.solution === 'string') {
      return (
        <div className="step-section-minimal">
          {thinkBlock}
          <span className="section-label-minimal">Solution</span>
          <div className="step-brief-summary"><MarkdownContent text={String(obj.solution)} /></div>
          <ResultMetaLine obj={obj} stepIndex={stepIndex} appDispatch={appDispatch} t={t} />
        </div>
      );
    }

    // Code generation result
    if (obj.code) {
      const code = String(obj.code);
      const lineCount = code.split('\n').length;
      const lang = String(obj.language || 'python');
      const fixAttempts = obj.fix_attempts as number | undefined;
      const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : undefined;
      const importCorrections = obj.import_corrections as string[] | undefined;
      return (
        <div className="step-section-minimal">
          {thinkBlock}
          {reasoning && (
            <div className="step-brief-summary">
              <MarkdownContent text={reasoning.length > 500 ? reasoning.slice(0, 500) + '...' : reasoning} />
            </div>
          )}
          {importCorrections && importCorrections.length > 0 && (
            <div className="import-corrections">
              {importCorrections.map((c, i) => (
                <span key={i} className="import-correction-item">Import fixed: {c}</span>
              ))}
            </div>
          )}
          <span className="section-label-minimal">Code Generated</span>
          <div className="code-gen-summary">
            {lineCount} lines of {lang}
            <button
              className="step-more-detail-btn"
              onClick={(e) => { e.stopPropagation(); appDispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'code' }); }}
            >
              (view in Code tab)
            </button>
          </div>
          {fixAttempts != null && fixAttempts > 0 && (
            <div className="code-fix-info">Auto-corrected ({fixAttempts} attempt{fixAttempts > 1 ? 's' : ''})</div>
          )}
          {obj.execution && <ExecutionResultInline execution={obj.execution as Record<string, unknown>} stepIndex={stepIndex} convId={convId} />}
          <ResultMetaLine obj={obj} stepIndex={stepIndex} appDispatch={appDispatch} t={t} />
        </div>
      );
    }

    // Structured result with title/summary
    if (obj.title || obj.summary) {
      const rawSummary = obj.summary
        ? (Array.isArray(obj.summary) ? (obj.summary as string[]).join('\n') : String(obj.summary))
        : '';
      const abbreviated = rawSummary.length > 250 ? extractSummaryHeaders(rawSummary) : rawSummary;

      return (
        <div className="step-section-minimal">
          {thinkBlock}
          {obj.title && <span className="section-label-minimal">{String(obj.title)}</span>}
          {abbreviated && (
            <div className="step-brief-summary">
              <MarkdownContent text={abbreviated} />
            </div>
          )}
          {/* Mini charts */}
          {obj.graph_type === 'efficiency' && <MiniEfficiencyChart data={obj} />}
          {obj.graph_type === 'timeline' && <MiniTimelineChart data={obj} />}
          <ResultMetaLine obj={obj} stepIndex={stepIndex} appDispatch={appDispatch} t={t} />
        </div>
      );
    }

    // Object with details array
    if (obj.details && Array.isArray(obj.details)) {
      const first = String(obj.details[0] || '');
      const more = obj.details.length > 1 ? ' ...' : '';
      return (
        <div className="step-section-minimal">
          {thinkBlock}
          <div className="step-brief-summary">{first}{more}</div>
          <ResultMetaLine obj={obj} stepIndex={stepIndex} appDispatch={appDispatch} t={t} />
        </div>
      );
    }

    // Unwrap nested result (e.g., {success, result: {actual data}})
    if (obj.result && typeof obj.result === 'object') {
      return <SingleResultView result={{ ...result, result: obj.result }} stepIndex={stepIndex} convId={convId} appDispatch={appDispatch} />;
    }

    // stdout/stderr from code execution
    if (obj.stdout && typeof obj.stdout === 'string') {
      const cleanStdout = (obj.stdout as string)
        .replace(/<observation>([\s\S]*?)<\/observation>/gi, '$1')
        .replace(/\[OBSERVATION\]([\s\S]*?)\[\/OBSERVATION\]/g, '$1')
        .trim();
      if (!cleanStdout) {
        return thinkBlock ? <div className="step-section-minimal">{thinkBlock}</div> : null;
      }
      const truncated = cleanStdout.length > 300 ? cleanStdout.slice(0, 300) + '...' : cleanStdout;
      return (
        <div className="step-section-minimal">
          {thinkBlock}
          <pre className="code-stdout">{truncated}</pre>
          <ResultMetaLine obj={obj} stepIndex={stepIndex} appDispatch={appDispatch} t={t} />
        </div>
      );
    }

    // If only think block
    if (thinkBlock) {
      return <div className="step-section-minimal">{thinkBlock}</div>;
    }
  }

  // Fallback: JSON (truncated)
  if (data == null) return null;
  const json = JSON.stringify(data, null, 2);
  const truncated = json && json.length > 500 ? json.slice(0, 500) + '\n...' : json;
  return <pre className="result-json">{truncated}</pre>;
}

// ─── Think Block ───

function ThinkBlock({ content }: { content: string }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div
      className={`think-section-minimal${collapsed ? ' collapsed' : ''}`}
      onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
    >
      <span className="think-toggle">Thinking {collapsed ? '▶' : '▼'}</span>
      {!collapsed && (
        <div className="think-content">
          <MarkdownContent text={content} />
        </div>
      )}
    </div>
  );
}

// ─── Execution Result Inline ───

function ExecutionResultInline({ execution, stepIndex, convId }: {
  execution: Record<string, unknown>;
  stepIndex: number;
  convId: string | null;
}) {
  const [figures, setFigures] = useState<string[]>([]);
  const stdout = execution.stdout as string | undefined;
  const execFigures = execution.figures as string[] | undefined;

  useEffect(() => {
    if (execFigures?.length) {
      setFigures(execFigures);
      return;
    }
    if (convId && stepIndex != null) {
      listStepOutputs(convId, stepIndex)
        .then(r => setFigures(r.figures || []))
        .catch(() => {});
    }
  }, [convId, stepIndex, execFigures]);

  return (
    <div className="step-exec-result">
      {stdout && stdout.trim() && (
        <pre className="code-stdout">{stdout.length > 500 ? stdout.slice(0, 500) + '...' : stdout}</pre>
      )}
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
  );
}

// ─── Summary Headers Extraction ───

function extractSummaryHeaders(text: string): string {
  const headers = text.match(/(?:^|\n)(?:\d+\.\s+\*\*[^*]+\*\*|#{1,3}\s+[^\n]+)/g);
  if (!headers || headers.length === 0) return text.slice(0, 200) + (text.length > 200 ? '...' : '');
  return headers.map(h => {
    const idx = text.indexOf(h);
    const after = text.slice(idx + h.length, idx + h.length + 100);
    const sentence = after.match(/^[^.!?\n]*[.!?]/)?.[0] || after.slice(0, 60);
    return h.trim() + sentence.trim();
  }).join('\n').slice(0, 400);
}

// ─── Mini Charts ───

function MiniEfficiencyChart({ data }: { data: Record<string, unknown> }) {
  const avg = data.avg_efficiency as number | undefined;
  if (avg == null) return null;
  const bars = Array.from({ length: 6 }, (_, i) => Math.max(10, Math.min(100, avg + (Math.random() - 0.5) * 30)));
  return (
    <div className="mini-chart">
      {bars.map((h, i) => (
        <div key={i} className="mini-bar" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

function MiniTimelineChart({ data }: { data: Record<string, unknown> }) {
  const weeks = data.weeks as Array<Record<string, unknown>> | undefined;
  if (!weeks?.length) return null;
  const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336', '#00BCD4'];
  return (
    <div className="mini-timeline">
      {weeks.slice(0, 8).map((w, i) => (
        <div
          key={i}
          className="mini-timeline-block"
          style={{ backgroundColor: colors[i % colors.length], opacity: 0.7 }}
          title={String(w.label || `Week ${i + 1}`)}
        />
      ))}
    </div>
  );
}
