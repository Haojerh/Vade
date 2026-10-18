import http from 'node:http';
import type {
  ErrorCode,
  RenameNodeTitleRequest,
  CreateAgentRequest,
  CreateWorktreeRequest,
} from '../../shared/contracts.js';
import { CliError, runOrca, type CommandRunner } from '../integrations/cli.js';
import { globalSourceMaps } from '../integrations/orca/state.js';
import {
  sendAgentMessage,
  deleteWorktree,
  closeAgentTab,
  renameNodeTitle,
  createWorktreeAgent,
} from '../integrations/orca/actions.js';
import type { SnapshotManager } from '../services/snapshot.js';
import { decodeAttachments, storeAttachments } from '../services/attachments.js';
import { createProjectWorktree, renameWorktree } from '../integrations/worktrees.js';
import { parseJsonBody } from './httpUtils.js';

export interface ActionRouteMatches {
  isMessagePost: RegExpMatchArray | null;
  isCloseTabPost: RegExpMatchArray | null;
  isRenamePost: RegExpMatchArray | null;
  isRenameWorktreePost: RegExpMatchArray | null;
  isCreateWorktreePost: RegExpMatchArray | null;
  isCreateAgentPost: RegExpMatchArray | null;
  isDeleteWorktreePost: RegExpMatchArray | null;
  isDeleteWorktreeDelete: RegExpMatchArray | null;
}

export function matchActionRoutes(pathname: string): ActionRouteMatches {
  return {
    isMessagePost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/message$/),
    isCloseTabPost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/close-tab$/),
    isRenamePost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/rename$/),
    isRenameWorktreePost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/rename-worktree$/),
    isCreateWorktreePost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/worktrees$/),
    isCreateAgentPost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/create-agent$/),
    isDeleteWorktreePost: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/delete-worktree$/),
    isDeleteWorktreeDelete: pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/worktree$/),
  };
}

export function isMethodAllowedForRoute(
  reqMethod: string,
  matches: ActionRouteMatches
): boolean {
  if (reqMethod === 'POST') {
    return Boolean(
      matches.isMessagePost ||
        matches.isCloseTabPost ||
        matches.isRenamePost ||
        matches.isRenameWorktreePost ||
        matches.isCreateWorktreePost ||
        matches.isCreateAgentPost ||
        matches.isDeleteWorktreePost
    );
  }
  if (reqMethod === 'DELETE') {
    return Boolean(matches.isDeleteWorktreeDelete);
  }
  return true;
}

export interface ActionRouteContext {
  req: http.IncomingMessage;
  reqMethod: string;
  query: Record<string, string>;
  matches: ActionRouteMatches;
  runner: CommandRunner;
  snapshotManager: SnapshotManager;
  sendJson: (statusCode: number, data: any) => void;
  sendError: (statusCode: number, code: ErrorCode, message: string, retryable?: boolean) => void;
}

