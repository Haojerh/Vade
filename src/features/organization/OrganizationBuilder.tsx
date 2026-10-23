import { Disclosure } from '../../components/ui/Disclosure';
import React, { useEffect, useRef, useState } from 'react';
import type { OrganizationConfig, OrganizationNode, WorkflowModel, WorkflowProvider, WorkflowRun, WorkflowSetupStatus } from '../../../shared/contracts';
import { cancelWorkflowRun, fetchOrganization, fetchWorkflowModels, fetchWorkflowRuns, fetchWorkflowSetup, saveOrganization } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { Select } from '../../components/ui/Select';
import { WorkflowModelPicker } from './WorkflowModelPicker';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { useAgentCatalog } from '../../hooks/useAgentCatalog';
import { workflowEdgePath } from '../workflow/WorkflowEdgesSvg';
import { clampWorkflowZoom, zoomScrollOffset } from '../workflow/workflowZoom';
import { bindWorkflowPinch } from '../workflow/workflowTouch';
import { AgentPicker } from '../../components/ui/AgentPicker';
import { Modal } from '../../components/ui/Modal';
import { DialogActions } from '../../components/ui/DialogActions';
import { useConfirmationState } from '../../hooks/useConfirmationState';

const labels: Record<WorkflowProvider, string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', codebuddy: 'CodeBuddy', opencode: 'OpenCode', opencode2: 'OpenCode 2', kilo: 'Kilo Code' };
function cycle(config: OrganizationConfig, source: string, target: string): boolean {
  const visited = new Set<string>();
  const visit = (id: string): boolean => id === source || (!visited.has(id) && (visited.add(id), config.edges.filter(edge => edge.source === id).some(edge => visit(edge.target))));
  return visit(target);
}

