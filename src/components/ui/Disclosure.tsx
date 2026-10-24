import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** Shared animated disclosure; lazy content is retained after its first expansion. */
export function Disclosure({ title, children, defaultOpen = false, className = '', lazy = false, compact = false, badge, actions, triggerContent, open: controlledOpen, onOpenChange }: { title: string; children: ReactNode; defaultOpen?: boolean; className?: string; lazy?: boolean; compact?: boolean; badge?: ReactNode; actions?:ReactNode; triggerContent?:ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setOpen] = useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const [hasOpened, setHasOpened] = useState(defaultOpen);
  const id = useId();
  return <section className={`disclosure ${compact ? 'disclosure-compact' : 'modal-section'} ${className}`}>
    <div className="section-header-row"><button type="button" className={`disclosure-trigger ${compact ? '' : 'section-title-btn'}`} aria-label={compact ? title : `${open ? 'Collapse' : 'Expand'} ${title} section`} aria-expanded={open} aria-controls={id} onClick={() => { setHasOpened(true); setOpen(!open); onOpenChange?.(!open); }}>
      {compact && <Icon name="chevron-right" size={14} className={`disclosure-chevron ${open ? 'is-expanded' : ''}`} />}
      {triggerContent??(compact ? <span>{title}</span> : <h3 className="section-title">{title}</h3>)}{badge}
      {!compact && <Icon name="chevron-right" size={13} className={`disclosure-chevron ${open ? 'is-expanded' : ''}`} />}
    </button>{actions}</div>
    <div id={id} className={`disclosure-content ${open ? 'is-expanded' : ''}`} inert={!open} aria-hidden={!open}><div className="disclosure-inner">{(!lazy || hasOpened) && children}</div></div>
  </section>;
}
