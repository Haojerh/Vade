import { CliError } from '../../integrations/cli.js';
import type { RouteContext } from '../routeContext.js';

export async function handleProjectStreamRoute(ctx: RouteContext, projectId: string, route: string): Promise<boolean> {
  const { runtime, res, sendJson, requireMethod, queryKeys } = ctx;

  if (route === 'snapshot') {
    requireMethod('GET');
    queryKeys('runId');
    sendJson(200, await runtime.snapshot(projectId));
    return true;
  }

  if (route === 'events') {
    requireMethod('GET');
    queryKeys('runId');
    if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
    runtime.connections++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false, busy = false, pending = false;
    const tick = async () => {
      if (closed) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        const snapshot = await runtime.snapshot(projectId);
        if (!closed && !res.destroyed && !res.writableNeedDrain) {
          res.write(`event: snapshot\nid: ${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
      } finally {
        busy = false;
        if (pending && !closed) {
          pending = false;
          void tick().catch(() => close());
        }
      }
    };
    const timer = setInterval(() => { void tick().catch(() => close()); }, 2000);
    const heartbeat = setInterval(() => { if (!res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
    const unsubscribeStatus = runtime.sessions.subscribeStatus(projectId, () => { void tick().catch(() => close()); });
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      unsubscribeStatus();
      runtime.connections--;
      runtime.streams.delete(close);
      res.end();
    };
    runtime.streams.add(close);
    res.once('close', close);
    await tick();
    return true;
  }

  return false;
}
