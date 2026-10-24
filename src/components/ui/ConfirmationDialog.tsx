import { Modal } from './Modal';
import { DialogActions, DialogError } from './DialogActions';
import React from 'react';
import { OverlayCloseButton } from './OverlayCloseButton';

export interface ConfirmationDialogProps {
  isOpen: boolean;
  isClosing: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'danger' | 'primary';
  isConfirming?: boolean;
  confirmDisabled?: boolean;
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
  confirmDisabled = false,
  error = null,
  onConfirm,
  onClose,
}) => {

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} isClosing={isClosing} busy={isConfirming} onClose={onClose}
      className="confirmation-dialog"
      aria-labelledby="confirmation-dialog-title"
      aria-describedby="confirmation-dialog-desc">
      <div className="overlay-heading"><h2 id="confirmation-dialog-title">{title}</h2><OverlayCloseButton onClick={onClose} disabled={isConfirming} /></div>
      <div id="confirmation-dialog-desc" className="confirmation-dialog-desc">
        {description}
      </div>
      <DialogError error={error} style={{ marginTop: 12 }} />
      <DialogActions onCancel={onClose} onConfirm={onConfirm} busy={isConfirming} disabled={confirmDisabled} confirmLabel={confirmLabel} cancelLabel={cancelLabel} variant={confirmVariant} autoFocusCancel />
    </Modal>
  );
};
