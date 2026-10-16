import { useCallback, useEffect, useState } from 'react';

export function usePopoverState() {
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed');
  const close = useCallback(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPhase((current) => current === 'closed' || reduced ? 'closed' : 'closing');
  }, []);
  const toggle = useCallback(() => {
    if (phase === 'open') close();
    else setPhase('open');
  }, [phase, close]);
  useEffect(() => {
    if (phase !== 'closing') return;
    const timer = setTimeout(() => setPhase('closed'), 150);
    return () => clearTimeout(timer);
  }, [phase]);
  return { present: phase !== 'closed', closing: phase === 'closing', close, toggle };
}
