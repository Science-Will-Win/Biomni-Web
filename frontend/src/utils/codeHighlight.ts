/**
 * Syntax highlighting — ported from original app.js:5586-5642.
 * Custom regex-based highlighter for Python/R code.
 * Uses placeholder tokens to avoid regex conflicts.
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PYTHON_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
];

const R_KEYWORDS = [
  'if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next',
  'break', 'TRUE', 'FALSE', 'NULL', 'Inf', 'NaN', 'NA', 'NA_integer_',
  'NA_real_', 'NA_complex_', 'NA_character_', 'library', 'require',
  'return', 'switch',
];

export function highlightCodeSyntax(code: string, language: string): string {
  if (!code) return '';

  let html = escapeHtml(code);
  const placeholders: string[] = [];

  function addPlaceholder(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  }

  // 1. Strings (single/double/triple-quoted)
  html = html.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, (m) =>
    addPlaceholder(`<span class="code-string">${m}</span>`),
  );

  // 2. Comments
  if (language === 'r' || language === 'R') {
    html = html.replace(/(#[^\n]*)/g, (m) =>
      addPlaceholder(`<span class="code-comment">${m}</span>`),
    );
  } else {
    // Python: # comments
    html = html.replace(/(#[^\n]*)/g, (m) =>
      addPlaceholder(`<span class="code-comment">${m}</span>`),
    );
  }

  // 3. Keywords
  const keywords = (language === 'r' || language === 'R') ? R_KEYWORDS : PYTHON_KEYWORDS;
  const kwRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
  html = html.replace(kwRegex, (m) =>
    addPlaceholder(`<span class="code-keyword">${m}</span>`),
  );

  // 4. Numbers
  html = html.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, (m) =>
    addPlaceholder(`<span class="code-number">${m}</span>`),
  );

  // 5. Function calls
  html = html.replace(/\b([a-zA-Z_]\w*)\s*(?=\()/g, (m, name) =>
    addPlaceholder(`<span class="code-function">${name}</span>`),
  );

  // 6. Decorators (Python)
  if (language !== 'r' && language !== 'R') {
    html = html.replace(/(^|\n)(@\w+)/g, (_m, pre, dec) =>
      pre + addPlaceholder(`<span class="code-keyword">${dec}</span>`),
    );
  }

  // Restore placeholders
  html = html.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[Number(idx)]);

  return `<pre class="code-highlighted"><code>${html}</code></pre>`;
}
