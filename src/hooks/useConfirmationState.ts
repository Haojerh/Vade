import { useCallback, useEffect, useState } from 'react';

export function useConfirmationState<T = void>() {
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const [data, setData] = useState<T | null>(null);

  const open = useCallback((payload?: T) => {
    if (payload !== undefined) {
      setData(payload);
    }
    setPhase('open');
  }, []);

  const close = useCallback(() => {
    setPhase((current) => {
      if (current !== 'open') return current;
      const reduced = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false;
      return reduced ? 'closed' : 'closing';
    });
  }, []);

  const reset = useCallback(() => {
    setPhase('closed');
    setData(null);
  }, []);

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
