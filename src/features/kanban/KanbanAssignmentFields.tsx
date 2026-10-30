import { useEffect, useState } from 'react';
import type { Node } from '../../../shared/contracts';
import { fetchSnapshot } from '../../api/client';
import { AgentPicker } from '../../components/ui/AgentPicker';
import { Select } from '../../components/ui/Select';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { useAgentCatalog } from '../../hooks/agents/useAgentCatalog';
import type { KanbanTarget } from './kanban';

export function KanbanAssignmentFields({ projectId, mode, onModeChange, onChange, disabled }: {
  projectId: string; mode: string; onModeChange: (mode: string) => void;
  onChange: (target: KanbanTarget | undefined) => void; disabled: boolean;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [nodeId, setNodeId] = useState('');
  const [worktreeId, setWorktreeId] = useState('');
  const [agentId, setAgentId] = useState('');
  const catalog = useAgentCatalog(mode === 'new');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    fetchSnapshot(projectId, null, controller.signal).then(snapshot => {
      if (controller.signal.aborted) return;
      if (!snapshot.graph.data || snapshot.graph.meta.stale || snapshot.graph.meta.availability !== 'ready') throw new Error('Agent and worktree information is unavailable.');
      setNodes(snapshot.graph.data.nodes);
    }).catch(cause => { if (!controller.signal.aborted) { setNodes([]); setError(cause instanceof Error ? cause.message : 'Could not load agents.'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, revision]);
  useEffect(() => {
    if (agentId) return;
    const agent = catalog.defaultAgent?.provider !== 'terminal' && catalog.defaultAgent?.id !== 'terminal' ? catalog.defaultAgent
      : catalog.catalog?.installed.find(entry => entry.id !== 'terminal' && entry.provider !== 'terminal');
    if (agent) setAgentId(agent.id);
  }, [agentId, catalog.defaultAgent, catalog.catalog]);
  useEffect(() => {
    const agent = nodes.find(node => node.id === nodeId && ['agent', 'orchestrator'].includes(node.kind) && !node.workflow && !node.stale);
    const worktree = nodes.find(node => node.id === worktreeId && node.kind === 'worktree' && !node.stale);
    const provider = catalog.catalog?.installed.find(entry => entry.id === agentId && entry.id !== 'terminal' && entry.provider !== 'terminal');
    onChange(!loading && !error && mode === 'existing' && agent ? { kind: 'existing', nodeId: agent.id, label: agent.label }
      : !loading && !error && mode === 'new' && worktree && provider ? { kind: 'new', worktreeNodeId: worktree.id,
        worktreeLabel: worktree.label, agentId: provider.id, agentLabel: provider.name, command: provider.command } : undefined);
  }, [mode, nodeId, worktreeId, agentId, nodes, catalog.catalog, loading, error, onChange]);
  const agents = nodes.filter(node => ['agent', 'orchestrator'].includes(node.kind));
  const worktrees = nodes.filter(node => node.kind === 'worktree');
  return <section className="kanban-routing" aria-label="Task assignment">
    <div className="kanban-routing-heading"><div><h3>Assignment</h3><p>Choose where this task will run.</p></div>
      <button type="button" className="btn-icon" title="Refresh agents and worktrees" aria-label="Refresh agents and worktrees" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}><RefreshIcon busy={loading} size={14}/></button></div>
    <label className="worktree-field">Run with<Select value={mode} disabled={disabled} onChange={event => onModeChange(event.target.value)}>
      <option value="manual">Assign later</option><option value="existing">Existing agent</option><option value="new">New session</option>
    </Select></label>
    {mode === 'existing' && <label className="worktree-field">Agent<Select value={nodeId} disabled={disabled || loading || Boolean(error)} onChange={event => setNodeId(event.target.value)}>
      <option value="">{loading ? 'Loading agents…' : 'Select an agent'}</option>
      {agents.map(node => <option key={node.id} value={node.id} disabled={Boolean(node.workflow) || node.stale}>{node.label} · {nodes.find(tree => tree.kind === 'worktree' && tree.id === node.worktreeId)?.label || 'workspace'} · {node.workflow ? 'in workflow' : node.liveness === 'exited' ? 'stopped' : node.state}</option>)}
    </Select>{!loading && !error && !agents.length && <span className="text-xs text-muted">No agent sessions yet. Choose New session to start one.</span>}</label>}
    {mode === 'new' && <div className="kanban-routing-grid">
      <label className="worktree-field">Worktree<Select value={worktreeId} disabled={disabled || loading || Boolean(error)} onChange={event => setWorktreeId(event.target.value)}>
        <option value="">{loading ? 'Loading worktrees…' : 'Select a worktree'}</option>
        {worktrees.map(node => <option key={node.id} value={node.id} disabled={node.stale}>{node.label}{node.branch ? ` · ${node.branch}` : ''}</option>)}
      </Select>{!loading && !error && !worktrees.length && <span className="text-xs text-muted">Create a worktree in the workspace first.</span>}</label>
      <div className="worktree-field"><span>Agent</span><AgentPicker agents={catalog.catalog?.installed.filter(agent => agent.id !== 'terminal' && agent.provider !== 'terminal') ?? []} value={agentId} onChange={setAgentId} disabled={disabled} loading={catalog.loading} error={catalog.error} onRetry={() => void catalog.refresh()}/></div>
    </div>}
    {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    {mode !== 'manual' && <p className="kanban-routing-note">{mode === 'new' ? 'A session will be created when the worktree is available. Its task waits for the agent to be ready; complete any setup or trust prompts in Terminal.' : 'Tasks run in creation order when this agent is available. Busy or stopped agents keep their tasks queued.'}</p>}
  </section>;
}
