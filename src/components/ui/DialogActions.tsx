import type { CSSProperties, ReactNode } from 'react';

export function DialogActions({ onCancel, onConfirm, busy = false, disabled = false, confirmLabel, busyLabel = 'Processing…', cancelLabel = 'Cancel', variant = 'primary', autoFocusCancel = false, style }: {
  onCancel: () => void; onConfirm: () => void | Promise<void>; busy?: boolean; disabled?: boolean;
  confirmLabel: ReactNode; busyLabel?: ReactNode; cancelLabel?: ReactNode; variant?: 'primary' | 'danger'; autoFocusCancel?: boolean; style?: CSSProperties;
}) {
  return <div className="confirmation-dialog-actions" style={style}>
    <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy} autoFocus={autoFocusCancel}>{cancelLabel}</button>
    <button type="button" className={`btn btn-${variant}`} onClick={onConfirm} disabled={busy || disabled}>{busy ? busyLabel : confirmLabel}</button>
  </div>;
}

export function DialogError({ error, style }: { error?: string | null; style?: CSSProperties }) {
  return error ? <div className="panel-alert alert-error" style={style} role="alert">{error}</div> : null;
}
