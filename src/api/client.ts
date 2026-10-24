import { readTerminalShell } from '../app/terminalShellPreference';
export async function fetchCommitFiles(projectId:string,sha:string,nodeId?:string,signal?:AbortSignal):Promise<import('../../shared/contracts').CommitFiles>{return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/commit-files?${new URLSearchParams({sha,...(nodeId?{nodeId}:{})})}`,{signal}));}
export async function fetchCommitDiff(projectId:string,sha:string,path:string,nodeId?:string,signal?:AbortSignal):Promise<import('../../shared/contracts').SourceDiff>{return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/commit-diff?${new URLSearchParams({sha,path,...(nodeId?{nodeId}:{})})}`,{signal}));}
export async function sourceRequest<T>(projectId:string,action:'status'|'diff'|'compare'|'action',values:Record<string,string>|import('../../shared/contracts').SourceActionRequest,signal?:AbortSignal):Promise<T>{
  const url=`/api/projects/${encodeURIComponent(projectId)}/source-control/${action}`;
  return handleResponse(await fetch(action==='action'?url:`${url}?${new URLSearchParams(values as Record<string,string>)}`,{signal,...(action==='action'?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)}:{})}));
}
export async function speechRequest<T>(path: string, value?: object, signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/speech/${path}`, { signal, ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) }));
}
import type { OrganizationConfig, WorkflowSetupStatus, WorkflowModel, WorkflowProvider, WorkflowRun } from '../../shared/contracts';

export async function workflowRequest<T>(path: string, value?: object, signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/workflow/${path}`, { ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}), signal }));
}
export const fetchOrganization = (signal?: AbortSignal) => workflowRequest<OrganizationConfig>('config', undefined, signal);
export const saveOrganization = (config: OrganizationConfig) => workflowRequest<OrganizationConfig>('config', config);
export const fetchWorkflowSetup = (signal?: AbortSignal) => workflowRequest<WorkflowSetupStatus>('setup', undefined, signal);
export const fetchWorkflowModels = (provider: WorkflowProvider, signal?: AbortSignal) => workflowRequest<WorkflowModel[]>(`models?provider=${encodeURIComponent(provider)}`, undefined, signal);
export const fetchWorkflowRunSummaries=(signal?:AbortSignal)=>workflowRequest<import('../../shared/contracts').WorkflowRunSummary[]>('runs?summary=1',undefined,signal);
export const fetchWorkflowRunDetails=(id:string,signal?:AbortSignal)=>workflowRequest<WorkflowRun>(`runs/${encodeURIComponent(id)}`,undefined,signal);
export const cancelWorkflowRun = (id: string) => workflowRequest<{ ok: boolean }>(`runs/${encodeURIComponent(id)}/cancel`, {});
export async function systemRequest<T>(path: 'computer-awake' | 'resources/details' | 'ports' | `ports/${string}/stop`, value?: object, signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/${path}`, { signal, ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) }));
}
export async function projectShortcutsRequest<T>(projectId: string, shortcuts?: import('../../shared/contracts').ProjectShortcut[], signal?: AbortSignal): Promise<T> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/shortcuts`, { signal, ...(shortcuts ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shortcuts }) } : {}) }));
}
export async function runProjectShortcutRequest(projectId: string, id: string, worktreeId: string): Promise<import('../../shared/contracts').RunProjectShortcutResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/shortcuts/${encodeURIComponent(id)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worktreeId }) }));
}
import type { AgentHistoryPage, ResumeHistoryRequest } from '../../shared/contracts';

export async function fetchAgentHistory(query: { scope: string; projectId?: string; worktreeId?: string; search?: string; offset?: number; refresh?: boolean }, signal?: AbortSignal): Promise<AgentHistoryPage> {
  const params = new URLSearchParams({ scope: query.scope });
  for (const key of ['projectId', 'worktreeId', 'search'] as const) if (query[key]) params.set(key, query[key]!);
  if (query.offset) params.set('offset', String(query.offset));
  if (query.refresh) params.set('refresh', '1');
  return handleResponse(await fetch(`/api/agent-history?${params}`, { signal }));
}
export async function resumeHistorySession(projectId: string, request: ResumeHistoryRequest): Promise<{ projectId: string; nodeId: string }> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/resume-history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }));
}
export async function handoffSession(projectId: string, nodeId: string, request?: import('../../shared/contracts').HandoffSessionRequest): Promise<import('../../shared/contracts').HandoffSessionResponse | import('../../shared/contracts').SessionHandoff> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/${request ? 'handoff' : 'handoff-message'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request ?? {}) }));
}
import type { AgentPreferences, AgentInteraction, AnswerAgentRequest } from '../../shared/contracts';

