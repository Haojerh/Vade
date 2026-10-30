import type {
  AgentChatOptions,
  AgentInteraction,
  AnswerAgentRequest,
  CompactConversationResponse,
  NativeRewindPickerResponse,
  RewindConversationRequest,
  RewindConversationResponse,
  Section,
  SetAgentChatOptionRequest,
  Subagent,
  SubagentConversation,
} from '../../shared/contracts';
import { encodeMessageFiles, handleResponse } from './http';

export async function fetchAgentChatOptions(
  projectId: string,
  nodeId: string,
  runId: string | null,
  signal?: AbortSignal,
): Promise<Section<AgentChatOptions>> {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/chat-options${query}`, { signal }));
}

export async function setAgentChatOption(
  projectId: string,
  nodeId: string,
  runId: string | null,
  option: SetAgentChatOptionRequest,
  signal?: AbortSignal,
): Promise<AgentChatOptions> {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/chat-options${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(option),
    signal,
  }));
}

export async function fetchAgentInteraction(projectId: string, nodeId: string, signal?: AbortSignal): Promise<Section<AgentInteraction>> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/interaction`, { signal }));
}

export async function answerAgentInteraction(projectId: string, nodeId: string, value: AnswerAgentRequest, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/interaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    signal,
  }));
}

export async function rewindConversation(
  projectId: string,
  nodeId: string,
  request: RewindConversationRequest,
  signal?: AbortSignal,
): Promise<RewindConversationResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/rewind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  }));
}

export async function openNativeRewindPicker(
  projectId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<NativeRewindPickerResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/rewind-picker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal,
  }));
}

/** Submit the provider's own compaction command. `ok` reflects a fresh native
 *  acknowledgement; an unconfirmed submission is returned as a warning. */
export async function compactConversation(projectId: string, nodeId: string): Promise<CompactConversationResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }));
}

export async function sendNodeMessage(
  projectId: string,
  nodeId: string,
  message: string,
  signal?: AbortSignal,
  files: File[] = [],
  workflowConfirmed = false,
  requireIdle = false,
): Promise<{ ok: boolean; message?: string }> {
  const attachments = await encodeMessageFiles(files);
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/message`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        message,
        ...(attachments.length ? { attachments } : {}),
        ...(workflowConfirmed ? { workflowConfirmed: true } : {}),
        ...(requireIdle ? { requireIdle: true } : {}),
      }),
      signal,
    },
  );
  return handleResponse<{ ok: boolean; message?: string }>(res);
}

/** Native child agents recorded for this exact session. */
export async function fetchSubagents(projectId: string, nodeId: string, signal?: AbortSignal): Promise<Section<Subagent[]>> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/subagents`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse(res);
}

/** Public turns and observed tool calls of one recorded child agent. */
export async function fetchSubagentConversation(
  projectId: string,
  nodeId: string,
  subagentId: string,
  options?: { cursor?: string | null; limit?: number; direction?: 'older' },
  signal?: AbortSignal,
): Promise<SubagentConversation> {
  const params = new URLSearchParams();
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.direction) params.set('direction', options.direction);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString() ? `?${params}` : '';
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/subagents/${encodeURIComponent(subagentId)}/conversation${query}`,
    { headers: { Accept: 'application/json' }, signal },
  );
  return handleResponse(res);
}
