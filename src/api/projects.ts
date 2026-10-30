import type {
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DeleteProjectResponse,
  Inventory,
  LocalFolders,
  ProjectShortcut,
  RegisterProjectRequest,
  RegisterProjectResponse,
  RenameNodeTitleResponse,
  RunProjectShortcutResponse,
  Section,
} from '../../shared/contracts';
import { handleResponse } from './http';

export async function fetchProjects(signal?: AbortSignal): Promise<Section<Inventory>> {
  const res = await fetch('/api/projects', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<Section<Inventory>>(res);
}

export async function registerProject(request: string | RegisterProjectRequest, signal?: AbortSignal): Promise<RegisterProjectResponse> {
  return handleResponse(await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof request === 'string' ? { path: request } : request),
    signal,
  }));
}

export async function deleteProject(projectId: string): Promise<DeleteProjectResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }));
}

export async function fetchProjectFolders(path?: string, signal?: AbortSignal): Promise<LocalFolders> {
  return handleResponse(await fetch('/api/projects/folders' + (path ? `?path=${encodeURIComponent(path)}` : ''), { signal }));
}

export async function projectShortcutsRequest<T>(projectId: string, shortcuts?: ProjectShortcut[], signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/shortcuts`, {
    signal,
    ...(shortcuts ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortcuts }) } : {}),
  }));
}

export async function runProjectShortcutRequest(projectId: string, id: string, worktreeId: string): Promise<RunProjectShortcutResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/shortcuts/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreeId }),
  }));
}

export async function createProjectWorktree(projectId: string, body: CreateWorktreeRequest): Promise<CreateWorktreeResponse> {
  return handleResponse<CreateWorktreeResponse>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function renameWorktree(projectId: string, nodeId: string, title: string): Promise<RenameNodeTitleResponse> {
  return handleResponse<RenameNodeTitleResponse>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/rename-worktree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  }));
}

export async function deleteWorktree(
  projectId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/delete-worktree`,
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal,
    },
  );
  return handleResponse<{ ok: boolean; message?: string }>(res);
}

export async function renameNodeTitle(
  projectId: string,
  nodeId: string,
  title: string,
  signal?: AbortSignal,
): Promise<RenameNodeTitleResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/rename`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ title }),
      signal,
    },
  );
  return handleResponse<RenameNodeTitleResponse>(res);
}
