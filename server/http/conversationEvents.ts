import type { ReadRouteContext } from './readRoutes.js';

let activeStreams = 0;

export async function handleConversationEvents(ctx: ReadRouteContext): Promise<boolean> {
  const match = ctx.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/events$/);
  if (!match) return false;
  const { res, query } = ctx;
  if (Object.keys(query).some(key => !['runId', 'cursor'].includes(key)) ||
    (query.runId !== undefined && !/^[a-zA-Z0-9_.-]{1,256}$/.test(query.runId)) ||
    (query.cursor !== undefined && (!query.cursor.length || query.cursor.length > 512))) {
    ctx.sendError(400, 'INVALID_ARGUMENT', 'Invalid conversation stream scope');
    return true;
  }
  if (activeStreams >= 32) {
    ctx.sendError(429, 'RATE_LIMITED', 'Too many open conversation streams');
    return true;
  }
  activeStreams++;
  let closed = false;
  let busy = false;
  let cursor = query.cursor ?? null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    activeStreams--;
    clearInterval(timer);
    clearInterval(heartbeat);
  };
  res.on('close', close);
  const read = () => ctx.snapshotManager.getNodeDetails(match[1], match[2], { runId: query.runId ?? null, cursor, limit: 20 }, ctx.runner);
  try {
    const initial = await read();
    if (closed) return true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const publish = (details: typeof initial, first = false) => {
      if (closed) return;
      const section = details.conversation;
      if (section.data?.nextCursor) cursor = section.data.nextCursor;
      // Unchanged empty tails need only a heartbeat. Cursor envelopes are forward-only.
      if (first || section.data?.messages.length || section.meta.issue || !section.data) {
        res.write(`event: conversation\ndata: ${JSON.stringify(section)}\n\n`);
      }
    };
    publish(initial, true);
    timer = setInterval(async () => {
      if (closed || busy || res.writableNeedDrain) return;
      busy = true;
      try { publish(await read()); }
      catch {
        if (!closed) { res.write('event: stream-reset\ndata: {}\n\n'); res.end(); }
        close();
      } finally { busy = false; }
    }, 2000);
    heartbeat = setInterval(() => { if (!closed && !res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
  } catch (error) {
    close();
    throw error;
  }
  return true;
}
