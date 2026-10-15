import crypto from 'node:crypto';
import {
  Id,
  ISO,
  State,
  Project,
  Inventory,
  Run,
  Node,
  Edge,
  Task,
  Progress,
  Activity,
  Graph,
  SourceMeta,
  Section,
  NodeDetails,
} from '../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, CliError } from './cli.js';

export function hashId(prefix: string, key: string): Id {
  const h = crypto.createHash('sha256').update(key).digest('base64url').slice(0, 20);
  return `${prefix}_${h}`;
}

export function mapToState(raw: string | null | undefined): State {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase().trim();
  if (lower === 'working' || lower === 'running') return 'working';
  if (lower === 'waiting' || lower === 'awaiting input' || lower === 'awaiting approval') return 'waiting';
  if (lower === 'blocked') return 'blocked';
  if (lower === 'completed' || lower === 'done' || lower === 'succeeded' || lower === 'success') return 'completed';
  if (lower === 'failed' || lower === 'failure' || lower === 'error') return 'failed';
  if (lower === 'idle') return 'idle';
  return 'unknown';
}

export function stripAnsi(str: string): string {
  // Strips standard ANSI escape sequences
  return str.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

export function toIsoOrNull(val: any): ISO | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0 || val > 1e15) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Must contain time and explicit timezone indicator (e.g. 09:38:45Z, 09:38:45+00:00, 09:38:45-05:00)
    // Reject ambiguous SQL timestamp strings lacking timezone (e.g. "2026-10-15 09:38:45" or "2026-10-15")
    const tzMatch = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
    if (!tzMatch.test(trimmed)) {
      return null;
    }
    const d = new Date(trimmed.replace(' ', 'T'));
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return null;
}

export interface RunAssociation {
  associated: boolean;
  association?: 'coordinator-terminal' | 'worker-workspace';
  coordinatorNodeId?: Id | null;
}

// In-memory mappings between source identifiers and API IDs
export interface OrcaSourceMaps {
  projectSourceMap: Map<Id, { sourceId: string; repoIds: string[]; paths: string[] }>;
  nodeSourceMap: Map<Id, { handle?: string; worktreeId?: string; paneKey?: string }>;
  cursorMap: Map<string, string>; // server-issued source-bound cursors
  runAssociationCache: Map<string, RunAssociation>;
  observedAppVersion: string | null;
}

export const globalSourceMaps: OrcaSourceMaps = {
  projectSourceMap: new Map(),
  nodeSourceMap: new Map(),
  cursorMap: new Map(),
  runAssociationCache: new Map(),
  observedAppVersion: null,
};

