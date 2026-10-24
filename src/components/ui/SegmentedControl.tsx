import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Choice { value: string; label: string; icon?: ReactNode }

/** The active copy is clipped to the confirmed selection, keeping text and highlight in sync. */
export function SegmentedControl({ label, choices, value, disabled, onChange, radius = 14 }: {
  label: string; choices: Choice[]; value?: string; disabled?: boolean; onChange: (value: string) => void; radius?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [clip, setClip] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const signature = choices.map(choice => choice.value).join('\0');
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('button'));
      const selected = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
      setClip(selected ? `inset(${selected.offsetTop}px ${Math.max(0, element.offsetWidth - selected.offsetLeft - selected.offsetWidth)}px ${Math.max(0, element.offsetHeight - selected.offsetTop - selected.offsetHeight)}px ${selected.offsetLeft}px round ${radius}px)` : null);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    const frame = requestAnimationFrame(() => setReady(true));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [value, signature, radius]);
  return <div ref={root} className="segmented-control" role="group" aria-label={label} data-ready={ready} data-disabled={disabled || undefined} style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}>
    {choices.map(choice => <button type="button" key={choice.value} aria-label={choice.label} title={choice.icon ? choice.label : undefined} aria-pressed={choice.value === value} disabled={disabled} onClick={() => onChange(choice.value)}>{choice.icon ?? choice.label}</button>)}
    <div className="segmented-control-active" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))`, clipPath: clip ?? 'inset(0 100% 0 0)' }}>
      {choices.map(choice => <span key={choice.value}>{choice.icon ?? choice.label}</span>)}
    </div>
  </div>;
}
