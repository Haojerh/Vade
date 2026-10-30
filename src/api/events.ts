import type { ConversationPage, DashboardSnapshot, NodeStatusUpdate, Section } from '../../shared/contracts';
import { withoutClosedTabs } from './nodes';

export function subscribeConversationEvents(
  projectId: string,
  nodeId: string,
  runId: string | null,
  onConversation: (section: Section<ConversationPage>) => void,
  onConnection: (connected: boolean) => void,
  onReset: () => void,
  savedCursor?: { current: string | null },
  onStatus?: (status: NodeStatusUpdate) => void,
): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let cursor: string | null = savedCursor?.current ?? null;
  const connect = () => {
    if (closed || document.hidden) return;
    const query = new URLSearchParams();
    if (runId) query.set('runId', runId);
    if (cursor) query.set('cursor', cursor);
    source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/events?${query}`);
    const current = source;
    source.onopen = () => { if (!closed && source === current) onConnection(true); };
    source.addEventListener('conversation', (event) => {
      if (closed || source !== current) return;
      try {
        const section = JSON.parse((event as MessageEvent).data) as Section<ConversationPage>;
        if (section.data?.nextCursor) { cursor = section.data.nextCursor; if (savedCursor) savedCursor.current = cursor; }
        onConversation(section);
      } catch { /* A malformed event never replaces the loaded history. */ }
    });
    source.addEventListener('node-status', event => {
      if (closed || source !== current) return;
      try {
        const update = JSON.parse((event as MessageEvent).data) as NodeStatusUpdate;
        if (update.nodeId === nodeId && update.agentStatus && ['live', 'exited'].includes(update.liveness) && Number.isFinite(Date.parse(update.observedAt))) {
          onStatus?.(update);
        }
      } catch { /* Preserve the last verified status. */ }
    });
    source.addEventListener('stream-reset', () => {
      if (closed || source !== current) return;
      source?.close();
      cursor = null; if (savedCursor) savedCursor.current = null;
      if (!closed) { onReset(); timer = setTimeout(connect, 2000); }
    });
    source.onerror = () => {
      if (closed || source !== current) return;
      source?.close();
      if (!closed) { onConnection(false); timer = setTimeout(connect, 2000); }
    };
  };
  const visibility = () => {
    clearTimeout(timer);
    source?.close();
    source = null;
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
  keepAliveWhenHidden = false,
): () => void {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
  const url = `/api/projects/${encodeURIComponent(projectId)}/events${query}`;
  let source: EventSource | null = null, closed = false;
  const visibility = () => {
    if (!closed && keepAliveWhenHidden && source) return;
    source?.close(); source = null;
    if (closed || (document.hidden && !keepAliveWhenHidden)) return;
    const current = new EventSource(url); source = current;
    const snapshotHandler = (e: MessageEvent) => {
      if (closed || source !== current || (document.hidden && !keepAliveWhenHidden)) return;
      try { onSnapshot(withoutClosedTabs(JSON.parse(e.data) as DashboardSnapshot)); }
      catch (err) { console.error('Failed to parse snapshot SSE event:', err); }
    };
    current.addEventListener('snapshot', snapshotHandler);
    current.addEventListener('message', snapshotHandler);
    current.onerror = event => { if (!closed && source === current && (!document.hidden || keepAliveWhenHidden)) onError(event); };
  };
  document.addEventListener('visibilitychange', visibility);
  visibility();
  return () => { closed = true; source?.close(); source = null; document.removeEventListener('visibilitychange', visibility); };
}
