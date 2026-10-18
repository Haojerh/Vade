import React, { useEffect, useRef } from 'react';

interface ModalProps extends Omit<React.DialogHTMLAttributes<HTMLDialogElement>, 'open' | 'onClose'> {
  isOpen: boolean;
  isClosing?: boolean;
  busy?: boolean;
  onClose: () => void;
}

/** Native top-layer modal. Callers keep it mounted during the shared exit phase. */
export function Modal({ isOpen, isClosing = false, busy = false, onClose, className = '', children, onClick, onCancel, ...props }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected && !opener.closest('dialog:not([open])')) opener.focus();
      else document.querySelector<HTMLElement>('.dashboard-topbar button, .dashboard-topbar select')?.focus();
    };
  }, [isOpen]);
  if (!isOpen) return null;
  return <dialog {...props} ref={ref} className={`node-modal-dialog ${className} ${isClosing ? 'is-closing' : ''}`}
    onCancel={event => { onCancel?.(event); event.preventDefault(); if (!busy && !isClosing) onClose(); }}
    onClick={event => { onClick?.(event); if (event.target === event.currentTarget && !event.defaultPrevented && !busy && !isClosing) onClose(); }}>
    {children}
  </dialog>;
}
