import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import type { ApiError, ErrorCode } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';

export const MIME_TYPES: Record<string, string> = {
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

export async function parseJsonBody<T = any>(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<T> {
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

export function parseSearchQuery(searchParams: URLSearchParams): {
  query: Record<string, string>;
  error: string | null;
} {
  const query: Record<string, string> = {};
  const seenQueryKeys = new Set<string>();
  let error: string | null = null;

  for (const [k, v] of searchParams.entries()) {
    if (seenQueryKeys.has(k)) {
      error = `Duplicate query parameter '${k}'`;
      break;
    }
    seenQueryKeys.add(k);
    if (v === '') {
      error = `Query parameter '${k}' cannot be empty`;
      break;
    }
    query[k] = v;
  }

  return { query, error };
}

export function createResponseHelpers(res: http.ServerResponse, requestId: string) {
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

  return { sendJson, sendError };
}

export function serveStaticFile(
  pathname: string,
  reqMethod: string,
  distDir: string,
  res: http.ServerResponse,
  sendError: (statusCode: number, code: ErrorCode, message: string, retryable?: boolean) => void
): void {
  if (!fs.existsSync(distDir)) {
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html><head><title>Orca Visualization</title></head><body><div id="root">Dashboard frontend building or not yet bundled. Run npm run build.</div></body></html>`
      );
      return;
    }
    sendError(404, 'INVALID_ARGUMENT', `File not found: ${pathname}`);
    return;
  }

  const safeRelativePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let targetFile = path.join(distDir, safeRelativePath);

  if (!targetFile.startsWith(distDir)) {
    sendError(403, 'FORBIDDEN_ORIGIN', 'Access denied');
    return;
  }

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
}
