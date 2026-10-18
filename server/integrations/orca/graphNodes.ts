import { Id, Node, Edge } from '../../../shared/contracts.js';
import { runOrca, CommandRunner } from '../cli.js';
import {
  hashId,
  mapToState,
  normalizeLiveness,
  stripAnsi,
  isGenericShellTitle,
  toIsoOrNull,
} from './utils.js';
import { globalSourceMaps, NodeSourceEntry } from './state.js';

export interface LayoutTitles {
  tabTitleById: Map<string, string>;
  paneTitleByHandle: Map<string, string>;
  paneTitleByPaneKey: Map<string, string>;
}

export function extractLayoutTitles(visualLayouts: any[] | undefined): LayoutTitles {
  const tabTitleById = new Map<string, string>();
  const paneTitleByHandle = new Map<string, string>();
  const paneTitleByPaneKey = new Map<string, string>();

  if (!Array.isArray(visualLayouts)) {
    return { tabTitleById, paneTitleByHandle, paneTitleByPaneKey };
  }

  function collectPanes(pane: any, tabTitle: string): void {
    if (!pane || typeof pane !== 'object') return;
    if (pane.handle && typeof pane.handle === 'string') {
      paneTitleByHandle.set(pane.handle, tabTitle);
    }
    const paneKey = pane.tabId && pane.leafId ? `${pane.tabId}:${pane.leafId}` : pane.paneKey || null;
    if (paneKey) {
      paneTitleByPaneKey.set(paneKey, tabTitle);
    }
    if (pane.first) collectPanes(pane.first, tabTitle);
    if (pane.second) collectPanes(pane.second, tabTitle);
    if (Array.isArray(pane.children)) {
      for (const child of pane.children) collectPanes(child, tabTitle);
    }
    if (Array.isArray(pane.panes)) {
      for (const child of pane.panes) collectPanes(child, tabTitle);
    }
  }

  function walkLayout(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        const rawTitle = typeof tab?.title === 'string' ? stripAnsi(tab.title).trim() : '';
        if (!rawTitle || isGenericShellTitle(rawTitle)) continue;
        if (tab.tabId) tabTitleById.set(tab.tabId, rawTitle);
        if (tab.panes) collectPanes(tab.panes, rawTitle);
      }
    }
    if (node.first) walkLayout(node.first);
    if (node.second) walkLayout(node.second);
    if (Array.isArray(node.children)) {
      for (const child of node.children) walkLayout(child);
    }
    if (Array.isArray(node.items)) {
      for (const item of node.items) walkLayout(item);
    }
  }

  for (const layout of visualLayouts) {
    if (layout?.root) walkLayout(layout.root);
  }

  return { tabTitleById, paneTitleByHandle, paneTitleByPaneKey };
}

export async function fetchProjectWorktrees(
  projectEntry: { repoIds: string[]; paths: string[] },
  runner: CommandRunner
): Promise<{ projectWorktrees: any[]; runtimeId: string | null; partial: boolean }> {
  const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '200', '--json'], runner);
  const runtimeId = psRes._meta?.runtimeId ?? null;
  const allWorktrees: any[] = psRes.result?.worktrees ?? [];
  const partial = Boolean(psRes.result?.truncated);

  const repoIdSet = new Set(projectEntry.repoIds);
  const lowerPathSet = new Set(projectEntry.paths.map((p) => p.toLowerCase()));

  const projectWorktrees = allWorktrees.filter((w) => {
    if (w.repoId && repoIdSet.has(w.repoId)) return true;
    if (w.path && lowerPathSet.has(w.path.toLowerCase())) return true;
    return false;
  });

  return { projectWorktrees, runtimeId, partial };
}

