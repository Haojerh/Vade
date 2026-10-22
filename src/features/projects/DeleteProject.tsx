import { useState } from 'react';
import type { Project } from '../../../shared/contracts';
import { deleteProject } from '../../api/client';
import { Modal } from '../../components/ui/Modal';
import { DialogActions, DialogError } from '../../components/ui/DialogActions';
import { Icon } from '../../components/ui/Icon';
import { useConfirmationState } from '../../hooks/useConfirmationState';

export function DeleteProject({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const overlay = useConfirmationState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await deleteProject(project.id); overlay.close(); onDeleted(); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="btn-icon project-delete-button" aria-label={`Delete project ${project.name}`} title="Delete project"
      onClick={() => { setError(null); overlay.open(); }}><Icon name="trash" size={12} /></button>
    <Modal isOpen={overlay.present} isClosing={overlay.closing} busy={busy} onClose={overlay.close} className="confirmation-dialog" aria-label="Delete project">
      <h2>Delete project?</h2>
      <p>Remove <strong>{project.name}</strong> from Vade? Its folder, files, and Git worktrees will stay on disk.</p>
      <p>Close any agent tabs in this project first.</p>
      <DialogError error={error} />
      <DialogActions onCancel={overlay.close} onConfirm={confirm} busy={busy} confirmLabel="Delete project" busyLabel="Deleting…" variant="danger" autoFocusCancel />
    </Modal>
  </>;
}
