import React, { useRef, useEffect, useState } from 'react';

export interface RenameDialogProps {
  isOpen: boolean;
  isClosing: boolean;
  initialTitle: string;
  isRenaming?: boolean;
  error?: string | null;
  onRename: (newTitle: string) => void | Promise<void>;
  onClose: () => void;
}

export const RenameDialog: React.FC<RenameDialogProps> = ({
  isOpen,
  isClosing,
  initialTitle,
  isRenaming = false,
  error = null,
  onRename,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(initialTitle);

  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
    }
  }, [isOpen, initialTitle]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Modal unsupported or already open
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

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!isRenaming) {
      onRename(title.trim());
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={`node-modal-dialog confirmation-dialog rename-dialog ${isClosing ? 'is-closing' : ''}`}
      aria-labelledby="rename-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!isRenaming) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isRenaming) {
          onClose();
        }
      }}
    >
      <h2 id="rename-dialog-title">Rename Tab Title</h2>
      <div className="confirmation-dialog-desc">
        <p className="text-sm text-muted mb-2">
          Update the terminal tab title. Leave empty to reset to the default title.
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
            placeholder="Tab title (e.g. My Worker)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isRenaming}
            maxLength={100}
            autoFocus
          />
        </form>
      </div>
      {error && (
        <div className="panel-alert alert-error" style={{ marginTop: '12px' }} role="alert">
          {error}
        </div>
      )}
      <div className="confirmation-dialog-actions" style={{ marginTop: '16px' }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={isRenaming}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => handleSubmit()}
          disabled={isRenaming}
        >
          {isRenaming ? 'Saving…' : 'Save'}
        </button>
      </div>
    </dialog>
  );
};
