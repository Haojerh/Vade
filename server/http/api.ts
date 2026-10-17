import http from 'node:http';
import url from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  Id,
  ApiError,
  ErrorCode,
  Section,
  Inventory,
  HealthResponse,
  GitHubQuery,
  PrerequisitesStatus,
} from '../../shared/contracts.js';
import { CommandRunner, defaultCommandRunner, CliError } from '../integrations/cli.js';
import { collectInventory, globalSourceMaps, sendAgentMessage, checkPrerequisites } from '../integrations/orca.js';
import { collectGitHubData } from '../integrations/github.js';
import { SnapshotManager, defaultSnapshotManager } from '../services/snapshot.js';
import { UsageCollector } from '../integrations/usage.js';
import { decodeAttachments, storeAttachments } from '../services/attachments.js';
import { runOrca } from '../integrations/cli.js';

export interface ApiServerOptions {
  runner?: CommandRunner;
  snapshotManager?: SnapshotManager;
  distDir?: string;
  allowedOrigins?: string[];
  devMode?: boolean;
  usageCollector?: UsageCollector;
  checkAppInstallation?: () => boolean;
  checkAppOpen?: () => Promise<boolean> | boolean;
  checkCliSkillInstallation?: () => boolean;
  checkOrchestrationSkillInstallation?: () => boolean;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function parseJsonBody<T = any>(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new CliError('INVALID_ARGUMENT', 'Request payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > maxBytes) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) {
          reject(new CliError('INVALID_ARGUMENT', 'Request body cannot be empty'));
          return;
        }
        resolve(JSON.parse(raw));
      } catch {
        reject(new CliError('INVALID_ARGUMENT', 'Malformed JSON in request body'));
      }
    });
    req.on('error', (err) => reject(err));
    req.on('aborted', () => reject(new CliError('INVALID_ARGUMENT', 'Upload was interrupted')));
  });
}

