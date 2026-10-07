import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus({ active, dialogRef, initialFocusRef, onEscape }) {
  const activeRef = useRef(active);
  const returnFocusRef = useRef(null);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return undefined;

    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const appRoot = document.getElementById('root');
    const previousOverflow = document.body.style.overflow;
    const previousInert = appRoot?.inert ?? false;
    if (!returnFocusRef.current) {
      const focused = document.activeElement;
      returnFocusRef.current = focused instanceof HTMLElement && focused !== document.body
        ? focused
        : appRoot?.querySelector(FOCUSABLE_SELECTOR) || null;
    }

    document.body.style.overflow = 'hidden';
    if (appRoot) appRoot.inert = true;

    const focusInitial = () => {
      const target = initialFocusRef?.current || dialog.querySelector(FOCUSABLE_SELECTOR) || dialog;
      target.focus({ preventScroll: true });
    };
    const focusFrame = requestAnimationFrame(focusInitial);

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter((node) => node.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (appRoot) appRoot.inert = previousInert;

      requestAnimationFrame(() => {
        if (activeRef.current) return;
        const target = returnFocusRef.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
        returnFocusRef.current = null;
      });
    };
  }, [active, dialogRef, initialFocusRef, onEscape]);
}
