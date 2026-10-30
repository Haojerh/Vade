import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { WorkflowSetupStatus } from '../../../shared/contracts';
import { fetchWorkflowSetup, workflowRequest } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { useAgentCatalog } from '../../hooks/agents/useAgentCatalog';
import { DesktopUpdateSettings } from '../updates/DesktopUpdates';

const AgentTerminal = lazy(() => import('../workflow/terminal/AgentTerminal').then(module => ({ default: module.AgentTerminal })));
type SetupTerminal = { projectId: string; nodeId: string; command: string };
export function WorkflowSetup() {
  const [status, setStatus] = useState<WorkflowSetupStatus | null>(null), [checking, setChecking] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<SetupTerminal | null>(null), [expanded, setExpanded] = useState<'cli' | 'skill' | 'cliSkill' | null>(null);
  const { catalog } = useAgentCatalog();
  const mounted = useRef(true), installedTerminal = useRef<SetupTerminal | null>(null);
  useEffect(() => { mounted.current = true; const controller = new AbortController(); fetchWorkflowSetup(controller.signal).then(setStatus).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => { mounted.current = false; controller.abort(); const owner = installedTerminal.current; if (owner) void workflowRequest('setup-terminal/close', { projectId: owner.projectId, nodeId: owner.nodeId }).catch(() => {}); }; }, []);
  async function check() {
    setChecking(true); setError(null);
    try { const [next] = await Promise.all([fetchWorkflowSetup(), new Promise(resolve => setTimeout(resolve, 400))]); if (mounted.current) setStatus(next); } catch (error) { if (mounted.current) setError((error as Error).message); } finally { if (mounted.current) setChecking(false); }
  }
  async function open(kind: 'cli' | 'skill' | 'cliSkill') {
    setOpening(true); setError(null);
    try {
      const next = await workflowRequest<SetupTerminal>('setup-terminal', {}); installedTerminal.current = next;
      if (mounted.current) { setTerminal(next); setExpanded(kind); }
      else void workflowRequest('setup-terminal/close', { projectId: next.projectId, nodeId: next.nodeId }).catch(() => {});
    } catch (error) { if (mounted.current) setError((error as Error).message); } finally { if (mounted.current) setOpening(false); }
  }
  const agents = catalog?.installed.filter(agent => ['codex', 'claude', 'antigravity', 'codebuddy', 'opencode', 'opencode2', 'kilo', 'dsh'].includes(agent.id)) ?? [];
  return <section className="organization-setup">
    <DesktopUpdateSettings />
    {error && <p role="alert" className="organization-error">{error}</p>}
    {(['cli', 'cliSkill', 'skill'] as const).map(kind => {
      const ready = status?.[kind];
      return <section className="organization-component" key={kind}>
        <div className="organization-component-heading"><span className="organization-component-icon"><Icon name={kind === 'cli' ? 'terminal' : 'workflow'} size={24} /></span><h2>{kind === 'cli' ? 'Vade CLI' : kind === 'cliSkill' ? 'CLI-awareness skill' : 'Orchestration skill'}</h2><span className={`organization-install-badge${ready ? ' is-ready' : ''}`}>{status ? ready ? 'Up to date' : 'Install / update required' : 'Checking…'}</span></div>
        <p>{kind === 'cli' ? 'Spawn and coordinate owned agent terminals through Vade’s local workflow controls.' : kind === 'cliSkill' ? 'Teach agents how to discover and use Vade commands within their assigned workflow.' : 'Give agents the delegation, dependency, and result-reporting protocol for your workflows.'}</p>
        {kind === 'cli' && status && <p className="organization-cli-path">Command path: <code>{status.cliPath}</code></p>}
        <div className="organization-actions"><button className="btn btn-secondary" disabled={opening} onClick={() => void open(kind)}><Icon name="terminal" size={15} />{ready ? 'Update' : 'Install'}</button><button className="btn organization-recheck" disabled={checking} onClick={() => void check()}><Icon name="refresh-cw" className={checking ? 'is-refreshing' : ''} size={15} />Re-check</button></div>
        {kind === 'skill' && <div className="organization-coverage"><h3>Agent coverage</h3><p>Both skills are installed in standard agent directories. Workflow assignments also provide exact local paths.</p><div>{agents.map(agent => <span key={agent.id}><ProviderIcon provider={agent.provider} size={17} />{agent.name}</span>)}{catalog && !agents.length && <span>No enabled agents detected. Configure agents in Settings.</span>}</div></div>}
        {expanded === kind && terminal && <div className="organization-install-terminal"><div className="organization-install-command"><code>{terminal.command}</code><button className="btn btn-secondary btn-xs" onClick={() => void navigator.clipboard.writeText(terminal.command).catch(() => setError('Could not copy the command. Select it to copy manually.'))}>Copy</button></div><p>Press Enter in the terminal to install or update the bundled components. Then re-check.</p><Suspense fallback={<p>Opening terminal…</p>}><AgentTerminal projectId={terminal.projectId} nodeId={terminal.nodeId} streamPath={`/api/workflow/setup-terminal/${terminal.projectId}/${terminal.nodeId}/terminal-stream`} /></Suspense></div>}
      </section>;
    })}
    {status?.error && <p className="organization-note">{status.error}</p>}
  </section>;
}