export async function fetchWorktreeTerminals(
  projectWorktrees: any[],
  runner: CommandRunner
): Promise<{
  terminalsByWorktree: Map<string, any[]>;
  visualLayoutsByWorktree: Map<string, any[]>;
  partial: boolean;
}> {
  let partial = false;
  const terminalsByWorktree = new Map<string, any[]>();
  const visualLayoutsByWorktree = new Map<string, any[]>();

  for (let start = 0; start < projectWorktrees.length; start += 4) {
    await Promise.all(
      projectWorktrees.slice(start, start + 4).map(async (wt) => {
        try {
          const termRes = await runOrca<any>(
            ['terminal', 'list', '--worktree', `id:${wt.worktreeId}`, '--limit', '100', '--include-visual-layouts', '--json'],
            runner
          );
          terminalsByWorktree.set(wt.worktreeId, termRes.result?.terminals ?? []);
          visualLayoutsByWorktree.set(wt.worktreeId, termRes.result?.visualLayouts ?? []);
        } catch {
          try {
            const termResFallback = await runOrca<any>(
              ['terminal', 'list', '--worktree', `id:${wt.worktreeId}`, '--limit', '100', '--json'],
              runner
            );
            terminalsByWorktree.set(wt.worktreeId, termResFallback.result?.terminals ?? []);
          } catch {
            partial = true;
          }
        }
      })
    );
  }

  return { terminalsByWorktree, visualLayoutsByWorktree, partial };
}

function createWorktreeNode(wt: any): Node {
  const wtNodeId = hashId('node', wt.worktreeId || wt.path || wt.displayName);
  const isFolder = wt.workspaceKind === 'folder' || wt.isFolder;
  const wtLabel = isFolder
    ? `Folder: ${wt.comment?.trim() || wt.displayName || wt.repo || 'workspace'}`
    : wt.displayName || wt.comment?.trim() || wt.branch || wt.repo || 'Worktree';

  return {
    id: wtNodeId,
    kind: 'worktree',
    label: wtLabel,
    worktreeId: wt.worktreeId || null,
    runId: null,
    agentType: null,
    branch: isFolder ? null : wt.branch || null,
    path: wt.path || null,
    state: mapToState(wt.status || wt.workspaceStatus),
    rawState: wt.status || wt.workspaceStatus || null,
    workspaceStatus: wt.workspaceStatus || null,
    taskOutcome: null,
    liveness: normalizeLiveness(wt.terminalVerdict),
    model: null,
    effort: null,
    observedAt: toIsoOrNull(wt.lastActivityAt || wt.lastOutputAt),
    lastActivityAt: toIsoOrNull(wt.lastActivityAt || wt.lastOutputAt),
    stale: false,
    taskIds: [],
    preview: wt.preview ? stripAnsi(wt.preview.slice(0, 300)) : null,
    outputAvailable: Boolean(wt.preview || wt.liveTerminalCount > 0),
  };
}

function createAgentNodeFromWorktreeAgent(
  wt: any,
  ag: any,
  matchingTerminal: any,
  titles: LayoutTitles,
  fallbackIndex: number
): { node: Node; sourceEntry: NodeSourceEntry } {
  const paneKey = ag.paneKey;
  const handle = matchingTerminal?.handle;
  const agentNodeId = hashId('node', paneKey || handle || `${wt.worktreeId}:agent:${fallbackIndex}`);

  let agState = mapToState(ag.state);
  let liveness = matchingTerminal?.connected ? 'live' : normalizeLiveness(wt.terminalVerdict);
  if (
    (agState === 'unknown' || liveness === 'unverifiable') &&
    matchingTerminal?.preview &&
    (matchingTerminal.preview.includes('5h limit') || matchingTerminal.preview.includes('heads up'))
  ) {
    agState = 'working';
    liveness = 'live';
  }

  const customTabTitle =
    (paneKey && titles.paneTitleByPaneKey.get(paneKey)) ||
    (handle && titles.paneTitleByHandle.get(handle)) ||
    (matchingTerminal?.tabId && titles.tabTitleById.get(matchingTerminal.tabId)) ||
    (matchingTerminal?.title && !isGenericShellTitle(matchingTerminal.title) ? stripAnsi(matchingTerminal.title).trim() : null);

  const agLabel =
    (!isGenericShellTitle(customTabTitle) && customTabTitle) ||
    ag.taskTitle ||
    ag.displayName ||
    ag.agentType ||
    'Agent';

  const node: Node = {
    id: agentNodeId,
    kind: 'agent',
    label: agLabel,
    worktreeId: wt.worktreeId || null,
    runId: null,
    agentType: ag.agentType || matchingTerminal?.agentIdentity || null,
    branch: null,
    path: wt.path || null,
    state: agState,
    rawState: ag.state || null,
    workspaceStatus: wt.workspaceStatus || null,
    taskOutcome: null,
    liveness,
    model: ag.model || matchingTerminal?.model || null,
    effort: ag.effort || matchingTerminal?.effort || null,
    observedAt: toIsoOrNull(ag.updatedAt || ag.stateStartedAt),
    lastActivityAt: toIsoOrNull(ag.updatedAt || matchingTerminal?.lastOutputAt),
    stale: false,
    taskIds: [],
    preview: matchingTerminal?.preview ? stripAnsi(matchingTerminal.preview.slice(0, 300)) : null,
    outputAvailable: Boolean(handle),
  };

  const endpointIncarnation =
    matchingTerminal?.ptyId && matchingTerminal?.incarnationId
      ? `${matchingTerminal.ptyId}:${matchingTerminal.incarnationId}`
      : undefined;

  return {
    node,
    sourceEntry: {
      handle,
      worktreeId: wt.worktreeId,
      paneKey,
      endpointIncarnation,
      ptyId: matchingTerminal?.ptyId,
    },
  };
}

