import type { InboxItem, UpdateNotificationStateRequest } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { section } from '../../runtime/localRuntime.js';
import { notificationScope, notificationState, updateNotificationState } from '../../runtime/system/notificationState.js';
import { type RouteContext, text } from '../routeContext.js';

export async function handleSystemRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, method, pathname, query, sendJson, requireMethod, queryKeys, body } = ctx;

  const accountRoute = pathname.match(/^\/api\/provider-accounts\/(codex|claude|opencode)(?:\/(select|login|delete))?$/);
  if (accountRoute) {
    queryKeys();
    const provider = accountRoute[1] as 'codex' | 'claude' | 'opencode';
    if (!accountRoute[2] && (method === 'GET' || method === 'HEAD')) {
      sendJson(200, await runtime.accounts.list(provider));
      return true;
    }
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
    sendJson(200, await runtime.accounts.list(provider));
    return true;
  }

  if (pathname === '/api/health') {
    requireMethod('GET');
    queryKeys();
    sendJson(200, { status: 'ok', readOnly: false, runtime: 'ade' });
    return true;
  }

  if (pathname === '/api/prerequisites') {
    requireMethod('GET');
    queryKeys();
    let git = false;
    try {
      await runtime.git.run(runtime.store.directory, ['--version']);
      git = true;
    } catch { /* Report installation failure without blocking agent detection. */ }
    sendJson(200, {
      runtime: 'ade',
      git,
      ready: git,
      orcaApp: false,
      orcaAppOpen: false,
      orcaCli: false,
      orcaCliSkill: false,
      orchestrationSkill: false,
      version: 'ADE v1',
      issues: git ? [] : ['Install Git and make it available on PATH, then retry.'],
    });
    return true;
  }

  if (pathname === '/api/connections') {
    requireMethod('GET');
    queryKeys('scope', 'refresh');
    if (query.has('refresh') && query.get('refresh') !== '1') throw new CliError('INVALID_ARGUMENT', 'Invalid refresh');
    const scope = query.get('scope') ?? 'all';
    if (scope !== 'all' && scope !== 'accounts' && scope !== 'integrations') {
      throw new CliError('INVALID_ARGUMENT', 'Invalid connection scope');
    }
    sendJson(200, await runtime.connectionsService.connections(scope, query.get('refresh') === '1'));
    return true;
  }

  if (pathname === '/api/usage') {
    requireMethod('GET');
    queryKeys('refresh');
    if (query.has('refresh') && query.get('refresh') !== '1') throw new CliError('INVALID_ARGUMENT', 'refresh must be 1');
    sendJson(200, await runtime.connectionsService.usage(query.get('refresh') === '1'));
    return true;
  }

  if (pathname === '/api/computer-awake') {
    queryKeys();
    if (method === 'POST') {
      const request = await body<{ mode: string }>(['mode']);
      sendJson(200, runtime.awake.set(request.mode));
    } else {
      requireMethod('GET');
      sendJson(200, runtime.awake.status());
    }
    return true;
  }

  if (pathname === '/api/resources/details') {
    requireMethod('GET');
    queryKeys();
    sendJson(200, await runtime.resources.details(runtime.sessions.processGroups(), runtime.desktopMemory));
    return true;
  }

  if (pathname === '/api/ports') {
    requireMethod('GET');
    queryKeys();
    sendJson(200, await runtime.ports.read());
    return true;
  }

  const stopPort = pathname.match(/^\/api\/ports\/([a-f0-9]{40})\/stop$/);
  if (stopPort) {
    requireMethod('POST');
    queryKeys();
    await body<{}>([]);
    sendJson(200, await runtime.ports.stop(stopPort[1]));
    return true;
  }

  if (pathname === '/api/resources') {
    requireMethod('GET');
    queryKeys();
    sendJson(200, await runtime.resources.read(runtime.sessions.processRoots(), runtime.desktopMemory));
    return true;
  }

  if (pathname === '/api/notifications/state') {
    if (method === 'POST') {
      queryKeys();
      sendJson(200, updateNotificationState(runtime.store, await body<UpdateNotificationStateRequest>(['scope', 'action', 'ids', 'baseline', 'legacy'], 1_500_000)));
      return true;
    }
    requireMethod('GET');
    queryKeys('scopes');
    const raw = query.get('scopes');
    if (!raw || raw.length > 12000) throw new CliError('INVALID_ARGUMENT', 'Provide bounded notification scopes');
    let scopes: unknown;
    try { scopes = JSON.parse(raw); } catch { throw new CliError('INVALID_ARGUMENT', 'Invalid notification scopes'); }
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 32) {
      throw new CliError('INVALID_ARGUMENT', 'Provide up to 32 notification scopes');
    }
    sendJson(200, {
      states: Object.fromEntries(scopes.map(scope => {
        const key = notificationScope(scope);
        return [key, notificationState(runtime.store, key)];
      })),
    });
    return true;
  }

  if (pathname === '/api/inbox') {
    requireMethod('GET');
    queryKeys();
    const open = new Map<string, Set<string>>();
    const items: InboxItem[] = runtime.store.inboxItems().map(item => {
      if (!open.has(item.projectId)) {
        open.set(item.projectId, new Set(runtime.store.sessions(item.projectId).filter(session => !session.closed).map(session => session.id)));
      }
      return item.nodeId && !open.get(item.projectId)!.has(item.nodeId) ? { ...item, nodeId: null } : item;
    });
    sendJson(200, section({ items }, items.length ? 'ready' : 'empty'));
    return true;
  }

  return false;
}
