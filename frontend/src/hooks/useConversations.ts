import { useState, useCallback, useEffect } from 'react';
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

      try {
        const detail = await api.getConversation(convId);
        const messages: ChatMessage[] = detail.messages.map((m: MessageData) => {
          const msg: ChatMessage = {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          };

          // Parse [TOOL_CALLS] synthetic messages → populate toolCalls
          if (m.content.includes('[TOOL_CALLS]create_plan[ARGS]')) {
            try {
              const argsStr = m.content.substring(
                m.content.indexOf('[ARGS]') + '[ARGS]'.length,
              );
              const args = JSON.parse(argsStr);
              msg.toolCalls = [{ name: 'create_plan', arguments: args }];
              msg.content = '';
            } catch { /* ignore malformed */ }
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

        // Restore detail panel from plan markers in messages
        restoreDetailPanel(detail.messages);
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
        // 항상 현재 대화 + Detail Panel 초기화 (삭제한 채팅이 현재든 아니든)
        chatDispatch({ type: 'SET_CONVERSATION', payload: { id: null, messages: [] } });
        appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
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
                codes: planData.codes || {},
                analysis: planData.analysis || '',
                currentStep: planData.steps.length,
              },
            });
            return;
          }
        } catch { /* skip malformed */ }
      }
    }

    // 2nd: [TOOL_CALLS]create_plan — in-progress plan (no results)
    console.log('[restoreDetailPanel] No [PLAN_COMPLETE] found, trying [TOOL_CALLS]create_plan...');
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.content.includes('[TOOL_CALLS]create_plan[ARGS]')) {
        try {
          const argsStr = msg.content.substring(
            msg.content.indexOf('[ARGS]') + '[ARGS]'.length,
          );
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
