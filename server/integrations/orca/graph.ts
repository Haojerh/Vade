import fs from 'node:fs';
import path from 'node:path';
import {
  Id,
  Run,
  Node,
  Task,
  Progress,
  Activity,
  Graph,
  SourceMeta,
} from '../../../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, CliError } from '../cli.js';
import { taskProgress } from '../../services/progress.js';
import {
  hashId,
  mapToState,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
  toIsoOrNull,
} from './utils.js';
import { globalSourceMaps } from './state.js';
import {
  fetchProjectWorktrees,
  fetchWorktreeTerminals,
  buildWorktreeAndAgentNodes,
} from './graphNodes.js';
import {
  bindActiveRunWorkers,
  enrichAgentModelsAndEffort,
} from './graphWorkers.js';

function readTurnContextHeadSettings(transcriptPath: string, coordNode: Node): void {
  if (!fs.existsSync(transcriptPath)) return;
  if (!isPathInsideRoots(transcriptPath, getAllowedTranscriptRoots())) return;

  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const readBytes = Math.min(stat.size, 512 * 1024);
    if (readBytes <= 0) return;

    const buf = Buffer.alloc(readBytes);
    const n = fs.readSync(fd, buf, 0, readBytes, 0);
    const lines = buf.subarray(0, n).toString('utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'turn_context' && obj.payload) {
          if (!coordNode.model && obj.payload.model) coordNode.model = String(obj.payload.model);
          if (!coordNode.effort && obj.payload.effort) coordNode.effort = String(obj.payload.effort);
          if (coordNode.model && coordNode.effort) break;
        }
      } catch {}
    }
  } finally {
    fs.closeSync(fd);
  }
}

function enrichCoordinatorFromLastStatus(coordNode: Node, coordHandle: string | undefined): void {
  try {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');
    if (!fs.existsSync(lastStatusPath)) return;

    const raw = JSON.parse(fs.readFileSync(lastStatusPath, 'utf-8'));
    const coordPane = globalSourceMaps.nodeSourceMap.get(coordNode.id)?.paneKey;
    const entries = raw.entries || {};
    let transcriptPath: string | null = null;

    for (const k of Object.keys(entries)) {
      const ent = entries[k];
      if ((coordPane && k === coordPane) || ent.handle === coordHandle || ent.paneKey === coordHandle || k === coordHandle) {
        const cModel = ent.payload?.model || ent.turn_context?.model || ent.payload?.turn_context?.model || null;
        const cEffort = ent.payload?.effort || ent.turn_context?.effort || ent.payload?.turn_context?.effort || null;
        if (cModel) coordNode.model = String(cModel);
        if (cEffort) coordNode.effort = String(cEffort);
        if (typeof ent.providerSession?.transcriptPath === 'string') {
          transcriptPath = ent.providerSession.transcriptPath;
        }
        break;
      }
    }

    if ((!coordNode.model || !coordNode.effort) && transcriptPath) {
      readTurnContextHeadSettings(transcriptPath, coordNode);
    }
  } catch {}
}

async function discoverAssociatedRuns(
  projectId: Id,
  terminalHandleToNodeId: Map<string, Id>,
  worktreeIdToNodeId: Map<string, Id>,
  nodeMap: Map<Id, Node>,
  runner: CommandRunner
): Promise<{ associatedRuns: Run[]; partial: boolean }> {
  const associatedRuns: Run[] = [];
  let candidateRuns: any[] = [];
  let partial = false;

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
    } else if (r.coordinator_handle && terminalHandleToNodeId.has(r.coordinator_handle)) {
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
        const hasMatchingWorktree = workers.some((w) => {
          const wWorktreeId = w.resource?.worktreeId || w.projection?.workspace?.id;
          return Boolean(wWorktreeId && worktreeIdToNodeId.has(wWorktreeId));
        });
        if (hasMatchingWorktree) {
          association = 'worker-workspace';
        }
        globalSourceMaps.runAssociationCache.set(cacheKey, {
          associated: Boolean(association),
          association: association || undefined,
        });
      } catch {
        partial = true;
      }
    } else {
      partial = true;
    }

    if (!association) continue;

    const runApiId = hashId('run', r.id);
    associatedRuns.push({
      id: runApiId,
      sourceRunId: r.id,
      objective: r.objective || r.id,
      coordinatorNodeId,
      association,
    });

    if (coordinatorNodeId) {
      const coordNode = nodeMap.get(coordinatorNodeId);
      if (coordNode) {
        coordNode.kind = 'orchestrator';
        enrichCoordinatorFromLastStatus(coordNode, r.coordinator_handle);
      }
    }
  }

  return { associatedRuns, partial };
}

function resolveActiveRun(
  selectedRunId: Id | null | undefined,
  associatedRuns: Run[],
  projectId: Id
): Run | null {
  if (selectedRunId) {
    const activeRun = associatedRuns.find((r) => r.id === selectedRunId) || null;
    if (!activeRun) {
      throw new CliError('RUN_NOT_FOUND', `Run ${selectedRunId} not found in project ${projectId}`);
    }
    return activeRun;
  }
  return associatedRuns.length > 0 ? associatedRuns[0] : null;
}