// 1. Fetch project inventory
export async function collectInventory(
  runner: CommandRunner = defaultCommandRunner
): Promise<{ inventory: Inventory; meta: SourceMeta; runtimeId: string | null; appVersion: string | null }> {
  const attemptedAt = new Date().toISOString();
  let runtimeId: string | null = null;
  let appVersion: string | null = globalSourceMaps.observedAppVersion;
  let partial = false;

  try {
    const [projectListRes, setupsRes, repoListRes, statusRes] = await Promise.allSettled([
      runOrca<any>(['project', 'list', '--json'], runner),
      runOrca<any>(['project', 'setups', '--json'], runner),
      runOrca<any>(['repo', 'list', '--json'], runner),
      runOrca<any>(['status', '--json'], runner),
    ]);

    if (statusRes.status === 'fulfilled') {
      const sResult = statusRes.value.result;
      const ver = sResult?.runtime?.appVersion;
      if (typeof ver === 'string') {
        appVersion = ver;
        globalSourceMaps.observedAppVersion = ver;
      }
      runtimeId = runtimeId || sResult?.runtime?.runtimeId || statusRes.value._meta?.runtimeId || null;
    }

    const allSourcesFailed =
      projectListRes.status === 'rejected' &&
      setupsRes.status === 'rejected' &&
      repoListRes.status === 'rejected';

    if (allSourcesFailed) {
      let failureMsg = 'All inventory sources failed';
      if (projectListRes.status === 'rejected') {
        failureMsg = projectListRes.reason?.message || failureMsg;
      }
      return {
        inventory: { projects: [] },
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: true,
          issue: {
            code: 'RUNTIME_UNAVAILABLE',
            message: failureMsg,
            retryable: true,
          },
        },
        runtimeId,
        appVersion,
      };
    }

    const projects: Project[] = [];
    const sourceProjectMap = new Map<string, Project>();

    if (projectListRes.status === 'fulfilled') {
      runtimeId = projectListRes.value._meta?.runtimeId ?? null;
      const rawProjects = projectListRes.value.result?.projects ?? [];
      for (const p of rawProjects) {
        if (!p.id) continue;
        const apiId = hashId('proj', p.id);
        const proj: Project = {
          id: apiId,
          name: p.displayName || p.id,
          kind: p.kind === 'git' ? 'git' : p.kind === 'folder' ? 'folder' : 'unknown',
          sourceProjectId: p.id,
          repoIds: Array.isArray(p.sourceRepoIds) ? p.sourceRepoIds : [],
          paths: [],
          hostIds: [],
        };
        sourceProjectMap.set(p.id, proj);
      }
    } else {
      partial = true;
    }

    if (setupsRes.status === 'fulfilled') {
      runtimeId = runtimeId || setupsRes.value._meta?.runtimeId || null;
      const rawSetups = setupsRes.value.result?.setups || setupsRes.value.result || [];
      const setupsList = Array.isArray(rawSetups) ? rawSetups : [];
      for (const s of setupsList) {
        if (!s.projectId) continue;
        const proj = sourceProjectMap.get(s.projectId);
        if (proj) {
          if (s.path && !proj.paths.includes(s.path)) proj.paths.push(s.path);
          if (s.hostId && !proj.hostIds.includes(s.hostId)) proj.hostIds.push(s.hostId);
          if (s.repoId && !proj.repoIds.includes(s.repoId)) proj.repoIds.push(s.repoId);
        } else {
          // Setup without project in project list
          const apiId = hashId('proj', s.projectId);
          const newProj: Project = {
            id: apiId,
            name: s.displayName || s.projectId,
            kind: s.kind === 'git' ? 'git' : s.kind === 'folder' ? 'folder' : 'unknown',
            sourceProjectId: s.projectId,
            repoIds: s.repoId ? [s.repoId] : [],
            paths: s.path ? [s.path] : [],
            hostIds: s.hostId ? [s.hostId] : [],
          };
          sourceProjectMap.set(s.projectId, newProj);
        }
      }
    }

    if (repoListRes.status === 'fulfilled') {
      runtimeId = runtimeId || repoListRes.value._meta?.runtimeId || null;
      const rawRepos = repoListRes.value.result?.repos || [];
      for (const r of rawRepos) {
        if (!r.id) continue;
        // Check if repo belongs to an existing project
        let matched = false;
        for (const proj of sourceProjectMap.values()) {
          if (proj.repoIds.includes(r.id)) {
            matched = true;
            if (r.path && !proj.paths.includes(r.path)) proj.paths.push(r.path);
          }
        }
        if (!matched) {
          const apiId = hashId('proj', `repo:${r.id}`);
          const newProj: Project = {
            id: apiId,
            name: r.displayName || r.id,
            kind: r.kind === 'git' ? 'git' : 'folder',
            sourceProjectId: `repo:${r.id}`,
            repoIds: [r.id],
            paths: r.path ? [r.path] : [],
            hostIds: ['local'],
          };
          sourceProjectMap.set(newProj.sourceProjectId!, newProj);
        }
      }
    }

    for (const p of sourceProjectMap.values()) {
      projects.push(p);
      globalSourceMaps.projectSourceMap.set(p.id, {
        sourceId: p.sourceProjectId || p.id,
        repoIds: p.repoIds,
        paths: p.paths,
      });
    }

    const observedAt = new Date().toISOString();
    return {
      inventory: { projects },
      meta: {
        availability: projects.length > 0 ? 'ready' : 'empty',
        observedAt,
        attemptedAt,
        stale: false,
        partial,
        issue: null,
      },
      runtimeId,
      appVersion,
    };
  } catch (err: any) {
    return {
      inventory: { projects: [] },
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: true,
        issue: {
          code: err.issue?.code || 'RUNTIME_UNAVAILABLE',
          message: err.message || 'Failed to collect inventory',
          retryable: true,
        },
      },
      runtimeId,
      appVersion,
    };
  }
}

