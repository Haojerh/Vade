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
      const errorJson = (await res.json()) as ApiError;
      if (errorJson && errorJson.error && errorJson.error.message) {
        errorMessage = `[${errorJson.error.code}] ${errorJson.error.message}`;
      }
    } catch {
      // Body not JSON or unreadable
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
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/message`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ message }),
      signal,
    },
  );
  return handleResponse<{ ok: boolean; message?: string }>(res);
}

