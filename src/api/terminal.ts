import type {
  InterruptAgentRequest,
  InterruptAgentResponse,
  TerminalAttachmentsRequest,
  TerminalInputRequest,
  TerminalPage,
  TerminalResizeRequest,
} from '../../shared/contracts';
import { encodeMessageFiles, handleResponse } from './http';

export async function fetchTerminal(projectId: string, nodeId: string, cursor: number, signal?: AbortSignal): Promise<TerminalPage> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/terminal?cursor=${cursor}`, { signal }));
}

const pendingResumes = new Map<string, Promise<void>>();
export function resumeTerminal(projectId: string, nodeId: string): Promise<void> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/resume`;
  const pending = pendingResumes.get(url);
  if (pending) return pending;
  const operation = (async () => {
    await handleResponse(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  })().finally(() => pendingResumes.delete(url));
  pendingResumes.set(url, operation);
  return operation;
}

export async function updateTerminal(
  projectId: string,
  nodeId: string,
  action: 'input' | 'resize',
  data: TerminalInputRequest | TerminalResizeRequest,
  signal?: AbortSignal,
): Promise<void> {
  await handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/terminal-${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  }));
}

export async function interruptAgent(projectId: string, nodeId: string): Promise<InterruptAgentResponse> {
  const request: InterruptAgentRequest = {};
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/interrupt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }));
}

const openingTerminals = new Map<string, Promise<TerminalPage>>();
/** Share one opening-time recovery across Chat mounts. Observed exits stay stopped. */
export function openChatTerminal(projectId: string, nodeId: string): Promise<TerminalPage> {
  const key = `${projectId}:${nodeId}`;
  const pending = openingTerminals.get(key);
  if (pending) return pending;
  const operation = (async () => {
    let page = await fetchTerminal(projectId, nodeId, 0);
    if (!page.live && page.recoverable) {
      await resumeTerminal(projectId, nodeId);
      page = await fetchTerminal(projectId, nodeId, 0);
    }
    return page;
  })().finally(() => openingTerminals.delete(key));
  openingTerminals.set(key, operation);
  return operation;
}

export async function pasteTerminalImages(projectId: string, nodeId: string, files: File[], signal?: AbortSignal): Promise<void> {
  const request: TerminalAttachmentsRequest = { attachments: await encodeMessageFiles(files) };
  if (signal?.aborted) return;
  await handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/terminal-attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  }));
}
