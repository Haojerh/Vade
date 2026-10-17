import React, { useRef, useEffect } from 'react';

export interface ConfirmationDialogProps {
  isOpen: boolean;
  isClosing: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  isConfirming?: boolean;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  isOpen,
  isClosing,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  isConfirming = false,
  error = null,
  onConfirm,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // If already open or modal unsupported
      }
    } else if (!isOpen && dialog.open) {
      try {
        dialog.close();
      } catch {
        // ignore
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`node-modal-dialog confirmation-dialog ${isClosing ? 'is-closing' : ''}`}
      aria-labelledby="confirmation-dialog-title"
      aria-describedby="confirmation-dialog-desc"
      onCancel={(e) => {
        e.preventDefault();
        if (!isConfirming) {
          onClose();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isConfirming) {
          onClose();
        }
      }}
    >
      <h2 id="confirmation-dialog-title">{title}</h2>
      <div id="confirmation-dialog-desc" className="confirmation-dialog-desc">
        {description}
      </div>
      {error && (
        <div className="panel-alert alert-error" style={{ marginTop: '12px' }} role="alert">
          {error}
        </div>
      )}
      <div className="confirmation-dialog-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={isConfirming}
          autoFocus
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${confirmVariant === 'danger' ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          disabled={isConfirming}
        >
          {isConfirming ? 'Processing…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
};
