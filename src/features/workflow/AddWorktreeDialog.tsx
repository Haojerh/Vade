import React, { useEffect, useRef, useState } from 'react';
import type { CreateWorktreeRequest, Project } from '../../../shared/contracts';
import { createProjectWorktree } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { AgentPicker } from '../../components/ui/AgentPicker';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { DialogError } from '../../components/ui/DialogActions';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { Disclosure } from '../../components/ui/Disclosure';

export function AddWorktreeDialog({ project, isClosing = false, onClose, onCreated }: { project: Project; isClosing?: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'name' | 'branch' | 'pr' | 'issue'>('name');
  const [source, setSource] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [agentId, setAgentId] = useState('');
  const agentChosen = useRef(false);
  const [setup, setSetup] = useState<CreateWorktreeRequest['setup']>('inherit');
  const { catalog, defaultAgent, loading: catalogLoading, error: catalogError, refresh: refreshCatalog } = useAgentCatalog();
  useEffect(() => {
    if (agentChosen.current || !catalog) return;
    if (defaultAgent) setAgentId(defaultAgent.id);
  }, [catalog, defaultAgent]);
  const [createMore, setCreateMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      await createProjectWorktree(project.id, { name: name.trim(), ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        ...(mode !== 'name' ? { from: { kind: mode, value: source.trim() } } : {}), ...(agentId ? { agentId } : {}), setup });
      if (!active.current) return;
      onCreated();
      if (createMore) { setName(''); setSource(''); setSuccess('Worktree created'); }
      else onClose();
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { if (active.current) setBusy(false); }
  };
  return <Modal isOpen isClosing={isClosing} busy={busy} onClose={onClose} className="confirmation-dialog add-worktree-dialog" aria-labelledby="add-worktree-title">
    <form onSubmit={submit} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!busy) e.currentTarget.requestSubmit(); } }}>
      <div className="worktree-dialog-heading"><h2 id="add-worktree-title">Create worktree</h2><button type="button" className="btn-icon" aria-label="Close" disabled={busy} onClick={onClose}><Icon name="close" size={18} /></button></div>
      <label className="worktree-field">Project<input value={project.name} readOnly /></label>
      <label className="worktree-field">Run on<input value={`Local ${navigator.platform.includes('Win') ? 'Windows' : 'host'}${project.paths[0] ? ` · ${project.paths[0]}` : ''}`} readOnly /></label>
      <fieldset disabled={busy} className="worktree-create-fields">
        <label className="worktree-field">Worktree name<input autoFocus required maxLength={100} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" placeholder="e.g. fix-login" value={name} onChange={e => setName(e.target.value)} /></label>
        <div className="worktree-field"><span>Create from <span className="text-muted">(optional)</span></span>
          <div className="worktree-source-tabs" role="tablist" aria-label="Worktree source">
            {(['name', 'branch', 'pr', 'issue'] as const).map(m => <button type="button" key={m} role="tab" aria-selected={mode === m} className={`btn btn-xs ${mode === m ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setMode(m); setSource(''); }}><Icon name={({ name: 'edit', branch: 'git-branch', pr: 'git-pull-request', issue: 'circle-dot' } as const)[m]} size={13} /><span>{({ name: 'Name', branch: 'Branch', pr: 'GitHub PR', issue: 'GitHub Issue' })[m]}</span></button>)}
          </div>
          {mode !== 'name' && <input aria-label={mode === 'branch' ? 'Source branch' : 'GitHub number'} required placeholder={mode === 'branch' ? 'Branch or ref, e.g. origin/main' : 'Number, e.g. 1234'} pattern={mode === 'branch' ? undefined : '[1-9][0-9]{0,8}'} value={source} onChange={e => setSource(e.target.value)} />}
          {mode === 'name' && <span className="text-xs text-muted">Uses the repository’s default base branch.</span>}
        </div>
        <div className="worktree-field"><span>Agent <span className="text-muted">(optional)</span></span><AgentPicker agents={catalog?.installed ?? []} value={agentId} onChange={id => { agentChosen.current = true; setAgentId(id); }} disabled={busy} loading={catalogLoading} error={catalogError} onRetry={() => void refreshCatalog()} optional /></div>
        <Disclosure title="Advanced" compact><div className="worktree-advanced">
          {mode !== 'branch' && <label className="worktree-field">Base branch<input maxLength={256} placeholder="Repository default" value={baseBranch} onChange={e => setBaseBranch(e.target.value)} /></label>}
          <label className="worktree-field">Repository setup<Select value={setup} onChange={e => setSetup(e.target.value as CreateWorktreeRequest['setup'])}><option value="inherit">Use repository settings</option><option value="run">Run setup hooks</option><option value="skip">Skip setup hooks</option></Select></label>
        </div></Disclosure>
      </fieldset>
      <DialogError error={error} />
      {success && <p role="status">{success}</p>}
      <div className="worktree-create-footer"><label><input type="checkbox" checked={createMore} disabled={busy} onChange={e => setCreateMore(e.target.checked)} /> Create more</label><button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create worktree'}</button></div>
    </form>
  </Modal>;
}