function createTerminalNode(
  wt: any,
  term: any,
  termPaneKey: string | null,
  titles: LayoutTitles
): { node: Node; sourceEntry: NodeSourceEntry } {
  const isAgent = Boolean(term.agentIdentity);
  const termNodeId = hashId('node', termPaneKey || term.handle);

  const customTabTitle =
    (term.tabId && titles.tabTitleById.get(term.tabId)) ||
    (term.handle && titles.paneTitleByHandle.get(term.handle)) ||
    (termPaneKey && titles.paneTitleByPaneKey.get(termPaneKey));

  const cleanedTermTitle = term.title ? stripAnsi(term.title).trim() : null;
  const termLabel = isAgent
    ? customTabTitle || (!isGenericShellTitle(term.title) ? cleanedTermTitle : null) || term.agentIdentity || 'Agent'
    : customTabTitle || cleanedTermTitle || `Terminal ${term.handle}`;

  const node: Node = {
    id: termNodeId,
    kind: isAgent ? 'agent' : 'terminal',
    label: termLabel,
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
    model: term.model || null,
    effort: term.effort || null,
    observedAt: toIsoOrNull(term.lastOutputAt),
    lastActivityAt: toIsoOrNull(term.lastOutputAt),
    stale: false,
    taskIds: [],
    preview: term.preview ? stripAnsi(term.preview.slice(0, 300)) : null,
    outputAvailable: Boolean(term.handle),
  };

  const endpointIncarnation =
    term.ptyId && term.incarnationId ? `${term.ptyId}:${term.incarnationId}` : undefined;

  return {
    node,
    sourceEntry: {
      handle: term.handle,
      worktreeId: wt.worktreeId,
      paneKey: termPaneKey || undefined,
      endpointIncarnation,
      ptyId: term.ptyId,
    },
  };
}

