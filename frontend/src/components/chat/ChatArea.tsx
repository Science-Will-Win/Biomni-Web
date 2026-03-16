import { useEffect } from 'react';
import { useChatContext } from '@/context/ChatContext';
import { useToast } from '@/components/common/Toast';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

export function ChatArea() {
  const { state, dispatch } = useChatContext();
  const { addToast } = useToast();

  useEffect(() => {
    if (state.error) {
      addToast(state.error, 'error');
      dispatch({ type: 'CLEAR_ERROR' });
    }
  }, [state.error, addToast, dispatch]);

  return (
    <div className="chat-area">
      <MessageList />
      <ChatInput />
    </div>
  );
}