// 2. Collect Graph for a project
export async function collectGraph(
  projectId: Id,
  selectedRunId?: Id | null,
  runner: CommandRunner = defaultCommandRunner
): Promise<{ graph: Graph; meta: SourceMeta; runtimeId: string | null; appVersion: string | null }> {
  const attemptedAt = new Date().toISOString();
  let runtimeId: string | null = null;
  let partial = false;

  const projectEntry = globalSourceMaps.projectSourceMap.get(projectId);
  if (!projectEntry) {
    throw new CliError('PROJECT_NOT_FOUND', `Project ${projectId} not found in inventory`);
  }

  try {
    // A. Query worktree ps
    const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '200', '--json'], runner);
    runtimeId = psRes._meta?.runtimeId ?? null;
    const allWorktrees: any[] = psRes.result?.worktrees ?? [];
    if (psRes.result?.truncated) partial = true;

    // Filter worktrees for this project
    const projectWorktrees = allWorktrees.filter((w) => {
      if (w.repoId && projectEntry.repoIds.includes(w.repoId)) return true;
      if (w.path && projectEntry.paths.some((p) => p.toLowerCase() === w.path.toLowerCase())) return true;
      return false;
    });

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const nodeMap = new Map<Id, Node>();
    const paneKeyToNodeId = new Map<string, Id>();
    const terminalHandleToNodeId = new Map<string, Id>();
    const worktreeIdToNodeId = new Map<string, Id>();

    // B. Build worktree nodes and fetch terminals for each worktree
    for (const wt of projectWorktrees) {
      const wtNodeId = hashId('node', wt.worktreeId || wt.path || wt.displayName);
      worktreeIdToNodeId.set(wt.worktreeId, wtNodeId);

      const isFolder = wt.workspaceKind === 'folder' || wt.isFolder;
      const wtNode: Node = {
        id: wtNodeId,
        kind: 'worktree',
        label: isFolder ? `Folder: ${wt.displayName || wt.repo || 'workspace'}` : (wt.displayName || wt.branch || wt.repo || 'Worktree'),
        worktreeId: wt.worktreeId || null,
        runId: null,
        agentType: null,
        branch: isFolder ? null : (wt.branch || null),
        path: wt.path || null,
        state: mapToState(wt.status || wt.workspaceStatus),
        rawState: wt.status || wt.workspaceStatus || null,
        workspaceStatus: wt.workspaceStatus || null,
        taskOutcome: null,
        liveness: wt.terminalVerdict === 'live' ? 'live' : wt.terminalVerdict === 'none' ? 'exited' : 'unknown',
        observedAt: toIsoOrNull(wt.lastActivityAt || wt.lastOutputAt),
        lastActivityAt: toIsoOrNull(wt.lastActivityAt || wt.lastOutputAt),
        stale: false,
        taskIds: [],
        preview: wt.preview ? stripAnsi(wt.preview.slice(0, 300)) : null,
        outputAvailable: Boolean(wt.preview || wt.liveTerminalCount > 0),
      };
      nodes.push(wtNode);
      nodeMap.set(wtNodeId, wtNode);
      globalSourceMaps.nodeSourceMap.set(wtNodeId, { worktreeId: wt.worktreeId });

      // Fetch terminals in this worktree
      let terminals: any[] = [];
      try {
        const termRes = await runOrca<any>(['terminal', 'list', '--worktree', `id:${wt.worktreeId}`, '--limit', '100', '--json'], runner);
        terminals = termRes.result?.terminals ?? [];
      } catch {
        // partial terminal discovery
        partial = true;
      }

      // Index terminals by tabId:leafId and by handle
      const terminalByPane = new Map<string, any>();
      for (const t of terminals) {
        if (t.tabId && t.leafId) {
          terminalByPane.set(`${t.tabId}:${t.leafId}`, t);
        }
      }

      // C. Build agent nodes from wt.agents
      const agents: any[] = Array.isArray(wt.agents) ? wt.agents : [];
      const handledTerminalHandles = new Set<string>();

      for (const ag of agents) {
        const paneKey = ag.paneKey;
        const matchingTerminal = paneKey ? terminalByPane.get(paneKey) : null;
        const handle = matchingTerminal?.handle;
        if (handle) handledTerminalHandles.add(handle);

        const agentNodeId = hashId('node', paneKey || handle || `${wt.worktreeId}:agent:${nodes.length}`);
        if (paneKey) paneKeyToNodeId.set(paneKey, agentNodeId);
        if (handle) terminalHandleToNodeId.set(handle, agentNodeId);

        const agState = mapToState(ag.state);
        const liveness = matchingTerminal?.connected ? 'live' : wt.terminalVerdict === 'live' ? 'live' : 'unknown';

        const agNode: Node = {
          id: agentNodeId,
          kind: 'agent',
          label: ag.taskTitle || ag.displayName || ag.agentType || 'Agent',
          worktreeId: wt.worktreeId || null,
          runId: null, // will be attached when runs are associated
          agentType: ag.agentType || matchingTerminal?.agentIdentity || null,
          branch: null,
          path: wt.path || null,
          state: agState,
          rawState: ag.state || null,
          workspaceStatus: wt.workspaceStatus || null,
          taskOutcome: null,
          liveness,
          observedAt: toIsoOrNull(ag.updatedAt || ag.stateStartedAt),
          lastActivityAt: toIsoOrNull(ag.updatedAt || matchingTerminal?.lastOutputAt),
          stale: false,
          taskIds: [],
          preview: matchingTerminal?.preview ? stripAnsi(matchingTerminal.preview.slice(0, 300)) : null,
          outputAvailable: Boolean(handle),
        };
        nodes.push(agNode);
        nodeMap.set(agentNodeId, agNode);
        globalSourceMaps.nodeSourceMap.set(agentNodeId, { handle, worktreeId: wt.worktreeId, paneKey });

        // Worktree contains agent edge
        edges.push({
          id: hashId('edge', `${wtNodeId}->${agentNodeId}:membership`),
          source: wtNodeId,
          target: agentNodeId,
          kind: 'contains',
          evidence: 'workspace-membership',
          active: agNode.state === 'working',
        });
      }

      // D. Shell / unattached terminals become terminal nodes
      for (const term of terminals) {
        if (handledTerminalHandles.has(term.handle)) continue;

        const termNodeId = hashId('node', term.handle);
        terminalHandleToNodeId.set(term.handle, termNodeId);

        const termNode: Node = {
          id: termNodeId,
          kind: 'terminal',
          label: term.title ? stripAnsi(term.title) : `Terminal ${term.handle}`,
          worktreeId: wt.worktreeId || null,
          runId: null,
          agentType: term.agentIdentity || null,
          branch: null,
          path: wt.path || null,
          state: term.connected ? 'idle' : 'unknown',
          rawState: term.connected ? 'connected' : 'disconnected',
          workspaceStatus: wt.workspaceStatus || null,
          taskOutcome: null,
          liveness: term.connected ? 'live' : 'exited',
          observedAt: toIsoOrNull(term.lastOutputAt),
          lastActivityAt: toIsoOrNull(term.lastOutputAt),
          stale: false,
          taskIds: [],
          preview: term.preview ? stripAnsi(term.preview.slice(0, 300)) : null,
          outputAvailable: Boolean(term.handle),
        };
        nodes.push(termNode);
        nodeMap.set(termNodeId, termNode);
        globalSourceMaps.nodeSourceMap.set(termNodeId, { handle: term.handle, worktreeId: wt.worktreeId });

        edges.push({
          id: hashId('edge', `${wtNodeId}->${termNodeId}:membership`),
          source: wtNodeId,
          target: termNodeId,
          kind: 'contains',
          evidence: 'workspace-membership',
          active: false,
        });
      }

      // E. Parent-child worktree edges
      if (wt.parentWorktreeId) {
        const parentNodeId = worktreeIdToNodeId.get(wt.parentWorktreeId);
        if (parentNodeId) {
          edges.push({
            id: hashId('edge', `${parentNodeId}->${wtNodeId}:lineage`),
            source: parentNodeId,
            target: wtNodeId,
            kind: 'lineage',
            evidence: 'parent-worktree',
            active: true,
          });
        }
      }

      // F. Agent parent-pane edges
      for (const ag of agents) {
        if (ag.parentPaneKey && ag.paneKey) {
          const parentNodeId = paneKeyToNodeId.get(ag.parentPaneKey);
          const childNodeId = paneKeyToNodeId.get(ag.paneKey);
          if (parentNodeId && childNodeId && parentNodeId !== childNodeId) {
            const childNode = nodeMap.get(childNodeId);
            edges.push({
              id: hashId('edge', `${parentNodeId}->${childNodeId}:parent-pane`),
              source: parentNodeId,
              target: childNodeId,
              kind: 'delegates',
              evidence: 'parent-pane',
              active: childNode?.state === 'working',
            });
          }
        }
      }
    }

    // G. Discover Runs and associate with this project
    const associatedRuns: Run[] = [];
    let candidateRuns: any[] = [];
    try {
      const runListRes = await runOrca<any>(['orchestration', 'run-list', '--limit', '50', '--json'], runner);
      candidateRuns = runListRes.result?.runs ?? [];
    } catch {
      partial = true;
    }

    let inspectedWorkersCount = 0;
    const MAX_WORKER_INSPECTIONS = 5;

    for (const r of candidateRuns) {
      if (!r.id) continue;
      const cacheKey = `${projectId}::${r.id}`;
      const cachedAssoc = globalSourceMaps.runAssociationCache.get(cacheKey);

      let association: 'coordinator-terminal' | 'worker-workspace' | null = null;
      let coordinatorNodeId: Id | null = null;

      if (cachedAssoc) {
        if (cachedAssoc.associated) {
          association = cachedAssoc.association!;
          coordinatorNodeId =
            cachedAssoc.coordinatorNodeId ??
            (r.coordinator_handle ? terminalHandleToNodeId.get(r.coordinator_handle) || null : null);
        }
      } else {
        // Fast path: Coordinator handle match requires 0 CLI calls
        if (r.coordinator_handle && terminalHandleToNodeId.has(r.coordinator_handle)) {
          association = 'coordinator-terminal';
          coordinatorNodeId = terminalHandleToNodeId.get(r.coordinator_handle)!;
          globalSourceMaps.runAssociationCache.set(cacheKey, {
            associated: true,
            association,
            coordinatorNodeId,
          });
        } else if (inspectedWorkersCount < MAX_WORKER_INSPECTIONS) {
          inspectedWorkersCount++;
          try {
            const wListRes = await runOrca<any>(
              ['orchestration', 'worker-list', '--run', r.id, '--limit', '100', '--json'],
              runner
            );
            const workers: any[] = wListRes.result?.workers ?? [];
            for (const w of workers) {
              const wWorktreeId = w.resource?.worktreeId || w.projection?.workspace?.id;
              if (wWorktreeId && worktreeIdToNodeId.has(wWorktreeId)) {
                association = 'worker-workspace';
                break;
              }
            }
            globalSourceMaps.runAssociationCache.set(cacheKey, {
              associated: Boolean(association),
              association: association || undefined,
            });
          } catch {
            partial = true;
          }
        } else {
          // Exceeded inspection budget for this tick
          partial = true;
        }
      }

      if (association) {
        const runApiId = hashId('run', r.id);
        const runObj: Run = {
          id: runApiId,
          sourceRunId: r.id,
          objective: r.objective || r.id,
          coordinatorNodeId,
          association,
        };
        associatedRuns.push(runObj);

        // If coordinator node found, update kind to 'orchestrator'
        if (coordinatorNodeId) {
          const coordNode = nodeMap.get(coordinatorNodeId);
          if (coordNode) {
            coordNode.kind = 'orchestrator';
            coordNode.runId = runApiId;
          }
        }
      }
    }

    // H. Select active run
    let activeRun: Run | null = null;
    if (selectedRunId) {
      activeRun = associatedRuns.find((r) => r.id === selectedRunId) || null;
      if (!activeRun) {
        throw new CliError('RUN_NOT_FOUND', `Run ${selectedRunId} not found in project ${projectId}`);
      }
    } else if (associatedRuns.length > 0) {
      // Pick newest
      activeRun = associatedRuns[0];
    }

    // Preserve selected-run worker evidence & delegation
    if (activeRun) {
      try {
        const activeWorkersRes = await runOrca<any>(
          ['orchestration', 'worker-list', '--run', activeRun.sourceRunId, '--limit', '100', '--json'],
          runner
        );
        const activeWorkers: any[] = activeWorkersRes.result?.workers ?? [];
        for (const w of activeWorkers) {
          const handle = w.agentTerminalHandle || w.resource?.terminalHandle;
          const targetNodeId = handle ? terminalHandleToNodeId.get(handle) : null;
          if (targetNodeId) {
            const targetNode = nodeMap.get(targetNodeId);
            if (targetNode) {
              targetNode.runId = activeRun.id;
              if (w.projection?.stage?.activity) {
                targetNode.rawState = w.projection.stage.activity;
                targetNode.state = mapToState(w.projection.stage.activity);
              } else if (w.workerState) {
                targetNode.rawState = w.workerState;
                targetNode.state = mapToState(w.workerState);
              }

              if (w.projection?.outcome) {
                targetNode.taskOutcome = w.projection.outcome;
              } else if (w.outcome) {
                targetNode.taskOutcome = w.outcome;
              }

              if (w.projection?.liveness?.verdict) {
                targetNode.liveness = w.projection.liveness.verdict === 'live' ? 'live' : 'exited';
              }

              if (w.projection?.liveness?.observedAt) {
                targetNode.observedAt = toIsoOrNull(w.projection.liveness.observedAt) || targetNode.observedAt;
              }

              // Delegation edge from coordinator to worker
              if (activeRun.coordinatorNodeId && activeRun.coordinatorNodeId !== targetNodeId) {
                const edgeId = hashId('edge', `${activeRun.coordinatorNodeId}->${targetNodeId}:run-dispatch`);
                if (!edges.some((e) => e.id === edgeId)) {
                  edges.push({
                    id: edgeId,
                    source: activeRun.coordinatorNodeId,
                    target: targetNodeId,
                    kind: 'delegates',
                    evidence: 'run-dispatch',
                    active: targetNode.state === 'working',
                  });
                }
              }
            }
          }
        }
      } catch {
        partial = true;
      }
    }

    const tasks: Task[] = [];
    const activities: Activity[] = [];

    // I. Collect Tasks for active run
    if (activeRun) {
      try {
        const taskRes = await runOrca<any>(['orchestration', 'task-list', '--run', activeRun.sourceRunId, '--json'], runner);
        const rawTasks: any[] = taskRes.result?.tasks ?? [];

        for (const t of rawTasks) {
          const taskId = hashId('task', `${activeRun.id}:${t.id}`);
          const assigneeNodeId = t.assignee_handle ? terminalHandleToNodeId.get(t.assignee_handle) || null : null;
          const tState = mapToState(t.status);

          let depIds: Id[] = [];
          if (typeof t.deps === 'string') {
            try {
              const parsed = JSON.parse(t.deps);
              if (Array.isArray(parsed)) {
                depIds = parsed.map((d: any) => hashId('task', `${activeRun!.id}:${d}`));
              }
            } catch {
              // deps parsing
            }
          } else if (Array.isArray(t.deps)) {
            depIds = t.deps.map((d: any) => hashId('task', `${activeRun!.id}:${d}`));
          }

          const taskObj: Task = {
            id: taskId,
            runId: activeRun.id,
            title: t.task_title || t.id,
            spec: t.spec || null,
            specTruncated: Boolean(t.spec_truncated),
            rawStatus: String(t.status || 'unknown'),
            state: tState,
            assigneeNodeId,
            result: t.result || null,
            dependencyIds: depIds,
            createdAt: toIsoOrNull(t.created_at),
            completedAt: toIsoOrNull(t.completed_at),
          };
          tasks.push(taskObj);

          if (assigneeNodeId) {
            const assigneeNode = nodeMap.get(assigneeNodeId);
            if (assigneeNode) {
              assigneeNode.taskIds.push(taskId);
              assigneeNode.runId = activeRun.id;
              if (t.result && !assigneeNode.taskOutcome) assigneeNode.taskOutcome = t.result;
            }
          }

          // Build activity entry from task
          if (t.status) {
            activities.push({
              id: hashId('act', `${taskId}:${t.status}:${t.created_at || attemptedAt}`),
              nodeId: assigneeNodeId,
              taskId,
              at: toIsoOrNull(t.completed_at || t.created_at) || attemptedAt,
              timestampKind: (t.completed_at || t.created_at) ? 'source' : 'observed',
              kind: 'task-status',
              text: `Task '${t.task_title || t.id}' status: ${t.status}`,
            });
          }
        }
      } catch {
        partial = true;
      }
    }

    // J. Progress calculation
    let completed = 0;
    let failed = 0;
    let working = 0;
    let waiting = 0;
    let blocked = 0;
    let unknown = 0;

    for (const t of tasks) {
      if (t.state === 'completed') completed++;
      else if (t.state === 'failed') failed++;
      else if (t.state === 'working') working++;
      else if (t.state === 'waiting') waiting++;
      else if (t.state === 'blocked') blocked++;
      else unknown++;
    }

    const total = tasks.length;
    const progressCoverage = !activeRun ? 'unavailable' : partial ? 'partial' : 'complete';
    const percent = (total > 0 && progressCoverage === 'complete') ? Math.floor((completed / total) * 100) : null;

    const progress: Progress = {
      total,
      completed,
      failed,
      working,
      waiting,
      blocked,
      unknown,
      percent,
      coverage: progressCoverage,
      basis: 'completed-tasks',
    };

    // Node activities
    for (const n of nodes) {
      if (n.lastActivityAt) {
        activities.push({
          id: hashId('act', `${n.id}:${n.state}:${n.lastActivityAt}`),
          nodeId: n.id,
          taskId: null,
          at: n.lastActivityAt,
          timestampKind: 'source',
          kind: n.kind === 'agent' ? 'agent-status' : 'output-observed',
          text: `${n.label} state: ${n.state}`,
        });
      }
    }

    activities.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const boundedActivity = activities.slice(0, 100);

    const observedAt = new Date().toISOString();
    return {
      graph: {
        runs: associatedRuns,
        selectedRunId: activeRun?.id ?? null,
        nodes,
        edges,
        tasks,
        progress,
        activity: boundedActivity,
      },
      meta: {
        availability: nodes.length > 0 ? 'ready' : 'empty',
        observedAt,
        attemptedAt,
        stale: false,
        partial,
        issue: null,
      },
      runtimeId,
      appVersion: globalSourceMaps.observedAppVersion,
    };
  } catch (err: any) {
    if (err instanceof CliError && (err.issue.code === 'PROJECT_NOT_FOUND' || err.issue.code === 'RUN_NOT_FOUND')) {
      throw err;
    }
    return {
      graph: {
        runs: [],
        selectedRunId: null,
        nodes: [],
        edges: [],
        tasks: [],
        progress: {
          total: 0,
          completed: 0,
          failed: 0,
          working: 0,
          waiting: 0,
          blocked: 0,
          unknown: 0,
          percent: null,
          coverage: 'unavailable',
          basis: 'completed-tasks',
        },
        activity: [],
      },
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: true,
        issue: {
          code: err.issue?.code || 'RUNTIME_UNAVAILABLE',
          message: err.message || 'Failed to collect graph data',
          retryable: true,
        },
      },
      runtimeId,
      appVersion: globalSourceMaps.observedAppVersion,
    };
  }
}

