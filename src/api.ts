import type {
  DashboardSnapshot,
  GitHubData,
  HealthResponse,
  Inventory,
  NodeDetails,
  Section,
  ApiError,
} from '../shared/contracts';

/**
 * Strips ANSI escape sequences and non-printable control characters from terminal text.
 */
export function stripAnsi(text: string): string {
  // Matches ANSI escape codes, OSC sequences, CSI sequences
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
  cursor?: string | null,
  limit?: number,
  signal?: AbortSignal,
): Promise<NodeDetails> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
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
  signal?: AbortSignal,
): Promise<GitHubData> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/github`, {
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
  // Also listen to default message in case server sends plain messages
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
