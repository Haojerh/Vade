import { useCallback, useEffect, useRef, useState } from 'react';

export function useConfirmationState<T = void>({ onClosed }: { onClosed?: () => void } = {}) {
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const [data, setData] = useState<T | null>(null);
  const afterClose = useRef(onClosed);
  afterClose.current = onClosed;
  const closeRequested = useRef(false);

  const open = useCallback((payload?: T) => {
    closeRequested.current = false;
    if (payload !== undefined) {
      setData(payload);
    }
    setPhase('open');
  }, []);

  const close = useCallback(() => {
    closeRequested.current = true;
    setPhase((current) => {
      if (current !== 'open') return current;
      const reduced = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
      return reduced ? 'closed' : 'closing';
    });
  }, []);

  const reset = useCallback(() => {
    closeRequested.current = false;
    setPhase('closed');
    setData(null);
  }, []);

  useEffect(() => {
    if (phase === 'closed' && closeRequested.current) {
      closeRequested.current = false;
      afterClose.current?.();
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== 'closing') return;
    const timer = setTimeout(() => {
      setPhase('closed');
      setData(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [phase]);

  return {
    present: phase !== 'closed',
    closing: phase === 'closing',
    data,
    open,
    close,
    reset,
  };
}
