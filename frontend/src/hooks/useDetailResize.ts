import { useCallback, useRef, useEffect } from 'react';

/**
 * Hook for drag-resizing the detail panel.
 * Updates CSS variable --detail-panel-width on the container element.
 * Uses CSS: .detail-resize-handle
 */
export function useDetailResize(
  containerRef: React.RefObject<HTMLDivElement | null>,
  onClose?: () => void,
  onWidthChange?: (width: number) => void,
) {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const rawWidth = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;

    const container = containerRef.current;
    if (container) {
      const detailPanel = container.querySelector('.detail-panel') as HTMLElement;
      if (detailPanel) {
        startWidth.current = detailPanel.getBoundingClientRect().width;
      }
      const toggle = container.querySelector('.detail-toggle') as HTMLElement;
      if (toggle) toggle.classList.add('resizing');
    }

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [containerRef]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;

      const container = containerRef.current;
      if (!container) return;

      const delta = startX.current - e.clientX;
      const intendedWidth = startWidth.current + delta;
      rawWidth.current = intendedWidth;
      const maxWidth = Math.min(container.clientWidth * 0.6, container.clientWidth - 320);
      const newWidth = Math.max(330, Math.min(intendedWidth, maxWidth));

      container.style.setProperty('--detail-panel-width', `${newWidth}px`);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;

      const container = containerRef.current;
      if (container) {
        const toggle = container.querySelector('.detail-toggle') as HTMLElement;
        if (toggle) toggle.classList.remove('resizing');

        if (rawWidth.current < 200 && onClose) {
          container.style.removeProperty('--detail-panel-width');
          if (onWidthChange) onWidthChange(250);
          onClose();
        } else {
          const panel = container.querySelector('.detail-panel') as HTMLElement;
          const currentWidth = panel?.getBoundingClientRect().width ?? 0;
          if (currentWidth > 0 && onWidthChange) {
            onWidthChange(currentWidth);
          }
        }
      }

      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [containerRef, onClose, onWidthChange]);

  return { handleMouseDown };
}
