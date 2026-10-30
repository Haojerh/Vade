import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { HandoffWorktree, Node, SessionHandoff } from '../../../../shared/contracts';
import { fetchHandoffWorktrees, handoffSession } from '../../../api/client';
import { dismissHandoffNotice, handoffNoticeDismissed, handoffNoticeKey } from './handoffNotices';
import { useAgentCatalog } from '../../../hooks/agents/useAgentCatalog';
import { AgentPicker } from '../../../components/ui/AgentPicker';
import { Icon } from '../../../components/ui/Icon';
import { Modal } from '../../../components/ui/Modal';
import { DialogActions, DialogError } from '../../../components/ui/DialogActions';
import { OverlayCloseButton } from '../../../components/ui/OverlayCloseButton';
import { Select } from '../../../components/ui/Select';
import { RefreshIcon } from '../../../components/ui/RefreshIcon';

export function HandoffDialog({ projectId, node, closing, onClose, onStarted }: { projectId: string; node: Node; closing: boolean; onClose: () => void; onStarted: (nodeId: string) => void }) {
  const { catalog, defaultAgent, loading, error: catalogError, refresh } = useAgentCatalog();
  const agents = catalog?.installed.filter(agent => agent.id !== 'terminal') ?? [];
  const [agentId, setAgentId] = useState(''), [context, setContext] = useState<'focused' | 'full'>('focused');
  const [worktrees, setWorktrees] = useState<HandoffWorktree[]>([]);
  const [worktreeId, setWorktreeId] = useState(node.worktreeId ?? '');
  const [worktreesLoading, setWorktreesLoading] = useState(true), [worktreesError, setWorktreesError] = useState<string | null>(null);
  const [worktreeRevision, setWorktreeRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), lock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController();
    setWorktreesLoading(true); setWorktreesError(null);
    void fetchHandoffWorktrees(projectId, node.id, abort.signal).then(rows => {
      if (abort.signal.aborted) return;
      setWorktrees(rows);
      setWorktreeId(current => rows.some(row => row.id === current) ? current : rows.find(row => row.current)?.id ?? rows.find(row => !row.locked)?.id ?? '');
    }).catch(reason => { if (!abort.signal.aborted) { setWorktrees([]); setWorktreesError(reason instanceof Error ? reason.message : 'Could not load worktrees.'); } })
      .finally(() => { if (!abort.signal.aborted) setWorktreesLoading(false); });
    return () => abort.abort();
  }, [projectId, node.id, worktreeRevision]);
  const selected = agents.find(agent => agent.id === agentId) ?? agents.find(agent => agent.id === node.agentType) ?? agents.find(agent => agent.id === defaultAgent?.id) ?? agents[0];
  const destination = worktrees.find(tree => tree.id === worktreeId);
  const sourceName = [...(catalog?.installed ?? []), ...(catalog?.available ?? [])].find(agent => agent.id === node.agentType)?.name ?? ((node.agentType?.charAt(0).toUpperCase() ?? '') + (node.agentType?.slice(1) ?? ''));
  const start = async () => {
    if (!selected || !destination || destination.locked || lock.current) return; lock.current = true; setBusy(true); setError(null);
    try {
      const response = await handoffSession(projectId, node.id, { agentId: selected.id, context, worktreeId: destination.id });
      if (mounted.current && 'nodeId' in response) { onClose(); onStarted(response.nodeId); }
    } catch (reason) { if (mounted.current) setError((reason as Error).message.replace(/^\[[A-Z_]+\]\s*/, '')); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <Modal isOpen isClosing={closing} busy={busy} onClose={onClose} className="confirmation-dialog add-agent-dialog handoff-dialog" aria-labelledby="handoff-title">
    <div className="worktree-dialog-heading"><div><h2 id="handoff-title"><MessageSquarePlus size={18} />Hand Off to Another Agent</h2><p>Start a fresh agent session from this stopping point. The original session stays unchanged.</p></div><OverlayCloseButton onClick={onClose} disabled={busy} aria-label="Close handoff" /></div>
    <div className="handoff-source"><strong>Current Session</strong><span>Original Agent: {sourceName}</span></div>
    <section className="handoff-destination" aria-labelledby="handoff-destination-title">
      <div className="handoff-destination-heading"><div><strong id="handoff-destination-title">Destination</strong><p>Choose the worktree where the new session starts.</p></div>
        <button type="button" className="btn-icon" title="Refresh worktrees" aria-label="Refresh worktrees" disabled={busy || worktreesLoading} onClick={() => setWorktreeRevision(value => value + 1)}><RefreshIcon busy={worktreesLoading} size={14}/></button></div>
      <label className="worktree-field">Worktree<Select aria-label="Destination worktree" value={worktreeId} disabled={busy || worktreesLoading || Boolean(worktreesError)} onChange={event => setWorktreeId(event.target.value)}>
        <option value="">{worktreesLoading ? 'Loading worktrees…' : 'Choose a worktree'}</option>
        {worktrees.map(tree => <option key={tree.id} value={tree.id} disabled={tree.locked}>{tree.label}{tree.current ? ' · Current' : ''}{tree.locked ? ' · Locked' : ''}</option>)}
      </Select></label>
      {destination && <div className="handoff-destination-details">
        <span><Icon name={destination.main ? 'folder' : 'git-branch'} size={13}/><strong>{destination.label}</strong>{destination.current && <em>Current checkout</em>}{destination.locked && <em className="is-locked">Locked</em>}</span>
        <span><Icon name="git-branch" size={13}/>{destination.branch ?? 'Detached checkout'}</span>
        <code title={destination.path}>{destination.path}</code>
      </div>}
      {destination?.locked && <p className="handoff-locked" role="status">This worktree is locked. Choose an unlocked worktree for the new session.</p>}
      {worktreesError && <div className="handoff-worktree-error" role="alert"><span>{worktreesError}</span><button type="button" className="btn btn-secondary btn-xs" onClick={() => setWorktreeRevision(value => value + 1)}>Retry</button></div>}
      {!worktreesLoading && !worktreesError && !worktrees.length && <p className="text-xs text-muted handoff-empty">No worktrees are available for this project.</p>}
    </section>
    <div className="worktree-field"><span>Agent</span><AgentPicker agents={agents} value={selected?.id ?? ''} onChange={setAgentId} disabled={busy} loading={loading} error={catalogError} onRetry={() => void refresh()} /></div>
    <div className="handoff-context"><label className="worktree-field">Context<Select aria-label="Handoff context" value={context} disabled={busy} onChange={event => setContext(event.target.value as 'focused' | 'full')}><option value="focused">Focused handoff (Recommended)</option><option value="full">Full session transcript</option></Select></label>
    <p className="text-xs text-muted handoff-description">{context === 'focused' ? 'Uses the latest updates and current workspace, reading older conversation details only when needed.' : 'Reads the complete public conversation before continuing. Private reasoning and tool output are excluded.'}</p></div>
    <DialogError error={error} />
    <DialogActions onCancel={onClose} onConfirm={start} busy={busy} disabled={!selected || !destination || destination.locked || loading || worktreesLoading || Boolean(worktreesError)} confirmLabel="Start New Session" busyLabel="Starting…" />
  </Modal>;
}

export function HandoffNotice({ projectId, nodeId, info, onRefresh }: { projectId: string; nodeId: string; info: SessionHandoff; onRefresh: () => void }) {
  const [result, setResult] = useState<SessionHandoff | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = result ?? info;
  const noticeKey = handoffNoticeKey(projectId, nodeId, info.sourceId);
  const [hidden] = useState(() => handoffNoticeDismissed(noticeKey));
  useEffect(() => {
    if (current.delivery !== 'uncertain' || hidden) return;
    return () => dismissHandoffNotice(noticeKey);
  }, [noticeKey, current.delivery, hidden]);
  if (current.delivery === 'submitted' || current.delivery === 'uncertain' && hidden) return null;
  const send = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { const next = await handoffSession(projectId, nodeId); if (alive.current && !('nodeId' in next)) { setResult(next); onRefresh(); } }
    catch (reason) { if (alive.current) setError((reason as Error).message.replace(/^\[[A-Z_]+\]\s*/, '')); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="panel-alert handoff-notice" role="status"><strong>{current.delivery === 'pending' ? 'Handoff context is ready' : 'Handoff delivery is uncertain'}</strong><p>{current.delivery === 'pending' ? 'Finish any sign-in or trust prompts in Terminal, then leave an empty agent prompt and send the context.' : 'Inspect Terminal before continuing. The context will not be sent again automatically.'}</p>{current.delivery === 'pending' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void send()}>{busy && <RefreshIcon busy size={13} />}Send handoff context</button>}<DialogError error={error} /></div>;
}
