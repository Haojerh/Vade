import type { InboxData, InboxItem, Project, Section } from '../../shared/contracts.js';
import { runOrca, type CommandRunner } from '../integrations/cli.js';
import { collectInventory } from '../integrations/orca/inventory.js';
import { hashId, mapToState, stripAnsi, toIsoOrNull } from '../integrations/orca/utils.js';

export function agentInboxItems(projects: Project[], worktrees: any[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const wt of worktrees.slice(0, 200)) {
    const owners = projects.filter(p => p.repoIds.includes(wt.repoId) || p.paths.some(path => path.toLowerCase() === String(wt.path).toLowerCase()));
    for (const ag of (Array.isArray(wt.agents) ? wt.agents : []).slice(0, 200)) {
      const state = mapToState(ag.state);
      const at = toIsoOrNull(ag.stateStartedAt || ag.updatedAt);
      if (!ag.paneKey || !at || (state !== 'completed' && state !== 'failed')) continue;
      for (const project of owners) {
        const entityId = `agent:${ag.paneKey}`;
        items.push({ id: hashId('inbox', `${project.id}:${entityId}:${state}:${at}`), entityId,
          nodeId: hashId('node', ag.paneKey), runId: null,
          projectId: project.id, projectName: project.name, at, source: 'agent',
          title: stripAnsi(String(ag.taskTitle || ag.displayName || ag.agentType || 'Agent result')).slice(0, 240),
          outcome: state === 'failed' ? 'failed' : 'succeeded' });
      }
    }
  }
  return items;
}

/** No transcript reads or per-project graph collections. Cache is shared by clients. */
export class InboxCollector {
  private cached: Section<InboxData> | null = null;
  private expires = 0;
  private pending: Promise<Section<InboxData>> | null = null;
  private history = new Map<string, InboxItem>();
  constructor(private runner: CommandRunner) {}

  get(): Promise<Section<InboxData>> {
    if (this.cached && Date.now() < this.expires) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async collect(): Promise<Section<InboxData>> {
    const attemptedAt = new Date().toISOString();
    try {
      const [inventory, ps, runs] = await Promise.all([
        collectInventory(this.runner),
        runOrca<any>(['worktree', 'ps', '--limit', '200', '--json'], this.runner),
        runOrca<any>(['orchestration', 'run-list', '--limit', '50', '--json'], this.runner).catch(() => null),
      ]);
      if (inventory.meta.availability === 'unavailable' || !Array.isArray(ps.result?.worktrees)) throw new Error('Inbox sources unavailable');
      const projects = inventory.inventory.projects;
      const worktrees = ps.result.worktrees;
      const items = agentInboxItems(projects, worktrees);
      const terminals = new Map<string, Promise<any[]>>();
      const rawRuns = [...(Array.isArray(runs?.result?.runs) ? runs.result.runs : [])].sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
      let partial = inventory.meta.partial || Boolean(ps.result.truncated) || rawRuns.length > 10 || Boolean(runs?.result?.truncated || runs?.result?.nextCursor) || !Array.isArray(runs?.result?.runs);
      // Recent runs only, with at most two run collections in flight.
      for (let start = 0; start < Math.min(rawRuns.length, 10); start += 2) {
        await Promise.all(rawRuns.slice(start, Math.min(start + 2, 10)).map(async (run: any) => {
          try {
            const [tasks, workers] = await Promise.all([
              runOrca<any>(['orchestration', 'task-list', '--run', run.id, '--json'], this.runner),
              runOrca<any>(['orchestration', 'worker-list', '--run', run.id, '--limit', '100', '--json'], this.runner),
            ]);
            if (!Array.isArray(tasks.result?.tasks) || !Array.isArray(workers.result?.workers)) throw new Error('Invalid inbox tasks');
            partial ||= Boolean(tasks.result.truncated || tasks.result.partial || workers.result.truncated || workers.result.page?.hasMore || tasks.result.tasks.length > 200);
            for (const task of tasks.result.tasks.slice(0, 200)) {
              let result: any = task.result;
              if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
              const state = mapToState(result?.outcome || task.status);
              const at = toIsoOrNull(task.completed_at || result?.completedAt);
              if (!at || (state !== 'completed' && state !== 'failed')) continue;
              let candidates = workers.result.workers.filter((w: any) => w.taskId === task.id);
              const reporter = result?.reportedBy || result?.completedBy || task.assignee_handle;
              if (reporter) candidates = candidates.filter((w: any) => w.agentTerminalHandle === reporter || w.resource?.terminalHandle === reporter);
              const workspaceIds = new Set<string>(candidates.map((w: any) => w.resource?.worktreeId || w.projection?.workspace?.id).filter(Boolean));
              if (workspaceIds.size !== 1) { partial = true; continue; }
              const wtId = [...workspaceIds][0];
              const wt = worktrees.find((w: any) => w.worktreeId === wtId);
              if (!wt) continue; // Never attribute a cross-project task to its coordinator's project.
              let nodeId: string | null = null;
              const handles = new Set<string>(candidates.map((w: any) => w.agentTerminalHandle || w.resource?.terminalHandle).filter(Boolean));
              if (handles.size === 1) {
                if (!terminals.has(wtId) && terminals.size < 10) {
                  terminals.set(wtId, runOrca<any>(['terminal', 'list', '--worktree', `id:${wtId}`, '--limit', '100', '--json'], this.runner)
                    .then(response => Array.isArray(response.result?.terminals) ? response.result.terminals : [])
                    .catch(() => { partial = true; return []; }));
                }
                const rows = await terminals.get(wtId);
                const terminal = rows?.find(row => row.handle === [...handles][0]);
                const paneKey = terminal?.tabId && terminal?.leafId ? `${terminal.tabId}:${terminal.leafId}` : terminal?.paneKey;
                if (paneKey && wt.agents?.some((agent: any) => agent.paneKey === paneKey)) nodeId = hashId('node', paneKey);
              }
              for (const project of projects.filter(p => p.repoIds.includes(wt.repoId) || p.paths.includes(wt.path))) {
                const entityId = `run:${run.id}`;
                items.push({ id: hashId('inbox', `${project.id}:${run.id}:${task.id}:${state}:${at}`),
                  entityId, projectId: project.id, projectName: project.name, at, source: 'task',
                  nodeId, runId: hashId('run', run.id),
                  title: stripAnsi(String(task.task_title || task.id)).slice(0, 240), outcome: state === 'failed' ? 'failed' : 'succeeded' });
              }
            }
          } catch { partial = true; }
        }));
      }
      for (const item of items) this.history.set(item.id, item);
      const currentNodeIds = new Set<string>(worktrees.flatMap((wt: any) => (wt.agents || []).filter((agent: any) => agent.paneKey).map((agent: any) => hashId('node', agent.paneKey))));
      const bounded = [...this.history.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
        .map(item => item.nodeId && !currentNodeIds.has(item.nodeId) ? { ...item, nodeId: null } : item);
      this.history = new Map(bounded.map(item => [item.id, item]));
      this.cached = { data: { items: bounded }, meta: { availability: bounded.length ? 'ready' : 'empty', observedAt: attemptedAt, attemptedAt, stale: false, partial, issue: null } };
    } catch {
      this.cached = { data: this.cached?.data ?? null, meta: { availability: 'unavailable', observedAt: this.cached?.meta.observedAt ?? null,
        attemptedAt, stale: Boolean(this.cached?.data), partial: true, issue: { code: 'RUNTIME_UNAVAILABLE', message: 'Inbox could not refresh. Previously observed results are retained.', retryable: true } } };
    }
    this.expires = Date.now() + 30_000;
    return this.cached;
  }
}