function NodeEditor({ node, onChange, onRemove }: { node: OrganizationNode; onChange: (patch: Partial<OrganizationNode>) => void; onRemove: () => void }) {
  const [models, setModels] = useState<WorkflowModel[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const { catalog, loading: detecting, error: detectionError, refresh } = useAgentCatalog();
  const deletion = useConfirmationState();
  useEffect(() => {
    const controller = new AbortController(); setModels([]); setLoading(true); setError(null);
    fetchWorkflowModels(node.provider, controller.signal).then(value => { if (!controller.signal.aborted) setModels(value); }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [node.provider, revision]);
  const model = models.find(model => model.id === node.model);
  return <aside className="organization-inspector" aria-label="Node configuration"><div className="organization-inspector-heading"><h3>Node configuration</h3><button className="btn btn-icon organization-delete" title="Remove node and its connections" aria-label="Remove node and its connections" onClick={() => deletion.open()}><Icon name="trash" size={16} /></button></div>
    <label>Title<input value={node.title} aria-invalid={!node.title.trim()} maxLength={100} onChange={event => onChange({ title: event.target.value })} />{!node.title.trim() && <small className="organization-error">Enter a node title to save this change.</small>}</label>
    <label>Prompt / Role<textarea value={node.prompt} aria-invalid={!node.prompt.trim()} maxLength={4000} rows={5} onChange={event => onChange({ prompt: event.target.value })} placeholder="Responsibilities and acceptance criteria" />{!node.prompt.trim() && <small className="organization-error">Enter a role to save this change.</small>}</label>
    <div className="organization-provider-field"><span>Agent provider</span><AgentPicker agents={catalog?.installed.filter(agent => agent.id in labels) ?? []} value={node.provider} loading={detecting} error={detectionError} onRetry={() => void refresh()} onChange={provider => onChange({ provider: provider as WorkflowProvider, model: null, effort: null })} /></div>
    <label>Model<WorkflowModelPicker key={node.provider} models={models} value={node.model ?? ''} disabled={loading} onChange={value => onChange({ model: value || null, effort: null })} /></label>
    {node.provider !== 'antigravity' && <label>Effort / Thinking<Select value={node.effort ?? ''} disabled={!model?.efforts.length} onChange={event => onChange({ effort: event.target.value || null })}><option value="">Provider default</option>{model?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</Select></label>}
    <p className="organization-note">{loading ? 'Reading provider model catalog…' : model && !model.efforts.length ? 'This model exposes no separate effort control. Model variants may include thinking levels.' : 'Selections apply when this node launches; live agent metadata shows observed settings.'}</p>
    {error && <div className="organization-note" role="status">{error} <button className="btn btn-secondary btn-xs" onClick={() => setRevision(value => value + 1)}>Retry catalog</button></div>}
    <Modal isOpen={deletion.present} isClosing={deletion.closing} onClose={deletion.close} className="confirmation-dialog" aria-labelledby="remove-organization-node"><h2 id="remove-organization-node">Remove {node.title || 'this node'}?</h2><p>Its role and all connected dependencies will be removed from this workflow. Active runs keep their saved graph.</p><DialogActions onCancel={deletion.close} onConfirm={onRemove} confirmLabel="Remove node" variant="danger" autoFocusCancel /></Modal>
  </aside>;
}

function IsolationPreview() {
  return <section className="organization-isolation-preview" aria-label="How isolated worktrees work"><h3>Independent work, safely integrated</h3><p>The orchestrator splits work only when two or more features can proceed independently.</p><div className="organization-isolation-flow"><div><Icon name="folder" size={19} /><strong>Main repository</strong><span>Your starting checkout</span></div><Icon name="chevron-right" size={16} /><div className="organization-isolation-branches"><div><Icon name="git-branch" size={17} /><span>Feature A <small>Isolated worktree + agents</small></span></div><div><Icon name="git-branch" size={17} /><span>Feature B <small>Isolated worktree + agents</small></span></div></div><Icon name="chevron-right" size={16} /><div><Icon name="workflow" size={19} /><strong>Integrate results</strong><span>Review, merge, return to main</span></div></div><p className="organization-isolation-footnote">Dependent work stays sequential. Conflicts pause integration and preserve your files.</p></section>;
}

export function OrganizationBuilder() {
  const [config, setConfig] = useState<OrganizationConfig | null>(null), [saved, setSaved] = useState(''), [setup, setSetup] = useState<WorkflowSetupStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [connecting, setConnecting] = useState<string | null>(null), [target, setTarget] = useState('');
  const [source, setSource] = useState(''), [connectionError, setConnectionError] = useState<string | null>(null), [saveError, setSaveError] = useState<string | null>(null), [saveRetry, setSaveRetry] = useState(0);
  const [error, setError] = useState<string | null>(null), [zoom, setZoom] = useState(1), [preview, setPreview] = useState(false), [reload, setReload] = useState(0);
  const saving = useRef(false), mounted = useRef(true), pendingWrite = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef({ config, ready: Boolean(setup?.ready) }), persisted = useRef(saved);
  latest.current = { config, ready: Boolean(setup?.ready) };
  persisted.current = saved;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const { config: value, ready } = latest.current;
      if (!ready || !value || value.nodes.some(node => !node.title.trim() || !node.prompt.trim())) return;
      const payload = { ...value, enabled: value.enabled && value.nodes.length > 0 }, serialized = JSON.stringify(payload);
      // Flush the latest edit after an in-flight save, without replaying an older graph.
      void pendingWrite.current.then(async () => { if (serialized !== persisted.current) await saveOrganization(payload); }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!config || !setup?.ready || saving.current || config.nodes.some(node => !node.title.trim() || !node.prompt.trim())) return;
    const payload = { ...config, enabled: config.enabled && config.nodes.length > 0 }, serialized = JSON.stringify(payload);
    if (serialized === saved) return;
    const timer = setTimeout(() => {
      saving.current = true;
      pendingWrite.current = saveOrganization(payload).then(next => { saving.current = false; persisted.current = JSON.stringify(next); if (mounted.current) { setSaved(persisted.current); setSaveError(null); } }).catch(error => { saving.current = false; if (mounted.current) setSaveError((error as Error).message); });
    }, 450);
    return () => clearTimeout(timer);
  }, [config, saved, setup?.ready, saveRetry]);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ id?: string; pointer: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const { defaultAgent, catalog: agentCatalog } = useAgentCatalog();
  const providers = agentCatalog?.installed.filter(agent => agent.id in labels) ?? [];
  const gesture = useRef({ zoom, changeZoom: (value: number, point: { x: number; y: number }) => changeZoom(value, point.x, point.y) });
  gesture.current = { zoom, changeZoom: (value, point) => changeZoom(value, point.x, point.y) };
  useEffect(() => {
    const view = viewport.current; if (!view) return;
    const releasePinch = bindWorkflowPinch(view, () => gesture.current.zoom, (value, point) => gesture.current.changeZoom(value, point), () => { drag.current = null; });
    const wheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); const rect = view.getBoundingClientRect(); gesture.current.changeZoom(gesture.current.zoom * Math.exp(-event.deltaY * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top }); };
    view.addEventListener('wheel', wheel, { passive: false });
    return () => { releasePinch(); view.removeEventListener('wheel', wheel); };
  }, [Boolean(config?.enabled)]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetchOrganization(controller.signal), fetchWorkflowSetup(controller.signal)]).then(([value, status]) => { if (!controller.signal.aborted) { setConfig(value); setSaved(JSON.stringify(value)); setSetup(status); setError(null); } }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [reload]);
  function update(patch: Partial<OrganizationConfig>) { setConfig(value => value ? { ...value, ...patch } : value); }
  function patchNode(id: string, patch: Partial<OrganizationNode>) { setConfig(value => value ? id === '__orchestrator__' ? { ...value, orchestratorPosition: { x: patch.x ?? value.orchestratorPosition?.x ?? 36, y: patch.y ?? value.orchestratorPosition?.y ?? 32 } } : { ...value, nodes: value.nodes.map(node => node.id === id ? { ...node, ...patch } : node) } : value); }
  function addNode() {
    if (!config || config.nodes.length >= 24 || !providers.length) return;
    const id = crypto.randomUUID(), provider = defaultAgent && providers.some(agent => agent.id === defaultAgent.id) ? defaultAgent.id as WorkflowProvider : providers[0].id as WorkflowProvider;
    update({ nodes: [...config.nodes, { id, title: 'New agent', prompt: 'Describe this agent’s role and responsibilities.', provider, model: null, effort: null, x: 330 + (config.nodes.length % 3) * 280, y: 180 + Math.floor(config.nodes.length / 3) * 160 }] }); setSelected(id);
  }
  function connect(source: string, destination: string) {
    if (!config) return;
    if (!config.nodes.some(node => node.id === destination) || (source !== '__orchestrator__' && !config.nodes.some(node => node.id === source))) { setConnectionError('Choose existing predecessor and successor nodes.'); return; }
    if (source === '__orchestrator__') {
      if (config.edges.some(edge => edge.target === destination)) { setConnectionError('Remove this node’s existing predecessors before connecting it directly to the orchestrator.'); return; }
      setConnecting(null); setSource(''); setTarget(''); setConnectionError(null); return;
    }
    if (source === destination || config.edges.some(edge => edge.source === source && edge.target === destination)) { setConnectionError('Choose two different nodes without an existing connection.'); return; }
    if (cycle(config, source, destination)) { setConnectionError('That connection would create a cycle. Dependencies must flow forward.'); return; }
    update({ edges: [...config.edges, { source, target: destination }] }); setConnecting(null); setSource(''); setTarget(''); setConnectionError(null);
  }
  function changeZoom(next: number, x?: number, y?: number) {
    next = clampWorkflowZoom(next); const view = viewport.current;
    if (view) { const left = zoomScrollOffset(view.scrollLeft, x ?? view.clientWidth / 2, zoom, next), top = zoomScrollOffset(view.scrollTop, y ?? view.clientHeight / 2, zoom, next); requestAnimationFrame(() => { view.scrollLeft = left; view.scrollTop = top; }); }
    setZoom(next);
  }
  function beginDrag(event: React.PointerEvent, id: string, position: { x: number; y: number }) {
    if (event.button !== 0) return;
    event.stopPropagation(); setSelected(id);
    drag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: position.x, startY: position.y };
    viewport.current?.setPointerCapture(event.pointerId);
  }
  const node = config?.nodes.find(node => node.id === selected);
  const orchestratorBox = { x: config?.orchestratorPosition?.x ?? 36, y: config?.orchestratorPosition?.y ?? 32, width: 220, height: 104 };
  const width = Math.max(1000, orchestratorBox.x + 360, ...(config?.nodes.map(node => node.x + 360) ?? [])), height = Math.max(650, orchestratorBox.y + 260, ...(config?.nodes.map(node => node.y + 260) ?? []));
  if (setup && !setup.ready) return <section className="organization-setup-required"><Icon name="download" size={28} /><h2>Set up workflow components</h2><p>Install and verify the Vade CLI and orchestration skill before opening the workflow builder.</p><a className="btn btn-primary" href="#/settings/setup">Open Installation / Setup<Icon name="chevron-right" size={15} /></a></section>;
  return <div className="organization-settings">
    {error && <p className="organization-error" role="alert">{error}{!config && <button className="btn btn-secondary" onClick={() => setReload(value => value + 1)}>Retry</button>}</p>}
    {!config ? <p>Loading workflow configuration…</p> : <>
      <section className="settings-preferences" aria-label="Workflow preferences"><label className="settings-page-row"><div><span className="settings-page-label">Enable Workflow / Organization</span><p>Every task submitted through Native Chat, a card composer, or Kanban starts this workflow. The contacted agent coordinates the run.</p></div><input type="checkbox" role="switch" checked={config.enabled} disabled={!setup?.ready && !config.enabled} onChange={event => { update({ enabled: event.target.checked, ...(!event.target.checked ? { isolatedWorktrees: false } : {}) }); if (!event.target.checked) setPreview(false); }} /></label>
      <div className={`settings-page-row organization-isolation-setting${!config.enabled ? ' organization-disabled' : ''}`}><div><label className="settings-page-label" htmlFor="workflow-isolation">Isolated Worktrees</label><p>Run independent workstreams in separate branches before integrating their results.</p></div><input id="workflow-isolation" type="checkbox" role="switch" checked={config.enabled && config.isolatedWorktrees} disabled={!config.enabled} onChange={event => { update({ isolatedWorktrees: event.target.checked }); if (!event.target.checked) setPreview(false); }} />
      {config.enabled && config.isolatedWorktrees && <Disclosure title="How it works" compact open={preview} onOpenChange={setPreview} className="organization-isolation-disclosure"><IsolationPreview /></Disclosure>}</div></section>
      {saveError && <p className="organization-error" role="alert">Could not save workflow changes: {saveError} <button className="btn btn-secondary btn-xs" onClick={() => setSaveRetry(value => value + 1)}>Retry</button></p>}
      {!setup?.ready && <p className="organization-note">Install and verify the required components in <a href="#/settings/setup">Installation / Setup</a> before enabling.</p>}
      {config.enabled && <>
      <div className="organization-toolbar"><div><h2>Execution graph</h2><p>The contacted agent is the orchestrator. Connect a predecessor’s output to its successor’s input.</p></div><button className="btn btn-secondary" onClick={addNode} disabled={config.nodes.length >= 24 || !providers.length}><Icon name="plus" size={14} />Add node</button></div>
      <div className="organization-builder">
        <div className="organization-canvas-wrap"><div ref={viewport} className="organization-canvas" aria-label="Workflow canvas. Drag nodes or empty space to pan. Use the zoom controls."
          onPointerDown={event => { if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return; const view = viewport.current!; drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: view.scrollLeft, startY: view.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { const active = drag.current; if (!active || active.pointer !== event.pointerId) return; if (active.id) patchNode(active.id, { x: Math.max(0, Math.min(10000, active.startX + (event.clientX - active.x) / zoom)), y: Math.max(0, Math.min(10000, active.startY + (event.clientY - active.y) / zoom)) }); else { event.currentTarget.scrollLeft = active.startX - event.clientX + active.x; event.currentTarget.scrollTop = active.startY - event.clientY + active.y; } }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <div style={{ width: width * zoom, height: height * zoom }}><div className="organization-canvas-world" style={{ width, height, transform: `scale(${zoom})` }}>
            <svg className="organization-edges" width={width} height={height} aria-label="Dependency connections"><defs><marker id="organization-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>{config.nodes.filter(node => !config.edges.some(edge => edge.target === node.id)).map(node => <path key={`orchestrator-${node.id}`} d={workflowEdgePath(orchestratorBox, { ...node, width: 220, height: 104 })} markerEnd="url(#organization-arrow)" />)}{config.edges.map(edge => { const source = config.nodes.find(node => node.id === edge.source), target = config.nodes.find(node => node.id === edge.target); return source && target && <path key={`${edge.source}:${edge.target}`} d={workflowEdgePath({ ...source, width: 220, height: 104 }, { ...target, width: 220, height: 104 })} markerEnd="url(#organization-arrow)" />; })}</svg>
            {config.nodes.length > 0 && <div className={`organization-node organization-orchestrator${selected === '__orchestrator__' ? ' is-selected' : ''}`} style={{ left: orchestratorBox.x, top: orchestratorBox.y }}><button className="organization-node-body" onClick={() => setSelected('__orchestrator__')} onPointerDown={event => beginDrag(event, '__orchestrator__', orchestratorBox)} onKeyDown={event => { const movement: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }; if (movement[event.key]) { event.preventDefault(); const [x, y] = movement[event.key]; patchNode('__orchestrator__', { x: Math.max(0, Math.min(10000, orchestratorBox.x + x)), y: Math.max(0, Math.min(10000, orchestratorBox.y + y)) }); } }} aria-label="Orchestrator: agent receiving the initial message. Drag to reposition; cannot be deleted."><span><Icon name="message-square" size={20} /><strong>Orchestrator</strong></span><small>Agent initiated message</small><p>Coordinates every workflow run</p></button><button className="organization-port organization-output" aria-label="Connect from Orchestrator" onClick={() => { setConnecting('__orchestrator__'); setConnectionError(null); }} /></div>}
            {config.nodes.map(item => <div key={item.id} className={`organization-node${selected === item.id ? ' is-selected' : ''}`} style={{ left: item.x, top: item.y }}>
              <button className="organization-port organization-input" aria-label={`Connect to ${item.title}`} title="Input: wait for predecessors" onClick={() => { if (connecting) connect(connecting, item.id); else setSelected(item.id); }} />
              <button className="organization-node-body" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)} onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); setSelected(item.id); drag.current = { id: item.id, pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: item.x, startY: item.y }; viewport.current?.setPointerCapture(event.pointerId); }} onKeyDown={event => { const movement: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }; if (movement[event.key]) { event.preventDefault(); const [x, y] = movement[event.key]; patchNode(item.id, { x: Math.max(0, Math.min(10000, item.x + x)), y: Math.max(0, Math.min(10000, item.y + y)) }); } }}><span><ProviderIcon provider={item.provider} size={20} /><strong>{item.title || 'Untitled agent'}</strong></span><small className="organization-node-model"><span>{item.model ?? labels[item.provider]}</span>{item.provider !== 'antigravity' && <span className="organization-effort" title="Configured effort">{item.effort ?? 'default'}</span>}</small><p>{item.prompt}</p></button>
              <button className={`organization-port organization-output${connecting === item.id ? ' is-connecting' : ''}`} aria-label={`Connect from ${item.title}`} title="Output: start a dependent node" onClick={() => { setConnecting(connecting === item.id ? null : item.id); setConnectionError(null); }} />
            </div>)}
          </div></div>
        </div>{!config.nodes.length && <div className="organization-empty"><Icon name="workflow" size={28} /><h3>Define how your agents collaborate</h3><p>{agentCatalog && !providers.length ? 'Install and enable a coding agent in Settings → Agents to add your first node.' : 'Add a role, choose its agent, then connect the next stage. Your contacted agent handles coordination.'}</p><button className="btn btn-primary" disabled={!providers.length} onClick={addNode}>Add first node</button></div>}</div>
        {node ? <NodeEditor key={node.id} node={node} onChange={patch => patchNode(node.id, patch)} onRemove={() => { update({ nodes: config.nodes.filter(item => item.id !== node.id), edges: config.edges.filter(edge => edge.source !== node.id && edge.target !== node.id) }); setSelected(null); setConnecting(null); setSource(''); setTarget(''); setConnectionError(null); }} /> : <aside className="organization-inspector organization-inspector-empty"><h3>Node configuration</h3><p>{selected === '__orchestrator__' ? 'The agent receiving your initial message becomes the orchestrator. This permanent node coordinates the graph and cannot be deleted.' : 'Select a node to edit its role, provider, model, and effort.'}</p></aside>}
      </div>
      <div className="organization-connections"><h3>Dependencies</h3>{connecting && <div className="organization-connection-hint" role="status"><span>Choose an input port to connect from {connecting === '__orchestrator__' ? 'Orchestrator' : config.nodes.find(node => node.id === connecting)?.title}.</span><button className="btn btn-danger btn-xs" onClick={() => { setConnecting(null); setConnectionError(null); }}>Cancel</button></div>}
        <div className="organization-connection-add"><Select aria-label="Predecessor node" value={source} onChange={event => { setSource(event.target.value); setTarget(''); setConnecting(null); setConnectionError(null); }}><option value="">Predecessor</option>{config.nodes.length > 0 && <option value="__orchestrator__">Orchestrator</option>}{config.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</Select><Icon name="chevron-right" size={16} /><Select aria-label="Successor node" value={target} disabled={!source} onChange={event => { setTarget(event.target.value); setConnectionError(null); }}><option value="">Successor</option>{config.nodes.filter(node => node.id !== source && !config.edges.some(edge => edge.source === source && edge.target === node.id) && (source === '__orchestrator__' ? !config.edges.some(edge => edge.target === node.id) : !cycle(config, source, node.id))).map(node => <option key={node.id} value={node.id}>{node.title}</option>)}</Select><button className="btn btn-secondary" disabled={!source || !target} onClick={() => connect(source, target)}>Connect</button></div>
        {connectionError && <p className="organization-error" role="alert">{connectionError}</p>}
        {config.edges.map(edge => <div className="organization-connection" key={`${edge.source}:${edge.target}`}><span>{config.nodes.find(node => node.id === edge.source)?.title}</span><Icon name="chevron-right" size={14} /><span>{config.nodes.find(node => node.id === edge.target)?.title}</span><button className="btn btn-icon" title="Remove connection" aria-label={`Remove connection ${edge.source} to ${edge.target}`} onClick={() => update({ edges: config.edges.filter(item => item !== edge) })}><Icon name="close" size={14} /></button></div>)}
        {!config.edges.length && <p className="organization-note">Nodes without predecessors receive their assignment from the orchestrator. Shared-checkout work runs sequentially.</p>}
      </div>
      <WorkflowRuns />
      </>}
    </>}
  </div>;
}