// 3. Read node details & output
export async function collectNodeDetails(
  projectId: Id,
  nodeId: Id,
  options?: { cursor?: string | null; limit?: number; preloadedGraph?: Graph },
  runner: CommandRunner = defaultCommandRunner
): Promise<NodeDetails> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const graph = options?.preloadedGraph ?? (await collectGraph(projectId, null, runner)).graph;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new CliError('NODE_NOT_FOUND', `Node ${nodeId} not found in project ${projectId}`);
  }

  const tasks = graph.tasks.filter((t) => node.taskIds.includes(t.id));
  const activity = graph.activity.filter((a) => a.nodeId === nodeId);

  const nodeSource = globalSourceMaps.nodeSourceMap.get(nodeId);
  const handle = nodeSource?.handle;

  let lines: string[] = [];
  let source: 'screen' | 'terminal' | 'transcript' | 'unknown' = 'unknown';
  let nextCursor: string | null = null;
  let limited = false;
  let truncated = false;
  let outputMeta: SourceMeta = {
    availability: handle ? 'ready' : 'empty',
    observedAt: new Date().toISOString(),
    attemptedAt: new Date().toISOString(),
    stale: false,
    partial: false,
    issue: null,
  };

  if (handle) {
    try {
      const readArgs = ['terminal', 'read', '--terminal', handle, '--limit', String(limit)];
      if (options?.cursor) {
        readArgs.push('--cursor', options.cursor);
      }
      readArgs.push('--json');

      const readRes = await runOrca<any>(readArgs, runner);
      const termData = readRes.result?.terminal;
      if (termData) {
        const rawTail: string[] = Array.isArray(termData.tail) ? termData.tail : [];
        lines = rawTail.map((l) => stripAnsi(l));
        source = termData.source === 'stream' ? 'terminal' : termData.source === 'screen' ? 'screen' : 'transcript';
        nextCursor = termData.nextCursor || termData.latestCursor || null;
        limited = Boolean(termData.limited);
        truncated = Boolean(termData.truncated);
      }
    } catch (err: any) {
      outputMeta = {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: true,
        issue: {
          code: err.issue?.code || 'CLI_FAILED',
          message: err.message || 'Failed to read terminal output',
          retryable: true,
        },
      };
    }
  }

  return {
    node,
    tasks,
    activity,
    currentTool: null, // Populated if active tool state is known
    output: {
      data: {
        lines,
        source,
        cursor: options?.cursor ?? null,
        nextCursor,
        limited,
        truncated,
      },
      meta: outputMeta,
    },
  };
}