export async function fetchAgentPreferences(signal?: AbortSignal): Promise<AgentPreferences> {
  return handleResponse(await fetch('/api/agents/settings', { signal }));
}
export async function saveAgentPreferences(value: AgentPreferences, signal?: AbortSignal): Promise<AgentPreferences> {
  const next = await handleResponse<AgentPreferences>(await fetch('/api/agents/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal }));
  catalogGeneration++; catalogCache = null; catalogPending = null;
  return next;
}
export async function fetchAgentInteraction(projectId: string, nodeId: string, signal?: AbortSignal): Promise<Section<AgentInteraction>> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/interaction`, { signal }));
}
export async function answerAgentInteraction(projectId: string, nodeId: string, value: AnswerAgentRequest, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal }));
}
import type {
  AgentChatOptions,
  ConversationPage,
  SetAgentChatOptionRequest,
  InboxData,
  DashboardSnapshot,
  GitHubData,
  GitHubQuery,
  HealthResponse,
  Inventory,
  NodeDetails,
  NodeDetailsQuery,
  Section,
  ApiError,
  UsageData,
  PrerequisitesStatus,
  RenameNodeTitleResponse,
  CreateAgentResponse,
  AgentCatalogResponse,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  CommitGraphData,
} from '../../shared/contracts';

export async function fetchConnections(signal?: AbortSignal, scope: 'all' | 'accounts' | 'integrations' = 'all', force = false): Promise<Section<import('../../shared/contracts').LocalConnectionsData>> {
  return handleResponse(await fetch(`/api/connections?scope=${scope}${force ? '&refresh=1' : ''}`, { signal }));
}
export async function addProviderAccount(provider: import('../../shared/contracts').AccountProvider, request: import('../../shared/contracts').AddProviderAccountRequest, signal?: AbortSignal): Promise<import('../../shared/contracts').ProviderAccount[]> {
  return handleResponse(await fetch(`/api/provider-accounts/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }));
}
export async function selectProviderAccount(provider: import('../../shared/contracts').AccountProvider, accountId: string, signal?: AbortSignal): Promise<import('../../shared/contracts').ProviderAccount[]> {
  return handleResponse(await fetch(`/api/provider-accounts/${provider}/select`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }), signal }));
}
export async function fetchResources(signal?: AbortSignal): Promise<import('../../shared/contracts').AppResources> {
  return handleResponse(await fetch('/api/resources', { signal }));
}

