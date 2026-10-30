import type { InterruptAgentRequest, Project, TerminalAttachmentsRequest } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import type { RouteContext } from '../routeContext.js';

export async function handleNodeTerminalRoute(
  ctx: RouteContext,
  projectId: string,
  project: Project,
  nodeId: string,
  action: string | undefined,
): Promise<boolean> {
  const { runtime, query, sendJson, requireMethod, queryKeys, body } = ctx;

  if (action === 'terminal') {
    requireMethod('GET');
    queryKeys('cursor');
    const raw = query.get('cursor') ?? '0';
    if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid terminal cursor');
    }
    sendJson(200, runtime.sessions.page(projectId, nodeId, Number(raw)));
    return true;
  }

  if (action === 'resume') {
    requireMethod('POST');
    if (query.size) throw new CliError('INVALID_ARGUMENT', 'Resume does not accept query parameters');
    await body<Record<string, never>>([]);
    const record = runtime.sessions.require(projectId, nodeId);
    const tree = await runtime.git.requireWorktree(project, record.worktreeId);
    if (tree.path !== record.cwd) throw new CliError('INVALID_ARGUMENT', 'The original session folder is no longer available');
    await runtime.sessions.resume(projectId, nodeId);
    sendJson(200, { ok: true });
    return true;
  }

  if (action === 'interrupt') {
    requireMethod('POST');
    queryKeys();
    await body<InterruptAgentRequest>([]);
    await runtime.sessions.interrupt(projectId, nodeId);
    sendJson(200, { ok: true });
    return true;
  }

  if (action === 'terminal-attachments') {
    requireMethod('POST');
    queryKeys();
    const request = await body<TerminalAttachmentsRequest>(['attachments'], 29 * 1024 * 1024);
    sendJson(200, await runtime.sessions.pasteTerminalAttachments(projectId, nodeId, request));
    return true;
  }

  if (action === 'terminal-input') {
    queryKeys('runId');
    requireMethod('POST');
    const request = await body<{ data: string }>(['data'], 65536);
    await runtime.sessions.input(projectId, nodeId, request.data);
    sendJson(200, { ok: true });
    return true;
  }

  if (action === 'terminal-resize') {
    queryKeys('runId');
    requireMethod('POST');
    const request = await body<{ cols: number; rows: number }>(['cols', 'rows']);
    await runtime.sessions.resize(projectId, nodeId, request.cols, request.rows);
    sendJson(200, { ok: true });
    return true;
  }

  return false;
}