function parseTaskDependencies(rawDeps: unknown, runId: Id): Id[] {
  if (typeof rawDeps === 'string') {
    try {
      const parsed = JSON.parse(rawDeps);
      if (Array.isArray(parsed)) {
        return parsed.map((d: any) => hashId('task', `${runId}:${d}`));
      }
    } catch {}
    return [];
  }
  if (Array.isArray(rawDeps)) {
    return rawDeps.map((d: any) => hashId('task', `${runId}:${d}`));
  }
  return [];
}

async function collectActiveRunTasks(
  activeRun: Run | null,
  terminalHandleToNodeId: Map<string, Id>,
  nodeMap: Map<Id, Node>,
  attemptedAt: string,
  runner: CommandRunner
): Promise<{ tasks: Task[]; taskCoverage: Progress['coverage']; taskActivities: Activity[]; partial: boolean }> {
  const tasks: Task[] = [];
  let taskCoverage: Progress['coverage'] = 'unavailable';
  const taskActivities: Activity[] = [];
  let partial = false;

  if (!activeRun) {
    return { tasks, taskCoverage, taskActivities, partial };
  }

  try {
    const taskRes = await runOrca<any>(['orchestration', 'task-list', '--run', activeRun.sourceRunId, '--json'], runner);
    if (!Array.isArray(taskRes.result?.tasks)) throw new Error('Invalid task inventory');
    const rawTasks: any[] = taskRes.result.tasks;
    taskCoverage = taskRes.result.truncated || taskRes.result.partial ? 'partial' : 'complete';
    if (taskCoverage === 'partial') partial = true;

    for (const t of rawTasks) {
      const taskId = hashId('task', `${activeRun.id}:${t.id}`);
      const assigneeNodeId = t.assignee_handle ? terminalHandleToNodeId.get(t.assignee_handle) || null : null;
      const tState = mapToState(t.status);
      const depIds = parseTaskDependencies(t.deps, activeRun.id);

      tasks.push({
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
      });

      if (assigneeNodeId) {
        const assigneeNode = nodeMap.get(assigneeNodeId);
        if (assigneeNode) {
          assigneeNode.taskIds.push(taskId);
          assigneeNode.runId = activeRun.id;
          if (t.result && !assigneeNode.taskOutcome) assigneeNode.taskOutcome = t.result;
        }
      }

      if (t.status) {
        taskActivities.push({
          id: hashId('act', `${taskId}:${t.status}:${t.created_at || attemptedAt}`),
          nodeId: assigneeNodeId,
          taskId,
          at: toIsoOrNull(t.completed_at || t.created_at) || attemptedAt,
          timestampKind: t.completed_at || t.created_at ? 'source' : 'observed',
          kind: 'task-status',
          text: `Task '${t.task_title || t.id}' status: ${t.status}`,
        });
      }
    }
  } catch {
    taskCoverage = tasks.length ? 'partial' : 'unavailable';
    partial = true;
  }

  return { tasks, taskCoverage, taskActivities, partial };
}

function buildGraphActivitiesAndProgress(
  nodes: Node[],
  tasks: Task[],
  taskCoverage: Progress['coverage'],
  taskActivities: Activity[]
): { progress: Progress; boundedActivity: Activity[] } {
  const progress = taskProgress(tasks, taskCoverage);
  const activities: Activity[] = [...taskActivities];

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
  return { progress, boundedActivity };
}

function buildEmptyGraphFailure(
  runtimeId: string | null,
  attemptedAt: string,
  err: any
): { graph: Graph; meta: SourceMeta; runtimeId: string | null; appVersion: string | null } {
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
    const wtResult = await fetchProjectWorktrees(projectEntry, runner);
    runtimeId = wtResult.runtimeId;
    if (wtResult.partial) partial = true;

    const termResult = await fetchWorktreeTerminals(wtResult.projectWorktrees, runner);
    if (termResult.partial) partial = true;

    const { nodes, edges, nodeMap, terminalHandleToNodeId, worktreeIdToNodeId } = buildWorktreeAndAgentNodes(
      wtResult.projectWorktrees,
      termResult.terminalsByWorktree,
      termResult.visualLayoutsByWorktree
    );

    const runResult = await discoverAssociatedRuns(
      projectId,
      terminalHandleToNodeId,
      worktreeIdToNodeId,
      nodeMap,
      runner
    );
    if (runResult.partial) partial = true;

    const activeRun = resolveActiveRun(selectedRunId, runResult.associatedRuns, projectId);

    const workerResult = await bindActiveRunWorkers(
      projectId,
      activeRun,
      nodeMap,
      terminalHandleToNodeId,
      edges,
      runner
    );
    if (workerResult.partial) partial = true;

    const taskResult = await collectActiveRunTasks(activeRun, terminalHandleToNodeId, nodeMap, attemptedAt, runner);
    if (taskResult.partial) partial = true;

    await enrichAgentModelsAndEffort(nodes);

    const { progress, boundedActivity } = buildGraphActivitiesAndProgress(
      nodes,
      taskResult.tasks,
      taskResult.taskCoverage,
      taskResult.taskActivities
    );

    const observedAt = new Date().toISOString();
    return {
      graph: {
        runs: runResult.associatedRuns,
        selectedRunId: activeRun?.id ?? null,
        nodes,
        edges,
        tasks: taskResult.tasks,
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
    return buildEmptyGraphFailure(runtimeId, attemptedAt, err);
  }
}
