import { useState } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { useTranslation } from '@/i18n';
import { truncateConversation } from '@/api/conversations';
import type { ToolCallEvent, ToolResultEvent, DetailPanelData, PlanStepResult, PlanComplete } from '@/types';

interface Props {
  toolCalls: ToolCallEvent['tool_call'][];
  toolResults?: ToolResultEvent['tool_result'][];
  planComplete?: PlanComplete;
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
 *
 * Features:
 * - Click entire box → switch Detail Panel to this plan's data
 * - Inline step results with toggle (▼/▲)
 * - Step hover actions: Retry (⟳), Ask (?), Detail (→)
 * - Goal header: Ask About Plan (?), Regenerate Plan (↻)
 * - Active plan highlighted with .plan-box-active CSS class
 * - Running indicator: number + CSS pulse animation (not ⟳ character)
 */
// frontend/src/components/chat/PlanStepsBox.tsx

export function PlanStepsBox({ toolCalls, toolResults, planComplete, messageIndex }: Props) {
  const { state: appState, dispatch: appDispatch } = useAppContext();
  const { state: chatState, dispatch: chatDispatch } = useChatContext();
  const { sendMessage, sendRaw } = useWebSocket();
  const { t } = useTranslation();

  const createPlanCall = toolCalls?.find((tc) => tc.name === 'create_plan');
  const tcArgs = createPlanCall?.arguments as any;

  // 1. 데이터 안전 추출 (중첩 객체, 문자열 JSON 등 모든 엣지 케이스 방어)
  let rawGoal = 'Plan';
  let rawSteps: any[] = [];
  let rawResults: any[] = [];

  const pc = planComplete as any;
  if (pc && typeof pc === 'object') {
    rawGoal = pc.goal || pc.plan?.goal || tcArgs?.goal || 'Plan';
    rawSteps = pc.steps || pc.plan?.steps || tcArgs?.steps;
    rawResults = pc.results || pc.plan?.results;
  } else if (tcArgs) {
    rawGoal = tcArgs.goal || 'Plan';
    rawSteps = tcArgs.steps;
  }

  // LLM이 배열을 문자열(String)로 내려보낸 경우 파싱 처리
  if (typeof rawSteps === 'string') {
    try { rawSteps = JSON.parse(rawSteps); } catch(e) { rawSteps = []; }
  }
  if (typeof rawResults === 'string') {
    try { rawResults = JSON.parse(rawResults); } catch(e) { rawResults = []; }
  }

  // steps 데이터가 정상적인 배열이 아니면 렌더링 중단 (MessageBubble이 알아서 원본 텍스트 노출함)
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  const args = { goal: rawGoal, steps: rawSteps };
  const panelSteps = appState.detailPanelData?.steps;
  const panelResults = appState.detailPanelData?.results;

  const steps: PlanStepDisplay[] = args.steps.map((s: any, i: number) => {
    const liveStatus = panelSteps?.[i]?.status;
    const liveTool = panelSteps?.[i]?.tool;
    const pcStep = Array.isArray(rawSteps) ? rawSteps[i] : undefined;
    const trResult = toolResults?.find((tr) => tr.step === i + 1);
    const pcResult = Array.isArray(rawResults) ? rawResults.find((r: any) => r.step === i + 1) : undefined;
    const stepResult = trResult || pcResult;

    let status: PlanStepDisplay['status'] = 'pending';
    if (liveStatus) {
      status = liveStatus;
    } else if (pcStep?.status) {
      status = pcStep.status;
    } else if (stepResult) {
      status = stepResult.success ? 'completed' : 'error';
    }

    return {
      name: s.name || `Step ${i + 1}`,
      description: s.description || '',
      status,
      tool: liveTool || pcStep?.tool || stepResult?.tool,
    };
  });

  const getStepResults = (stepNum: number): PlanStepResult[] => {
    const fromState = panelResults?.filter(r => r.step === stepNum) || [];
    if (fromState.length > 0) return fromState;

    if (Array.isArray(rawResults)) {
      const fromPlanComplete = rawResults.filter((r: any) => r.step === stepNum);
      if (fromPlanComplete.length > 0) return fromPlanComplete;
    }

    return (toolResults?.filter(tr => tr.step === stepNum) || []).map(tr => ({
      step: tr.step ?? 0,
      tool: tr.tool,
      success: tr.success,
      result: tr.result,
    }));
  };

  const handleMoreDetail = () => {
    const currentMessage = chatState.messages[messageIndex];
    const rawContent = currentMessage?.content || '';

    const formattedAnalysis = rawContent
      .replace(/<think>/g, '### 🤔 Thought Process\n\n')
      .replace(/<\/think>/g, '\n\n---\n\n### 📋 Generated Plan\n\n');

    const resultsArray = (Array.isArray(rawResults) && rawResults.length > 0) 
      ? rawResults 
      : (toolResults?.map(tr => ({
          step: tr.step ?? 0,
          tool: tr.tool,
          success: tr.success,
          result: tr.result,
        })) || []);

    const planData: DetailPanelData = {
      goal: args.goal,
      steps: steps.map(s => ({
        name: s.name,
        description: s.description,
        status: s.status,
        tool: s.tool,
      })),
      results: resultsArray,
      codes: {},
      analysis: formattedAnalysis,
      currentStep: steps.length,
    };
    
    resultsArray.forEach((tr: any) => {
      const resData = tr.result as Record<string, unknown>;
      if (resData && typeof resData === 'object' && resData.code && tr.step != null) {
        planData.codes[tr.step - 1] = String(resData.code);
      }
    });
    
    appDispatch({ type: 'SET_DETAIL_PANEL_DATA', payload: planData });
    appDispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'plan' });
  };

  const isActive = appState.detailPanelData?.goal === args.goal &&
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
      rerun_goal: args.goal,
      retry_step: stepIndex + 1,
    });
  };

  const handleAskStep = (stepIndex: number) => {
    const step = steps[stepIndex];
    chatDispatch({
      type: 'ADD_STEP_QUESTION',
      payload: {
        stepNum: stepIndex + 1,
        tool: step.tool || '',
        stepName: step.name,
        context: step.description,
      },
    });
  };

  // Goal action handlers
  const handleAskPlan = () => {
    chatDispatch({
      type: 'ADD_STEP_QUESTION',
      payload: { stepNum: 0, tool: '', stepName: args.goal, context: '' },
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

  return (
    <div
      className={`plan-steps-box${isActive ? ' plan-box-active' : ''}`}
      onClick={handleMoreDetail}
    >
      <div className="plan-goal plan-goal-row">
        <span className="plan-goal-text">{args.goal}</span>
        <div className="plan-goal-actions">
          <button className="plan-ref-btn" onClick={(e) => { e.stopPropagation(); handleAskPlan(); }} title={t('tooltip.plan_ref') || 'Ask about this plan'}>?</button>
          <button className="plan-regen-btn" onClick={(e) => { e.stopPropagation(); handleRegenPlan(); }} title={t('tooltip.regenerate_plan') || 'Regenerate plan'}>↻</button>
        </div>
      </div>
      <div className="plan-steps">
        {steps.map((step, i) => (
          <PlanStepItem
            key={i}
            step={step}
            index={i}
            stepResults={getStepResults(i + 1)}
            onMoreDetail={handleMoreDetail}
            onRetry={handleRetryStep}
            onAsk={handleAskStep}
            moreDetailLabel={t('label.more_detail')}
          />
        ))}
      </div>
    </div>
  );
}

// ─── PlanStepItem ───

interface PlanStepItemProps {
  step: PlanStepDisplay;
  index: number;
  stepResults: PlanStepResult[];
  onMoreDetail: () => void;
  onRetry: (index: number) => void;
  onAsk: (index: number) => void;
  moreDetailLabel: string;
}

function PlanStepItem({ step, index, stepResults, onMoreDetail, onRetry, onAsk, moreDetailLabel }: PlanStepItemProps) {
  const [expanded, setExpanded] = useState(true);
  const hasResults = stepResults.length > 0;

  // Indicator: running keeps the number (CSS handles animation), others use symbols
  const indicator = (() => {
    switch (step.status) {
      case 'completed': return '✓';
      case 'error': return '!';
      case 'stopped': return '◼';
      case 'running': return index + 1;   // number + CSS pulse/spinner
      default: return index + 1;           // pending: number
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
            {step.description && step.description !== step.name && (
              <div className="step-description">{step.description}</div>
            )}
            {(step.tool || step.status === 'running') && (
              <div className="step-tool">{getToolLabel(step.tool)}</div>
            )}
          </div>
        </div>
        {(step.status === 'completed' || step.status === 'error') && (
          <div className="step-actions">
            <button className="step-action-btn" onClick={() => onRetry(index)} title="Retry">⟳</button>
            <button className="step-action-btn" onClick={() => onAsk(index)} title="Ask">?</button>
            <button className="step-action-btn" onClick={onMoreDetail} title={moreDetailLabel}>→</button>
          </div>
        )}
        {hasResults && (
          <div className="step-toggle" onClick={handleToggle}>
            {expanded ? '▲' : '▼'}
          </div>
        )}
      </div>
      {/* Inline step result */}
      {hasResults && (
        <div className="step-result" style={{ display: expanded ? 'block' : 'none' }}>
          <StepResultContent results={stepResults} />
        </div>
      )}
    </div>
  );
}

// ─── Step Result Rendering ───

function StepResultContent({ results }: { results: PlanStepResult[] }) {
  return (
    <>
      {results.map((r, i) => (
        <div key={i}>
          {i > 0 && <hr className="tool-result-divider" />}
          <SingleResultView result={r} />
        </div>
      ))}
    </>
  );
}

function SingleResultView({ result }: { result: PlanStepResult }) {
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

    // Code generation result
    if (obj.code) {
      const code = String(obj.code);
      const lineCount = code.split('\n').length;
      const lang = String(obj.language || 'python');
      const fixAttempts = obj.fix_attempts as number | undefined;
      return (
        <div className="step-section-minimal">
          <span className="section-label-minimal">Code Generated</span>
          <div className="code-gen-summary">{lineCount} lines · {lang}</div>
          {fixAttempts != null && fixAttempts > 0 && (
            <div className="code-fix-info">Auto-corrected ({fixAttempts} attempt{fixAttempts > 1 ? 's' : ''})</div>
          )}
          {obj.execution ? <ExecutionResultView execution={obj.execution as Record<string, unknown>} /> : null}
        </div>
      );
    }

    // Structured result with title/summary
    if (obj.title || obj.summary) {
      const rawSummary = obj.summary
        ? (Array.isArray(obj.summary) ? (obj.summary as string[]).join('\n') : String(obj.summary))
        : '';
      const abbreviated = rawSummary.length > 250 ? rawSummary.slice(0, 250) + '...' : rawSummary;

      const duration = obj.duration as string | undefined;
      const tokens = obj.tokens as string | undefined;
      const metaText = [duration, tokens ? `${tokens} tokens` : ''].filter(Boolean).join(' · ');

      return (
        <div className="step-section-minimal">
          {obj.title ? <span className="section-label-minimal">{String(obj.title)}</span> : null}
          {abbreviated && <div className="step-brief-summary">{abbreviated}</div>}
          {metaText && <div className="result-meta-minimal">{metaText}</div>}
        </div>
      );
    }

    // Object with details array
    if (obj.details && Array.isArray(obj.details)) {
      const first = String(obj.details[0] || '');
      const more = obj.details.length > 1 ? ' ...' : '';
      return (
        <div className="step-section-minimal">
          <div className="step-brief-summary">{first}{more}</div>
        </div>
      );
    }
  }

  // Fallback: JSON (truncated)
  if (data == null) return null;
  const json = JSON.stringify(data, null, 2);
  const truncated = json && json.length > 500 ? json.slice(0, 500) + '\n...' : json;
  return <pre className="result-json">{truncated}</pre>;
}

// ─── Execution Result (code output) ───

function ExecutionResultView({ execution }: { execution: Record<string, unknown> }) {
  const stdout = execution.stdout as string | undefined;
  const figures = execution.figures as string[] | undefined;

  return (
    <div className="step-exec-result">
      {stdout && stdout.trim() && (
        <pre className="code-stdout">{stdout.length > 500 ? stdout.slice(0, 500) + '...' : stdout}</pre>
      )}
      {figures && figures.length > 0 && (
        figures.map((f, i) => (
          <img key={i} src={f} className="code-result-img" alt={`Figure ${i + 1}`} />
        ))
      )}
    </div>
  );
}
