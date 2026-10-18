import crypto from 'node:crypto';
import { Id } from '../../../shared/contracts.js';
import { CliError } from '../cli.js';

export interface RunAssociation {
  associated: boolean;
  association?: 'coordinator-terminal' | 'worker-workspace';
  coordinatorNodeId?: Id | null;
}

export interface NodeSourceEntry {
  handle?: string;
  worktreeId?: string;
  worktreePath?: string;
  paneKey?: string;
  endpointIncarnation?: string;
  ptyId?: string;
}

// In-memory mappings between source identifiers and API IDs
export interface OrcaSourceMaps {
  projectSourceMap: Map<Id, { sourceId: string; repoIds: string[]; paths: string[] }>;
  nodeSourceMap: Map<Id, NodeSourceEntry>;
  cursorMap: Map<string, string>; // server-issued source-bound cursors
  runAssociationCache: Map<string, RunAssociation>;
  observedAppVersion: string | null;
  dispatchMap: Map<string, { dispatchId: string; ambiguous?: boolean; tool?: { name: string; input: string | null } | null }>;
}

export const globalSourceMaps: OrcaSourceMaps = {
  projectSourceMap: new Map(),
  nodeSourceMap: new Map(),
  cursorMap: new Map(),
  runAssociationCache: new Map(),
  observedAppVersion: null,
  dispatchMap: new Map(),
};

export const workerLaunchCache = new Map<string, { model: string | null; effort: string | null }>();

export type CursorSourceMode =
  | 'worker-read-transcript'
  | 'antigravity-transcript'
  | 'coordinator-transcript'
  | 'terminal';

export interface StoredCursor {
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