export function buildWorktreeAndAgentNodes(
  projectWorktrees: any[],
  terminalsByWorktree: Map<string, any[]>,
  visualLayoutsByWorktree: Map<string, any[]>
): {
  nodes: Node[];
  edges: Edge[];
  nodeMap: Map<Id, Node>;
  paneKeyToNodeId: Map<string, Id>;
  terminalHandleToNodeId: Map<string, Id>;
  worktreeIdToNodeId: Map<string, Id>;
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nodeMap = new Map<Id, Node>();
  const paneKeyToNodeId = new Map<string, Id>();
  const terminalHandleToNodeId = new Map<string, Id>();
  const worktreeIdToNodeId = new Map<string, Id>();

  for (const wt of projectWorktrees) {
    const wtNode = createWorktreeNode(wt);
    const wtNodeId = wtNode.id;
    worktreeIdToNodeId.set(wt.worktreeId, wtNodeId);
    nodes.push(wtNode);
    nodeMap.set(wtNodeId, wtNode);
    globalSourceMaps.nodeSourceMap.set(wtNodeId, { worktreeId: wt.worktreeId, worktreePath: wt.path });

    const terminals = terminalsByWorktree.get(wt.worktreeId) ?? [];
    const titles = extractLayoutTitles(visualLayoutsByWorktree.get(wt.worktreeId));

    const terminalByPane = new Map<string, any>();
    for (const t of terminals) {
      if (t.tabId && t.leafId) terminalByPane.set(`${t.tabId}:${t.leafId}`, t);
      if (t.paneKey) terminalByPane.set(t.paneKey, t);
    }

    const agents: any[] = Array.isArray(wt.agents) ? wt.agents : [];
    const handledTerminalHandles = new Set<string>();

    for (const ag of agents) {
      const paneKey = ag.paneKey;
      const matchingTerminal = paneKey ? terminalByPane.get(paneKey) : null;
      const handle = matchingTerminal?.handle;
      if (handle) handledTerminalHandles.add(handle);
      if (paneKey) handledTerminalHandles.add(paneKey);

      const { node: agNode, sourceEntry } = createAgentNodeFromWorktreeAgent(
        wt,
        ag,
        matchingTerminal,
        titles,
        nodes.length
      );
      if (paneKey) paneKeyToNodeId.set(paneKey, agNode.id);
      if (handle) terminalHandleToNodeId.set(handle, agNode.id);

      nodes.push(agNode);
      nodeMap.set(agNode.id, agNode);
      globalSourceMaps.nodeSourceMap.set(agNode.id, sourceEntry);

      edges.push({
        id: hashId('edge', `${wtNodeId}->${agNode.id}:membership`),
        source: wtNodeId,
        target: agNode.id,
        kind: 'contains',
        evidence: 'workspace-membership',
        active: agNode.state === 'working',
      });
    }

    for (const term of terminals) {
      const termPaneKey = term.tabId && term.leafId ? `${term.tabId}:${term.leafId}` : term.paneKey || null;
      if (handledTerminalHandles.has(term.handle) || (termPaneKey && handledTerminalHandles.has(termPaneKey))) {
        continue;
      }

      const { node: termNode, sourceEntry } = createTerminalNode(wt, term, termPaneKey, titles);
      terminalHandleToNodeId.set(term.handle, termNode.id);
      if (termPaneKey) paneKeyToNodeId.set(termPaneKey, termNode.id);

      nodes.push(termNode);
      nodeMap.set(termNode.id, termNode);
      globalSourceMaps.nodeSourceMap.set(termNode.id, sourceEntry);

      edges.push({
        id: hashId('edge', `${wtNodeId}->${termNode.id}:membership`),
        source: wtNodeId,
        target: termNode.id,
        kind: 'contains',
        evidence: 'workspace-membership',
        active: false,
      });
    }
  }

  // Pass 2: Establish parent-child and parent-pane edges now that all worktrees and panes are indexed
  for (const wt of projectWorktrees) {
    if (wt.parentWorktreeId) {
      const parentNodeId = worktreeIdToNodeId.get(wt.parentWorktreeId);
      const wtNodeId = worktreeIdToNodeId.get(wt.worktreeId);
      if (parentNodeId && wtNodeId && parentNodeId !== wtNodeId) {
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

    const agents: any[] = Array.isArray(wt.agents) ? wt.agents : [];
    for (const ag of agents) {
      if (!ag.parentPaneKey || !ag.paneKey) continue;
      const parentNodeId = paneKeyToNodeId.get(ag.parentPaneKey);
      const childNodeId = paneKeyToNodeId.get(ag.paneKey);
      if (!parentNodeId || !childNodeId || parentNodeId === childNodeId) continue;

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

  return { nodes, edges, nodeMap, paneKeyToNodeId, terminalHandleToNodeId, worktreeIdToNodeId };
}
