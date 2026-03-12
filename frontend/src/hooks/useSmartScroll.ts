import { useRef, useState, useEffect, useCallback } from 'react';

/**
 * Smart scroll hook: auto-scrolls during streaming,
 * pauses when user manually scrolls up.
 * Returns a ref for the scrollable container, a scrollToBottom function,
 * and whether the scroll-to-bottom button should be visible.
 */
export function useSmartScroll(isStreaming: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const autoScrolling = useRef(false);
  const [nearBottom, setNearBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      autoScrolling.current = true;
      el.scrollTop = el.scrollHeight;
      userScrolledUp.current = false;
      setNearBottom(true);
    }
  }, []);

  // Track scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const threshold = 150; // Original uses 150px
      const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setNearBottom(isNear);
      // auto-scroll이 발생시킨 scroll이면 flag 리셋하지 않음
      if (autoScrolling.current) {
        autoScrolling.current = false;
        return;
      }
      if (!isNear && isStreaming) {
        userScrolledUp.current = true;
      }
    };

    // wheel 이벤트는 항상 사용자 의도
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && isStreaming) {
        userScrolledUp.current = true;
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', handleWheel);
    };
  }, [isStreaming]);

  // Auto-scroll during streaming
  useEffect(() => {
    if (!isStreaming) return;

    const interval = setInterval(() => {
      if (!userScrolledUp.current && containerRef.current) {
        autoScrolling.current = true;
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isStreaming]);

  // Scroll to bottom on new message (non-streaming)
  useEffect(() => {
    if (!isStreaming && nearBottom) {
      scrollToBottom();
    }
  }, [isStreaming, nearBottom, scrollToBottom]);

  return {
    containerRef,
    scrollToBottom,
    showScrollButton: !nearBottom,
  };
}
