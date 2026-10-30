import type {
  CommitFiles,
  CommitGraphData,
  GitHubData,
  GitHubQuery,
  Section,
  SourceActionRequest,
  SourceDiff,
} from '../../shared/contracts';
import { handleResponse } from './http';

export async function fetchCommitFiles(projectId: string, sha: string, nodeId?: string, signal?: AbortSignal): Promise<CommitFiles> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/commit-files?${new URLSearchParams({ sha, ...(nodeId ? { nodeId } : {}) })}`, { signal }));
}

export async function fetchCommitDiff(projectId: string, sha: string, path: string, nodeId?: string, signal?: AbortSignal): Promise<SourceDiff> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/commit-diff?${new URLSearchParams({ sha, path, ...(nodeId ? { nodeId } : {}) })}`, { signal }));
}

export async function fetchCommitGraph(projectId: string, nodeId?: string, signal?: AbortSignal): Promise<Section<CommitGraphData>> {
  return handleResponse<Section<CommitGraphData>>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/commit-graph${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`, { signal }));
}

export async function sourceRequest<T>(
  projectId: string,
  action: 'status' | 'diff' | 'compare' | 'action',
  values: Record<string, string> | SourceActionRequest,
  signal?: AbortSignal,
): Promise<T> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/source-control/${action}`;
  return handleResponse(await fetch(action === 'action' ? url : `${url}?${new URLSearchParams(values as Record<string, string>)}`, {
    signal,
    ...(action === 'action' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) } : {}),
  }));
}

export async function workspaceFilesRequest<T>(
  projectId: string,
  action: 'roots' | 'list' | 'read' | 'diff' | 'search' | 'save' | 'open' | 'stat' | 'action',
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/files/${action}`;
  const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== ''));
  return handleResponse(await fetch(action === 'save' || action === 'open' || action === 'action' ? url : `${url}?${query}`, {
    signal,
    ...(action === 'save' || action === 'open' || action === 'action' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) } : {}),
  }));
}

export async function fetchGitHub(
  projectId: string,
  query: GitHubQuery = { scope: 'general' },
  signal?: AbortSignal,
): Promise<GitHubData> {
  const params = new URLSearchParams();
  if (query.activity) params.set('activity', query.activity);
  if (query.page) params.set('page', String(query.page));
  if (query.scope === 'worktree') {
    params.set('scope', 'worktree');
    params.set('nodeId', query.nodeId);
  } else {
    params.set('scope', 'general');
  }
  const queryString = params.toString() ? `?${params.toString()}` : '';

  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github${queryString}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<GitHubData>(res);
}
