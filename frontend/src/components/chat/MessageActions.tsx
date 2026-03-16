import { useState } from 'react';
import { Copy, Check, Pencil, Trash2, RefreshCw } from 'lucide-react';
import { useChatContext } from '@/context/ChatContext';
import { useAppContext } from '@/context/AppContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { truncateConversation } from '@/api/conversations';

interface Props {
  messageIndex: number;
  role: 'user' | 'assistant';
  content: string;
  onEdit?: () => void;
}

/**
 * Message hover actions: Edit, Copy, Delete (truncate), Regenerate.
 * Uses CSS: .message-actions, .message-action-btn
 */
export function MessageActions({ messageIndex, role, content, onEdit }: Props) {
  const { state, dispatch } = useChatContext();
  const { dispatch: appDispatch } = useAppContext();
  const { sendMessage, stopGeneration } = useWebSocket();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const handleDelete = async () => {
    if (state.isStreaming) {
      stopGeneration();
    }
    const convId = state.conversationId;
    if (convId) {
      await truncateConversation(convId, messageIndex).catch(() => {});
    }
    appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
    dispatch({ type: 'TRUNCATE_FROM', payload: messageIndex });
  };

  const handleRegenerate = async () => {
    const messages = state.messages;
    const userMsg = messages[messageIndex - 1];
    if (userMsg && userMsg.role === 'user') {
      const convId = state.conversationId;
      if (convId) {
        await truncateConversation(convId, messageIndex - 1).catch(() => {});
      }
      appDispatch({ type: 'CLEAR_DETAIL_PANEL' });
      dispatch({ type: 'TRUNCATE_FROM', payload: messageIndex - 1 });
      // Reconstruct PendingFile-like objects from stored file data to preserve attachments
      const files = userMsg.files?.map((f) => ({
        file: new File([], (f.name as string) || ''),
        name: (f.name as string) || '',
        type: (f.type as 'image' | 'audio' | 'document') || 'document',
        uploadedFilename: (f.uploadId as string) || '',
      }));
      sendMessage(userMsg.content, files);
    }
  };

  return (
    <div className="message-actions">
      {role === 'user' && onEdit && (
        <button className="message-action-btn" onClick={onEdit} title="Edit">
          <Pencil size={14} />
        </button>
      )}
      <button className="message-action-btn" onClick={handleCopy} title={copied ? 'Copied' : 'Copy'}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <button className="message-action-btn delete-btn" onClick={handleDelete} title="Delete">
        <Trash2 size={14} />
      </button>
      {role === 'assistant' && (
        <button className="message-action-btn" onClick={handleRegenerate} title="Regenerate">
          <RefreshCw size={14} />
        </button>
      )}
    </div>
  );
}
