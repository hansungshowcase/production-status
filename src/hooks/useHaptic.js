import { useCallback } from 'react';

/**
 * Native haptic feedback via Vibration API
 * Falls back gracefully on unsupported devices
 */
export default function useHaptic() {
  const vibrate = useCallback((pattern) => {
    if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  }, []);

  const light = useCallback(() => vibrate(10), [vibrate]);
  const medium = useCallback(() => vibrate(20), [vibrate]);
  const heavy = useCallback(() => vibrate(40), [vibrate]);
  const success = useCallback(() => vibrate([10, 30, 10]), [vibrate]);
  const error = useCallback(() => vibrate([20, 50, 20, 50, 20]), [vibrate]);
  const selection = useCallback(() => vibrate(5), [vibrate]);

  return { light, medium, heavy, success, error, selection };
}
