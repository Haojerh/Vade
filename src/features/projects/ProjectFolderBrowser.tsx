import { useEffect, useState } from 'react';
import type { LocalFolders } from '../../../shared/contracts';
import { fetchProjectFolders } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { DialogError } from '../../components/ui/DialogActions';

export function ProjectFolderBrowser({ initialPath, busy, onSelect }: { initialPath?: string; busy: boolean; onSelect: (path: string) => void }) {
  const [directory, setDirectory] = useState(initialPath);
  const [input, setInput] = useState(initialPath ?? '');
  const [page, setPage] = useState<LocalFolders | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setPage(null);
    void fetchProjectFolders(directory, controller.signal).then(page => {
      if (!controller.signal.aborted) { setPage(page); setInput(page.path); }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [directory, retry]);
  return <div className="project-folder-browser">
    <p className="add-project-note">Choose a local folder on the computer running Vade.</p>
    <form className="project-folder-address" onSubmit={event => { event.preventDefault(); setDirectory(input.trim()); setRetry(value => value + 1); }}>
      <input aria-label="Folder path" value={input} onChange={event => setInput(event.target.value)} placeholder="Enter a folder path" disabled={busy} autoComplete="off" spellCheck={false} />
      <button className="btn btn-secondary" disabled={busy || !input.trim()}>Go</button>
    </form>
    <div className="project-folder-toolbar">
      <button className="btn btn-secondary btn-sm" type="button" disabled={busy || loading || !page?.parent} onClick={() => setDirectory(page!.parent!)}><Icon name="arrow-up" />Up</button>
      <button className="btn btn-secondary btn-sm" type="button" disabled={busy || loading || !page} onClick={() => setDirectory(page!.home)}>Home</button>
    </div>
    <div className="project-folder-list" aria-label="Folders" aria-busy={loading}>
      {loading && <p className="add-project-note" role="status">Loading folders…</p>}
      {!loading && page?.folders.length === 0 && <p className="add-project-note">No subfolders. You can select this folder.</p>}
      {page?.folders.map(folder => <button type="button" key={folder.path} disabled={busy} className="project-folder-entry" onClick={() => setDirectory(folder.path)}>
        <Icon name="folder" size={18} /><span>{folder.name}</span><Icon name="chevron-right" size={16} />
      </button>)}
    </div>
    {page?.limited && <p className="add-project-note">Folder list limited. Enter a path above if your folder is not shown.</p>}
    <DialogError error={error} />
    {error && <button className="btn btn-secondary btn-sm" onClick={() => setRetry(value => value + 1)}>Retry</button>}
    <div className="add-project-form-actions"><button type="button" className="btn btn-primary" disabled={busy || loading || !page} onClick={() => page && onSelect(page.path)}>{busy ? 'Adding…' : 'Select folder'}</button></div>
  </div>;
}
