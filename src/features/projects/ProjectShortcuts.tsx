import React, { useEffect, useRef, useState } from 'react';
import type { Node, ProjectShortcut } from '../../../shared/contracts';
import { projectShortcutsRequest, runProjectShortcutRequest } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { Popover } from '../../components/ui/Popover';
import { Select } from '../../components/ui/Select';
import { DialogActions, DialogError } from '../../components/ui/DialogActions';
import { usePopoverState } from '../../hooks/usePopoverState';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { SESSION_DRAG_TYPE, type HistoryDrag } from '../agents/historyDrag';
import { AgentPicker } from '../../components/ui/AgentPicker';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { RefreshIcon } from '../../components/ui/RefreshIcon';

export function ProjectShortcuts({ projectId, nodes, selectedNodeId, onOpen, onRefresh, onDragShortcut }: { projectId: string; nodes: Node[]; selectedNodeId: string | null; onOpen: (id: string) => void; onRefresh?: () => void; onDragShortcut?: (value: HistoryDrag | null) => void }) {
  const [shortcuts, setShortcuts] = useState<ProjectShortcut[]>([]), [draft, setDraft] = useState<ProjectShortcut | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [target, setTarget] = useState('');
  const menu = usePopoverState(), editor = useConfirmationState(), deletion = useConfirmationState<ProjectShortcut>();
  const trigger = useRef<HTMLButtonElement>(null), mounted = useRef(true);
  const { catalog, loading, error: catalogError, refresh } = useAgentCatalog();
  const trees = nodes.filter(node => node.kind === 'worktree'), selected = nodes.find(node => node.id === selectedNodeId);
  const worktree = trees.find(node => node.id === target) ?? trees.find(node => node.id === selected?.worktreeId || node.id === selectedNodeId) ?? trees[0];
  useEffect(() => { const abort = new AbortController(); mounted.current = true;
    projectShortcutsRequest<ProjectShortcut[]>(projectId, undefined, abort.signal).then(value => { if (!abort.signal.aborted) { setShortcuts(value); setLoaded(true); } }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => { mounted.current = false; abort.abort(); };
  }, [projectId]);
  function edit(value?: ProjectShortcut) {
    setError(''); setDraft(value ?? { id: crypto.randomUUID(), label: '', action: 'terminal', command: '', appendEnter: true, agent: 'codex' }); editor.open(); menu.close();
  }
  async function save(next: ProjectShortcut[]) {
    setBusy(true); setError('');
    try { const saved = await projectShortcutsRequest<ProjectShortcut[]>(projectId, next); if (mounted.current) { setShortcuts(saved); editor.close(); deletion.close(); } }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function run(value: ProjectShortcut) {
    if (!worktree || busy) return;
    setBusy(true); setError(''); menu.close();
    try { const result = await runProjectShortcutRequest(projectId, value.id, worktree.id); if (mounted.current) { if (!result.staged) setError(result.message); onRefresh?.(); onOpen(result.nodeId); } }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="project-shortcuts">
    <button ref={trigger} className="btn btn-secondary btn-xs" disabled={busy} onClick={menu.toggle} aria-expanded={menu.present} aria-haspopup="dialog"><Icon name="play" size={12} />{busy ? 'Opening…' : 'Commands'}<Icon name="chevron-down" size={12} /></button>
    <Popover isOpen={menu.present} isClosing={menu.closing} onClose={menu.close} triggerRef={trigger} floating floatingWidth={360} className="project-shortcuts-menu">
      <header className="project-shortcuts-heading"><div><strong>Run command</strong><span>Start a saved command in a worktree.</span></div></header>
      <label className="project-shortcuts-destination"><span>Worktree</span><Select aria-label="Run command in worktree" value={worktree?.id ?? ''} disabled={busy || !trees.length} onChange={event => setTarget(event.target.value)}>{trees.map(tree => <option key={tree.id} value={tree.id}>{tree.label}</option>)}</Select></label>
      <div className="project-shortcuts-section-heading"><strong>Saved commands</strong>{shortcuts.length > 0 && <span>{shortcuts.length}</span>}</div>
      {!loaded && !error && <p className="project-shortcuts-state" role="status"><RefreshIcon busy size={13} />Loading commands…</p>}
      {error && <p className="project-shortcuts-error" role="alert">{error}</p>}
      {loaded && !error && !shortcuts.length && <div className="project-shortcuts-empty"><Icon name="terminal" size={20} /><strong>No saved commands</strong><span>Add a command to run it in the selected worktree.</span></div>}
      {shortcuts.length > 0 && <div className="project-shortcut-list">
        {shortcuts.map(shortcut => <div key={shortcut.id} className="project-shortcut-row" draggable={!busy} onDragStart={event => { event.dataTransfer.setData(SESSION_DRAG_TYPE, `shortcut:${shortcut.id}`); event.dataTransfer.effectAllowed = 'copy'; onDragShortcut?.({ id: `shortcut:${shortcut.id}`, title: shortcut.label, provider: shortcut.action === 'terminal' ? 'terminal' : shortcut.agent }); }} onDragEnd={() => { onDragShortcut?.(null); menu.close(); }}>
          <button className="project-shortcut-run" aria-label={`Run ${shortcut.label} in ${worktree?.label ?? 'worktree'}`} disabled={busy || !worktree} onClick={() => void run(shortcut)}><span className="project-shortcut-play"><Icon name="play" size={12} /></span><span className="project-shortcut-copy"><strong>{shortcut.label}</strong><small>{shortcut.command}</small></span></button>
          <button className="project-shortcut-action-button" aria-label={`Edit ${shortcut.label}`} disabled={busy} onClick={() => edit(shortcut)}><Icon name="edit" size={14} /></button>
          <button className="project-shortcut-action-button text-danger" aria-label={`Remove ${shortcut.label}`} disabled={busy} onClick={() => { setError(''); deletion.open(shortcut); menu.close(); }}><Icon name="trash" size={14} /></button>
        </div>)}
      </div>}
      <button className="project-shortcut-add" disabled={!loaded || shortcuts.length >= 30} onClick={() => edit()}><Icon name="plus" size={14} /><span>{shortcuts.length >= 30 ? 'Command limit reached' : 'Add command'}</span></button>
    </Popover>
    {error && !menu.present && !editor.present && !deletion.present && <span role="alert" className="text-danger">{error}</span>}
    <Modal isOpen={editor.present} isClosing={editor.closing} busy={busy} onClose={() => { if (!busy) editor.close(); }} className="project-shortcut-editor" aria-labelledby="shortcut-editor-title">
      <h2 id="shortcut-editor-title">{shortcuts.some(row => row.id === draft?.id) ? 'Edit command' : 'Add command'}</h2>
      {draft && <><div className="project-shortcut-fields"><label>Label<input value={draft.label} placeholder={draft.action === 'terminal' ? 'e.g. Start dev server' : 'e.g. Review changes'} maxLength={80} onChange={event => setDraft({ ...draft, label: event.target.value })} autoFocus /></label><fieldset><legend>Action</legend><div className="project-shortcut-action"><SegmentedControl label="Command action" radius={6} choices={[{ value: 'terminal', label: 'Terminal' }, { value: 'agent', label: 'Agent' }]} value={draft.action} onChange={action => setDraft({ ...draft, action: action as ProjectShortcut['action'] })} /></div></fieldset></div>
      {draft.action === 'agent' && <label>Agent<AgentPicker agents={catalog?.installed.filter(agent => ['codex', 'claude', 'antigravity', 'codebuddy', 'opencode', 'opencode2', 'kilo', 'dsh'].includes(agent.id)) ?? []} value={draft.agent} loading={loading} error={catalogError} onRetry={() => void refresh()} onChange={agent => setDraft({ ...draft, agent: agent as ProjectShortcut['agent'] })} /></label>}
      <label className="project-shortcut-command">{draft.action === 'terminal' ? 'Command' : 'Prompt'}<textarea value={draft.command} placeholder={draft.action === 'terminal' ? 'e.g. npm run dev' : 'e.g. Review the current changes and suggest improvements.'} maxLength={10000} spellCheck={false} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label>
      <label className="settings-page-row"><span>Append Enter — run immediately</span><input type="checkbox" role="switch" checked={draft.appendEnter} onChange={event => setDraft({ ...draft, appendEnter: event.target.checked })} /></label>
      <p className="text-muted">Opens a new {draft.action === 'terminal' ? 'terminal' : 'agent'} in the selected worktree. Sign-in and approvals stay in Terminal.</p><DialogError error={error} /><DialogActions onCancel={editor.close} onConfirm={() => void save([...shortcuts.filter(row => row.id !== draft.id), draft])} confirmLabel={busy ? 'Saving…' : 'Save command'} busy={busy} disabled={!draft.label.trim() || !draft.command.trim()} /></>}
    </Modal>
    <Modal isOpen={deletion.present} isClosing={deletion.closing} busy={busy} onClose={() => { if (!busy) deletion.close(); }} className="confirmation-dialog" aria-labelledby="shortcut-delete-title"><h2 id="shortcut-delete-title">Remove {deletion.data?.label}?</h2><p>This removes the saved shortcut. Any terminal already running it stays open.</p><DialogError error={error} /><DialogActions onCancel={deletion.close} onConfirm={() => void save(shortcuts.filter(row => row.id !== deletion.data?.id))} confirmLabel="Remove command" variant="danger" busy={busy} autoFocusCancel /></Modal>
  </div>;
}
