import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { CommandRunner, defaultCommandRunner, CliError } from '../integrations/cli.js';
import { SnapshotManager, defaultSnapshotManager } from '../services/snapshot.js';
import { UsageCollector } from '../integrations/usage.js';
import { createResponseHelpers, parseSearchQuery, serveStaticFile } from './httpUtils.js';
import { handleReadRoute } from './readRoutes.js';
import { handleActionRoute, isMethodAllowedForRoute, matchActionRoutes } from './actionRoutes.js';

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
    const { sendJson, sendError } = createResponseHelpers(res, requestId);

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
    if (reqMethod !== 'GET' && reqMethod !== 'HEAD' && reqMethod !== 'POST' && reqMethod !== 'DELETE') {
      sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed`);
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;
    const actionMatches = matchActionRoutes(pathname);

    if (!isMethodAllowedForRoute(reqMethod, actionMatches)) {
      sendError(405, 'METHOD_NOT_ALLOWED', `Method ${reqMethod} is not allowed for ${pathname}`);
      return;
    }

    const { query, error: queryParseError } = parseSearchQuery(reqUrl.searchParams);

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
        const handledAction = await handleActionRoute({
          req,
          reqMethod,
          query,
          matches: actionMatches,
          runner,
          snapshotManager,
          sendJson,
          sendError,
        });
        if (handledAction) return;

        const handledRead = await handleReadRoute({
          req,
          res,
          reqMethod,
          pathname,
          query,
          runner,
          snapshotManager,
          usageCollector,
          prereqOptions: {
            checkAppInstallation: options.checkAppInstallation,
            checkAppOpen: options.checkAppOpen,
            checkCliSkillInstallation: options.checkCliSkillInstallation,
            checkOrchestrationSkillInstallation: options.checkOrchestrationSkillInstallation,
          },
          sendJson,
          sendError,
        });
        if (handledRead) return;

        sendError(404, 'INVALID_ARGUMENT', `API route ${pathname} not found`);
        return;
      } catch (err: any) {
        if (err instanceof CliError) {
          const status =
            err.issue.code === 'PROJECT_NOT_FOUND' ||
            err.issue.code === 'NODE_NOT_FOUND' ||
            err.issue.code === 'RUN_NOT_FOUND'
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
    serveStaticFile(pathname, reqMethod, distDir, res, sendError);
  };
}

export function createServer(options: ApiServerOptions = {}): http.Server {
  const handler = createApiHandler(options);
  return http.createServer(handler);
}