function WorkflowRuns() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const read = async () => { try { const next = await fetchWorkflowRuns(controller.signal); if (!controller.signal.aborted) { setRuns(next); setError(null); } } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); } finally { if (!controller.signal.aborted) timer = setTimeout(read, 3000); } }; void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  async function cancel(id: string) { setBusy(id); try { await cancelWorkflowRun(id); setRuns(await fetchWorkflowRuns()); } catch (error) { setError((error as Error).message); } finally { setBusy(null); } }
  return <section className="organization-runs"><h2>Workflow runs</h2>{error && <p role="alert" className="organization-error">{error}</p>}{!runs.length && <p className="organization-note">Runs appear here after you send a task with Workflow / Organization enabled.</p>}{[...runs].sort((a, b) => Number(['completed', 'failed', 'cancelled'].includes(a.state)) - Number(['completed', 'failed', 'cancelled'].includes(b.state))).slice(0, 20).map(run => <details key={run.id}><summary><span>{run.originalRequest.slice(0, 90) || 'Attached task'} <small className="text-muted">? {run.id.slice(0, 8)}</small></span><span>{run.state}</span></summary><div className="organization-run-details"><p>Started {new Date(run.createdAt).toLocaleString()} · Orchestrator {run.orchestratorId.slice(0, 8)}</p>{run.planReason && <p>{run.planReason}</p>}{run.integrationPath && <p>Integration worktree: <code>{run.integrationPath}</code></p>}{run.error && <p className="organization-error">{run.error}</p>}{run.steps.map(step => <div className="organization-run-step" key={step.nodeId}><strong>{run.config.nodes.find(node => node.id === step.nodeId)?.title}</strong><span>{step.state}{step.stream ? ` · ${step.stream}` : ''}</span>{step.result && <p>{step.result}</p>}</div>)}{run.result && <p>{run.result}</p>}{!['completed', 'failed', 'cancelled'].includes(run.state) && <button className="btn btn-secondary" disabled={busy === run.id} onClick={() => void cancel(run.id)}>Cancel run · keep worktrees</button>}</div></details>)}</section>;
}
