import type http from 'node:http';
import { CliError } from '../integrations/cli.js';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import { createResponseHelpers, parseJsonBody } from './httpUtils.js';

export function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new CliError('INVALID_ARGUMENT', `Invalid ${label}`);
  }
  return value.trim();
}

export interface RouteContext {
  readonly runtime: LocalRuntime;
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly requestId: string;
  readonly url: URL;
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly sendJson: (statusCode: number, data: unknown) => void;
  readonly sendError: (statusCode: number, code: any, message: string, retryable?: boolean) => void;
  requireMethod(allowed: string): void;
  queryKeys(...keys: string[]): void;
  body<T extends object>(keys: string[], max?: number): Promise<T>;
}

export function createRouteContext(
  runtime: LocalRuntime,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  url: URL,
): RouteContext {
  const { sendJson, sendError } = createResponseHelpers(res, requestId);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;
  const query = url.searchParams;

  const requireMethod = (allowed: string) => {
    if (method !== allowed && !(allowed === 'GET' && method === 'HEAD')) {
      throw new CliError('METHOD_NOT_ALLOWED', `Use ${allowed} for this endpoint`);
    }
  };

  const queryKeys = (...keys: string[]) => {
    if (
      [...query.keys()].some(key => !keys.includes(key)) ||
      [...query.keys()].some(key => query.getAll(key).length !== 1 || !query.get(key))
    ) {
      throw new CliError('INVALID_ARGUMENT', 'Unexpected, empty or duplicate query parameter');
    }
    if (query.has('runId')) {
      throw new CliError('RUN_NOT_FOUND', 'Standalone ADE has no orchestration runs');
    }
  };

  const body = async <T extends object>(keys: string[], max = 8192): Promise<T> => {
    if (!req.headers['content-type']?.startsWith('application/json')) {
      throw new CliError('INVALID_ARGUMENT', 'Actions require application/json');
    }
    const value = await parseJsonBody<T>(req, max);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) {
      throw new CliError('INVALID_ARGUMENT', 'Unexpected request field');
    }
    return value;
  };

  return {
    runtime,
    req,
    res,
    requestId,
    url,
    method,
    pathname,
    query,
    sendJson,
    sendError,
    requireMethod,
    queryKeys,
    body,
  };
}
