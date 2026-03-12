/**
 * GraphPopout — renders children into a separate browser window using React Portal.
 * Copies parent document stylesheets so the graph renders identically.
 */
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  children: ReactNode;
  onClose: () => void;
  title?: string;
}

export function GraphPopout({ children, onClose, title = 'Graph Editor' }: Props) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const windowRef = useRef<Window | null>(null);

  useEffect(() => {
    const win = window.open('', 'graphEditor', 'width=1200,height=800');
    if (!win) {
      onClose();
      return;
    }
    windowRef.current = win;

    // Set up basic document structure
    win.document.title = title;
    win.document.body.style.margin = '0';
    win.document.body.style.overflow = 'hidden';
    win.document.body.style.background = 'var(--bg-primary, #1a1a1a)';

    // Copy stylesheets from parent
    const styleSheets = document.querySelectorAll('link[rel="stylesheet"], style');
    styleSheets.forEach((s) => {
      win.document.head.appendChild(s.cloneNode(true));
    });

    // Copy theme attribute
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme) {
      win.document.documentElement.setAttribute('data-theme', theme);
    }

    // Create container div
    const div = win.document.createElement('div');
    div.id = 'graph-popout-root';
    div.style.width = '100vw';
    div.style.height = '100vh';
    div.style.position = 'relative';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    win.document.body.appendChild(div);
    setContainer(div);

    // Handle window close
    win.addEventListener('beforeunload', onClose);

    return () => {
      win.removeEventListener('beforeunload', onClose);
      win.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!container) return null;
  return createPortal(children, container);
}
