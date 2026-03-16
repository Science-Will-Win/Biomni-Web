import { useState, useRef, useEffect } from 'react';
import type { ChatMessage } from '@/types';
import { useChatContext } from '@/context/ChatContext';
import { useTranslation } from '@/i18n';
import { MarkdownContent } from '@/utils/MarkdownContent';
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
  const [editSize, setEditSize] = useState<{ width: number; height: number } | null>(null);
  const { state: chatState } = useChatContext();
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-resize textarea height on content change
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = el.scrollHeight + 'px';
    }
  }, [editValue]);

  const startEdit = () => {
    if (contentRef.current) {
      const rect = contentRef.current.getBoundingClientRect();
      setEditSize({ width: rect.width, height: rect.height });
    }
    setIsEditing(true);
  };

  // Parse content: extract [THINK] blocks + strip other special tokens
  const { displayContent, thinkBlocks } = parseContent(message.content);

  // Plan mode: hide Phase A streaming tokens (before create_plan tool call arrives)
  const isPlanMode = chatState.mode === 'plan';
  const hasPlanCall = message.toolCalls?.some((tc) => tc.name === 'create_plan');
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
            <div className="message-edit-container" style={editSize ? { minWidth: editSize.width } : undefined}>
              <textarea
                ref={textareaRef}
                className="edit-textarea"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                style={editSize ? { minHeight: editSize.height } : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    setIsEditing(false);
                    if (editValue.trim()) {
                      onSaveEdit?.(messageIndex, editValue.trim());
                    }
                  }
                }}
                autoFocus
              />
              <div className="edit-actions">
                <button
                  className="edit-btn save"
                  onClick={() => {
                    setIsEditing(false);
                    if (editValue.trim()) {
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
            <div className="message-text" ref={contentRef}>{displayContent}</div>
          )
        ) : showPlanCreatingIndicator ? (
          /* Plan mode Phase A: hide raw tokens, show creating/retrying indicator */
          <div className="plan-creating-indicator">
            <StreamingDots />
            <span>{chatState.planRetrying ? t('status.plan_retry') : t('status.creating_plan')}</span>
          </div>
        ) : hasPlanCall ? (
          /* Plan mode: PlanStepsBox handles display — hide raw plan text */
          null
        ) : (
          <div className="message-text markdown-content">
            {displayContent ? (
              <MarkdownContent text={displayContent} />
            ) : isStreaming && isLast ? (
              <StreamingDots />
            ) : null}
            {isStreaming && isLast && displayContent && <StreamingDots />}
          </div>
        )}

        {/* Plan steps box (for create_plan tool calls) */}
        {hasPlanCall && (
          <PlanStepsBox
            toolCalls={message.toolCalls!}
            toolResults={message.toolResults}
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
          onEdit={isUser ? startEdit : undefined}
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

  // Extract think blocks — supports mixed formats ([THINK]...</think>, <think>...[/THINK], etc.)
  const thinkPattern = /(?:\[THINK\]|<think>)([\s\S]*?)(?:\[\/THINK\]|<\/think>)/gi;
  for (const match of content.matchAll(thinkPattern)) {
    thinkBlocks.push(match[1].trim());
  }

  // Strip all think blocks for display (cross-format)
  let result = content;
  result = result.replace(/(?:\[THINK\]|<think>)[\s\S]*?(?:\[\/THINK\]|<\/think>)/gi, '');

  // Handle incomplete think blocks (streaming — closing tag not yet arrived)
  const partialThink = result.match(/(?:\[THINK\]|<think>)([\s\S]*)$/i);
  if (partialThink) {
    thinkBlocks.push(partialThink[1].trim());
    result = result.replace(/(?:\[THINK\]|<think>)[\s\S]*$/i, '');
  }

  // Extract execute blocks (cross-format) → code blocks
  // Negative lookahead prevents matching across nested/unclosed execute tags
  result = result.replace(/(?:<execute>|\[EXECUTE\])((?:(?!(?:<execute>|\[EXECUTE\]))[\s\S])*?)(?:<\/execute>|\[\/EXECUTE\])/gi, (_m: string, code: string) =>
    '\n```python\n' + code.trim() + '\n```\n');
  // Incomplete streaming execute blocks — match only the LAST unclosed block
  result = result.replace(/(?:<execute>|\[EXECUTE\])((?:(?!(?:<execute>|\[EXECUTE\]))[\s\S])*)$/i, (_m: string, code: string) =>
    '\n' + code.trim() + '\n');

  // Strip empty observation blocks first (cross-format)
  result = result.replace(/(?:<observation>|\[OBSERVATION\])\s*(?:<\/observation>|\[\/OBSERVATION\])/gi, '');
  // Observation blocks with content → blockquote (cross-format)
  result = result.replace(/(?:<observation>|\[OBSERVATION\])([\s\S]*?)(?:<\/observation>|\[\/OBSERVATION\])/gi, (_m: string, obs: string) =>
    '\n> **Output:** ' + obs.trim() + '\n');

  // Strip solution blocks (cross-format, displayed in plan box not chat)
  result = result.replace(/(?:<solution>|\[SOLUTION\])[\s\S]*?(?:<\/solution>|\[\/SOLUTION\])/gi, '');
  result = result.replace(/(?:<solution>|\[SOLUTION\])[\s\S]*$/i, '');

  result = result.replace(/\[TOOL_CALLS\][\s\S]*?(?:\[ARGS\][\s\S]*?)?(?=\[TOOL_RESULTS\]|$)/g, '');
  result = result.replace(/\[TOOL_RESULTS\][\s\S]*?\[\/TOOL_RESULTS\]/g, '');
  result = result.replace(/\[AVAILABLE_TOOLS\][\s\S]*?\[\/AVAILABLE_TOOLS\]/g, '');
  result = result.replace(/\[PLAN_COMPLETE\][\s\S]*$/g, '');
  result = result.replace(/\[(IMG|AUDIO)_PLACEHOLDER:[^\]]*\]/g, '');
  // Strip <start>tool_name{...} patterns (small model bare tool call format)
  result = result.replace(/<start>\w+\{[\s\S]*$/g, '');
  // Strip remaining <start> tags
  result = result.replace(/<start>/g, '');
  // Strip orphaned tags (unclosed ones that weren't the last block)
  result = result.replace(/\[EXECUTE\]/g, '');
  result = result.replace(/<\/?execute>/gi, '');
  result = result.replace(/<\/?think>/gi, '');

  return { displayContent: result.trim(), thinkBlocks };
}
