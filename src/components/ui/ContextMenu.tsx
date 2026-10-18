import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissLayer } from '../../hooks/useDismissLayer';
import { Icon, type IconName } from './Icon';

export interface ContextMenuAction { label: string; icon: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean }
export function ContextMenu({ position, label, actions, onClose }: { position: { x: number; y: number }; label: string; actions: ContextMenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState({ left: position.x, top: position.y });
  useDismissLayer(true, ref, onClose);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    const place = () => {
      const rect = ref.current?.getBoundingClientRect();
      setLocation({ left: Math.max(8, Math.min(position.x, window.innerWidth - (rect?.width ?? 190) - 8)), top: Math.max(8, Math.min(position.y, window.innerHeight - (rect?.height ?? 100) - 8)) });
    };
    place(); ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      if (menu?.contains(document.activeElement) && opener?.isConnected) opener.focus();
    };
  }, [position.x, position.y]);
  return createPortal(<div ref={ref} className="worktree-context-menu" role="menu" aria-label={label} style={location}
    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    onKeyDown={e => {
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (current + 1) % items.length : e.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : null;
      if (index !== null) { e.preventDefault(); items[index]?.focus(); }
    }}>
    {actions.map(action => <button key={action.label} type="button" role="menuitem" className={`context-menu-item ${action.danger ? 'context-menu-item-danger' : ''}`} disabled={action.disabled} onClick={() => { onClose(); action.onSelect(); }}><Icon name={action.icon} size={14} /><span>{action.label}</span></button>)}
  </div>, document.body);
}
