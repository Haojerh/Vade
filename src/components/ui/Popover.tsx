import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissLayer } from '../../hooks/useDismissLayer';

export function popoverPortalHost(trigger: HTMLElement | null, fallback: HTMLElement): Element {
  // A body-level portal is inert while its trigger's native modal is open.
  return trigger?.closest('dialog[open]') ?? fallback;
}

interface PopoverProps extends React.HTMLAttributes<HTMLDivElement> {
  isOpen: boolean;
  isClosing?: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  contentRef?: React.RefObject<HTMLDivElement | null>;
  portal?: boolean;
  focusOnOpen?: boolean;
  floating?: boolean;
  floatingWidth?: number;
  placement?: 'auto' | 'top' | 'bottom';
}
export function Popover({ isOpen, isClosing, onClose, triggerRef, contentRef, portal = false, focusOnOpen = false, floating = false, floatingWidth, placement = 'auto', className = '', children, style, ...props }: PopoverProps) {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const ref = contentRef ?? fallbackRef;
  const [position, setPosition] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!isOpen || !floating || !ref.current) return;
    const content = ref.current;
    content.showPopover();
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(floatingWidth ?? anchor.width, window.innerWidth - 24);
      const topInset = window.adeDesktop?.customTitleBar ? 48 : 12;
      const height = Math.min(content.scrollHeight, window.innerHeight - topInset - 12);
      const below = window.innerHeight - anchor.bottom - 12;
      const above = anchor.top - topInset;
      const flip = placement === 'top' || (placement === 'auto' && height > below && above > below);
      const maxHeight = Math.max(80, flip ? above - 6 : below - 6);
      setPosition({ position: 'fixed', inset: 'auto', margin: 0, width, maxHeight, overflowY: 'auto', boxSizing: 'border-box',
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)), top: flip ? Math.max(topInset, anchor.top - Math.min(height, maxHeight) - 6) : Math.max(topInset, anchor.bottom + 6) });
    };
    place();
    content.querySelector<HTMLElement>('input[autofocus], input')?.focus();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const resize = new ResizeObserver(place); resize.observe(content);
    return () => { resize.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); content.hidePopover(); };
  }, [isOpen, floating, floatingWidth, placement, ref, triggerRef]);
  useDismissLayer(isOpen, ref, onClose, triggerRef);
  useEffect(() => {
    if (!isOpen) return;
    const content = ref.current;
    if (focusOnOpen) content?.focus();
    return () => { if (content?.contains(document.activeElement) && triggerRef.current?.isConnected) triggerRef.current.focus(); };
  }, [isOpen, focusOnOpen, ref, triggerRef]);
  if (!isOpen) return null;
  const content = <div {...props} ref={ref} popover={floating ? 'manual' : undefined} role="dialog" tabIndex={-1} className={`${className} ${isClosing ? 'is-closing' : ''}`} style={{ ...style, ...(floating ? position : {}) }}>{children}</div>;
  return portal ? createPortal(content, popoverPortalHost(triggerRef.current, document.body)) : content;
}
