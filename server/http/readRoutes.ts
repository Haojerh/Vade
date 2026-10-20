import http from 'node:http';
import type {
  ErrorCode,
  Section,
  Inventory,
  HealthResponse,
  GitHubQuery,
} from '../../shared/contracts.js';
import type { CommandRunner } from '../integrations/cli.js';
import { collectInventory } from '../integrations/orca/inventory.js';
import { checkPrerequisites, type CheckPrerequisitesOptions } from '../integrations/orca/prerequisites.js';
import { collectGitHubData } from '../integrations/github.js';
import type { SnapshotManager } from '../services/snapshot.js';
import type { UsageCollector } from '../integrations/usage.js';
import type { InboxCollector } from '../services/inbox.js';
import { getAgentCatalog } from '../integrations/agents.js';
import { collectCommitGraph } from '../integrations/commitGraph.js';

export interface ReadRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  reqMethod: string;
  pathname: string;
  query: Record<string, string>;
  runner: CommandRunner;
  snapshotManager: SnapshotManager;
  usageCollector: UsageCollector;
  inboxCollector: InboxCollector;
  prereqOptions: CheckPrerequisitesOptions;
  sendJson: (statusCode: number, data: any) => void;
  sendError: (statusCode: number, code: ErrorCode, message: string, retryable?: boolean) => void;
}

