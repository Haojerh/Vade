/** Shared shimmer and reduced-motion fallback from the existing GitHub skeleton. */
export function Skeleton({ lines = 8, className = '', label = 'Loading' }: { lines?: number; className?: string; label?: string }) {
  return <div className={`ui-skeleton ${className}`} role="status" aria-label={label}>
    {Array.from({ length: lines }, (_, index) => <div key={index} className="github-skeleton-line" style={{ width: `${[72, 48, 83, 61, 90, 54][index % 6]}%` }} />)}
  </div>;
}
