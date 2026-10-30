import type http from 'node:http';
import { CliError } from '../integrations/cli.js';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import { createRouteContext } from './routeContext.js';
import { handleAgentRoutes } from './routes/agentRoutes.js';
import { handleNodeActionRoute, handleSubagentTranscriptRoute } from './routes/nodeRoutes.js';
import { handleProjectSubRoute, handleProjectTopLevelRoutes } from './routes/projectRoutes.js';
import { handleSpeechRoutes } from './routes/speechRoutes.js';
import { handleSystemRoutes } from './routes/systemRoutes.js';
import { handleWorkflowRoutes } from './routes/workflowRoutes.js';
import { handleWorkspaceRoutes } from './routes/workspaceRoutes.js';

const PROJECT_NODE_ROUTE_PATTERN = /^\/api\/projects\/([a-zA-Z0-9_.-]+)\/(snapshot|events|github|commit-graph|worktrees|nodes\/([a-zA-Z0-9_.-]+)(?:\/(handoff|handoff-message|interaction|interrupt|compact|terminal|terminal-input|terminal-attachments|terminal-resize|resume|create-agent|close-tab|rename|rename-worktree|delete-worktree|worktree|message|chat-options|rewind|rewind-picker|events|conversation-image|subagents))?)$/;

export async function handleLocalRoute(
  runtime: LocalRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  url: URL,
): Promise<void> {
  const ctx = createRouteContext(runtime, req, res, requestId, url);
  try {
    if (await handleWorkspaceRoutes(ctx)) return;
    if (await handleSpeechRoutes(ctx)) return;
    if (await handleWorkflowRoutes(ctx)) return;
    if (await handleAgentRoutes(ctx)) return;
    if (await handleSystemRoutes(ctx)) return;
    if (await handleProjectTopLevelRoutes(ctx)) return;
    if (await handleSubagentTranscriptRoute(ctx)) return;

    const match = ctx.pathname.match(PROJECT_NODE_ROUTE_PATTERN);
    if (!match) {
      ctx.sendError(404, 'INVALID_ARGUMENT', 'Unknown standalone ADE endpoint');
      return;
    }
    const [, projectId, route, nodeId, action] = match;
    const project = runtime.store.project(projectId);

    if (await handleProjectSubRoute(ctx, projectId, project, route)) return;
    await handleNodeActionRoute(ctx, projectId, project, nodeId!, action);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const issue = error instanceof CliError ? error.issue : { code: 'INTERNAL' as const, message: 'Standalone ADE operation failed', retryable: false };
    const status =
      issue.code === 'FORBIDDEN_ORIGIN' ? 403 :
      issue.code === 'INVALID_ARGUMENT' ? 400 :
      issue.code === 'METHOD_NOT_ALLOWED' ? 405 :
      issue.code.endsWith('_NOT_FOUND') ? 404 :
      issue.code === 'RATE_LIMITED' ? 429 : 500;
    ctx.sendError(status, issue.code, issue.message, issue.retryable);
  }
}
