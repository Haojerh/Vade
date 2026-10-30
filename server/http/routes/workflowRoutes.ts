import type { OrganizationConfig, WorkflowProvider } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { type RouteContext, text } from '../routeContext.js';

export async function handleWorkflowRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, req, method, pathname, query, sendJson, requireMethod, queryKeys, body } = ctx;

  if (pathname === '/api/workflow/setup-terminal') {
    requireMethod('POST');
    queryKeys();
    await body<{}>([]);
    sendJson(200, await runtime.organization.setup.prepareTerminal());
    return true;
  }

  if (pathname === '/api/workflow/setup-terminal/close') {
    requireMethod('POST');
    queryKeys();
    const owner = await body<{ projectId: string; nodeId: string }>(['projectId', 'nodeId']);
    runtime.organization.setup.closeTerminal(text(owner.projectId, 'setup project ID', 36), text(owner.nodeId, 'setup terminal ID', 36));
    sendJson(200, { ok: true });
    return true;
  }

  if (pathname === '/api/workflow/config') {
    queryKeys();
    if (method === 'POST') {
      sendJson(200, await runtime.organization.configure(await body<OrganizationConfig>([
        'version',
        'enabled',
        'isolatedWorktrees',
        'nodes',
        'edges',
        'orchestratorPosition',
        'closeWorkersOnCompletion',
        'removeWorktreesOnCompletion',
      ], 150000)));
    } else {
      requireMethod('GET');
      sendJson(200, runtime.organization.config());
    }
    return true;
  }

  if (pathname === '/api/workflow/setup') {
    queryKeys();
    requireMethod('GET');
    sendJson(200, runtime.organization.setup.status());
    return true;
  }

  if (pathname === '/api/workflow/models') {
    requireMethod('GET');
    queryKeys('provider');
    const provider = query.get('provider');
    if (!['codex', 'claude', 'antigravity', 'codebuddy', 'opencode', 'opencode2', 'kilo', 'dsh'].includes(provider ?? '')) {
      throw new CliError('INVALID_ARGUMENT', 'Select a supported provider');
    }
    sendJson(200, await runtime.organization.models.list(provider as WorkflowProvider));
    return true;
  }

  if (pathname === '/api/workflow/runs') {
    requireMethod('GET');
    queryKeys('projectId', 'summary');
    const projectId = query.get('projectId') ?? undefined;
    if (projectId) runtime.store.project(projectId);
    if (query.has('summary') && query.get('summary') !== '1') {
      throw new CliError('INVALID_ARGUMENT', 'Invalid workflow summary option');
    }
    sendJson(200, query.get('summary') === '1' ? runtime.organization.summaries(projectId) : runtime.organization.runs(projectId));
    return true;
  }

  const workflowDetails = pathname.match(/^\/api\/workflow\/runs\/([0-9a-f-]{36})$/i);
  if (workflowDetails) {
    requireMethod('GET');
    queryKeys();
    sendJson(200, runtime.organization.details(workflowDetails[1]));
    return true;
  }

  const workflowCancel = pathname.match(/^\/api\/workflow\/runs\/([0-9a-f-]{36})\/cancel$/i);
  if (workflowCancel) {
    requireMethod('POST');
    queryKeys();
    await body<{}>([]);
    await runtime.organization.cancel(workflowCancel[1]);
    sendJson(200, { ok: true });
    return true;
  }

  if (pathname === '/api/workflow/control') {
    requireMethod('POST');
    queryKeys();
    const request = await body<any>([
      'action',
      'runId',
      'sessionId',
      'nodes',
      'reason',
      'streams',
      'nodeId',
      'task',
      'to',
      'text',
      'outcome',
      'summary',
      'request',
      'edges',
      'isolatedWorktrees',
      'provider',
    ], 160000);
    sendJson(200, await runtime.organization.control(req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1], request));
    return true;
  }

  return false;
}
