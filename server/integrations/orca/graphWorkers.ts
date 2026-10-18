import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Id, Run, Node, Edge } from '../../../shared/contracts.js';
import { runOrca, CommandRunner } from '../cli.js';
import { readAntigravityModel } from '../../providers/antigravity.js';
import { transcriptSettings } from '../../providers/shared.js';
import { openCodeDatabase, readOpenCodeModel, findOpenCodeSession } from '../../providers/opencode.js';
import {
  hashId,
  mapToState,
  normalizeLiveness,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
  readBoundedTranscriptLines,
  toIsoOrNull,
} from './utils.js';
import { globalSourceMaps, workerLaunchCache, NodeSourceEntry } from './state.js';

function workerDispatchId(w: any): string | null {
  return w.dispatchId || (typeof w.id === 'string' && w.id.startsWith('ctx_') ? w.id : null);
}

function lookupTerminalResourceRow(
  handle: string
): { owner_dispatch_id?: string; origin_dispatch_id?: string; endpoint_incarnation?: string } | null {
  let db: DatabaseSync | null = null;
  try {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const orchDb = path.join(appData, 'orca', 'orchestration.db');
    if (!fs.existsSync(orchDb)) return null;
    db = new DatabaseSync(orchDb, { readOnly: true });
    return (
      (db
        .prepare(
          'SELECT owner_dispatch_id, origin_dispatch_id, endpoint_incarnation FROM worker_terminal_resources WHERE terminal_handle = ?'
        )
        .get(handle) as any) || null
    );
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function selectDisambiguatedWorker(
  workersList: any[],
  handle: string,
  targetNodeId: Id,
  targetSource: NodeSourceEntry | undefined,
  nodeMap: Map<Id, Node>
): any | null {
  if (workersList.length === 1) {
    return workersList[0];
  }

  const materialized = workersList.filter(
    (w) => w.resource && w.resource.state !== 'absent' && w.projection?.stage?.detail !== 'agent_readiness'
  );
  let candidates = materialized.length > 0 ? materialized : workersList;

  if (targetSource?.endpointIncarnation) {
    const incMatch = candidates.filter((w) => w.resource?.endpointIncarnation === targetSource.endpointIncarnation);
    if (incMatch.length > 0) candidates = incMatch;
  }

  const ownerMatch = candidates.filter((w) => {
    const dispId = workerDispatchId(w);
    return dispId && (w.resource?.ownerDispatchId === dispId || w.resource?.originDispatchId === dispId);
  });

  if (ownerMatch.length === 1) return ownerMatch[0];
  if (candidates.length === 1) return candidates[0];

  const targetNode = nodeMap.get(targetNodeId);
  if (targetNode && targetNode.taskIds.length > 0) {
    const taskMatch = candidates.filter((w) => targetNode.taskIds.includes(w.taskId));
    if (taskMatch.length === 1) return taskMatch[0];
  }

  const resRow = lookupTerminalResourceRow(handle);
  if (resRow?.owner_dispatch_id) {
    const dbMatch = candidates.find((w) => workerDispatchId(w) === resRow.owner_dispatch_id);
    if (dbMatch) return dbMatch;
  }

  return null;
}

function lookupWorkerSettingsFromHookStatus(
  handle: string,
  paneKey?: string
): { model: string | null; effort: string | null } {
  try {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');
    if (!fs.existsSync(lastStatusPath)) return { model: null, effort: null };

    const raw = JSON.parse(fs.readFileSync(lastStatusPath, 'utf-8'));
    const entries = raw.entries || {};
    for (const k of Object.keys(entries)) {
      const ent = entries[k];
      if (
        ent.handle === handle ||
        ent.terminalHandle === handle ||
        ent.paneKey === handle ||
        (paneKey && ent.paneKey === paneKey) ||
        k === handle
      ) {
        const m = ent.payload?.model || ent.turn_context?.model || ent.payload?.turn_context?.model || null;
        const ef = ent.payload?.effort || ent.turn_context?.effort || ent.payload?.turn_context?.effort || null;
        return {
          model: m ? String(m) : null,
          effort: ef ? String(ef) : null,
        };
      }
    }
  } catch {}
  return { model: null, effort: null };
}

async function resolveOriginDispatchSettings(
  originDispatchId: string,
  endpointIncarnation: string | null,
  handle: string,
  runner: CommandRunner
): Promise<{ model: string | null; effort: string | null }> {
  const originCacheKey = `${originDispatchId}::${endpointIncarnation || ''}`;
  if (workerLaunchCache.has(originCacheKey)) {
    return workerLaunchCache.get(originCacheKey)!;
  }

  try {
    const originRes = await runOrca<any>(
      ['orchestration', 'worker-show', '--dispatch', originDispatchId, '--json'],
      runner
    );
    const originWorker = originRes.result?.worker;
    const originInc =
      originWorker?.resource?.endpointIncarnation ||
      originWorker?.endpointIncarnation ||
      originRes.result?.terminalResource?.endpointIncarnation ||
      originRes.result?.dispatch?.processIncarnation ||
      (originRes.result?.terminal?.ptyId && originRes.result?.terminal?.incarnationId
        ? `${originRes.result.terminal.ptyId}:${originRes.result.terminal.incarnationId}`
        : null) ||
      null;
    const originHandle =
      originWorker?.agentTerminalHandle ||
      originWorker?.terminalHandle ||
      originRes.result?.terminal?.handle ||
      originRes.result?.dispatch?.assigneeHandle ||
      null;

    const sameIncarnation = Boolean(endpointIncarnation && originInc && originInc === endpointIncarnation);
    const sameHandle = Boolean(handle && originHandle && originHandle === handle);
    if (sameIncarnation && sameHandle) {
      const originLaunch = originWorker?.startOptions?.launch;
      const entry = {
        model: originLaunch?.effective?.model || null,
        effort: originLaunch?.effective?.effort || null,
      };
      workerLaunchCache.set(originCacheKey, entry);
      return entry;
    }
  } catch (originErr) {
    if (process.env.NODE_ENV !== 'test') {
      const msg = originErr instanceof Error ? originErr.message : String(originErr);
      console.debug(`[collectGraph] worker-show failed for originDispatch ${originDispatchId}: ${msg}`);
    }
  }

  const emptyEntry = { model: null, effort: null };
  workerLaunchCache.set(originCacheKey, emptyEntry);
  return emptyEntry;
}

async function resolveWorkerModelAndEffort(
  w: any,
  handle: string,
  targetSource: NodeSourceEntry | undefined,
  runner: CommandRunner
): Promise<{ model: string | null; effort: string | null }> {
  let workerModel: string | null =
    w.startOptions?.launch?.effective?.model ||
    w.projection?.provider?.model ||
    w.projection?.session?.model ||
    w.startOptions?.launch?.model ||
    w.model ||
    null;
  let workerEffort: string | null =
    w.startOptions?.launch?.effective?.effort ||
    w.projection?.provider?.effort ||
    w.projection?.session?.effort ||
    w.startOptions?.launch?.effort ||
    w.effort ||
    null;

  const dispId = workerDispatchId(w);
  let endpointIncarnation = w.resource?.endpointIncarnation || targetSource?.endpointIncarnation || null;
  let originDispatchId = w.resource?.originDispatchId || null;

  if (!endpointIncarnation || !originDispatchId) {
    const resRow = lookupTerminalResourceRow(handle);
    if (resRow) {
      if (!endpointIncarnation && resRow.endpoint_incarnation) endpointIncarnation = resRow.endpoint_incarnation;
      if (!originDispatchId && resRow.origin_dispatch_id) originDispatchId = resRow.origin_dispatch_id;
    }
  }

  const cacheKey = dispId ? `${dispId}::${endpointIncarnation || ''}` : null;
  if (!cacheKey || (workerModel && workerEffort)) {
    return {
      model: workerModel ? String(workerModel) : null,
      effort: workerEffort ? String(workerEffort) : null,
    };
  }

  if (workerLaunchCache.has(cacheKey)) {
    const cached = workerLaunchCache.get(cacheKey)!;
    if (!workerModel && cached.model) workerModel = cached.model;
    if (!workerEffort && cached.effort) workerEffort = cached.effort;
    return {
      model: workerModel ? String(workerModel) : null,
      effort: workerEffort ? String(workerEffort) : null,
    };
  }

  let effModel: string | null = null;
  let effEffort: string | null = null;
  try {
    const showRes = await runOrca<any>(['orchestration', 'worker-show', '--dispatch', dispId!, '--json'], runner);
    const launch = showRes.result?.worker?.startOptions?.launch;
    effModel = launch?.effective?.model || null;
    effEffort = launch?.effective?.effort || null;
    if (!originDispatchId && showRes.result?.terminalResource?.originDispatchId) {
      originDispatchId = showRes.result.terminalResource.originDispatchId;
    }
  } catch (showErr) {
    if (process.env.NODE_ENV !== 'test') {
      const msg = showErr instanceof Error ? showErr.message : String(showErr);
      console.debug(`[collectGraph] worker-show failed for dispatch ${dispId}: ${msg}`);
    }
  }

  if ((!effModel || !effEffort) && originDispatchId && originDispatchId !== dispId) {
    const originSettings = await resolveOriginDispatchSettings(originDispatchId, endpointIncarnation, handle, runner);
    if (!effModel && originSettings.model) effModel = originSettings.model;
    if (!effEffort && originSettings.effort) effEffort = originSettings.effort;
  }

  if (!effModel || !effEffort) {
    const hookSettings = lookupWorkerSettingsFromHookStatus(handle, targetSource?.paneKey);
    if (!effModel && hookSettings.model) effModel = hookSettings.model;
    if (!effEffort && hookSettings.effort) effEffort = hookSettings.effort;
  }

  workerLaunchCache.set(cacheKey, { model: effModel, effort: effEffort });
  if (!workerModel && effModel) workerModel = effModel;
  if (!workerEffort && effEffort) workerEffort = effEffort;

  return {
    model: workerModel ? String(workerModel) : null,
    effort: workerEffort ? String(workerEffort) : null,
  };
}

function applyWorkerStateAndLiveness(targetNode: Node, w: any): void {
  const stageState = mapToState(w.projection?.stage?.activity);
  const workerMappedState = mapToState(w.workerState);
  if (stageState !== 'unknown') {
    targetNode.rawState = w.projection.stage.activity;
    targetNode.state = stageState;
  } else if (workerMappedState !== 'unknown') {
    targetNode.rawState = w.workerState;
    targetNode.state = workerMappedState;
  } else if (w.projection?.stage?.activity) {
    targetNode.rawState = w.projection.stage.activity;
    targetNode.state = stageState;
  } else if (w.workerState) {
    targetNode.rawState = w.workerState;
    targetNode.state = workerMappedState;
  }

  if (w.projection?.outcome) {
    targetNode.taskOutcome = w.projection.outcome;
  } else if (w.outcome) {
    targetNode.taskOutcome = w.outcome;
  }

  if (w.projection?.liveness?.verdict) {
    const normLiveness = normalizeLiveness(w.projection.liveness.verdict);
    const keepConnectedLive =
      normLiveness === 'unverifiable' &&
      targetNode.liveness === 'live' &&
      (w.projection.liveness?.reason === 'missing_status' ||
        targetNode.preview?.includes('5h limit') ||
        targetNode.preview?.includes('heads up'));
    if (!keepConnectedLive) {
      targetNode.liveness = normLiveness;
    }
  }

  if (targetNode.preview && (targetNode.preview.includes('5h limit') || targetNode.preview.includes('heads up'))) {
    if (targetNode.liveness === 'unverifiable' || targetNode.liveness === 'unknown') {
      targetNode.liveness = 'live';
    }
    if (targetNode.state === 'unknown') {
      targetNode.state = 'working';
    }
  }

  if (w.projection?.liveness?.observedAt) {
    targetNode.observedAt = toIsoOrNull(w.projection.liveness.observedAt) || targetNode.observedAt;
  }
}

export async function bindActiveRunWorkers(
  projectId: Id,
  activeRun: Run | null,
  nodeMap: Map<Id, Node>,
  terminalHandleToNodeId: Map<string, Id>,
  edges: Edge[],
  runner: CommandRunner
): Promise<{ partial: boolean }> {
  let partial = false;
  if (!activeRun) {
    for (const key of Array.from(globalSourceMaps.dispatchMap.keys())) {
      if (key.startsWith(`${projectId}::`)) {
        globalSourceMaps.dispatchMap.delete(key);
      }
    }
    return { partial };
  }

  const coordinator = activeRun.coordinatorNodeId && nodeMap.get(activeRun.coordinatorNodeId);
  if (coordinator) coordinator.runId = activeRun.id;

  for (const key of Array.from(globalSourceMaps.dispatchMap.keys())) {
    if (key.startsWith(`${projectId}::${activeRun.id}::`)) {
      globalSourceMaps.dispatchMap.delete(key);
    }
  }

  try {
    const activeWorkers: any[] = [];
    let workerCursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const listArgs = ['orchestration', 'worker-list', '--run', activeRun.sourceRunId, '--limit', '100'];
      if (workerCursor) listArgs.push('--cursor', workerCursor);
      listArgs.push('--json');
      const workersRes = await runOrca<any>(listArgs, runner);
      const pageWorkers: any[] = workersRes.result?.workers ?? [];
      activeWorkers.push(...pageWorkers);
      const nextCursor = workersRes.result?.page?.nextCursor ?? workersRes.result?.nextCursor;
      if (!nextCursor || pageWorkers.length === 0) break;
      workerCursor = nextCursor;
    }

    const handleToWorkers = new Map<string, any[]>();
    for (const w of activeWorkers) {
      const handle = w.agentTerminalHandle || w.resource?.terminalHandle;
      if (!handle) continue;
      const list = handleToWorkers.get(handle);
      if (list) list.push(w);
      else handleToWorkers.set(handle, [w]);
    }

    const handleToSelectedWorker = new Map<string, any>();

    for (const [handle, workersList] of handleToWorkers.entries()) {
      const targetNodeId = terminalHandleToNodeId.get(handle);
      if (!targetNodeId) continue;

      const dispatchKey = `${projectId}::${activeRun.id}::${targetNodeId}`;
      const targetSource = globalSourceMaps.nodeSourceMap.get(targetNodeId);
      const selectedWorker = selectDisambiguatedWorker(workersList, handle, targetNodeId, targetSource, nodeMap);

      if (!selectedWorker && workersList.length > 1) {
        globalSourceMaps.dispatchMap.set(dispatchKey, { dispatchId: '', ambiguous: true });
        continue;
      }
      if (!selectedWorker) continue;

      handleToSelectedWorker.set(handle, selectedWorker);
      const dispId = workerDispatchId(selectedWorker);
      const toolInfo = selectedWorker.projection?.tool?.name
        ? {
            name: String(selectedWorker.projection.tool.name),
            input: selectedWorker.projection.tool.input ? String(selectedWorker.projection.tool.input) : null,
          }
        : null;
      if (dispId) {
        globalSourceMaps.dispatchMap.set(dispatchKey, {
          dispatchId: dispId,
          ambiguous: false,
          tool: toolInfo,
        });
      }
    }

    const existingEdgeIds = new Set(edges.map((e) => e.id));

    for (const [handle, w] of handleToSelectedWorker.entries()) {
      const targetNodeId = terminalHandleToNodeId.get(handle);
      if (!targetNodeId) continue;
      const targetNode = nodeMap.get(targetNodeId);
      if (!targetNode) continue;

      targetNode.runId = activeRun.id;
      applyWorkerStateAndLiveness(targetNode, w);

      const targetSource = globalSourceMaps.nodeSourceMap.get(targetNodeId);
      const { model, effort } = await resolveWorkerModelAndEffort(w, handle, targetSource, runner);
      targetNode.model = model;
      targetNode.effort = effort;

      if (activeRun.coordinatorNodeId && activeRun.coordinatorNodeId !== targetNodeId) {
        const edgeId = hashId('edge', `${activeRun.coordinatorNodeId}->${targetNodeId}:run-dispatch`);
        if (!existingEdgeIds.has(edgeId)) {
          existingEdgeIds.add(edgeId);
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
  } catch {
    partial = true;
  }

  return { partial };
}

async function enrichNodeFromLiveHookEntry(
  node: Node,
  entry: any,
  isAllowedPath: (file: string) => boolean
): Promise<void> {
  const model = entry.payload?.model;
  const effort = entry.payload?.effort;
  if (typeof model === 'string' && model.trim()) node.model = model;
  if (typeof effort === 'string' && effort.trim()) node.effort = effort;

  if (
    node.agentType === 'antigravity' &&
    entry.providerSession?.key === 'conversation_id' &&
    typeof entry.providerSession.id === 'string'
  ) {
    const observed = readAntigravityModel(entry.providerSession.id, isAllowedPath);
    if (observed) {
      node.model = observed.model;
      node.effort = observed.effort;
    }
  }

  const transcriptPath = entry.providerSession?.transcriptPath;
  const sessionId = entry.providerSession?.id;

  if (sessionId && ['opencode', 'kilo', 'kilocode'].includes(node.agentType || '')) {
    try {
      const file = openCodeDatabase(node.agentType!, sessionId, isAllowedPath);
      const observed = file ? readOpenCodeModel(file, sessionId) : null;
      if (observed) {
        node.model = observed.model;
        node.effort = observed.effort;
      }
    } catch {}
  }

  if (
    sessionId &&
    ['claude', 'pi', 'omp'].includes(node.agentType || '') &&
    typeof transcriptPath === 'string' &&
    isAllowedPath(transcriptPath)
  ) {
    try {
      const recent = await readBoundedTranscriptLines(transcriptPath, null, 200, 512 * 1024);
      for (const line of recent.lines) {
        const record = JSON.parse(line);
        if (record.sessionId && record.sessionId !== sessionId) continue;
        const observed = transcriptSettings(record);
        if (observed.model) node.model = observed.model;
        if (observed.effort) node.effort = observed.effort;
      }
    } catch {}
  }

  if (
    node.agentType === 'codex' &&
    sessionId &&
    typeof transcriptPath === 'string' &&
    isAllowedPath(transcriptPath)
  ) {
    try {
      for (const window of [512 * 1024, 16 * 1024 * 1024]) {
        const recent = await readBoundedTranscriptLines(transcriptPath, null, 1, window, false, (line) => {
          try {
            return JSON.parse(line).type === 'turn_context';
          } catch {
            return false;
          }
        });
        if (!recent.lines.length) continue;
        const context = JSON.parse(recent.lines[0]).payload;
        if (typeof context?.model === 'string' && context.model.trim()) node.model = context.model;
        if (typeof context?.effort === 'string' && context.effort.trim()) node.effort = context.effort;
        break;
      }
    } catch {}
  }
}

export async function enrichAgentModelsAndEffort(nodes: Node[]): Promise<void> {
  const allowedRoots = getAllowedTranscriptRoots();
  const isAllowedPath = (file: string) => isPathInsideRoots(file, allowedRoots);

  // Pane hooks cover agents launched outside orchestration as well as workers.
  try {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const statusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');
    const entries = JSON.parse(fs.readFileSync(statusPath, 'utf-8')).entries ?? {};

    for (const node of nodes) {
      if (node.kind !== 'agent' && node.kind !== 'orchestrator') continue;
      const paneKey = globalSourceMaps.nodeSourceMap.get(node.id)?.paneKey;
      const entry = paneKey ? entries[paneKey] : null;
      if (
        !entry ||
        (entry.worktreeId && entry.worktreeId !== node.worktreeId) ||
        (entry.source && node.agentType && entry.source !== node.agentType)
      ) {
        continue;
      }
      await enrichNodeFromLiveHookEntry(node, entry, isAllowedPath);
    }
  } catch {}

  // For any agent nodes that didn't get model/effort from live hooks (e.g. standalone or resumed sessions)
  for (const node of nodes) {
    if (node.kind !== 'agent' && node.kind !== 'orchestrator') continue;
    if (node.model) continue;
    if (!['opencode', 'kilo', 'kilocode'].includes(node.agentType || '')) continue;

    try {
      const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
      const rawPtyId =
        nodeSource?.ptyId ||
        (nodeSource?.endpointIncarnation
          ? nodeSource.endpointIncarnation.slice(0, nodeSource.endpointIncarnation.lastIndexOf(':'))
          : null);
      const worktreePath = node.worktreeId
        ? node.worktreeId.includes('::')
          ? node.worktreeId.split('::')[1]
          : node.worktreeId
        : null;
      const found = findOpenCodeSession(node.agentType!, node.label, isAllowedPath, {
        worktreePath,
        ptyId: rawPtyId,
      });
      if (found) {
        const observed = readOpenCodeModel(found.dbPath, found.sessionId);
        if (observed?.model) node.model = observed.model;
        if (observed?.effort) node.effort = observed.effort;
      }
    } catch {}
  }
}
