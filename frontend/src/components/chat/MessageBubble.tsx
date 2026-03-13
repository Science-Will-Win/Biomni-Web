import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '@/types';
import { useChatContext } from '@/context/ChatContext';
import { useTranslation } from '@/i18n';
import { StreamingDots } from './StreamingDots';
import { SpecialTokenBlock } from './SpecialTokenBlock';
import { MessageActions } from './MessageActions';
import { PlanStepsBox } from './PlanStepsBox';

interface Props {
  message: ChatMessage;
  isLast: boolean;
  isStreaming: boolean;
  messageIndex: number;
  onSaveEdit?: (messageIndex: number, newContent: string) => void;
}

export function MessageBubble({ message, isLast, isStreaming, messageIndex, onSaveEdit }: Props) {
  const isUser = message.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const { state: chatState } = useChatContext();
  const { t } = useTranslation();

  // Parse content: extract [THINK] blocks + strip other special tokens
  const { displayContent, thinkBlocks } = parseContent(message.content);

  // 👇 [수정됨] 백엔드에서 오는 planComplete 데이터나 tool_call 데이터가 있는지 확실하게 확인합니다.
  const isPlanMode = chatState.mode === 'plan';
  const pc = message.planComplete as any;
  const createPlanCall = message.toolCalls?.find((tc) => tc.name === 'create_plan');
  
  // 데이터가 배열 형태로 존재하거나, toolCall이 있을 때만 true를 반환합니다.
  const hasPlanCall = !!createPlanCall || (pc && (Array.isArray(pc.steps) || Array.isArray(pc.plan?.steps)));
  const showPlanCreatingIndicator = !isUser && isPlanMode && isStreaming && isLast && !hasPlanCall;

  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-header">
        <div className="message-avatar">{isUser ? 'U' : 'A'}</div>
        <div className="message-role">{isUser ? 'User' : 'Assistant'}</div>
      </div>
      <div className="message-content">
        {/* Think blocks (collapsible) */}
        {thinkBlocks.map((block, i) => (
          <SpecialTokenBlock key={i} label="Thinking" content={block} variant="think" isStreaming={isStreaming && isLast} />
        ))}

        {/* Main content */}
        {isUser ? (
          isEditing ? (
            <div className="message-edit-container">
              <textarea
                className="edit-textarea"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                autoFocus
              />
              <div className="edit-actions">
                <button
                  className="edit-btn save"
                  onClick={() => {
                    setIsEditing(false);
                    if (editValue.trim() && editValue !== message.content) {
                      onSaveEdit?.(messageIndex, editValue.trim());
                    }
                  }}
                >
                  Save
                </button>
                <button
                  className="edit-btn cancel"
                  onClick={() => {
                    setIsEditing(false);
                    setEditValue(message.content);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="message-text">{displayContent}</div>
          )
        ) : showPlanCreatingIndicator ? (
          /* Plan mode Phase A: hide raw tokens, show "플랜 생성 중..." with blue dots */
          <div className="plan-creating-indicator">
            <StreamingDots />
            <span>{t('status.creating_plan')}</span>
          </div>
        ) : hasPlanCall ? (
          /* Plan mode: PlanStepsBox handles display — hide raw plan text */
          null
        ) : (
          <div className="message-text markdown-content">
            {displayContent ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayContent}
              </ReactMarkdown>
            ) : isStreaming && isLast ? (
              <StreamingDots />
            ) : null}
            {isStreaming && isLast && displayContent && <StreamingDots />}
          </div>
        )}

        {/* Plan steps box (for create_plan tool calls) */}
        {hasPlanCall && (
          <PlanStepsBox
            toolCalls={message.toolCalls || []}
            toolResults={message.toolResults || []}
            planComplete={message.planComplete} /* 👇 [수정됨] 이 데이터가 넘어가야 박스가 그려집니다 */
            messageIndex={messageIndex}
          />
        )}

        {/* Tool calls/results — only show when there's NO plan box
            (plan mode step execution tools are shown in PlanStepsBox instead) */}
        {!hasPlanCall && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="tool-call-box">
            {message.toolCalls.map((tc, i) => (
              <div key={i} className="tool-call-header">
                <span className="tool-call-name">{tc.name}</span>
                <span className={`tool-call-status ${tc.status || 'running'}`}>
                  {tc.status || 'running'}
                </span>
              </div>
            ))}
          </div>
        )}

        {!hasPlanCall && message.toolResults && message.toolResults.length > 0 && (
          <div className="tool-result-details">
            {message.toolResults.map((tr, i) => (
              <div
                key={i}
                className={`tool-result-title ${tr.success ? 'success' : 'error'}`}
              >
                <span className="tool-result-name">{tr.tool}</span>
                <span className="tool-result-status">
                  {tr.success ? 'completed' : 'failed'}
                </span>
              </div>
            ))}
          </div>
        )}

      </div>
      {/* Hover actions — outside message-content, sibling */}
      {!isStreaming && !isEditing && (
        <MessageActions
          messageIndex={messageIndex}
          role={message.role}
          content={message.content}
          onEdit={isUser ? () => setIsEditing(true) : undefined}
        />
      )}
    </div>
  );
}

/**
 * Parse message content: extract [THINK]/`<think>` blocks and strip other special tokens.
 */
function parseContent(content: string): { displayContent: string; thinkBlocks: string[] } {
  if (!content) return { displayContent: '', thinkBlocks: [] };

  const thinkBlocks: string[] = [];

  // Extract [THINK]...[/THINK]
  content.replace(/\[THINK\]([\s\S]*?)\[\/THINK\]/g, (_, block: string) => {
    thinkBlocks.push(block.trim());
    return '';
  });

  // Extract <think>...</think>
  content.replace(/<think>([\s\S]*?)<\/think>/g, (_, block: string) => {
    thinkBlocks.push(block.trim());
    return '';
  });

  // Strip all special tokens for display
  let result = content;
  result = result.replace(/\[THINK\][\s\S]*?\[\/THINK\]/g, '');
  result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // Handle incomplete think blocks (streaming — closing tag not yet arrived)
  const partialBracket = result.match(/\[THINK\]([\s\S]*)$/);
  if (partialBracket) {
    thinkBlocks.push(partialBracket[1].trim());
    result = result.replace(/\[THINK\][\s\S]*$/, '');
  }
  const partialHtml = result.match(/<think>([\s\S]*)$/i);
  if (partialHtml) {
    thinkBlocks.push(partialHtml[1].trim());
    result = result.replace(/<think>[\s\S]*$/i, '');
  }

  result = result.replace(/\[TOOL_CALLS\][\s\S]*?(?:\[ARGS\][\s\S]*?)?(?=\[TOOL_RESULTS\]|$)/g, '');
  result = result.replace(/\[TOOL_RESULTS\][\s\S]*?\[\/TOOL_RESULTS\]/g, '');
  result = result.replace(/\[AVAILABLE_TOOLS\][\s\S]*?\[\/AVAILABLE_TOOLS\]/g, '');
  result = result.replace(/\[PLAN_COMPLETE\][\s\S]*$/g, '');
  result = result.replace(/\[(IMG|AUDIO)_PLACEHOLDER:[^\]]*\]/g, '');
  // Strip <start>tool_name{...} patterns (small model bare tool call format)
  result = result.replace(/<start>\w+\{[\s\S]*$/g, '');
  // Strip remaining <start> tags
  result = result.replace(/<start>/g, '');

  return { displayContent: result.trim(), thinkBlocks };
}