import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { MarkdownContent } from '@/utils/MarkdownContent';

interface Props {
  label: string;
  content: string;
  variant?: 'think' | 'tool-calls' | 'tool-results';
  isStreaming?: boolean;
}

/**
 * Convert [EXECUTE]/[OBSERVATION] inside think content to markdown.
 */
function processThinkContent(content: string): string {
  let result = content;
  // Closed execute → code blocks (cross-format)
  result = result.replace(/(?:<execute>|\[EXECUTE\])((?:(?!(?:<execute>|\[EXECUTE\]))[\s\S])*?)(?:<\/execute>|\[\/EXECUTE\])/gi,
    (_m: string, code: string) => '\n```python\n' + code.trim() + '\n```\n');
  // Unclosed (streaming) — last block only (cross-format)
  result = result.replace(/(?:<execute>|\[EXECUTE\])((?:(?!(?:<execute>|\[EXECUTE\]))[\s\S])*)$/i,
    (_m: string, code: string) => '\n```python\n' + code.trim() + '\n```\n');
  // Empty observation blocks (cross-format)
  result = result.replace(/(?:<observation>|\[OBSERVATION\])\s*(?:<\/observation>|\[\/OBSERVATION\])/gi, '');
  // Observation → blockquote (cross-format)
  result = result.replace(/(?:<observation>|\[OBSERVATION\])([\s\S]*?)(?:<\/observation>|\[\/OBSERVATION\])/gi,
    (_m: string, obs: string) => '\n> **Output:** ' + obs.trim() + '\n');
  // Strip orphan tags
  result = result.replace(/\[EXECUTE\]/g, '');
  result = result.replace(/<\/?execute>/gi, '');
  return result;
}

/**
 * Collapsible block for special tokens ([THINK], etc.).
 * Think variant: minimal gray design with ▶/▼ triangle.
 *  - Streaming: collapsed, shows last line rolling below toggle
 *  - Complete: collapsed, shows 80-char italic preview
 *  - Expanded: full content with MarkdownContent rendering (code blocks, blockquotes)
 */
export function SpecialTokenBlock({ label, content, variant = 'think', isStreaming = false }: Props) {
  const [expanded, setExpanded] = useState(false);

  // Think variant: minimal gray design
  if (variant === 'think') {
    const rawPreview = content.replace(/\n/g, ' ');
    const preview = rawPreview.length > 80 ? rawPreview.slice(0, 80) + '...' : rawPreview;
    const lastLine = content.split('\n').filter(l => l.trim()).pop() || '';

    return (
      <div className="cot-container">
        <button
          className={`cot-toggle ${expanded ? 'expanded' : ''}`}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="cot-arrow">{expanded ? '\u25BC' : '\u25B6'}</span>
          <span className="cot-label">{label}</span>
        </button>
        {expanded ? (
          <div className="cot-content markdown-content">
            <MarkdownContent text={processThinkContent(content)} />
          </div>
        ) : (
          <div className="cot-preview">
            {isStreaming ? lastLine : preview}
          </div>
        )}
      </div>
    );
  }

  // Other variants: existing special-* design
  return (
    <div className={`special-token-container ${variant}-container`}>
      <button
        className={`special-toggle ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight size={14} className="special-arrow" />
        <span>{label}</span>
      </button>
      {expanded && (
        <div className="special-content">
          <pre>{content}</pre>
        </div>
      )}
    </div>
  );
}
