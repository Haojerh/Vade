import type {
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
} from '../../shared/contracts';

export async function fetchUsage(signal?: AbortSignal): Promise<Section<UsageData>> {
  return handleResponse<Section<UsageData>>(await fetch('/api/usage', {
    headers: { Accept: 'application/json' }, signal,
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
  return handleResponse<DashboardSnapshot>(res);
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
      onSnapshot(snap);
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
      body: JSON.stringify({ message, ...(attachments.length ? { attachments } : {}) }),
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
  return handleResponse<{ ok: boolean; message?: string }>(res);
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
      body: JSON.stringify({ command, title }),
      signal,
    },
  );
  return handleResponse<CreateAgentResponse>(res);
}

export async function fetchAgentCatalog(signal?: AbortSignal): Promise<AgentCatalogResponse> {
  const res = await fetch('/api/agents/catalog', {
    headers: { Accept: 'application/json' },
    signal,
  });
  return handleResponse<AgentCatalogResponse>(res);
}


