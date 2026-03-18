import { useState, useCallback, useEffect, useRef } from 'react';
import { useChatContext } from '@/context/ChatContext';
import { useAppContext } from '@/context/AppContext';
import * as api from '@/api/conversations';
import type { ConversationSummary, ChatMessage, MessageData } from '@/types';

/**
 * Hook for conversation CRUD + sidebar list management.
 * Mirrors inference_ui's loadConversations/loadConversation/createNewChat/delete.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const { state: chatState, dispatch: chatDispatch } = useChatContext();
  const { state: appState, dispatch: appDispatch } = useAppContext();

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listConversations();
      setConversations(list);
    } catch {
      // Silently fail — server might not be ready
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount and when conversationVersion changes (triggered by BUMP_CONVERSATIONS)
  useEffect(() => {
    loadConversations();
  }, [loadConversations, appState.conversationVersion]);

  const switchTo = useCallback(
    async (convId: string) => {
      if (convId === chatState.conversationId) return;

      // Immediately clear stale detail panel data before async load
      appDispatch({ type: 'CLEAR_DETAIL_PANEL' });

      try {
        const detail = await api.getConversation(convId);
        const messages: ChatMessage[] = detail.messages.map((m: MessageData) => {
          const msg: ChatMessage = {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          };

          // Parse [PLAN_CREATE] or legacy [TOOL_CALLS]create_plan[ARGS] → populate toolCalls
          {
            const planCreateTag = '[PLAN_CREATE]';
            const legacyTag = '[TOOL_CALLS]create_plan[ARGS]';
            let planArgsStr: string | null = null;
            let markerIdx = -1;

            if (m.content.includes(planCreateTag)) {
              markerIdx = m.content.indexOf(planCreateTag);
              planArgsStr = m.content.substring(markerIdx + planCreateTag.length);
            } else if (m.content.includes(legacyTag)) {
              markerIdx = m.content.indexOf(legacyTag);
              planArgsStr = m.content.substring(m.content.indexOf('[ARGS]') + '[ARGS]'.length);
            }

            if (planArgsStr !== null) {
              try {
                const args = JSON.parse(planArgsStr);
                msg.toolCalls = [{ name: 'create_plan', arguments: args }];
                // Preserve think blocks (content before marker), strip plan marker
                msg.content = markerIdx > 0 ? m.content.substring(0, markerIdx).trim() : '';
              } catch { /* ignore malformed */ }
            }
          }

          // Hide raw [PLAN_COMPLETE] marker text and reconstruct plan box widget
          if (m.content.includes('[PLAN_COMPLETE]')) {
            try {
              const planJson = m.content.substring(
                m.content.indexOf('[PLAN_COMPLETE]') + '[PLAN_COMPLETE]'.length,
              );
              const planData = JSON.parse(planJson.trim());
              if (planData.goal && planData.steps) {
                msg.toolCalls = [{ name: 'create_plan', arguments: { goal: planData.goal, steps: planData.steps } }];
              }
            } catch { /* ignore malformed */ }
            msg.content = '';
          }

          return msg;
        });

        chatDispatch({ type: 'SET_CONVERSATION', payload: { id: convId, messages } });

        // Persist last conversation for auto-restore on page reload
        try { localStorage.setItem('lastConversationId', convId); } catch { /* ignore */ }

        // Restore detail panel if chat has plan (already cleared above before async load)
        const hasPlan = messages.some(m => m.toolCalls?.some(tc => tc.name === 'create_plan'));
        if (hasPlan) {
          restoreDetailPanel(detail.messages);
        }
      } catch (err) {
        chatDispatch({ type: 'SET_ERROR', payload: String(err) });
      }
    },
    [chatState.conversationId, chatDispatch, appDispatch],
  );

  const createNew = useCallback(async () => {
    try {
      const newConv = await api.createConversation();  // POST /api/new — creates blank conversation
      chatDispatch({ type: 'SET_CONVERSATION', payload: { id: newConv.id, messages: [] } });
    } catch {
      chatDispatch({ type: 'SET_CONVERSATION', payload: { id: null, messages: [] } });
    }
    chatDispatch({ type: 'SET_STREAMING', payload: false });
    chatDispatch({ type: 'CLEAR_STEP_QUESTIONS' });
    appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
    await loadConversations();
  }, [chatDispatch, appDispatch, loadConversations]);

  const deleteFn = useCallback(
    async (convId: string) => {
      // Optimistic removal
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      try {
        await api.deleteConversation(convId);
        // Clean up graph localStorage for deleted conversation
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key?.startsWith(`graphState-${convId}-`)) {
            localStorage.removeItem(key);
          }
        }
        // 삭제한 채팅이 현재 보고 있는 채팅일 때만 초기화
        if (convId === chatState.conversationId) {
          chatDispatch({ type: 'SET_CONVERSATION', payload: { id: null, messages: [] } });
          appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
          try { localStorage.removeItem('lastConversationId'); } catch { /* ignore */ }
        }
      } catch {
        // Rollback
        await loadConversations();
      }
    },
    [chatState.conversationId, chatDispatch, appDispatch, loadConversations],
  );

  const renameFn = useCallback(
    async (convId: string, newTitle: string) => {
      // Optimistic update
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, title: newTitle } : c)),
      );
      try {
        await api.renameConversation(convId, newTitle);
      } catch {
        await loadConversations();
      }
    },
    [loadConversations],
  );

  // Auto-restore last conversation on page reload
  const autoRestoreDone = useRef(false);
  useEffect(() => {
    if (autoRestoreDone.current || loading || conversations.length === 0 || chatState.conversationId) return;
    autoRestoreDone.current = true;
    const lastId = localStorage.getItem('lastConversationId');
    if (lastId && conversations.some(c => c.id === lastId)) {
      switchTo(lastId);
    }
  }, [conversations, loading, chatState.conversationId, switchTo]);

  /** Restore detail panel from plan markers in conversation messages.
   *  1st pass: [PLAN_COMPLETE] (finished/stopped plan with results)
   *  2nd pass: [TOOL_CALLS]create_plan (in-progress plan, structure only)
   */
  function restoreDetailPanel(messages: MessageData[]) {
    console.log('[restoreDetailPanel] Scanning', messages.length, 'messages');
    // 1st: [PLAN_COMPLETE] — completed or stopped plan
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.content.includes('[PLAN_COMPLETE]')) {
        try {
          const marker = msg.content.substring(
            msg.content.indexOf('[PLAN_COMPLETE]') + '[PLAN_COMPLETE]'.length,
          );
          const planData = JSON.parse(marker.trim());
          console.log('[restoreDetailPanel] Found [PLAN_COMPLETE]:', { goal: planData.goal, stepsCount: planData.steps?.length, resultsCount: planData.results?.length });
        if (planData.goal && planData.steps) {
            const isStopped = !!planData.stopped;
            const completedSteps = new Set(
              (planData.results || []).filter((r: { success: boolean; step: number }) => r.success).map((r: { step: number }) => r.step),
            );
            const errorSteps = new Set(
              (planData.results || []).filter((r: { success: boolean; step: number }) => !r.success).map((r: { step: number }) => r.step),
            );

            appDispatch({
              type: 'SET_DETAIL_PANEL_DATA',
              payload: {
                goal: planData.goal,
                steps: planData.steps.map((s: { name: string; description: string }, i: number) => ({
                  name: s.name,
                  description: s.description || '',
                  status: completedSteps.has(i + 1)
                    ? 'completed' as const
                    : errorSteps.has(i + 1)
                      ? 'error' as const
                      : isStopped
                        ? 'stopped' as const
                        : 'completed' as const,
                })),
                results: planData.results || [],
                codes: (() => {
                  // Convert string keys to number keys (JSON serialization converts number keys to strings)
                  const raw = planData.codes || {};
                  const out: Record<number, unknown> = {};
                  for (const [k, v] of Object.entries(raw)) out[Number(k)] = v;
                  return out;
                })(),
                analysis: planData.analysis || '',
                currentStep: planData.steps.length,
                retrievalResult: planData.retrievalResult || null,
              },
            });
            return;
          }
        } catch { /* skip malformed */ }
      }
    }

    // 2nd: [PLAN_CREATE] or legacy [TOOL_CALLS]create_plan — in-progress plan (no results)
    console.log('[restoreDetailPanel] No [PLAN_COMPLETE] found, trying [PLAN_CREATE]...');
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const hasPlanCreate = msg.role === 'assistant' && (
        msg.content.includes('[PLAN_CREATE]') || msg.content.includes('[TOOL_CALLS]create_plan[ARGS]')
      );
      if (hasPlanCreate) {
        try {
          let argsStr: string;
          if (msg.content.includes('[PLAN_CREATE]')) {
            argsStr = msg.content.substring(
              msg.content.indexOf('[PLAN_CREATE]') + '[PLAN_CREATE]'.length,
            );
          } else {
            argsStr = msg.content.substring(
              msg.content.indexOf('[ARGS]') + '[ARGS]'.length,
            );
          }
          const args = JSON.parse(argsStr);
          if (args.goal && args.steps) {
            appDispatch({
              type: 'SET_DETAIL_PANEL_DATA',
              payload: {
                goal: args.goal,
                steps: args.steps.map((s: { name: string; description: string }) => ({
                  name: s.name,
                  description: s.description || '',
                  status: 'pending' as const,
                })),
                results: [],
                codes: {},
                analysis: '',
                currentStep: 0,
              },
            });
            return;
          }
        } catch { /* skip malformed */ }
      }
    }

    // No plan found — clear detail panel
    console.log('[restoreDetailPanel] No plan markers found in any message. Messages summary:', messages.map(m => ({ role: m.role, len: m.content.length, preview: m.content.substring(0, 80) })));
    appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
  }

  return {
    conversations,
    loading,
    loadConversations,
    switchTo,
    createNew,
    deleteFn,
    renameFn,
    currentConversationId: chatState.conversationId,
  };
}
