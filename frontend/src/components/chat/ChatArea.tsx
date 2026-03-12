import { useEffect } from 'react';
import { useChatContext } from '@/context/ChatContext';
import { useToast } from '@/components/common/Toast';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

export function ChatArea() {
  // 수정: 더 이상 즉시 초기화를 위한 dispatch를 사용하지 않습니다.
  const { state } = useChatContext();
  const { addToast } = useToast();

  useEffect(() => {
    if (state.error) {
      addToast(state.error, 'error');
      // 수정: 에러가 발생하더라도 여기서 CLEAR_ERROR를 호출하지 않아 상태에 유지시킵니다.
    }
  }, [state.error, addToast]);

  return (
    <div className="chat-area">
      <MessageList />
      <ChatInput />
    </div>
  );
}