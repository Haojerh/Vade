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
} from '../shared/contracts.js';
import { CommandRunner, defaultCommandRunner, CliError } from './cli.js';
import { collectInventory, globalSourceMaps } from './orca.js';
import { collectGitHubData } from './github.js';
import { SnapshotManager, defaultSnapshotManager } from './snapshot.js';

export interface ApiServerOptions {
  runner?: CommandRunner;
  snapshotManager?: SnapshotManager;
  distDir?: string;
  allowedOrigins?: string[];
  devMode?: boolean;
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

export function createApiHandler(options: ApiServerOptions = {}) {
  const runner = options.runner ?? defaultCommandRunner;
  const snapshotManager = options.snapshotManager ?? defaultSnapshotManager;
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
    }

    if (reqMethod === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Reject write methods
    if (reqMethod !== 'GET' && reqMethod !== 'HEAD') {
      sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed`);
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;
    const query: Record<string, string> = {};
    for (const [k, v] of reqUrl.searchParams.entries()) {
      query[k] = v;
    }

    // 3. API Routes
    if (pathname.startsWith('/api/')) {
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

          // Send immediate initial snapshot
          try {
            const initialSnapshot = await snapshotManager.getSnapshot(projectId, runId, runner);
            res.write(`event: snapshot\nid: ${initialSnapshot.revision}\ndata: ${JSON.stringify(initialSnapshot)}\n\n`);
          } catch (err: any) {
            // Error represented in stream or initial response
          }

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
          return;
        }

        // GET /api/projects/:projectId/nodes/:nodeId
        const nodeMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)$/);
        if (nodeMatch) {
          const projectId = decodeURIComponent(nodeMatch[1]);
          const nodeId = decodeURIComponent(nodeMatch[2]);

          for (const k of Object.keys(query)) {
            if (k !== 'cursor' && k !== 'limit') {
              sendError(400, 'INVALID_ARGUMENT', `Unexpected query parameter '${k}'`);
              return;
            }
          }

          let limit = 100;
          if (query.limit) {
            const parsed = parseInt(String(query.limit), 10);
            if (isNaN(parsed) || parsed < 1 || parsed > 200) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter limit must be an integer between 1 and 200');
              return;
            }
            limit = parsed;
          }

          let cursor: string | null = null;
          if (query.cursor) {
            if (typeof query.cursor !== 'string' || query.cursor.length > 512) {
              sendError(400, 'INVALID_ARGUMENT', 'Query parameter cursor must be string <= 512 chars');
              return;
            }
            cursor = query.cursor;
          }

          const details = await snapshotManager.getNodeDetails(projectId, nodeId, { cursor, limit }, runner);
          sendJson(200, details);
          return;
        }

        // GET /api/projects/:projectId/github
        const githubMatch = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/github$/);
        if (githubMatch) {
          const projectId = decodeURIComponent(githubMatch[1]);
          if (Object.keys(query).length > 0) {
            sendError(400, 'INVALID_ARGUMENT', 'No query parameters allowed on /api/projects/:projectId/github');
            return;
          }

          // Lookup project in inventory
          let project: any = null;
          const { inventory } = await collectInventory(runner);
          project = inventory.projects.find((p) => p.id === projectId);

          if (!project) {
            sendError(404, 'PROJECT_NOT_FOUND', `Project ${projectId} not found`);
            return;
          }

          const githubData = await collectGitHubData(project, runner);
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
