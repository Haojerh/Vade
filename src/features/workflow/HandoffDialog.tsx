import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { Node, SessionHandoff } from '../../../shared/contracts';
import { handoffSession } from '../../api/client';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { AgentPicker } from '../../components/ui/AgentPicker';
import { Modal } from '../../components/ui/Modal';
import { DialogActions, DialogError } from '../../components/ui/DialogActions';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { Select } from '../../components/ui/Select';
import { RefreshIcon } from '../../components/ui/RefreshIcon';

export function HandoffDialog({ projectId, node, closing, onClose, onStarted }: { projectId: string; node: Node; closing: boolean; onClose: () => void; onStarted: (nodeId: string) => void }) {
  const { catalog, defaultAgent, loading, error: catalogError, refresh } = useAgentCatalog();
  const agents = catalog?.installed.filter(agent => agent.id !== 'terminal') ?? [];
  const [agentId, setAgentId] = useState(''), [context, setContext] = useState<'focused' | 'full'>('focused');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), lock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = agents.find(agent => agent.id === agentId) ?? agents.find(agent => agent.id === node.agentType) ?? agents.find(agent => agent.id === defaultAgent?.id) ?? agents[0];
  const sourceName = [...(catalog?.installed ?? []), ...(catalog?.available ?? [])].find(agent => agent.id === node.agentType)?.name ?? ((node.agentType?.charAt(0).toUpperCase() ?? '') + (node.agentType?.slice(1) ?? ''));
  const start = async () => {
    if (!selected || lock.current) return; lock.current = true; setBusy(true); setError(null);
    try {
      const response = await handoffSession(projectId, node.id, { agentId: selected.id, context });
      if (mounted.current && 'nodeId' in response) { onClose(); onStarted(response.nodeId); }
    } catch (reason) { if (mounted.current) setError((reason as Error).message.replace(/^\[[A-Z_]+\]\s*/, '')); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal isOpen isClosing={closing} busy={busy} onClose={onClose} className="confirmation-dialog add-agent-dialog handoff-dialog" aria-labelledby="handoff-title">
    <div className="worktree-dialog-heading"><div><h2 id="handoff-title"><MessageSquarePlus size={18} />Hand Off to Another Agent</h2><p>Start a fresh agent session from this stopping point. The original session stays unchanged.</p></div><OverlayCloseButton onClick={onClose} disabled={busy} aria-label="Close handoff" /></div>
    <div className="handoff-source"><strong>Current Session</strong><span>Original Agent: {sourceName}</span></div>
    <div className="worktree-field"><span>Agent</span><AgentPicker agents={agents} value={selected?.id ?? ''} onChange={setAgentId} disabled={busy} loading={loading} error={catalogError} onRetry={() => void refresh()} /></div>
    <div className="handoff-context"><label className="worktree-field">Context<Select aria-label="Handoff context" value={context} disabled={busy} onChange={event => setContext(event.target.value as 'focused' | 'full')}><option value="focused">Focused handoff (Recommended)</option><option value="full">Full session transcript</option></Select></label>
    <p className="text-xs text-muted handoff-description">{context === 'focused' ? 'Uses the latest updates and current workspace, reading older conversation details only when needed.' : 'Reads the complete public conversation before continuing. Private reasoning and tool output are excluded.'}</p></div>
    <p className="text-xs text-muted handoff-location">Starts in: <span className="handoff-path">{node.path}</span></p>
    <DialogError error={error} />
    <DialogActions onCancel={onClose} onConfirm={start} busy={busy} disabled={!selected || loading} confirmLabel="Start New Session" busyLabel="Starting…" />
  </Modal>;
}

export function HandoffNotice({ projectId, nodeId, info, onRefresh }: { projectId: string; nodeId: string; info: SessionHandoff; onRefresh: () => void }) {
  const [result, setResult] = useState<SessionHandoff | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = result ?? info;
  if (current.delivery === 'submitted') return null;
  const send = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { const next = await handoffSession(projectId, nodeId); if (alive.current && !('nodeId' in next)) { setResult(next); onRefresh(); } }
    catch (reason) { if (alive.current) setError((reason as Error).message.replace(/^\[[A-Z_]+\]\s*/, '')); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="panel-alert handoff-notice" role="status"><strong>{current.delivery === 'pending' ? 'Handoff context is ready' : 'Handoff delivery is uncertain'}</strong><p>{current.delivery === 'pending' ? 'Finish any sign-in or trust prompts in Terminal, then leave an empty agent prompt and send the context.' : 'Inspect Terminal before continuing. The context will not be sent again automatically.'}</p>{current.delivery === 'pending' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void send()}>{busy && <RefreshIcon busy size={13} />}Send handoff context</button>}<DialogError error={error} /></div>;
}
