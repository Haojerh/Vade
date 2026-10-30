import crypto from 'node:crypto';
import type { Id } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';

export type CursorSourceMode =
  | 'opencode-db'
  | 'worker-read-transcript'
  | 'antigravity-transcript'
  | 'coordinator-transcript'
  | 'terminal';

export interface StoredCursor {
  direction?: 'older';
  upstreamCursor: string;
  projectId: Id;
  nodeId: Id;
  runId: Id | null;
  dispatchId?: string;
  sourceIdentity: string;
  sourceMode: CursorSourceMode;
  expiresAt: number;
  seekingNewline?: boolean;
}

export const cursorStore = new Map<string, StoredCursor>();
export const MAX_CURSORS = 1000;
export const CURSOR_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function pruneCursors(): void {
  const now = Date.now();
  for (const [k, v] of cursorStore.entries()) {
    if (v.expiresAt <= now) {
      cursorStore.delete(k);
    }
  }
  if (cursorStore.size >= MAX_CURSORS) {
    const keysToDelete = Array.from(cursorStore.keys()).slice(0, 200);
    for (const k of keysToDelete) {
      cursorStore.delete(k);
    }
  }
}

export function issueStoredCursor(entry: Omit<StoredCursor, 'expiresAt'>): string {
  pruneCursors();
  const publicNextCursor = 'cur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  cursorStore.set(publicNextCursor, {
    ...entry,
    expiresAt: Date.now() + CURSOR_TTL_MS,
  });
  return publicNextCursor;
}

export function validateStoredCursor(
  cursorToken: string,
  expected: {
    projectId: Id;
    nodeId: Id;
    runId: Id | null;
    sourceIdentity?: string;
    dispatchId?: string;
  }
): StoredCursor {
  pruneCursors();
  const stored = cursorStore.get(cursorToken);
  if (
    !stored ||
    stored.projectId !== expected.projectId ||
    stored.nodeId !== expected.nodeId ||
    (stored.runId ?? null) !== (expected.runId ?? null) ||
    (expected.sourceIdentity !== undefined && stored.sourceIdentity !== expected.sourceIdentity)
  ) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid or cross-bound cursor token');
  }
  if (
    expected.dispatchId &&
    stored.dispatchId &&
    stored.dispatchId !== expected.dispatchId &&
    stored.sourceMode === 'worker-read-transcript'
  ) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid or cross-bound cursor token');
  }
  return stored;
}
