import { useState, useRef, useCallback } from 'react';
import { Send, Paperclip } from 'lucide-react';
import { useChatContext } from '@/context/ChatContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { useConversations } from '@/hooks/useConversations';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useSettings } from '@/context/SettingsContext';
import { useTranslation } from '@/i18n';
import { FilePreviewList } from './FilePreviewList';

export function ChatInput() {
  const [input, setInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { state, dispatch } = useChatContext();
  const { sendMessage, sendRaw, stopGeneration, isStreaming } = useWebSocket();
  const { loadConversations } = useConversations();
  const { settings } = useSettings();
  const { pendingFiles, uploading, addFiles, removeFile, clearFiles } = useFileUpload(settings.maxAttachments);
  const { t } = useTranslation();

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (isStreaming) return;
    if (!text && pendingFiles.length === 0) return;

    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // If step questions are attached, route through step_question WS action
    if (state.stepQuestions.length > 0 && state.conversationId) {
      dispatch({ type: 'ADD_MESSAGE', payload: { role: 'user', content: text } });
      dispatch({ type: 'ADD_MESSAGE', payload: { role: 'assistant', content: '' } });
      sendRaw('step_question', {
        conv_id: state.conversationId,
        question: text,
        steps: state.stepQuestions,
        plan_goal: state.stepQuestions[0]?.planGoal || '',
        plan_steps: state.stepQuestions[0]?.planSteps || [],
      });
      dispatch({ type: 'CLEAR_STEP_QUESTIONS' });
      return;
    }

    const files = pendingFiles.length > 0 ? pendingFiles : undefined;
    clearFiles();

    await sendMessage(text, files, () => {
      loadConversations();
    });
  }, [input, isStreaming, sendMessage, sendRaw, loadConversations, pendingFiles, clearFiles, state.stepQuestions, state.conversationId, dispatch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Backspace on empty input → clear all step tags (original app.js:249-251)
    if (e.key === 'Backspace' && input === '' && state.stepQuestions.length > 0) {
      e.preventDefault();
      dispatch({ type: 'CLEAR_STEP_QUESTIONS' });
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  };

  return (
    <div
      className={`input-area ${dragOver ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* File previews */}
      <FilePreviewList files={pendingFiles} onRemove={removeFile} />

      {/* Input wrapper — flex row: mode-toggle | textarea | attach | send */}
      <div className="input-wrapper">
        {/* Mode toggle */}
        <div className="mode-toggle" id="modeToggle">
          <button
            className={`mode-btn ${state.mode === 'agent' ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_MODE', payload: 'agent' })}
          >
            {t('label.mode_agent')}
          </button>
          <button
            className={`mode-btn ${state.mode === 'plan' ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_MODE', payload: 'plan' })}
          >
            {t('label.mode_plan')}
          </button>
        </div>

        {/* Input container — tags inline with textarea */}
        <div className="input-container">
          {state.stepQuestions.length > 0 && (
            <div className="input-tags">
              {state.stepQuestions.map((q) => (
                <span key={q.stepNum} className="input-tag" data-step={q.stepNum}>
                  {q.stepNum === 0 ? (t('label.entire_plan') || 'Entire Plan') : `Step ${q.stepNum}`}
                  <span
                    className="input-tag-remove"
                    onClick={() => dispatch({ type: 'REMOVE_STEP_QUESTION', payload: q.stepNum })}
                  >
                    &times;
                  </span>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="message-input"
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={state.stepQuestions.length > 0
              ? `Ask a question about Step Plan...`
              : t('placeholder.message')}
            rows={1}
            disabled={isStreaming}
          />
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
          accept="image/*,audio/*,.csv,.xml,.json,.txt,.pdf,.doc,.docx,.xlsx"
        />

        {/* Attach button */}
        <button
          className="btn-attach"
          title={t('tooltip.attach')}
          disabled={isStreaming}
          onClick={handleAttachClick}
        >
          <Paperclip size={20} />
        </button>

        {/* Send / Stop button */}
        {isStreaming ? (
          <button className="btn-send streaming" onClick={stopGeneration} title={t('tooltip.stop')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            className="btn-send"
            onClick={handleSend}
            disabled={(!input.trim() && pendingFiles.length === 0) || uploading}
            title={t('tooltip.send')}
          >
            <Send size={20} />
          </button>
        )}
      </div>

      {/* Input hint */}
      <div className="input-hint">
        {t('hint.input')}
      </div>
    </div>
  );
}
