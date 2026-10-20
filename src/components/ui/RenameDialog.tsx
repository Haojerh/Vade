import { Modal } from './Modal';
import { DialogActions, DialogError } from './DialogActions';
import React, { useEffect, useState } from 'react';
import { OverlayCloseButton } from './OverlayCloseButton';

export interface RenameDialogProps {
  isOpen: boolean;
  isClosing: boolean;
  initialTitle: string;
  isRenaming?: boolean;
  error?: string | null;
  onRename: (newTitle: string) => void | Promise<void>;
  onClose: () => void;
  subject?: 'tab' | 'worktree';
}

export const RenameDialog: React.FC<RenameDialogProps> = ({
  isOpen,
  isClosing,
  initialTitle,
  isRenaming = false,
  error = null,
  onRename,
  onClose,
  subject = 'tab',
}) => {
  const [title, setTitle] = useState(initialTitle);

  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
    }
  }, [isOpen, initialTitle]);

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!isRenaming) {
      onRename(title.trim());
    }
  };

  return (
    <Modal isOpen={isOpen} isClosing={isClosing} busy={isRenaming} onClose={onClose}
      className="confirmation-dialog rename-dialog"
      aria-labelledby="rename-dialog-title">
      <div className="overlay-heading"><h2 id="rename-dialog-title">{subject === 'worktree' ? 'Rename Worktree' : 'Rename Tab Title'}</h2><OverlayCloseButton onClick={onClose} disabled={isRenaming} /></div>
      <div className="confirmation-dialog-desc">
        <p className="text-sm text-muted mb-2">
          {subject === 'worktree' ? 'Update the worktree display name. Leave empty to reset to the default name.' : 'Update the terminal tab title. Leave empty to reset to the default title.'}
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            className="w-full px-3 py-2 rounded border bg-surface-2 text-main text-sm"
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border-main)',
              background: 'var(--surface-2)',
              color: 'var(--text-main)',
              fontSize: '14px',
              boxSizing: 'border-box',
              marginTop: '8px',
            }}
            aria-label={subject === 'worktree' ? 'Worktree name' : 'Tab title'}
            placeholder={subject === 'worktree' ? 'Worktree display name' : 'Tab title (e.g. My Worker)'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isRenaming}
            maxLength={100}
            autoFocus
          />
        </form>
      </div>
      <DialogError error={error} style={{ marginTop: 12 }} />
      <DialogActions onCancel={onClose} onConfirm={handleSubmit} busy={isRenaming} confirmLabel="Save" busyLabel="Saving…" style={{ marginTop: 16 }} />
    </Modal>
  );
};
