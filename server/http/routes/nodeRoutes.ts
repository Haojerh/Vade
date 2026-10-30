import type {
  HandoffSessionRequest,
  Project,
  TerminalShell,
} from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { type RouteContext, text } from '../routeContext.js';
import { handleNodeChatRoute } from './nodeChatRoutes.js';
import { handleNodeTerminalRoute } from './nodeTerminalRoutes.js';

export async function handleSubagentTranscriptRoute(ctx: RouteContext): Promise<boolean> {
  const { runtime, pathname, query, sendJson, requireMethod, queryKeys } = ctx;
  const subagentTranscript = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/subagents\/([a-zA-Z0-9_.-]+)\/conversation$/);
  if (!subagentTranscript) return false;

  requireMethod('GET');
  queryKeys('cursor', 'limit', 'direction');
  if ((query.has('cursor') && query.get('cursor')!.length > 512) || (query.has('direction') && query.get('direction') !== 'older')) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid subagent conversation cursor or direction');
  }
  if (query.has('limit') && (!/^[1-9][0-9]*$/.test(query.get('limit')!) || Number(query.get('limit')) > 200)) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid subagent conversation limit');
  }
  sendJson(
    200,
    await runtime.subagentConversation(subagentTranscript[1], subagentTranscript[2], subagentTranscript[3], {
      direction: query.get('direction') === 'older' ? 'older' : undefined,
      cursor: query.get('cursor'),
      limit: Number(query.get('limit') ?? 20),
    }),
  );
  return true;
}

export async function handleNodeActionRoute(
  ctx: RouteContext,
  projectId: string,
  project: Project,
  nodeId: string,
  action: string | undefined,
): Promise<void> {
  const { runtime, req, query, sendJson, requireMethod, queryKeys, body } = ctx;

  if (!action) {
    requireMethod('GET');
    queryKeys('runId', 'limit', 'cursor', 'direction');
    if ((query.has('cursor') && query.get('cursor')!.length > 512) || (query.has('direction') && query.get('direction') !== 'older')) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid conversation cursor or direction');
    }
    if (query.has('limit') && (!/^[1-9][0-9]*$/.test(query.get('limit')!) || Number(query.get('limit')) > 200)) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid conversation limit');
    }
    sendJson(200, await runtime.details(projectId, nodeId, {
      direction: 'older',
      cursor: query.get('cursor'),
      limit: Number(query.get('limit') ?? 20),
    }));
    return;
  }

  if (await handleNodeChatRoute(ctx, projectId, nodeId, action)) return;
  if (await handleNodeTerminalRoute(ctx, projectId, project, nodeId, action)) return;

  queryKeys('runId');

  if (action === 'handoff' && (req.method === 'GET' || req.method === 'HEAD')) {
    queryKeys();
    sendJson(200, await runtime.handoffWorktrees(projectId, nodeId));
    return;
  }

  requireMethod(action === 'worktree' ? 'DELETE' : 'POST');

  if (action === 'handoff') {
    queryKeys();
    const request = await body<HandoffSessionRequest>(['agentId', 'context', 'worktreeId']);
    sendJson(200, await runtime.handoffs.start(projectId, nodeId, request));
    return;
  } else if (action === 'handoff-message') {
    queryKeys();
    await body<{}>([]);
    sendJson(200, await runtime.handoffs.deliver(projectId, nodeId));
    return;
  } else if (action === 'create-agent') {
    const tree = await runtime.git.requireWorktree(project, nodeId);
    const request = await body<{ command: string; title?: string; shell?: TerminalShell }>(['command', 'title', 'shell']);
    const session = await runtime.sessions.launch(
      projectId,
      tree.id,
      tree.path,
      text(request.command, 'agent', 32),
      request.title === undefined ? undefined : text(request.title, 'title'),
      request.shell === undefined ? undefined : (text(request.shell, 'shell', 16) as TerminalShell),
    );
    sendJson(200, { ok: true, handle: session.id, title: session.title });
    return;
  } else if (action === 'close-tab') {
    runtime.sessions.closeSession(projectId, nodeId);
  } else if (action === 'rename' || action === 'rename-worktree') {
    const request = await body<{ title: string }>(['title']);
    if (action === 'rename-worktree') await runtime.git.requireWorktree(project, nodeId);
    else runtime.sessions.require(projectId, nodeId);
    const title = text(request.title, 'title');
    runtime.store.rename(nodeId, title);
    sendJson(200, { ok: true, title });
    return;
  } else if (action === 'delete-worktree' || action === 'worktree') {
    if (runtime.store.sessions(projectId).some(session => !session.closed && session.worktreeId === nodeId)) {
      throw new CliError('INVALID_ARGUMENT', 'Close this worktree’s agent sessions before deleting it');
    }
    await runtime.git.remove(project, nodeId);
  } else {
    throw new CliError('METHOD_NOT_ALLOWED', 'Action is not available in standalone ADE');
  }

  sendJson(200, { ok: true });
}
