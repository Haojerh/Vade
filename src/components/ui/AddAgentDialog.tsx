import { useEffect, useRef, useState } from 'react';
import { useAgentCatalog } from '../../hooks/agents/useAgentCatalog';
import { AgentPicker } from './AgentPicker';
import { DialogActions, DialogError } from './DialogActions';
import { Modal } from './Modal';
import { RefreshIcon } from './RefreshIcon';
import { Disclosure } from './Disclosure';
import { OverlayCloseButton } from './OverlayCloseButton';

export interface AddAgentDialogProps {
  isOpen: boolean;
  isClosing: boolean;
  worktreeName: string;
  isCreating?: boolean;
  error?: string | null;
  onCreate: (command: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

export function AddAgentDialog({ isOpen, isClosing, worktreeName, isCreating = false, error, onCreate, onClose }: AddAgentDialogProps) {
  const { catalog, defaultAgent, loading, error: catalogError, refresh } = useAgentCatalog(isOpen);
  const [agentId, setAgentId] = useState('');
  const [command, setCommand] = useState('');
  const [title, setTitle] = useState('');
  const manualSelection = useRef(false);
  useEffect(() => { if (isOpen) { manualSelection.current = false; setAgentId(''); setCommand(''); setTitle(''); } }, [isOpen]);
  useEffect(() => {
    if (!isOpen || manualSelection.current || !catalog) return;
    const agent = defaultAgent;
    if (agent) { setAgentId(agent.id); setCommand(agent.command); setTitle(agent.name); }
  }, [catalog, defaultAgent, isOpen]);
  const select = (id: string) => {
    manualSelection.current = true;
    const agent = catalog?.installed.find(a => a.id === id);
    if (!agent) return;
    setAgentId(id); setCommand(agent.command);
    setTitle(previous => !previous || catalog?.installed.some(a => a.name === previous) ? agent.name : previous);
  };
  const submit = () => { if (!isCreating && command.trim()) void onCreate(command.trim(), title.trim() || undefined); };
  return <Modal isOpen={isOpen} isClosing={isClosing} busy={isCreating} onClose={onClose} className="confirmation-dialog add-agent-dialog" aria-labelledby="add-agent-dialog-title">
    <div className="worktree-dialog-heading"><div><h2 id="add-agent-dialog-title">Add New Agent</h2><p className="text-sm text-muted">Start a new agent session in worktree <strong>{worktreeName}</strong>.</p></div><div className="overlay-heading-actions"><button type="button" className="btn-icon" onClick={() => void refresh()} disabled={loading || isCreating} aria-label="Refresh detected agents"><RefreshIcon busy={loading} size={14} /></button><OverlayCloseButton onClick={onClose} disabled={isCreating} aria-label="Close add agent" /></div></div>
    <div className="add-agent-dialog-scroll">
      <div className="worktree-field"><span>Agent</span><AgentPicker agents={catalog?.installed ?? []} value={agentId} onChange={select} disabled={isCreating} loading={loading || (!catalog && !catalogError)} error={catalogError} onRetry={() => void refresh()} /></div>
      <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <label className="worktree-field">Terminal Tab Title (optional)<input type="text" placeholder="e.g. Worker Tab" value={title} onChange={e => setTitle(e.target.value)} disabled={isCreating} maxLength={100} /></label>
        {catalog && catalog.runtime !== 'ade' && <Disclosure title="Advanced: command flags" compact><label className="worktree-field worktree-advanced">Command<input type="text" className="font-mono" aria-label="Agent command" value={command} onChange={e => { manualSelection.current = true; setCommand(e.target.value); }} disabled={isCreating} maxLength={200} /></label></Disclosure>}
      </form>
    </div>
    <DialogError error={error} style={{ marginTop: 22 }} />
    <DialogActions onCancel={onClose} onConfirm={submit} busy={isCreating} disabled={!command.trim()} confirmLabel="Create Agent" busyLabel="Spawning Agent…" style={{ marginTop: 30 }} />
  </Modal>;
}
