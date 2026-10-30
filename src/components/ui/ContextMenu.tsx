import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useDismissLayer } from '../../hooks/ui/useDismissLayer';
import { Icon, type IconName } from './Icon';
import { useConfirmationState } from '../../hooks/ui/useConfirmationState';

export interface ContextMenuAction { label: string; icon: IconName | ReactElement; onSelect: () => void; danger?: boolean; disabled?: boolean; separatorBefore?: boolean; shortcut?: string }
export function ContextMenu({ position, label, actions, onClose, preferLeft = false, className = '', animateExit = false }: { position: { x: number; y: number }; label: string; actions: ContextMenuAction[]; onClose: () => void; preferLeft?: boolean; className?: string; animateExit?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState({ left: position.x, top: position.y });
  const exit=useConfirmationState({onClosed:onClose}),closeRequested=useRef(false);
  useEffect(()=>{exit.open();},[exit.open]);
  const close=useCallback(()=>{if(closeRequested.current)return;closeRequested.current=true;if(animateExit)exit.close();else onClose();},[animateExit,exit.close,onClose]);
  useDismissLayer(!exit.closing, ref, close);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = ref.current;
    const place = () => {
      const rect = ref.current?.getBoundingClientRect();
      const width=rect?.width??190;
      setLocation({ left: Math.max(8, Math.min(preferLeft?position.x-width-4:position.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(position.y, window.innerHeight - (rect?.height ?? 100) - 8)) });
    };
    place(); ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      if (menu?.contains(document.activeElement) && opener?.isConnected) opener.focus();
    };
  }, [position.x, position.y, preferLeft]);
  return createPortal(<div ref={ref} className={`worktree-context-menu ${className} ${exit.closing?'is-closing':''}`} inert={exit.closing} role="menu" aria-label={label} style={location}
    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    onKeyDown={e => {
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (current + 1) % items.length : e.key === 'ArrowUp' ? (current - 1 + items.length) % items.length : null;
      if (index !== null) { e.preventDefault(); items[index]?.focus(); }
    }}>
    {actions.map(action => <Fragment key={action.label}>{action.separatorBefore && <div role="separator" className="context-menu-separator" />}<button type="button" role="menuitem" className={`context-menu-item ${action.danger ? 'context-menu-item-danger' : ''}`} disabled={action.disabled} onClick={() => { if(closeRequested.current)return;close();action.onSelect(); }}>{typeof action.icon==='string'?<Icon name={action.icon} size={14} />:action.icon}<span>{action.label}</span>{action.shortcut && <small className="context-menu-shortcut">{action.shortcut}</small>}</button></Fragment>)}
  </div>, document.body);
}
