import { useEffect, useRef, useState } from 'react';

export function RefreshIcon({ busy, size = 14 }: { busy: boolean; size?: number }) {
  const [spinning, setSpinning] = useState(busy);
  const startedAt = useRef(0);
  useEffect(() => {
    if (busy) {
      startedAt.current = Date.now();
      setSpinning(true);
      return;
    }
    // Keep quick cached reads visibly responsive without delaying the request.
    const timer = setTimeout(() => setSpinning(false), Math.max(0, 600 - (Date.now() - startedAt.current)));
    return () => clearTimeout(timer);
  }, [busy]);
  return <svg className={`refresh-icon ${spinning ? 'spin' : ''}`} width={size} height={size}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5" />
  </svg>;
}