export async function fetchAgentChatOptions(projectId: string, nodeId: string, runId: string | null, signal?: AbortSignal): Promise<Section<AgentChatOptions>> {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/chat-options${query}`, { signal }));
}
export async function setAgentChatOption(projectId: string, nodeId: string, runId: string | null, option: SetAgentChatOptionRequest, signal?: AbortSignal): Promise<AgentChatOptions> {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/chat-options${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(option), signal,
  }));
}

export async function deleteProject(projectId: string): Promise<import('../../shared/contracts').DeleteProjectResponse> {
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }));
}

export async function fetchInbox(signal?: AbortSignal): Promise<Section<InboxData>> {
  return handleResponse<Section<InboxData>>(await fetch('/api/inbox', {
    headers: { Accept: 'application/json' }, signal,
  }));
}

export async function fetchUsage(signal?: AbortSignal, refresh = false): Promise<Section<UsageData>> {
  return handleResponse<Section<UsageData>>(await fetch(refresh ? '/api/usage?refresh=1' : '/api/usage', {
    headers: { Accept: 'application/json' }, cache: 'no-store', signal,
  }));
}

/**
 * Strips ANSI escape sequences and non-printable control characters from text.
 */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let errorMessage = `HTTP ${res.status} ${res.statusText}`;
    try {
      const cloned = res.clone();
      try {
        const errorJson = (await res.json()) as ApiError;
        if (errorJson?.error?.message) {
          errorMessage = `[${errorJson.error.code}] ${errorJson.error.message}`;
        }
      } catch {
        const text = await cloned.text();
        if (text && text.trim()) {
          errorMessage = `${errorMessage}: ${text.trim().slice(0, 200)}`;
        }
      }
    } catch {
      // Body not readable, retain default status message
    }
    throw new Error(errorMessage);
  }
  return res.json() as Promise<T>;
}

export async function registerProject(request: string | import('../../shared/contracts').RegisterProjectRequest, signal?: AbortSignal): Promise<import('../../shared/contracts').RegisterProjectResponse> {
  return handleResponse(await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(typeof request === 'string' ? { path: request } : request), signal }));
}

export async function fetchProjectFolders(path?: string, signal?: AbortSignal): Promise<import('../../shared/contracts').LocalFolders> {
  return handleResponse(await fetch('/api/projects/folders' + (path ? `?path=${encodeURIComponent(path)}` : ''), { signal }));
}

export async function fetchTerminal(projectId: string, nodeId: string, cursor: number, signal?: AbortSignal): Promise<import('../../shared/contracts').TerminalPage> {
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

export async function updateTerminal(projectId: string, nodeId: string, action: 'input' | 'resize', data: import('../../shared/contracts').TerminalInputRequest | import('../../shared/contracts').TerminalResizeRequest, signal?: AbortSignal): Promise<void> {
  await handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/terminal-${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal,
  }));
}

export async function interruptAgent(projectId:string,nodeId:string):Promise<import('../../shared/contracts').InterruptAgentResponse> {
  const request:import('../../shared/contracts').InterruptAgentRequest={};
  return handleResponse(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/interrupt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}));
}

const openingTerminals=new Map<string,Promise<import('../../shared/contracts').TerminalPage>>();
/** Share one opening-time recovery across Chat mounts. Observed exits stay stopped. */
export function openChatTerminal(projectId:string,nodeId:string) {
  const key=`${projectId}:${nodeId}`,pending=openingTerminals.get(key);if(pending)return pending;
  const operation=(async()=>{let page=await fetchTerminal(projectId,nodeId,0);if(!page.live&&page.recoverable){await resumeTerminal(projectId,nodeId);page=await fetchTerminal(projectId,nodeId,0);}return page;})().finally(()=>openingTerminals.delete(key));
  openingTerminals.set(key,operation);return operation;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<HealthResponse>(res);
}

export async function fetchPrerequisites(signal?: AbortSignal): Promise<PrerequisitesStatus> {
  const res = await fetch('/api/prerequisites', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<PrerequisitesStatus>(res);
}

export async function fetchProjects(signal?: AbortSignal): Promise<Section<Inventory>> {
  const res = await fetch('/api/projects', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<Section<Inventory>>(res);
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

const closedTabs = new Map<string, true>();
export function markTabClosed(projectId: string, nodeId: string): void {
  closedTabs.set(`${projectId}:${nodeId}`, true);
  if (closedTabs.size > 2000) closedTabs.delete(closedTabs.keys().next().value!);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('ade:session-closed', { detail: { projectId, nodeId } }));
}
export function withoutClosedTabs(snapshot: DashboardSnapshot): DashboardSnapshot {
  if (!snapshot.graph.data || !closedTabs.size) return snapshot;
  const nodes = snapshot.graph.data.nodes.filter(node => !closedTabs.has(`${snapshot.projectId}:${node.id}`));
  if (nodes.length === snapshot.graph.data.nodes.length) return snapshot;
  const ids = new Set(nodes.map(node => node.id));
  return { ...snapshot, graph: { ...snapshot.graph, data: { ...snapshot.graph.data, nodes, edges: snapshot.graph.data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) } } };
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

export function subscribeConversationEvents(
  projectId: string, nodeId: string, runId: string | null,
  onConversation: (section: Section<ConversationPage>) => void,
  onConnection: (connected: boolean) => void,
  onReset: () => void,
): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let cursor: string | null = null;
  const connect = () => {
    if (closed || document.hidden) return;
    const query = new URLSearchParams();
    if (runId) query.set('runId', runId);
    if (cursor) query.set('cursor', cursor);
    source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/events?${query}`);
    source.onopen = () => { if (!closed) onConnection(true); };
    source.addEventListener('conversation', (event) => {
      if (closed) return;
      try {
        const section = JSON.parse((event as MessageEvent).data) as Section<ConversationPage>;
        if (section.data?.nextCursor) cursor = section.data.nextCursor;
        onConversation(section);
      } catch { /* A malformed event never replaces the loaded history. */ }
    });
    source.addEventListener('stream-reset', () => {
      source?.close();
      cursor = null;
      if (!closed) { onReset(); timer = setTimeout(connect, 2000); }
    });
    source.onerror = () => {
      source?.close();
      if (!closed) { onConnection(false); timer = setTimeout(connect, 2000); }
    };
  };
  const visibility = () => {
    clearTimeout(timer);
    source?.close();
    if (!document.hidden) connect();
  };
  document.addEventListener('visibilitychange', visibility);
  connect();
  return () => { closed = true; clearTimeout(timer); source?.close(); document.removeEventListener('visibilitychange', visibility); };
}

