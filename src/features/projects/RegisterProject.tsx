import { useEffect, useRef, useState } from 'react';
import type { RegisterProjectRequest } from '../../../shared/contracts';
import { registerProject } from '../../api/client';
import { DialogError } from '../../components/ui/DialogActions';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Icon } from '../../components/ui/Icon';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { ProjectFolderBrowser } from './ProjectFolderBrowser';

type Mode = 'choose' | 'browse' | 'clone' | 'create';

export function RegisterProject({ onRegistered }: { onRegistered: (id: string) => void }) {
  const overlay = useConfirmationState();
  const [mode, setMode] = useState<Mode>('choose');
  const [browseFor, setBrowseFor] = useState<'add' | 'clone' | 'create'>('add');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; request.current?.abort(); }; }, []);
  const add = async (value: RegisterProjectRequest) => {
    if (busy) return;
    setBusy(true); setError(null);
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await registerProject(value, controller.signal);
      if (!controller.signal.aborted && active.current) { onRegistered(result.project.id); overlay.close(); }
    } catch (error) { if (!controller.signal.aborted && active.current) setError((error as Error).message); }
    finally { if (!controller.signal.aborted && active.current) setBusy(false); }
  };
  const chooseFolder = async (purpose: 'add' | 'clone' | 'create') => {
    setError(null); setBrowseFor(purpose);
    if (!window.adeDesktop) { setMode('browse'); return; }
    setBusy(true);
    let selected: string | null = null;
    try { selected = await window.adeDesktop.chooseFolder(); }
    catch { if (active.current) setError('The folder picker could not open. Try again.'); }
    finally { if (active.current) setBusy(false); }
    if (!active.current || !selected) return;
    if (purpose === 'add') await add({ path: selected });
    else setPath(selected);
  };
  const title = mode === 'clone' ? 'Clone from URL' : mode === 'create' ? 'Create new project' : mode === 'browse' ? 'Browse folder' : 'Add a project';
  const host = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform) ? 'Local Windows'
    : typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'Local macOS' : 'Local computer';
  return <>
    <button type="button" className="btn-icon project-add-button" aria-label="Add a project" title="Add a project"
      aria-haspopup="dialog" aria-expanded={overlay.present && !overlay.closing}
      onClick={() => { setMode('choose'); setPath(''); setName(''); setUrl(''); setError(null); overlay.open(); }}><Icon name="plus" size={16} /></button>
    <Modal isOpen={overlay.present} isClosing={overlay.closing} busy={busy} onClose={overlay.close}
      className="add-project-dialog" aria-labelledby="add-project-title">
      <div className="add-project-heading">
        <div>{mode !== 'choose' && <button type="button" className="add-project-back" disabled={busy} onClick={() => { setError(null); setMode(mode === 'browse' && browseFor !== 'add' ? browseFor : 'choose'); }}><Icon name="chevron-left" size={16} />Back</button>}
          <h2 id="add-project-title">{title}</h2></div>
        <OverlayCloseButton onClick={overlay.close} disabled={busy} aria-label="Close add project" />
      </div>
      <div className="add-project-host"><label htmlFor="project-host">Host</label><Select id="project-host" value="local" aria-label="Project host"><option value="local">{host}</option></Select></div>
      {mode === 'choose' && <div className="add-project-choices">
        <button type="button" className="add-project-browse" disabled={busy} onClick={() => void chooseFolder('add')}>
          <span className="add-project-folder-icon"><Icon name="folder" size={21} /></span>
          <span><strong>{busy ? 'Opening folder…' : 'Browse folder'}</strong><span>Local project, Git repo, or folder with many repos</span></span>
          <Icon name="chevron-right" size={18} />
        </button>
        <h3>Other ways to add</h3>
        <div className="add-project-other">
          <button type="button" disabled={busy} onClick={() => { setError(null); setMode('clone'); }}><Icon name="globe" size={21} /><span><strong>Clone from URL</strong><span>Clone a remote Git repository</span></span></button>
          <button type="button" disabled={busy} onClick={() => { setError(null); setMode('create'); }}><Icon name="plus" size={21} /><span><strong>Create new project</strong><span>Start from an empty folder</span></span></button>
        </div>
      </div>}
      {mode === 'browse' && <ProjectFolderBrowser initialPath={path || undefined} busy={busy} onSelect={selected => {
        if (browseFor === 'add') void add({ path: selected });
        else { setPath(selected); setMode(browseFor); setError(null); }
      }} />}
      {(mode === 'clone' || mode === 'create') && <form className="add-project-form" onSubmit={event => {
        event.preventDefault();
        if (mode === 'clone') void add({ mode: 'clone', path: path.trim(), name: name.trim(), url: url.trim() });
        else void add({ mode: 'create', path: path.trim(), name: name.trim() });
      }}>
        <fieldset disabled={busy || overlay.closing}>
          {mode === 'clone' && <label className="worktree-field">Repository URL<input type="url" required value={url} maxLength={2048} placeholder="https://github.com/owner/repository.git" autoComplete="off" spellCheck={false}
            onChange={event => setUrl(event.target.value)} onBlur={() => { if (!name) setName(url.trim().replace(/\/$/, '').split('/').pop()?.replace(/\.git$/, '') ?? ''); }} /></label>}
          <label className="worktree-field">Project name<input required value={name} maxLength={100} placeholder="my-project" onChange={event => setName(event.target.value)} autoComplete="off" /></label>
          <label className="worktree-field">Parent folder<div className="add-project-destination"><input required value={path} maxLength={4096} placeholder="Choose where to put the project" onChange={event => setPath(event.target.value)} spellCheck={false} /><button className="btn btn-secondary" type="button" onClick={() => void chooseFolder(mode)}>Browse</button></div></label>
          <p className="add-project-note">{mode === 'clone' ? 'Use an HTTPS Git URL. Private repositories use your existing local Git authentication.' : 'Creates a new folder and initializes a Git repository. Existing folders are never overwritten.'}</p>
          <div className="add-project-form-actions"><button className="btn btn-primary" disabled={!path.trim() || !name.trim() || (mode === 'clone' && !url.trim())}>{busy ? mode === 'clone' ? 'Cloning…' : 'Creating…' : mode === 'clone' ? 'Clone repository' : 'Create project'}</button></div>
        </fieldset>
      </form>}
      <DialogError error={error} />
    </Modal>
  </>;
}
