import type { DashboardSnapshot, NodeDetails, NodeDetailsQuery } from '../../shared/contracts';
import { handleResponse } from './http';

let tabCloseRevision = 0;
const closedTabs = new Map<string, number>();

export function currentTabCloseRevision(): number {
  return tabCloseRevision;
}

export function retireClosedTab(projectId: string, nodeId: string, revision: number): void {
  const key = `${projectId}:${nodeId}`;
  // Resume reuses the original node ID. Retire its old close marker, but never
  // undo another close performed while this request was in flight.
  if ((closedTabs.get(key) ?? 0) <= revision) {
    closedTabs.delete(key);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ade:session-created', { detail: { projectId } }));
    }
  }
}

export function markTabClosed(projectId: string, nodeId: string): void {
  closedTabs.set(`${projectId}:${nodeId}`, ++tabCloseRevision);
  if (closedTabs.size > 2000) closedTabs.delete(closedTabs.keys().next().value!);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('ade:session-closed', { detail: { projectId, nodeId } }));
  }
}

export function withoutClosedTabs(snapshot: DashboardSnapshot): DashboardSnapshot {
  if (!snapshot.graph.data || !closedTabs.size) return snapshot;
  const nodes = snapshot.graph.data.nodes.filter(node => !closedTabs.has(`${snapshot.projectId}:${node.id}`));
  if (nodes.length === snapshot.graph.data.nodes.length) return snapshot;
  const ids = new Set(nodes.map(node => node.id));
  return {
    ...snapshot,
    graph: {
      ...snapshot.graph,
      data: {
        ...snapshot.graph.data,
        nodes,
        edges: snapshot.graph.data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
      },
    },
  };
}

export async function fetchSnapshot(
  projectId: string,
  runId?: string | null,
  signal?: AbortSignal,
): Promise<DashboardSnapshot> {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/snapshot${query}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return withoutClosedTabs(await handleResponse<DashboardSnapshot>(res));
}

export async function fetchNodeDetails(
  projectId: string,
  nodeId: string,
  options?: NodeDetailsQuery,
  signal?: AbortSignal,
): Promise<NodeDetails> {
  const params = new URLSearchParams();
  if (options?.runId) params.set('runId', options.runId);
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.direction) params.set('direction', options.direction);
  if (options?.limit !== undefined && options?.limit !== null) {
    params.set('limit', String(options.limit));
  }
  const queryString = params.toString() ? `?${params.toString()}` : '';

  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}${queryString}`,
    {
      headers: { Accept: 'application/json' },
      signal,
    },
  );
  return handleResponse<NodeDetails>(res);
}