export function subscribeProjectEvents(
  projectId: string,
  runId: string | null,
  onSnapshot: (snap: DashboardSnapshot) => void,
  onError: (err: Event) => void,
): () => void {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  const url = `/api/projects/${encodeURIComponent(projectId)}/events${query}`;
  const es = new EventSource(url);

  const snapshotHandler = (e: MessageEvent) => {
    try {
      const snap = JSON.parse(e.data) as DashboardSnapshot;
      onSnapshot(withoutClosedTabs(snap));
    } catch (err) {
      console.error('Failed to parse snapshot SSE event:', err);
    }
  };

  es.addEventListener('snapshot', snapshotHandler);
  es.addEventListener('message', snapshotHandler);

  es.onerror = (e) => {
    onError(e);
  };

  return () => {
    es.removeEventListener('snapshot', snapshotHandler);
    es.removeEventListener('message', snapshotHandler);
    es.close();
  };
}

export async function sendNodeMessage(
  projectId: string,
  nodeId: string,
  message: string,
  signal?: AbortSignal,
  files: File[] = [],
  workflowConfirmed = false,
): Promise<{ ok: boolean; message?: string }> {
  const attachments = await Promise.all(files.map(async (file) => ({
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    dataBase64: await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
      reader.readAsDataURL(file);
    }),
  })));
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/message`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ message, ...(attachments.length ? { attachments } : {}), ...(workflowConfirmed ? { workflowConfirmed: true } : {}) }),
      signal,
    },
  );
  return handleResponse<{ ok: boolean; message?: string }>(res);
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
      headers: {
        Accept: 'application/json',
      },
      signal,
    },
  );
  const result = await handleResponse<{ ok: boolean; message?: string }>(res);
  if (result.ok) {
    markTabClosed(projectId, nodeId);
  }
  return result;
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
      headers: {
        Accept: 'application/json',
      },
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

let catalogCache: { value: AgentCatalogResponse; expires: number } | null = null;
let catalogPending: Promise<AgentCatalogResponse> | null = null;
let catalogGeneration = 0;
export function cachedAgentCatalog(): AgentCatalogResponse | null { return catalogCache && Date.now() < catalogCache.expires ? catalogCache.value : null; }
export async function fetchAgentCatalog(signal?: AbortSignal, force = false): Promise<AgentCatalogResponse> {
  signal?.throwIfAborted();
  const cached = !force && cachedAgentCatalog(); if (cached) return cached;
  if (!catalogPending) {
    const generation = catalogGeneration;
    const pending = fetch('/api/agents/catalog', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      .then(handleResponse<AgentCatalogResponse>).then(value => { if (generation === catalogGeneration) catalogCache = { value, expires: Date.now() + 15000 }; return value; })
      .finally(() => { if (catalogPending === pending) catalogPending = null; });
    catalogPending = pending;
  }
  // Callers cancel their own subscription, without cancelling another picker's shared read.
  const result = await catalogPending; signal?.throwIfAborted(); return result;
}

export async function createProjectWorktree(projectId: string, body: CreateWorktreeRequest): Promise<CreateWorktreeResponse> {
  return handleResponse<CreateWorktreeResponse>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/worktrees`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

export async function renameWorktree(projectId: string, nodeId: string, title: string): Promise<RenameNodeTitleResponse> {
  return handleResponse<RenameNodeTitleResponse>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/rename-worktree`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  }));
}

export async function fetchCommitGraph(projectId: string, nodeId?: string, signal?: AbortSignal): Promise<Section<CommitGraphData>> {
  return handleResponse<Section<CommitGraphData>>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/commit-graph${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`, { signal }));
}



export async function providerAccountAction(provider: import('../../shared/contracts').AccountProvider, action: 'login' | 'delete', accountId: string, signal?: AbortSignal): Promise<import('../../shared/contracts').ProviderAccount[]> {
  return handleResponse(await fetch('/api/provider-accounts/' + provider + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }), signal }));
}
export async function fetchProviderAccounts(provider: import('../../shared/contracts').AccountProvider, signal?: AbortSignal): Promise<import('../../shared/contracts').ProviderAccount[]> {
  return handleResponse(await fetch('/api/provider-accounts/' + provider, { signal }));
}
export async function workspaceFilesRequest<T>(projectId: string, action: 'roots' | 'list' | 'read' | 'diff' | 'search' | 'save' | 'open' | 'stat' | 'action', values: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const url = `/api/projects/${encodeURIComponent(projectId)}/files/${action}`;
  const query = new URLSearchParams(Object.entries(values).filter(([, value]) => value !== ''));
  return handleResponse(await fetch(action === 'save' || action === 'open' || action === 'action' ? url : `${url}?${query}`, {
    signal, ...(action === 'save' || action === 'open' || action === 'action' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) } : {}),
  }));
}