export function createApiHandler(options: ApiServerOptions = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const snapshotManager = options.snapshotManager ?? defaultSnapshotManager;
  const usageCollector = options.usageCollector ?? new UsageCollector();
  const distDir = options.distDir ?? path.resolve(process.cwd(), 'dist');
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:4317',
      'http://localhost:4317',
    ]
  );

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const requestId = crypto.randomUUID();
    const reqMethod = req.method ?? 'GET';

    const sendJson = (statusCode: number, data: any) => {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };

    const sendError = (statusCode: number, code: ErrorCode, message: string, retryable = false) => {
      const errPayload: ApiError = {
        error: { code, message, retryable },
        requestId,
      };
      sendJson(statusCode, errPayload);
    };

    // 1. Origin validation for CORS
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        sendError(403, 'FORBIDDEN_ORIGIN', `Origin ${origin} is not allowed`);
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
    }

    if (reqMethod === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Reject unsupported write methods
    if (reqMethod !== 'GET' && reqMethod !== 'HEAD' && reqMethod !== 'POST') {
      sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed`);
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    // POST is strictly allowed only for agent node messaging
    const isMessagePost = pathname.match(/^\/api\/projects\/[a-zA-Z0-9_.-]+\/nodes\/[a-zA-Z0-9_.-]+\/message$/);
    if (reqMethod === 'POST' && !isMessagePost) {
      sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed for ${pathname}`);
      return;
    }
    const query: Record<string, string> = {};
    const seenQueryKeys = new Set<string>();
    let queryParseError: string | null = null;

    for (const [k, v] of reqUrl.searchParams.entries()) {
      if (seenQueryKeys.has(k)) {
        queryParseError = `Duplicate query parameter '${k}'`;
        break;
      }
      seenQueryKeys.add(k);
      if (v === '') {
        queryParseError = `Query parameter '${k}' cannot be empty`;
        break;
      }
      query[k] = v;
    }

    // 3. API Routes
    if (pathname.startsWith('/api/')) {
      if (queryParseError) {
        sendError(400, 'INVALID_ARGUMENT', queryParseError);
        return;
      }

      if (reqMethod === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
        return;
      }

      try {
        // GET /api/health
        if (pathname === '/api/health') {
          if (Object.keys(query).length > 0) {
            sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/health');
            return;
          }
          const health: HealthResponse = { status: 'ok', readOnly: true };
          sendJson(200, health);
          return;
        }

        // GET /api/prerequisites: verify Orca desktop app, CLI, and Orchestration skill.
        if (pathname === '/api/prerequisites') {
          if (Object.keys(query).length > 0) {
            sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/prerequisites');
            return;
          }
          const prereqs = await checkPrerequisites(runner, {
            checkAppInstallation: options.checkAppInstallation,
            checkAppOpen: options.checkAppOpen,
            checkCliSkillInstallation: options.checkCliSkillInstallation,
            checkOrchestrationSkillInstallation: options.checkOrchestrationSkillInstallation,
          });
          sendJson(200, prereqs);
          return;
        }

        // GET /api/usage: shared host quota snapshot, independent of project selection.
        if (pathname === '/api/usage') {
          if (Object.keys(query).length) {
            sendError(400, 'INVALID_ARGUMENT', 'Usage endpoint does not accept query parameters');
            return;
          }
          sendJson(200, await usageCollector.get());
          return;
        }

        // GET /api/projects
        if (pathname === '/api/projects') {
          if (Object.keys(query).length > 0) {
            sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/projects');
            return;
          }
          const { inventory, meta } = await collectInventory(runner);
          const response: Section<Inventory> = {
            data: inventory,
            meta,
          };
          sendJson(200, response);
          return;
        }

        // GET /api/projects/:projectId/snapshot
        const snapshotMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/snapshot$/);
        if (snapshotMatch) {
          const projectId = decodeURIComponent(snapshotMatch[1]);
          for (const k of Object.keys(query)) {
            if (k !== 'runId') {
              sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
              return;
            }
          }
          const runId = typeof query.runId === 'string' ? query.runId : null;
          const snapshot = await snapshotManager.getSnapshot(projectId, runId, runner);
          sendJson(200, snapshot);
          return;
        }

        // GET /api/projects/:projectId/events (SSE)
        const eventsMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/events$/);
        if (eventsMatch) {
          const projectId = decodeURIComponent(eventsMatch[1]);
          for (const k of Object.keys(query)) {
            if (k !== 'runId') {
              sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
              return;
            }
          }
          const runId = typeof query.runId === 'string' ? query.runId : null;

          // Setup SSE headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          // Comment heartbeat every 15s
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
            return;
          }

          req.on('close', () => {
            clearInterval(heartbeatTimer);
            if (unsubscribe) unsubscribe();
          });

          // Send cached evidence immediately; collect fresh data without blanking the graph.
          try {
            const cachedSnapshot = snapshotManager.getCachedSnapshot(projectId, runId);
            if (cachedSnapshot) {
              res.write(`event: snapshot\nid: ${cachedSnapshot.revision}\ndata: ${JSON.stringify(cachedSnapshot)}\n\n`);
            }
            const initialSnapshot = await snapshotManager.getSnapshot(projectId, runId, runner);
            if (!res.destroyed) {
              res.write(`event: snapshot\nid: ${initialSnapshot.revision}\ndata: ${JSON.stringify(initialSnapshot)}\n\n`);
            }
          } catch (err: any) {
            // Background polling can recover transient collection failures.
          }
          return;
        }

        // GET /api/projects/:projectId/nodes/:nodeId
        const nodeMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)$/);
        if (nodeMatch) {
          const projectId = decodeURIComponent(nodeMatch[1]);
          const nodeId = decodeURIComponent(nodeMatch[2]);

          for (const k of Object.keys(query)) {
            if (k !== 'cursor' && k !== 'limit' && k !== 'runId') {
              sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
              return;
            }
          }

          let limit = 100;
          if (query.limit !== undefined) {
            if (!/^\d+$/.test(query.limit)) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter limit must be an integer between 1 and 200');
              return;
            }
            const parsed = parseInt(query.limit, 10);
            if (parsed < 1 || parsed > 200) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter limit must be an integer between 1 and 200');
              return;
            }
            limit = parsed;
          }

          let cursor: string | null = null;
          if (query.cursor !== undefined) {
            if (query.cursor.length === 0 || query.cursor.length > 512) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter cursor must be string between 1 and 512 chars');
              return;
            }
            cursor = query.cursor;
          }

          let runId: string | null = null;
          if (query.runId !== undefined) {
            if (query.runId.length === 0 || query.runId.length > 256 || !/^[a-zA-Z0-9_.-]{1,256}$/.test(query.runId)) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter runId must be an opaque identifier between 1 and 256 chars');
              return;
            }
            runId = query.runId;
          }

          const details = await snapshotManager.getNodeDetails(projectId, nodeId, { runId, cursor, limit }, runner);
          sendJson(200, details);
          return;
        }

        // POST /api/projects/:projectId/nodes/:nodeId/message
        const messageMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/message$/);
        if (messageMatch) {
          if (reqMethod !== 'POST') {
            sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed for messaging endpoint`);
            return;
          }
          const projectId = decodeURIComponent(messageMatch[1]);
          const nodeId = decodeURIComponent(messageMatch[2]);
          if (!req.headers['content-type']?.startsWith('application/json')) {
            sendError(400, 'INVALID_ARGUMENT', 'Messaging requires application/json');
            return;
          }
          const body = await parseJsonBody<{ message?: string; attachments?: unknown }>(req, 29 * 1024 * 1024);
          if (!body || typeof body.message !== 'string' || body.message.length > 10000) {
            sendError(400, 'INVALID_ARGUMENT', 'Field "message" must be a string up to 10000 characters');
            return;
          }
          const decoded = decodeAttachments(body.attachments);
          if (!body.message.trim() && !decoded.length) {
            sendError(400, 'INVALID_ARGUMENT', 'Add a message or attachment');
            return;
          }
          let attachments: Parameters<typeof sendAgentMessage>[4];
          if (decoded.length) {
            const snapshot = await snapshotManager.getSnapshot(projectId, null, runner);
            const node = snapshot.graph.data?.nodes.find((candidate) => candidate.id === nodeId);
            const source = globalSourceMaps.nodeSourceMap.get(nodeId);
            if (!node || !['agent', 'orchestrator'].includes(node.kind) || !source?.handle || !source.worktreeId) {
              throw new CliError('INVALID_ARGUMENT', 'Attachments require a discovered agent in this project');
            }
            const terminals = await runOrca<any>(['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '100', '--json'], runner);
            const terminal = terminals.result?.terminals?.find((item: any) => item.handle === source.handle);
            if (!terminal?.connected || terminal.executionHostId !== 'local') {
              throw new CliError('INVALID_ARGUMENT', 'Attachment delivery currently requires a connected local terminal; remote uploads are not supported');
            }
            attachments = { provider: node.agentType, files: await storeAttachments(decoded) };
          }
          const result = await sendAgentMessage(projectId, nodeId, body.message.trim() || 'Please inspect the attached files.', runner, attachments);
          sendJson(200, result);
          return;
        }

        // GET /api/projects/:projectId/github
        const githubMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/github$/);
        if (githubMatch) {
          const projectId = decodeURIComponent(githubMatch[1]);

          for (const k of Object.keys(query)) {
            if (!['scope', 'nodeId', 'activity', 'page'].includes(k)) {
              sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
              return;
            }
          }

          const rawScope = query.scope;
          if (rawScope !== undefined && rawScope !== 'general' && rawScope !== 'worktree') {
            sendError(400, 'INVALID_ARGUMENT', `Query parameter scope must be 'general' or 'worktree'`);
            return;
          }

          const scopeKind = rawScope ?? 'general';
          let githubQuery: GitHubQuery;

          if (scopeKind === 'general') {
            if (query.nodeId !== undefined) {
              sendError(400, 'INVALID_ARGUMENT', 'General scope does not accept nodeId');
              return;
            }
            githubQuery = { scope: 'general' };
          } else {
            if (query.nodeId === undefined) {
              sendError(400, 'INVALID_ARGUMENT', 'Worktree scope requires nodeId');
              return;
            }
            if (query.nodeId.length === 0 || query.nodeId.length > 256 || !/^[a-zA-Z0-9_.-]{1,256}$/.test(query.nodeId)) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter nodeId must be an opaque identifier between 1 and 256 chars');
              return;
            }
            githubQuery = { scope: 'worktree', nodeId: query.nodeId };
          }

          if (query.activity !== undefined && !['commits', 'prs', 'issues'].includes(query.activity)) {
            sendError(400, 'INVALID_ARGUMENT', 'Invalid GitHub activity');
            return;
          }
          if (query.page !== undefined && (!/^[1-9][0-9]{0,4}$/.test(query.page) || Number(query.page) > 10000 || !query.activity)) {
            sendError(400, 'INVALID_ARGUMENT', 'Page requires activity and must be between 1 and 10000');
            return;
          }
          githubQuery = { ...githubQuery, activity: query.activity as GitHubQuery['activity'], page: query.page ? Number(query.page) : undefined };

          // Lookup project in inventory
          let project: any = null;
          const { inventory } = await collectInventory(runner);
          project = inventory.projects.find((p) => p.id === projectId);

          if (!project) {
            sendError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found`);
            return;
          }

          const githubData = await collectGitHubData(project, githubQuery, runner);
          sendJson(200, githubData);
          return;
        }

        // Unknown API route
        sendError(404, 'INVALID_ARGUMENT', `API route ${pathname} not found`);
        return;
      } catch (err: any) {
        if (err instanceof CliError) {
          const status =
            err.issue.code === 'PROJECT_NOT_FOUND' || err.issue.code === 'NODE_NOT_FOUND' || err.issue.code === 'RUN_NOT_FOUND'
              ? 404
              : err.issue.code === 'INVALID_ARGUMENT'
              ? 400
              : err.issue.code === 'FORBIDDEN_ORIGIN'
              ? 403
              : err.issue.code === 'RATE_LIMITED'
              ? 429
              : 500;
          sendError(status, err.issue.code, err.issue.message, err.issue.retryable);
          return;
        }

        sendError(500, 'INTERNAL', 'An unexpected server error occurred');
        return;
      }
    }

    // 4. Static File Serving (Production Mode)
    if (!fs.existsSync(distDir)) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Orca Visualization</title></head><body><div id="root">Dashboard frontend building or not yet bundled. Run npm run build.</div></body></html>`);
        return;
      }
      sendError(404, 'INVALID_ARGUMENT', `File not found: ${pathname}`);
      return;
    }

    const safeRelativePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    let targetFile = path.join(distDir, safeRelativePath);

    // Path containment check
    if (!targetFile.startsWith(distDir)) {
      sendError(403, 'FORBIDDEN_ORIGIN', 'Access denied');
      return;
    }

    // If directory or doesn't exist, fallback to index.html (SPA)
    if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
      targetFile = path.join(distDir, 'index.html');
    }

    if (!fs.existsSync(targetFile)) {
      sendError(404, 'INVALID_ARGUMENT', 'index.html not found in dist');
      return;
    }

    const ext = path.extname(targetFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (reqMethod === 'HEAD') {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(targetFile).pipe(res);
  };
}

export function createServer(options: ApiServerOptions = {}): http.Server {
  const handler = createApiHandler(options);
  return http.createServer(handler);
}