export async function handleReadRoute(ctx: ReadRouteContext): Promise<boolean> {
  const {
    req,
    res,
    reqMethod,
    pathname,
    query,
    runner,
    snapshotManager,
    usageCollector,
    prereqOptions,
    sendJson,
    sendError,
  } = ctx;

  // GET /api/health
  if (pathname === '/api/inbox') {
    if (Object.keys(query).length) sendError(400, 'INVALID_ARGUMENT', 'Inbox endpoint does not accept query parameters');
    else sendJson(200, await ctx.inboxCollector.get());
    return true;
  }

  if (pathname === '/api/health') {
    if (Object.keys(query).length > 0) {
      sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/health');
      return true;
    }
    const health: HealthResponse = { status: 'ok', readOnly: true };
    sendJson(200, health);
    return true;
  }

  // GET /api/prerequisites: verify Orca desktop app, CLI, and Orchestration skill.
  if (pathname === '/api/prerequisites') {
    if (Object.keys(query).length > 0) {
      sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/prerequisites');
      return true;
    }
    const prereqs = await checkPrerequisites(runner, prereqOptions);
    sendJson(200, prereqs);
    return true;
  }

  // GET /api/agents/catalog: detected installed and available agents on host
  if (pathname === '/api/agents/catalog') {
    if (Object.keys(query).length > 0) {
      sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/agents/catalog');
      return true;
    }
    const catalog = getAgentCatalog();
    sendJson(200, catalog);
    return true;
  }

  // GET /api/usage: shared host quota snapshot, independent of project selection.
  if (pathname === '/api/usage') {
    if (Object.keys(query).length) {
      sendError(400, 'INVALID_ARGUMENT', 'Usage endpoint does not accept query parameters');
      return true;
    }
    sendJson(200, await usageCollector.get());
    return true;
  }

  // GET /api/projects
  if (pathname === '/api/projects') {
    if (Object.keys(query).length > 0) {
      sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/projects');
      return true;
    }
    const { inventory, meta } = await collectInventory(runner);
    const response: Section<Inventory> = {
      data: inventory,
      meta,
    };
    sendJson(200, response);
    return true;
  }

  // GET /api/projects/:projectId/snapshot
  const snapshotMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/snapshot$/);
  if (snapshotMatch) {
    const projectId = decodeURIComponent(snapshotMatch[1]);
    for (const k of Object.keys(query)) {
      if (k !== 'runId') {
        sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
        return true;
      }
    }
    const runId = typeof query.runId === 'string' ? query.runId : null;
    const snapshot = await snapshotManager.getSnapshot(projectId, runId, runner);
    sendJson(200, snapshot);
    return true;
  }

  // GET /api/projects/:projectId/events (SSE)
  const eventsMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/events$/);
  if (eventsMatch) {
    const projectId = decodeURIComponent(eventsMatch[1]);
    for (const k of Object.keys(query)) {
      if (k !== 'runId') {
        sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
        return true;
      }
    }
    const runId = typeof query.runId === 'string' ? query.runId : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const heartbeatTimer = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = snapshotManager.subscribe(projectId, runId, (snapshot) => {
        res.write(`event: snapshot\nid: ${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`);
      });
    } catch (err: any) {
      clearInterval(heartbeatTimer);
      sendError(429, 'RATE_LIMITED', err.message);
      return true;
    }

    req.on('close', () => {
      clearInterval(heartbeatTimer);
      if (unsubscribe) unsubscribe();
    });

    try {
      const cachedSnapshot = snapshotManager.getCachedSnapshot(projectId, runId);
      if (cachedSnapshot) {
        res.write(`event: snapshot\nid: ${cachedSnapshot.revision}\ndata: ${JSON.stringify(cachedSnapshot)}\n\n`);
      }
      const initialSnapshot = await snapshotManager.getSnapshot(projectId, runId, runner);
      if (!res.destroyed) {
        res.write(`event: snapshot\nid: ${initialSnapshot.revision}\ndata: ${JSON.stringify(initialSnapshot)}\n\n`);
      }
    } catch {
      // Background polling can recover transient collection failures.
    }
    return true;
  }

  // GET /api/projects/:projectId/nodes/:nodeId
  const nodeMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)$/);
  if (nodeMatch) {
    const projectId = decodeURIComponent(nodeMatch[1]);
    const nodeId = decodeURIComponent(nodeMatch[2]);

    for (const k of Object.keys(query)) {
      if (k !== 'cursor' && k !== 'limit' && k !== 'runId' && k !== 'direction') {
        sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
        return true;
      }
    }

    let limit = 100;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit)) {
        sendError(400, 'INVALID_ARGUMENT', 'Query parameter limit must be an integer between 1 and 200');
        return true;
      }
      const parsed = parseInt(query.limit, 10);
      if (parsed < 1 || parsed > 200) {
        sendError(400, 'INVALID_ARGUMENT', 'Query parameter limit must be an integer between 1 and 200');
        return true;
      }
      limit = parsed;
    }

    let cursor: string | null = null;
    if (query.cursor !== undefined) {
      if (query.cursor.length === 0 || query.cursor.length > 512) {
        sendError(400, 'INVALID_ARGUMENT', 'Query parameter cursor must be string between 1 and 512 chars');
        return true;
      }
      cursor = query.cursor;
    }

    let runId: string | null = null;
    if (query.runId !== undefined) {
      if (query.runId.length === 0 || query.runId.length > 256 || !/^[a-zA-Z0-9_.-]{1,256}$/.test(query.runId)) {
        sendError(400, 'INVALID_ARGUMENT', 'Query parameter runId must be an opaque identifier between 1 and 256 chars');
        return true;
      }
      runId = query.runId;
    }

    if (query.direction !== undefined && query.direction !== 'older') {
      sendError(400, 'INVALID_ARGUMENT', 'Conversation direction must be older');
      return true;
    }
    const details = await snapshotManager.getNodeDetails(projectId, nodeId, { runId, cursor, limit, direction: query.direction as 'older' | undefined }, runner);
    sendJson(200, details);
    return true;
  }

  // GET /api/projects/:projectId/commit-graph
  const commitGraphMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/commit-graph$/);
  if (commitGraphMatch && reqMethod === 'GET') {
    if (
      Object.keys(query).some((k) => k !== 'nodeId') ||
      (query.nodeId && !/^[a-zA-Z0-9_.-]{1,256}$/.test(query.nodeId))
    ) {
      sendError(400, 'INVALID_ARGUMENT', 'Invalid commit graph scope');
      return true;
    }
    sendJson(200, await collectCommitGraph(commitGraphMatch[1], query.nodeId, runner));
    return true;
  }

  // GET /api/projects/:projectId/github
  const githubMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/github$/);
  if (githubMatch) {
    const projectId = decodeURIComponent(githubMatch[1]);

    for (const k of Object.keys(query)) {
      if (!['scope', 'nodeId', 'activity', 'page'].includes(k)) {
        sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
        return true;
      }
    }

    const rawScope = query.scope;
    if (rawScope !== undefined && rawScope !== 'general' && rawScope !== 'worktree') {
      sendError(400, 'INVALID_ARGUMENT', `Query parameter scope must be 'general' or 'worktree'`);
      return true;
    }

    const scopeKind = rawScope ?? 'general';
    let githubQuery: GitHubQuery;

    if (scopeKind === 'general') {
      if (query.nodeId !== undefined) {
        sendError(400, 'INVALID_ARGUMENT', 'General scope does not accept nodeId');
        return true;
      }
      githubQuery = { scope: 'general' };
    } else {
      if (query.nodeId === undefined) {
        sendError(400, 'INVALID_ARGUMENT', 'Worktree scope requires nodeId');
        return true;
      }
      if (query.nodeId.length === 0 || query.nodeId.length > 256 || !/^[a-zA-Z0-9_.-]{1,256}$/.test(query.nodeId)) {
        sendError(400, 'INVALID_ARGUMENT', 'Query parameter nodeId must be an opaque identifier between 1 and 256 chars');
        return true;
      }
      githubQuery = { scope: 'worktree', nodeId: query.nodeId };
    }

    if (query.activity !== undefined && !['commits', 'prs', 'issues'].includes(query.activity)) {
      sendError(400, 'INVALID_ARGUMENT', 'Invalid GitHub activity');
      return true;
    }
    if (
      query.page !== undefined &&
      (!/^[1-9][0-9]{0,4}$/.test(query.page) || Number(query.page) > 10000 || !query.activity)
    ) {
      sendError(400, 'INVALID_ARGUMENT', 'Page requires activity and must be between 1 and 10000');
      return true;
    }
    githubQuery = {
      ...githubQuery,
      activity: query.activity as GitHubQuery['activity'],
      page: query.page ? Number(query.page) : undefined,
    };

    const { inventory } = await collectInventory(runner);
    const project = inventory.projects.find((p) => p.id === projectId);

    if (!project) {
      sendError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found`);
      return true;
    }

    const githubData = await collectGitHubData(project, githubQuery, runner);
    sendJson(200, githubData);
    return true;
  }

  return false;
}