export async function handleActionRoute(ctx: ActionRouteContext): Promise<boolean> {
  const { req, reqMethod, query, matches, runner, snapshotManager, sendJson, sendError } = ctx;
  const {
    isMessagePost,
    isCloseTabPost,
    isRenamePost,
    isRenameWorktreePost,
    isCreateWorktreePost,
    isCreateAgentPost,
    isDeleteWorktreePost,
    isDeleteWorktreeDelete,
  } = matches;

  // POST /api/projects/:projectId/nodes/:nodeId/message
  if (isMessagePost) {
    if (reqMethod !== 'POST') {
      sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed for messaging endpoint`);
      return true;
    }
    const projectId = decodeURIComponent(isMessagePost[1]);
    const nodeId = decodeURIComponent(isMessagePost[2]);
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(400, 'INVALID_ARGUMENT', 'Messaging requires application/json');
      return true;
    }
    const body = await parseJsonBody<{ message?: string; attachments?: unknown }>(req, 29 * 1024 * 1024);
    if (!body || typeof body.message !== 'string' || body.message.length > 10000) {
      sendError(400, 'INVALID_ARGUMENT', 'Field "message" must be a string up to 10000 characters');
      return true;
    }
    const decoded = decodeAttachments(body.attachments);
    if (!body.message.trim() && !decoded.length) {
      sendError(400, 'INVALID_ARGUMENT', 'Add a message or attachment');
      return true;
    }
    let attachments: Parameters<typeof sendAgentMessage>[4];
    if (decoded.length) {
      const snapshot = await snapshotManager.getSnapshot(projectId, null, runner);
      const node = snapshot.graph.data?.nodes.find((candidate) => candidate.id === nodeId);
      const source = globalSourceMaps.nodeSourceMap.get(nodeId);
      if (!node || !['agent', 'orchestrator'].includes(node.kind) || !source?.handle || !source.worktreeId) {
        throw new CliError('INVALID_ARGUMENT', 'Attachments require a discovered agent in this project');
      }
      const terminals = await runOrca<any>(
        ['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '100', '--json'],
        runner
      );
      const terminal = terminals.result?.terminals?.find((item: any) => item.handle === source.handle);
      if (!terminal?.connected || terminal.executionHostId !== 'local') {
        throw new CliError(
          'INVALID_ARGUMENT',
          'Attachment delivery currently requires a connected local terminal; remote uploads are not supported'
        );
      }
      attachments = { provider: node.agentType, files: await storeAttachments(decoded) };
    }
    const result = await sendAgentMessage(
      projectId,
      nodeId,
      body.message.trim() || 'Please inspect the attached files.',
      runner,
      attachments
    );
    sendJson(200, result);
    return true;
  }

  // POST /api/projects/:projectId/nodes/:nodeId/close-tab
  if (isCloseTabPost && reqMethod === 'POST') {
    const projectId = decodeURIComponent(isCloseTabPost[1]);
    const nodeId = decodeURIComponent(isCloseTabPost[2]);
    const result = await closeAgentTab(projectId, nodeId, runner);
    sendJson(200, result);
    return true;
  }

  // POST /api/projects/:projectId/worktrees
  if (isCreateWorktreePost && reqMethod === 'POST') {
    if (Object.keys(query).length) {
      sendError(400, 'INVALID_ARGUMENT', 'Create worktree does not accept query parameters');
      return true;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(400, 'INVALID_ARGUMENT', 'Create worktree requires application/json');
      return true;
    }
    const body = await parseJsonBody<CreateWorktreeRequest>(req, 4096);
    sendJson(200, await createProjectWorktree(isCreateWorktreePost[1], body, runner));
    return true;
  }

  // POST /api/projects/:projectId/nodes/:nodeId/rename or /rename-worktree
  if ((isRenamePost || isRenameWorktreePost) && reqMethod === 'POST') {
    const match = isRenameWorktreePost || isRenamePost!;
    const projectId = decodeURIComponent(match[1]);
    const nodeId = decodeURIComponent(match[2]);
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(400, 'INVALID_ARGUMENT', 'Rename requires application/json');
      return true;
    }
    const body = await parseJsonBody<RenameNodeTitleRequest>(req, 1024 * 64);
    if (
      !body ||
      typeof body.title !== 'string' ||
      body.title.length > 100 ||
      body.title.includes('\n') ||
      /[\x00-\x1f\x7f]/.test(body.title) ||
      body.title.trim().startsWith('-')
    ) {
      sendError(400, 'INVALID_ARGUMENT', 'Field "title" must be a single-line string up to 100 characters');
      return true;
    }
    const result = await (isRenameWorktreePost ? renameWorktree : renameNodeTitle)(
      projectId,
      nodeId,
      body.title,
      runner
    );
    sendJson(200, result);
    return true;
  }

  // POST /api/projects/:projectId/nodes/:nodeId/create-agent
  if (isCreateAgentPost && reqMethod === 'POST') {
    const projectId = decodeURIComponent(isCreateAgentPost[1]);
    const nodeId = decodeURIComponent(isCreateAgentPost[2]);
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(400, 'INVALID_ARGUMENT', 'Create agent requires application/json');
      return true;
    }
    const body = await parseJsonBody<CreateAgentRequest>(req, 1024 * 64);
    if (
      !body ||
      typeof body.command !== 'string' ||
      body.command.trim().length === 0 ||
      body.command.length > 200 ||
      body.command.includes('\n') ||
      body.command.includes('\r')
    ) {
      sendError(400, 'INVALID_ARGUMENT', 'Field "command" must be a non-empty string up to 200 characters');
      return true;
    }
    if (
      body.title !== undefined &&
      (typeof body.title !== 'string' ||
        body.title.length > 100 ||
        body.title.includes('\n') ||
        body.title.includes('\r'))
    ) {
      sendError(400, 'INVALID_ARGUMENT', 'Field "title" must be a string up to 100 characters');
      return true;
    }
    const result = await createWorktreeAgent(
      projectId,
      nodeId,
      body.command.trim(),
      body.title?.trim(),
      runner
    );
    sendJson(200, result);
    return true;
  }

  // POST /api/projects/:projectId/nodes/:nodeId/delete-worktree or DELETE /api/projects/:projectId/nodes/:nodeId/worktree
  if ((isDeleteWorktreePost && reqMethod === 'POST') || (isDeleteWorktreeDelete && reqMethod === 'DELETE')) {
    const match = isDeleteWorktreePost || isDeleteWorktreeDelete!;
    const projectId = decodeURIComponent(match[1]);
    const nodeId = decodeURIComponent(match[2]);
    const result = await deleteWorktree(projectId, nodeId, runner);
    sendJson(200, result);
    return true;
  }

  return false;
}
