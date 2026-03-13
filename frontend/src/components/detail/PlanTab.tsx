import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { truncateConversation } from '@/api/conversations';
import { analyzePlan } from '@/api/plan';
import { useTranslation } from '@/i18n';
import { RefreshCw, Loader, AlertCircle } from 'lucide-react';

export function PlanTab() {
  const { state, dispatch: appDispatch } = useAppContext();
  const { state: chatState, dispatch: chatDispatch } = useChatContext();
  const { sendMessage, isStreaming } = useWebSocket();
  const { t } = useTranslation();
  const data = state.detailPanelData;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestedRef = useRef(false);

  const allStepsDone = data
    ? data.steps.length > 0 &&
      data.steps.every(
        (s) => s.status === 'completed' || s.status === 'error' || s.status === 'stopped',
      )
    : false;

  let planMsg = chatState.messages.find(m =>
    m.toolCalls?.some(tc => tc.name === 'create_plan' && (tc.arguments as Record<string, unknown>)?.goal === data?.goal)
  );

  if (!planMsg && !allStepsDone) {
    const assistantMsgs = chatState.messages.filter(m => m.role === 'assistant');
    planMsg = assistantMsgs[assistantMsgs.length - 1];
  }

  const rawContent = planMsg?.content || '';
  const hasThink = rawContent.includes('<think>') || rawContent.includes('[THINK]');

  const formattedThink = rawContent
    .replace(/<think>|\[THINK\]/gi, '### 🤔 Thought Process\n\n')
    .replace(/<\/think>|\[\/THINK\]/gi, '\n\n---\n\n### 📋 Generated Plan\n\n');

  const displayContent = data?.analysis || (hasThink ? formattedThink : '');

  const requestAnalysis = useCallback(
    async (force = false) => {
      if (!data || (!force && displayContent)) return;
      if (!allStepsDone && !force) return;

      setLoading(true);
      setError('');
      try {
        const stepsWithResults = data.steps.map((step, i) => ({
          name: step.name,
          tool: step.tool || '',
          description: step.description || '',
          status: step.status || 'pending',
          result: data.results[i] || null,
        }));

        const res = await analyzePlan({
          goal: data.goal,
          steps: stepsWithResults,
          current_step: data.currentStep,
        });

        if (res.success && res.analysis) {
          appDispatch({ type: 'SET_ANALYSIS', payload: res.analysis });
        } else {
          setError(res.error || 'Analysis generation failed');
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [data, allStepsDone, appDispatch, displayContent],
  );

  useEffect(() => {
    if (allStepsDone && data && !displayContent && !requestedRef.current) {
      requestedRef.current = true;
      requestAnalysis();
    }
    if (!allStepsDone) {
      requestedRef.current = false;
    }
  }, [allStepsDone, data, requestAnalysis, displayContent]);

  const handleReplan = async () => {
    if (isStreaming) return;
    const convId = chatState.conversationId;
    if (!convId) return;

    const messages = chatState.messages;
    let userMsgIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userMsgIndex = i;
        break;
      }
    }
    if (userMsgIndex < 0) return;

    const userContent = messages[userMsgIndex].content;
    try {
      await truncateConversation(convId, userMsgIndex);
      chatDispatch({ type: 'TRUNCATE_FROM', payload: userMsgIndex });
      sendMessage(userContent);
    } catch (err) {
      chatDispatch({ type: 'SET_ERROR', payload: String(err) });
    }
  };

  // 🚨 문제의 원인이었던 부분 해결! (!data && !displayContent)일 때만 빈 화면 리턴
  if (!data && !displayContent) {
    return (
      <div className="detail-empty-state">
        <p>{t('empty.plan_hint')}</p>
      </div>
    );
  }

  if (!allStepsDone && !displayContent) {
    return (
      <div className="detail-empty-state">
        <p>{t('status.plan_running') !== 'status.plan_running'
          ? t('status.plan_running')
          : 'Plan is running. Analysis will appear here when all steps complete.'}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="detail-empty-state">
        <Loader size={20} className="spin" style={{ marginBottom: 8 }} />
        <p>{t('status.analyzing') !== 'status.analyzing'
          ? t('status.analyzing')
          : 'Generating analysis...'}</p>
      </div>
    );
  }

  return (
    <div className="plan-content">
      <div className="plan-goal-actions" style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', padding: '8px 12px 0' }}>
        <button
          className="plan-regen-btn"
          onClick={handleReplan}
          disabled={isStreaming}
          title="Regenerate Plan"
        >
          <RefreshCw size={14} />
          <span style={{ marginLeft: 4, fontSize: 12 }}>Replan</span>
        </button>
        <button
          className="plan-regen-btn"
          onClick={() => requestAnalysis(true)}
          disabled={loading || isStreaming}
          title="Regenerate Analysis"
        >
          <RefreshCw size={14} />
          <span style={{ marginLeft: 4, fontSize: 12 }}>Regenerate</span>
        </button>
      </div>

      {error && (
        <div className="detail-error-banner">
          <AlertCircle size={16} className="error-icon" />
          <span className="error-text">{error}</span>
        </div>
      )}

      {/* ✅ 생각(Think) 또는 분석이 있으면 무조건 렌더링 */}
      {displayContent && (
        <div className="plan-analysis">
          <div className="analysis-content markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {displayContent}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {!displayContent && !error && (
        <div className="detail-empty-state">
          <p>Click "Regenerate" to generate analysis.</p>
        </div>
      )}
    </div>
  );
}