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
  const [isScrollable, setIsScrollable] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      autoScrolling.current = true;
      el.scrollTop = el.scrollHeight;
      userScrolledUp.current = false;
      setNearBottom(true);
    }
  }, []);

  // Recompute scroll state helper
  const recomputeScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight > el.clientHeight + 10;
    const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    setIsScrollable(scrollable);
    setNearBottom(isNear);
  }, []);

  // Track scroll position
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const threshold = 150;
      const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      const scrollable = el.scrollHeight > el.clientHeight + 10;
      setNearBottom(isNear);
      setIsScrollable(scrollable);
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

  // Recompute scroll state when content or container size changes
  // (fixes stale isScrollable when switching conversations)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recomputeScroll);
    ro.observe(el);
    const mo = new MutationObserver(recomputeScroll);
    mo.observe(el, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [recomputeScroll]);

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
    showScrollButton: isScrollable && !nearBottom,
  };
}
