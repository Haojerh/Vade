import type {
  AgentCatalogResponse,
  AgentHistoryPage,
  AgentPreferences,
  AgentSkillSummary,
  CreateAgentResponse,
  HandoffSessionRequest,
  HandoffSessionResponse,
  HandoffWorktree,
  ResumeHistoryRequest,
  Section,
  SessionHandoff,
} from '../../shared/contracts';
import { readTerminalShell } from '../app/terminalShellPreference';
import { handleResponse } from './http';
import { currentTabCloseRevision, markTabClosed, retireClosedTab } from './nodes';

let catalogCache: { value: AgentCatalogResponse; expires: number } | null = null;
let catalogPending: Promise<AgentCatalogResponse> | null = null;
let catalogGeneration = 0;

export function cachedAgentCatalog(): AgentCatalogResponse | null {
  return catalogCache && Date.now() < catalogCache.expires ? catalogCache.value : null;
}

export async function fetchAgentCatalog(signal?: AbortSignal, force = false): Promise<AgentCatalogResponse> {
  signal?.throwIfAborted();
  const cached = !force && cachedAgentCatalog();
  if (cached) return cached;
  if (!catalogPending) {
    const generation = catalogGeneration;
    const pending = fetch('/api/agents/catalog', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      .then(handleResponse<AgentCatalogResponse>)
      .then(value => {
        if (generation === catalogGeneration) catalogCache = { value, expires: Date.now() + 15000 };
        return value;
      })
      .finally(() => { if (catalogPending === pending) catalogPending = null; });
    catalogPending = pending;
  }
  // Callers cancel their own subscription, without cancelling another picker's shared read.
  const result = await catalogPending;
  signal?.throwIfAborted();
  return result;
}

export async function fetchAgentPreferences(signal?: AbortSignal): Promise<AgentPreferences> {
  return handleResponse(await fetch('/api/agents/settings', { signal }));
}

export async function saveAgentPreferences(value: AgentPreferences, signal?: AbortSignal): Promise<AgentPreferences> {
  const next = await handleResponse<AgentPreferences>(await fetch('/api/agents/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    signal,
  }));
  catalogGeneration++;
  catalogCache = null;
  catalogPending = null;
  return next;
}

let skillsCache: { value: Section<AgentSkillSummary[]>; expires: number } | null = null;
let skillsPending: Promise<Section<AgentSkillSummary[]>> | null = null;

/** Installed personal skills for composer references. The read is shared so several
 *  composers on screen never repeat it, and a stale result is never reported as fresh. */
export async function fetchAgentSkills(signal?: AbortSignal, force = false): Promise<Section<AgentSkillSummary[]>> {
  signal?.throwIfAborted();
  if (!force && skillsCache && Date.now() < skillsCache.expires) return skillsCache.value;
  if (!skillsPending) {
    const pending = fetch('/api/skills', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      .then(handleResponse<Section<AgentSkillSummary[]>>)
      .then(value => { skillsCache = { value, expires: Date.now() + 30000 }; return value; })
      .finally(() => { if (skillsPending === pending) skillsPending = null; });
    skillsPending = pending;
  }
  const result = await skillsPending;
  signal?.throwIfAborted();
  return result;
}

export async function fetchAgentHistory(
  query: { scope: string; projectId?: string; worktreeId?: string; search?: string; offset?: number; refresh?: boolean },
  signal?: AbortSignal,
): Promise<AgentHistoryPage> {
  const params = new URLSearchParams({ scope: query.scope });
  for (const key of ['projectId', 'worktreeId', 'search'] as const) if (query[key]) params.set(key, query[key]!);
  if (query.offset) params.set('offset', String(query.offset));
  if (query.refresh) params.set('refresh', '1');
  return handleResponse(await fetch(`/api/agent-history?${params}`, { signal }));
}

export async function resumeHistorySession(projectId: string, request: ResumeHistoryRequest): Promise<{ projectId: string; nodeId: string }> {
  const revision = currentTabCloseRevision();
  const result = await handleResponse<{ projectId: string; nodeId: string }>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/resume-history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }));
  retireClosedTab(result.projectId, result.nodeId, revision);
  return result;
}

export async function handoffSession(
  projectId: string,
  nodeId: string,
  request?: HandoffSessionRequest,
): Promise<HandoffSessionResponse | SessionHandoff> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/${request ? 'handoff' : 'handoff-message'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request ?? {}),
  }));
}

export async function fetchHandoffWorktrees(projectId: string, nodeId: string, signal?: AbortSignal): Promise<HandoffWorktree[]> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/handoff`, {
    headers: { Accept: 'application/json' },
    signal,
  }));
}

export async function createWorktreeAgent(
  projectId: string,
  nodeId: string,
  command: string,
  title?: string,
  signal?: AbortSignal,
): Promise<CreateAgentResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/create-agent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ command, title, ...(command === 'terminal' ? { shell: readTerminalShell() } : {}) }),
      signal,
    },
  );
  const result = await handleResponse<CreateAgentResponse>(res);
  window.dispatchEvent(new CustomEvent('ade:session-created', { detail: { projectId } }));
  return result;
}

export async function closeAgentTab(
  projectId: string,
  nodeId: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/close-tab`,
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal,
    },
  );
  const result = await handleResponse<{ ok: boolean; message?: string }>(res);
  if (result.ok) {
    markTabClosed(projectId, nodeId);
  }
  return result;
}
