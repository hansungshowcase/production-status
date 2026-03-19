import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Detects scroll direction & position for native-like header behavior
 * Returns: { scrolled, hidden, scrollY }
 * - scrolled: true when scrolled past threshold (for glass effect)
 * - hidden: true when scrolling down fast (auto-hide header)
 */
export default function useScrollHeader(containerRef, { threshold = 10, hideThreshold = 60 } = {}) {
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const lastScrollY = useRef(0);
  const ticking = useRef(false);

  const onScroll = useCallback(() => {
    if (ticking.current) return;
    ticking.current = true;

    requestAnimationFrame(() => {
      const el = containerRef?.current;
      const y = el ? el.scrollTop : window.scrollY;
      const delta = y - lastScrollY.current;

      setScrolled(y > threshold);

      if (delta > 5 && y > hideThreshold) {
        setHidden(true);
      } else if (delta < -5) {
        setHidden(false);
      }

      lastScrollY.current = y;
      ticking.current = false;
    });
  }, [containerRef, threshold, hideThreshold]);

  useEffect(() => {
    const el = containerRef?.current || window;
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerRef, onScroll]);

  return { scrolled, hidden };
}
