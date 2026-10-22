import type http from 'node:http';
import type { CreateWorktreeRequest, GitHubQuery, RegisterProjectRequest, SendMessageRequest, TerminalShell } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { collectGitHubData } from '../integrations/github.js';
import { LocalRuntime, section } from '../runtime/localRuntime.js';
import { agentCatalog } from '../runtime/sessions.js';
import { createResponseHelpers, parseJsonBody } from './httpUtils.js';
import { listProjectFolders } from '../runtime/projectFolders.js';
import { addProject } from '../runtime/projects.js';

function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new CliError('INVALID_ARGUMENT', `Invalid ${label}`);
  return value.trim();
}

export async function handleLocalRoute(runtime: LocalRuntime, req: http.IncomingMessage, res: http.ServerResponse, requestId: string, url: URL): Promise<void> {
  const { sendJson, sendError } = createResponseHelpers(res, requestId);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;
  const query = url.searchParams;
  const requireMethod = (allowed: string) => {
    if (method !== allowed && !(allowed === 'GET' && method === 'HEAD')) throw new CliError('METHOD_NOT_ALLOWED', `Use ${allowed} for this endpoint`);
  };
  const queryKeys = (...keys: string[]) => {
    if ([...query.keys()].some(key => !keys.includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1 || !query.get(key))) throw new CliError('INVALID_ARGUMENT', 'Unexpected, empty or duplicate query parameter');
    if (query.has('runId')) throw new CliError('RUN_NOT_FOUND', 'Standalone ADE has no orchestration runs');
  };
  const body = async <T extends object>(keys: string[], max = 8192): Promise<T> => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new CliError('INVALID_ARGUMENT', 'Actions require application/json');
    const value = await parseJsonBody<T>(req, max);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) throw new CliError('INVALID_ARGUMENT', 'Unexpected request field');
    return value;
  };
  try {
    const accountRoute = pathname.match(/^\/api\/provider-accounts\/(codex|claude)(?:\/(select|login|delete))?$/);
    if (accountRoute) {
      queryKeys();
      const provider = accountRoute[1] as 'codex' | 'claude';
      if (!accountRoute[2] && (method === 'GET' || method === 'HEAD')) { sendJson(200, await runtime.accounts.list(provider)); return; }
      requireMethod('POST');
      if (accountRoute[2]) {
        const request = await body<{ accountId: string }>(['accountId']);
        const id = text(request.accountId, 'account ID', 36);
        if (accountRoute[2] === 'select') runtime.accounts.select(provider, id);
        else if (accountRoute[2] === 'login') await runtime.accounts.startLogin(provider, id);
        else await runtime.accounts.remove(provider, id);
      } else {
        const request = await body<{ label: string }>(['label']);
        await runtime.accounts.add(provider, text(request.label, 'account name', 60));
      }
      runtime.connectionsService.invalidate();
      sendJson(200, await runtime.accounts.list(provider)); return;
    }
    if (pathname === '/api/health') { requireMethod('GET'); queryKeys(); sendJson(200, { status: 'ok', readOnly: false, runtime: 'ade' }); return; }
    if (pathname === '/api/prerequisites') {
      requireMethod('GET'); queryKeys();
      let git = false;
      try { await runtime.git.run(runtime.store.directory, ['--version']); git = true; } catch { /* Report installation failure without blocking agent detection. */ }
      sendJson(200, { runtime: 'ade', git, ready: git, orcaApp: false, orcaAppOpen: false, orcaCli: false, orcaCliSkill: false,
        orchestrationSkill: false, version: 'ADE v1', issues: git ? [] : ['Install Git and make it available on PATH, then retry.'] }); return;
    }
    if (pathname === '/api/agents/catalog') { requireMethod('GET'); queryKeys(); sendJson(200, agentCatalog()); return; }
    if (pathname === '/api/connections') { requireMethod('GET'); queryKeys(); sendJson(200, await runtime.connectionsService.connections()); return; }
    if (pathname === '/api/usage') { requireMethod('GET'); queryKeys('refresh'); if (query.has('refresh') && query.get('refresh') !== '1') throw new CliError('INVALID_ARGUMENT', 'refresh must be 1'); sendJson(200, await runtime.connectionsService.usage(query.get('refresh') === '1')); return; }
    if (pathname === '/api/resources') {
      requireMethod('GET'); queryKeys();
      const desktop = runtime.desktopMemory && Date.now() - runtime.desktopMemory.at < 15000 ? runtime.desktopMemory : null;
      sendJson(200, { memoryBytes: desktop?.bytes ?? process.memoryUsage().rss, scope: desktop ? 'desktop-app' : 'backend', observedAt: new Date(desktop?.at ?? Date.now()).toISOString() }); return;
    }
    if (pathname === '/api/inbox') { requireMethod('GET'); queryKeys(); sendJson(200, section({ items: [] }, 'unsupported', 'Standalone ADE does not yet collect structured task outcomes.')); return; }
    const deleteProject = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)$/);
    if (deleteProject && pathname !== '/api/projects/folders') {
      requireMethod('DELETE'); queryKeys();
      runtime.store.deleteProject(deleteProject[1]);
      sendJson(200, { ok: true }); return;
    }
    if (pathname === '/api/projects/folders') {
      requireMethod('GET'); queryKeys('path'); sendJson(200, listProjectFolders(query.get('path') ?? undefined)); return;
    }
    if (pathname === '/api/projects') {
      queryKeys();
      if (method === 'POST') {
        const request = await body<RegisterProjectRequest>(['path', 'name', 'mode', 'url']);
        const project = await addProject(runtime.git, request);
        sendJson(201, { project });
      } else { requireMethod('GET'); sendJson(200, section({ projects: runtime.store.projects() })); }
      return;
    }
    const match = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/(snapshot|events|github|commit-graph|worktrees|nodes\/([a-zA-Z0-9_.-]+)(?:\/(terminal|terminal-input|terminal-resize|resume|create-agent|close-tab|rename|rename-worktree|delete-worktree|worktree|message|chat-options|events))?)$/);
    if (!match) { sendError(404, 'INVALID_ARGUMENT', 'Unknown standalone ADE endpoint'); return; }
    const [, projectId, route, nodeId, action] = match;
    const project = runtime.store.project(projectId);
    if (route === 'snapshot') { requireMethod('GET'); queryKeys('runId'); sendJson(200, await runtime.snapshot(projectId)); return; }
    if (route === 'events') {
      requireMethod('GET'); queryKeys('runId');
      if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
      runtime.connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      let closed = false, busy = false, pending = false;
      const tick = async () => {
        if (closed) return;
        if (busy) { pending = true; return; }
        busy = true;
        try {
          const snapshot = await runtime.snapshot(projectId);
          if (!closed && !res.destroyed && !res.writableNeedDrain) res.write(`event: snapshot\nid: ${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } finally { busy = false; if (pending && !closed) { pending = false; void tick().catch(() => close()); } }
      };
      const timer = setInterval(() => { void tick().catch(() => close()); }, 2000);
      const heartbeat = setInterval(() => { if (!res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
      const unsubscribeStatus = runtime.sessions.subscribeStatus(projectId, () => { void tick().catch(() => close()); });
      const close = () => {
        if (closed) return;
        closed = true; clearInterval(timer); clearInterval(heartbeat); unsubscribeStatus(); runtime.connections--; runtime.streams.delete(close); res.end();
      };
      runtime.streams.add(close); res.once('close', close);
      await tick(); return;
    }
    if (route === 'github') {
      requireMethod('GET'); queryKeys('scope', 'nodeId', 'activity', 'page');
      const scope = query.get('scope') ?? 'general';
      if (!['general', 'worktree'].includes(scope) || (scope === 'worktree' && !query.get('nodeId')) || (scope === 'general' && query.has('nodeId'))) throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub scope');
      if (query.has('activity') && !['commits', 'prs', 'issues'].includes(query.get('activity')!)) throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub activity');
      if (query.has('page') && !/^[1-9][0-9]{0,4}$/.test(query.get('page')!)) throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub page');
      const selection = { scope, ...(scope === 'worktree' ? { nodeId: query.get('nodeId')! } : {}),
        ...(query.has('activity') ? { activity: query.get('activity') } : {}), ...(query.has('page') ? { page: Number(query.get('page')) } : {}) } as GitHubQuery;
      const snapshot = await runtime.snapshot(projectId);
      if (!snapshot.graph.data || snapshot.graph.meta.stale) throw new CliError('SCOPE_UNAVAILABLE', 'Repository scope is unavailable');
      sendJson(200, await collectGitHubData(project, selection, runtime.git.runner, snapshot.graph.data)); return;
    }
    if (route === 'commit-graph') { requireMethod('GET'); queryKeys('nodeId'); sendJson(200, await runtime.git.history(project, query.get('nodeId') ?? undefined)); return; }
    if (route === 'worktrees') {
      requireMethod('POST'); queryKeys();
      const request = await body<CreateWorktreeRequest>(['name', 'baseBranch', 'from', 'setup', 'agentId']);
      if (request.agentId && !agentCatalog().installed.some(agent => agent.id === request.agentId)) throw new CliError('INVALID_ARGUMENT', 'Select an installed agent');
      const tree = await runtime.git.create(project, request);
      if (request.agentId) {
        try { await runtime.sessions.launch(projectId, tree.id, tree.path, request.agentId); }
        catch { sendJson(200, { ok: true, message: 'Worktree created. Agent could not start; open the worktree and add an agent.' }); return; }
      }
      sendJson(200, { ok: true, message: 'Worktree created' }); return;
    }
    if (!action) {
      requireMethod('GET'); queryKeys('runId', 'limit', 'cursor', 'direction');
      if ((query.has('cursor') && query.get('cursor')!.length > 512) || (query.has('direction') && query.get('direction') !== 'older')) throw new CliError('INVALID_ARGUMENT', 'Invalid conversation cursor or direction');
      if (query.has('limit') && (!/^[1-9][0-9]*$/.test(query.get('limit')!) || Number(query.get('limit')) > 200)) throw new CliError('INVALID_ARGUMENT', 'Invalid conversation limit');
      sendJson(200, await runtime.details(projectId, nodeId, { direction: 'older', cursor: query.get('cursor'), limit: Number(query.get('limit') ?? 20) })); return;
    }
    if (action === 'terminal') {
      requireMethod('GET'); queryKeys('cursor');
      const raw = query.get('cursor') ?? '0';
      if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new CliError('INVALID_ARGUMENT', 'Invalid terminal cursor');
      sendJson(200, runtime.sessions.page(projectId, nodeId, Number(raw))); return;
    }
    if (action === 'events') {
      requireMethod('GET'); queryKeys('runId', 'cursor');
      if (query.has('cursor') && query.get('cursor')!.length > 512) throw new CliError('INVALID_ARGUMENT', 'Invalid conversation cursor');
      runtime.sessions.require(projectId, nodeId);
      if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
      let cursor = query.get('cursor'), closed = false, busy = false;
      const read = () => runtime.conversations.read(runtime.sessions.require(projectId, nodeId), { cursor, limit: 20 });
      const initial = await read();
      if (res.destroyed) return;
      if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
      runtime.connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const publish = (conversation: typeof initial, first = false) => {
        if (closed) return;
        if (conversation.data?.nextCursor) cursor = conversation.data.nextCursor;
        if (first || conversation.data?.messages.length || conversation.meta.issue) res.write(`event: conversation\ndata: ${JSON.stringify(conversation)}\n\n`);
      };
      const timer = setInterval(async () => {
        if (closed || busy || res.writableNeedDrain) return;
        busy = true;
        try { publish(await read()); }
        catch { if (!closed) res.write('event: stream-reset\ndata: {}\n\n'); close(); }
        finally { busy = false; }
      }, 2000);
      const heartbeat = setInterval(() => { if (!closed && !res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
      const close = () => {
        if (closed) return;
        closed = true; clearInterval(timer); clearInterval(heartbeat); runtime.connections--; runtime.streams.delete(close); res.end();
      };
      runtime.streams.add(close); res.once('close', close); publish(initial, true); return;
    }
    queryKeys('runId');
    if (action === 'chat-options') { requireMethod('GET'); runtime.sessions.require(projectId, nodeId); sendJson(200, section(null, 'unsupported', 'Use the provider’s controls in Terminal.')); return; }
    requireMethod(action === 'worktree' ? 'DELETE' : 'POST');
    if (action === 'resume') {
      if (query.size) throw new CliError('INVALID_ARGUMENT', 'Resume does not accept query parameters');
      await body<Record<string, never>>([]);
      const record = runtime.sessions.require(projectId, nodeId);
      const tree = await runtime.git.requireWorktree(project, record.worktreeId);
      if (tree.path !== record.cwd) throw new CliError('INVALID_ARGUMENT', 'The original session folder is no longer available');
      await runtime.sessions.resume(projectId, nodeId);
    }
    else if (action === 'terminal-input') { const request = await body<{ data: string }>(['data'], 65536); await runtime.sessions.input(projectId, nodeId, request.data); }
    else if (action === 'terminal-resize') { const request = await body<{ cols: number; rows: number }>(['cols', 'rows']); await runtime.sessions.resize(projectId, nodeId, request.cols, request.rows); }
    else if (action === 'create-agent') {
      const tree = await runtime.git.requireWorktree(project, nodeId);
      const request = await body<{ command: string; title?: string; shell?: TerminalShell }>(['command', 'title', 'shell']);
      const session = await runtime.sessions.launch(projectId, tree.id, tree.path, text(request.command, 'agent', 32), request.title === undefined ? undefined : text(request.title, 'title'), request.shell === undefined ? undefined : text(request.shell, 'shell', 16) as TerminalShell);
      sendJson(200, { ok: true, handle: session.id, title: session.title }); return;
    } else if (action === 'close-tab') { runtime.sessions.closeSession(projectId, nodeId); }
    else if (action === 'rename' || action === 'rename-worktree') {
      const request = await body<{ title: string }>(['title']);
      if (action === 'rename-worktree') await runtime.git.requireWorktree(project, nodeId);
      else runtime.sessions.require(projectId, nodeId);
      const title = text(request.title, 'title'); runtime.store.rename(nodeId, title); sendJson(200, { ok: true, title }); return;
    } else if (action === 'delete-worktree' || action === 'worktree') {
      if (runtime.store.sessions(projectId).some(session => !session.closed && session.worktreeId === nodeId)) throw new CliError('INVALID_ARGUMENT', 'Close this worktree’s agent sessions before deleting it');
      await runtime.git.remove(project, nodeId);
    } else if (action === 'message') {
      const request = await body<SendMessageRequest>(['message', 'attachments'], 29 * 1024 * 1024);
      sendJson(200, await runtime.sessions.send(projectId, nodeId, request)); return;
    }
    else throw new CliError('METHOD_NOT_ALLOWED', 'Action is not available in standalone ADE');
    sendJson(200, { ok: true });
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    const issue = error instanceof CliError ? error.issue : { code: 'INTERNAL' as const, message: 'Standalone ADE operation failed', retryable: false };
    const status = issue.code === 'INVALID_ARGUMENT' ? 400 : issue.code === 'METHOD_NOT_ALLOWED' ? 405 : issue.code.endsWith('_NOT_FOUND') ? 404 : issue.code === 'RATE_LIMITED' ? 429 : 500;
    sendError(status, issue.code, issue.message, issue.retryable);
  }
}
