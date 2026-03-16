import { useCallback } from 'react';

import { useChatContext } from '@/context/ChatContext';
import { useAppContext } from '@/context/AppContext';
import { useSmartScroll } from '@/hooks/useSmartScroll';
import { useWebSocket } from '@/context/WebSocketContext';
import { truncateConversation } from '@/api/conversations';
import { MessageBubble } from './MessageBubble';
import { useTranslation } from '@/i18n';

export function MessageList() {
  const { state, dispatch } = useChatContext();
  const { dispatch: appDispatch } = useAppContext();
  const { sendMessage } = useWebSocket();
  const { t } = useTranslation();
  const { containerRef, scrollToBottom, showScrollButton } = useSmartScroll(state.isStreaming);

  const handleSaveEdit = useCallback(async (messageIndex: number, newContent: string) => {
    const convId = state.conversationId;
    try {
      if (convId) {
        await truncateConversation(convId, messageIndex);
      }
      appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
      dispatch({ type: 'TRUNCATE_FROM', payload: messageIndex });
      sendMessage(newContent);
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: String(err) });
    }
  }, [state.conversationId, dispatch, sendMessage]);

  if (state.messages.length === 0) {
    return (
      <div className="messages-container" ref={containerRef}>
        <div className="welcome-message">
          <h2>{t('welcome.title')}</h2>
          <p>{t('welcome.subtitle')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="messages-container" ref={containerRef}>
      {state.messages.map((msg, idx) => (
        <MessageBubble
          key={`${state.conversationId || 'new'}-${idx}-${msg.role}`}
          message={msg}
          isLast={idx === state.messages.length - 1}
          isStreaming={state.isStreaming && idx === state.messages.length - 1 && msg.role === 'assistant'}
          messageIndex={idx}
          onSaveEdit={handleSaveEdit}
        />
      ))}

      {/* Scroll to bottom button — always rendered, CSS .visible controls opacity */}
      <button
        className={`scroll-to-bottom-btn${showScrollButton ? ' visible' : ''}`}
        onClick={scrollToBottom}
      >
        ⌄
      </button>
    </div>
  );
}
