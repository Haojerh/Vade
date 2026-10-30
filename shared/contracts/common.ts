export type Id = string; // opaque server-issued ID, 1..256 chars
export type ISO = string; // validated UTC ISO-8601 timestamp
export type State = 'working' | 'waiting' | 'blocked' | 'completed' | 'failed'
  | 'interrupted' | 'idle' | 'unknown';
export type Availability = 'ready' | 'empty' | 'unavailable' | 'unsupported';
export type ErrorCode = 'INVALID_ARGUMENT' | 'PROJECT_NOT_FOUND' | 'RUN_NOT_FOUND'
  | 'NODE_NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'FORBIDDEN_ORIGIN'
  | 'CLI_MISSING' | 'CLI_TIMEOUT' | 'CLI_FAILED' | 'INVALID_UPSTREAM'
  | 'RUNTIME_UNAVAILABLE' | 'AUTH_REQUIRED' | 'REMOTE_MISSING'
  | 'REMOTE_AMBIGUOUS' | 'REMOTE_UNSUPPORTED' | 'GITHUB_FORBIDDEN'
  | 'GITHUB_NOT_FOUND' | 'RATE_LIMITED' | 'SOURCE_CHANGED' | 'INTERNAL'
  | 'CONVERSATION_UNSUPPORTED' | 'SCOPE_UNAVAILABLE';

export interface Issue {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface SourceMeta {
  availability: Availability;
  observedAt: ISO | null; // last successful collection, not HTTP response time
  attemptedAt: ISO;
  stale: boolean;
  partial: boolean; // true for capped, omitted-host, or incomplete collections
  issue: Issue | null;
}

export interface Section<T> {
  data: T | null;
  meta: SourceMeta;
}

export interface ApiError {
  error: Issue;
  requestId: string;
}
