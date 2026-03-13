/**
 * Singleton WebSocket provider.
 * Manages ONE WSClient instance per conversation, shared by all consumers.
 * Replaces the per-component useWebSocketChat() hook that caused
 * multiple connections and infinite re-render loops.
 */
import { createContext, useContext, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { useChatContext } from '@/context/ChatContext';
import { useAppContext } from '@/context/AppContext';
import { createConversation } from '@/api/conversations';
import { WSClient } from '@/api/websocket';
import type { PlanStep, PlanStepResult, PendingFile, ToolCallEvent, ToolResultEvent, PlanComplete } from '@/types';

interface WebSocketContextValue {
  sendMessage: (
    content: string,
    files?: PendingFile[],
    onConversationCreated?: (id: string) => void,
  ) => Promise<void>;
  sendRaw: (action: string, payload: Record<string, unknown>) => void;
  stopGeneration: () => void;
  sendStepQuestion: (question: string, stepIndex: number) => void;
  retryStep: (stepIndex: number) => void;
  isStreaming: boolean;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { state: chatState, dispatch: chatDispatch } = useChatContext();
  const { dispatch: appDispatch } = useAppContext();
  const wsRef = useRef<WSClient | null>(null);
  // Track intentional WS closes to avoid race condition with SET_STREAMING
  const intentionalCloseRef = useRef(false);
  // Track streaming state via ref to avoid closure capture issues in handleEvent
  const isStreamingRef = useRef(chatState.isStreaming);
  isStreamingRef.current = chatState.isStreaming;

  // Handle incoming WS events — same dispatch logic as old SSE handler
  const handleEvent = useCallback(
    (raw: unknown) => {
      const event = raw as Record<string, unknown>;
      const eventType = event.type as string;
      const eventData = (event.data as Record<string, unknown>) ?? event;

      switch (eventType) {
        case 'token': {
          // Ignore residual tokens after stop
          if (!isStreamingRef.current) break;
          const token = (eventData.token as string) ?? (event.token as string) ?? '';
          chatDispatch({ type: 'APPEND_TOKEN', payload: token });
          break;
        }

        case 'tool_call': {
          const toolCall = (eventData.tool_call as Record<string, unknown>) ??
            (event.tool_call as Record<string, unknown>) ?? eventData;
          chatDispatch({ type: 'ADD_TOOL_CALL', payload: toolCall as ToolCallEvent['tool_call'] });

          // If this is create_plan, initialize detail panel
          if (toolCall.name === 'create_plan') {
            const args = toolCall.arguments as {
              goal?: string;
              steps?: Array<{ name: string; description: string }>;
            } | undefined;
            if (args?.goal && args?.steps) {
              const planSteps: PlanStep[] = args.steps.map((s) => ({
                name: s.name,
                description: s.description,
                status: 'pending' as const,
              }));
              appDispatch({
                type: 'SET_DETAIL_PANEL_DATA',
                payload: {
                  goal: args.goal,
                  steps: planSteps,
                  results: [],
                  codes: {},
                  analysis: '',
                  currentStep: 0,
                },
              });
            }
          }
          break;
        }

        case 'tool_result': {
          console.log('[WS] tool_result:', eventData);
          const toolResult = (eventData.tool_result as Record<string, unknown>) ??
            (event.tool_result as Record<string, unknown>) ?? eventData;
          chatDispatch({ type: 'ADD_TOOL_RESULT', payload: toolResult as ToolResultEvent['tool_result'] });

          const step = toolResult.step as number | undefined;
          if (step !== undefined) {
            const stepIdx = step - 1;
            appDispatch({
              type: 'UPDATE_STEP_STATUS',
              payload: {
                stepIndex: stepIdx,
                status: toolResult.success ? 'completed' : 'error',
              },
            });
            const stepResult: PlanStepResult = {
              step: (toolResult.step as number) ?? 0,
              tool: (toolResult.tool as string) ?? '',
              success: (toolResult.success as boolean) ?? false,
              result: toolResult.result,
            };
            appDispatch({ type: 'ADD_STEP_RESULT', payload: stepResult });
            if (toolResult.tool) {
              appDispatch({
                type: 'UPDATE_STEP_TOOL',
                payload: { stepIndex: stepIdx, toolName: toolResult.tool as string },
              });
            }
            const result = toolResult.result as Record<string, unknown> | undefined;
            if (result && typeof result === 'object' && 'code' in result) {
              appDispatch({
                type: 'SET_STEP_CODE',
                payload: { stepIndex: stepIdx, code: String(result.code) },
              });
            }
          }
          break;
        }

        case 'step_start': {
          console.log('[WS] step_start:', eventData);
          const stepStart = (eventData.step_start as Record<string, unknown>) ??
            (event.step_start as Record<string, unknown>) ?? eventData;
          const stepNum = stepStart.step as number;
          chatDispatch({ type: 'SET_CURRENT_STEP', payload: stepNum });
          appDispatch({
            type: 'UPDATE_STEP_STATUS',
            payload: { stepIndex: stepNum - 1, status: 'running' },
          });
          appDispatch({ type: 'SET_CURRENT_STEP', payload: stepNum });
          break;
        }

        case 'plan_complete': {
          console.log('[WS] plan_complete:', eventData);
          const planComplete = (eventData.plan_complete as Record<string, unknown>) ?? eventData;
          if (planComplete) {
            chatDispatch({ type: 'SET_PLAN_COMPLETE', payload: planComplete as unknown as PlanComplete });
            
            // Populate analysis in detail panel if provided
            const analysis = planComplete.analysis as string | undefined;
            if (analysis) {
              appDispatch({ type: 'SET_ANALYSIS', payload: analysis });
            }
          }
          break;
        }

        case 'done': {
          console.log('[WS] done:', eventData);
          chatDispatch({ type: 'SET_STREAMING', payload: false });
          appDispatch({ type: 'BUMP_CONVERSATIONS' }); // Refresh sidebar (title may have been updated)
          const planComplete = (eventData.plan_complete as Record<string, unknown>) ??
            (event.plan_complete as Record<string, unknown>);
          if (planComplete) {
            chatDispatch({ type: 'SET_PLAN_COMPLETE', payload: planComplete as unknown as PlanComplete });
            // Populate analysis in detail panel if provided
            const analysis = planComplete.analysis as string | undefined;
            if (analysis) {
              appDispatch({ type: 'SET_ANALYSIS', payload: analysis });
            }
          }
          break;
        }

        case 'error': {
          const errorMsg = (eventData.error as string) ?? (event.error as string) ?? 'Unknown error';
          chatDispatch({ type: 'SET_ERROR', payload: errorMsg });
          chatDispatch({ type: 'SET_STREAMING', payload: false });
          break;
        }
      }
    },
    [chatDispatch, appDispatch],
  );

  // Stable ref to avoid reconnection when handleEvent identity changes
  const handleEventRef = useRef(handleEvent);
  handleEventRef.current = handleEvent;

  // Connect WS when conversation changes — single connection for whole app
  useEffect(() => {
    const convId = chatState.conversationId;
    if (!convId) return;

    // Mark close as intentional to avoid race condition with SET_STREAMING
    intentionalCloseRef.current = true;
    wsRef.current?.close();

    const client = new WSClient(convId, {
      onMessage: (raw) => handleEventRef.current(raw),
      onClose: (_code, _reason) => {
        // Only reset streaming on unexpected closes (server disconnect, error)
        if (!intentionalCloseRef.current) {
          chatDispatch({ type: 'SET_STREAMING', payload: false });
          // Mark any running plan steps as error so UI doesn't show eternal spinner
          appDispatch({ type: 'MARK_RUNNING_STEPS_ERROR' });
        }
        intentionalCloseRef.current = false;
      },
    });
    client.connect();
    wsRef.current = client;

    return () => {
      intentionalCloseRef.current = true;
      client.close();
    };
  }, [chatState.conversationId, chatDispatch]);

  const sendMessage = useCallback(
    async (
      content: string,
      files?: PendingFile[],
      onConversationCreated?: (id: string) => void,
    ) => {
      // 1. Determine or create conversation
      let convId = chatState.conversationId;
      if (!convId) {
        try {
          const newConv = await createConversation();
          convId = newConv.id;
          chatDispatch({ type: 'SET_CONVERSATION_ID', payload: convId });
          appDispatch({ type: 'BUMP_CONVERSATIONS' });
          onConversationCreated?.(convId);
        } catch (err) {
          chatDispatch({ type: 'SET_ERROR', payload: String(err) });
          return;
        }
      }

      // 2. Add user message to local state
      const fileData = files?.map((f) => ({
        type: f.type,
        name: f.name,
        uploadId: f.uploadedFilename,
      }));
      chatDispatch({
        type: 'ADD_MESSAGE',
        payload: { role: 'user', content, files: fileData },
      });

      // 3. Add empty assistant placeholder
      chatDispatch({
        type: 'ADD_MESSAGE',
        payload: { role: 'assistant', content: '' },
      });
      chatDispatch({ type: 'SET_STREAMING', payload: true });

      // 4. Wait for WS connection (useEffect handles creation when conversationId changes)
      await new Promise<void>((resolve) => {
        if (wsRef.current?.isConnected) { resolve(); return; }
        const check = setInterval(() => {
          if (wsRef.current?.isConnected) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        setTimeout(() => { clearInterval(check); resolve(); }, 5000);
      });

      wsRef.current?.send('chat', {
        conv_id: convId,
        message: content,
        mode: chatState.mode,
        files: fileData,
      });
    },
    [chatState.conversationId, chatState.mode, chatDispatch],
  );

  const sendRaw = useCallback(
    (action: string, payload: Record<string, unknown>) => {
      chatDispatch({ type: 'SET_STREAMING', payload: true });
      wsRef.current?.send(action, payload);
    },
    [chatDispatch],
  );

  const stopGeneration = useCallback(() => {
    wsRef.current?.send('stop');
    chatDispatch({ type: 'SET_STREAMING', payload: false });
  }, [chatDispatch]);

  const sendStepQuestion = useCallback(
    (question: string, stepIndex: number) => {
      if (!chatState.conversationId) return;
      chatDispatch({ type: 'SET_STREAMING', payload: true });
      wsRef.current?.send('step_question', {
        conv_id: chatState.conversationId,
        question,
        step_index: stepIndex,
      });
    },
    [chatState.conversationId, chatDispatch],
  );

  const retryStep = useCallback(
    (stepIndex: number) => {
      if (!chatState.conversationId) return;
      chatDispatch({ type: 'SET_STREAMING', payload: true });
      appDispatch({
        type: 'UPDATE_STEP_STATUS',
        payload: { stepIndex, status: 'running' },
      });
      wsRef.current?.send('retry_step', {
        conv_id: chatState.conversationId,
        step_index: stepIndex,
      });
    },
    [chatState.conversationId, chatDispatch, appDispatch],
  );

  const value: WebSocketContextValue = {
    sendMessage,
    sendRaw,
    stopGeneration,
    sendStepQuestion,
    retryStep,
    isStreaming: chatState.isStreaming,
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
  return ctx;
}
