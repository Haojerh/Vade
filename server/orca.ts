import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import {
  Id,
  ISO,
  State,
  Project,
  Inventory,
  Run,
  Node,
  Edge,
  Task,
  Progress,
  Activity,
  Graph,
  SourceMeta,
  Section,
  NodeDetails,
  ConversationMessage,
  ConversationPage,
  ErrorCode,
} from '../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, CliError, cleanErrorMessage } from './cli.js';

export function hashId(prefix: string, key: string): Id {
  const h = crypto.createHash('sha256').update(key).digest('base64url').slice(0, 20);
  return `${prefix}_${h}`;
}

export function mapToState(raw: string | null | undefined): State {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase().trim();
  if (lower === 'working' || lower === 'running') return 'working';
  if (lower === 'waiting' || lower === 'awaiting input' || lower === 'awaiting approval') return 'waiting';
  if (lower === 'blocked') return 'blocked';
  if (lower === 'completed' || lower === 'done' || lower === 'succeeded' || lower === 'success') return 'completed';
  if (lower === 'failed' || lower === 'failure' || lower === 'error') return 'failed';
  if (lower === 'idle') return 'idle';
  return 'unknown';
}

export function normalizeLiveness(raw: any): 'live' | 'exited' | 'unverifiable' | 'unknown' {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const lower = raw.toLowerCase().trim();
  if (lower === 'live' || lower === 'running' || lower === 'active') return 'live';
  if (lower === 'exited' || lower === 'dead' || lower === 'stopped' || lower === 'none') return 'exited';
  if (lower === 'unverifiable') return 'unverifiable';
  if (lower === 'unknown') return 'unknown';
  return 'unknown';
}

export function stripAnsi(str: string): string {
  // Strips standard ANSI escape sequences
  return str.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
}

export function getAllowedTranscriptRoots(): string[] {
  const roots: string[] = [];
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  if (userHome) {
    roots.push(path.join(userHome, '.codex'));
    roots.push(path.join(userHome, '.gemini'));
    roots.push(path.join(userHome, '.orca'));
  }
  const appData = process.env.APPDATA || '';
  if (appData) {
    roots.push(path.join(appData, 'orca'));
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    roots.push(path.join(localAppData, 'orca'));
  }
  if (process.env.ORCA_APPDATA_DIR) {
    roots.push(path.resolve(process.env.ORCA_APPDATA_DIR));
  }
  if (process.env.GEMINI_APPDATA_DIR) {
    roots.push(path.resolve(process.env.GEMINI_APPDATA_DIR));
  }
  if (process.env.ANTIGRAVITY_APPDATA_DIR) {
    roots.push(path.resolve(process.env.ANTIGRAVITY_APPDATA_DIR));
  }
  return roots;
}

export function isPathInsideRoots(targetPath: string, allowedRoots: string[]): boolean {
  try {
    let canonicalTarget: string;
    try {
      canonicalTarget = fs.realpathSync(targetPath);
    } catch {
      canonicalTarget = path.resolve(targetPath);
    }
    const normTarget = path.normalize(canonicalTarget).toLowerCase();

    return allowedRoots.some((root) => {
      if (!root) return false;
      let canonicalRoot: string;
      try {
        canonicalRoot = fs.realpathSync(root);
      } catch {
        canonicalRoot = path.resolve(root);
      }
      const normRoot = path.normalize(canonicalRoot).toLowerCase();
      return (
        normTarget === normRoot ||
        normTarget.startsWith(normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep)
      );
    });
  } catch {
    return false;
  }
}

export interface BoundedTranscriptReadResult {
  lines: string[];
  hasMore: boolean;
  limited: boolean;
  nextByteOffset: number;
  seekingNewline?: boolean;
  totalScanned?: number;
}

export async function readBoundedTranscriptLines(
  filePath: string,
  startByteOffset?: number | null,
  recordLimit: number = 100,
  maxBytesWindow: number = 512 * 1024,
  seekingNewline: boolean = false,
  includeRecord?: (line: string) => boolean
): Promise<BoundedTranscriptReadResult> {
  const limit = Math.min(Math.max(recordLimit || 100, 1), 200);
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) {
      return { lines: [], hasMore: false, limited: false, nextByteOffset: 0, seekingNewline: false, totalScanned: 0 };
    }

    let readStart = 0;
    let readLen = 0;
    const isInitialTail = startByteOffset === null || startByteOffset === undefined;

    if (isInitialTail) {
      // Initial read: recent TAIL of the file
      if (fileSize > maxBytesWindow) {
        readStart = fileSize - maxBytesWindow;
        readLen = maxBytesWindow;
      } else {
        readStart = 0;
        readLen = fileSize;
      }
    } else {
      // Continuation read from explicit byte offset
      readStart = Math.min(startByteOffset, fileSize);
      if (readStart >= fileSize) {
        return { lines: [], hasMore: false, limited: seekingNewline, nextByteOffset: fileSize, seekingNewline, totalScanned: 0 };
      }
      readLen = Math.min(maxBytesWindow, fileSize - readStart);
    }

    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
    const sliceBuf = buf.subarray(0, bytesRead);

    // If seeking newline from an earlier giant line:
    if (seekingNewline) {
      const nlIdx = sliceBuf.indexOf(0x0a);
      if (nlIdx !== -1) {
        const nextByteOffset = readStart + nlIdx + 1;
        return {
          lines: [],
          hasMore: nextByteOffset < fileSize,
          limited: true,
          nextByteOffset,
          seekingNewline: false,
          totalScanned: 0,
        };
      }
      // Not in sliceBuf, scan at most 64KiB extra:
      let giantEnd = readStart + bytesRead;
      const extraBuf = Buffer.alloc(64 * 1024);
      const toScan = Math.min(extraBuf.length, fileSize - giantEnd);
      let foundNl = false;
      if (toScan > 0) {
        const n = fs.readSync(fd, extraBuf, 0, toScan, giantEnd);
        if (n > 0) {
          const extraIdx = extraBuf.subarray(0, n).indexOf(0x0a);
          if (extraIdx !== -1) {
            giantEnd += extraIdx + 1;
            foundNl = true;
          } else {
            giantEnd += n;
          }
        }
      }
      return {
        lines: [],
        hasMore: giantEnd < fileSize,
        limited: true,
        nextByteOffset: giantEnd,
        seekingNewline: !foundNl,
        totalScanned: 0,
      };
    }

    let initialDiscardBytes = 0;
    // On initial tail read, align to the first newline if we sliced into the middle of a file
    if (isInitialTail && readStart > 0) {
      const firstNl = sliceBuf.indexOf(0x0a);
      if (firstNl !== -1) {
        initialDiscardBytes = firstNl + 1;
      } else {
        // Initial huge no-newline tail!
        return {
          lines: [],
          hasMore: readStart + bytesRead < fileSize,
          limited: true,
          nextByteOffset: readStart + bytesRead,
          seekingNewline: true,
          totalScanned: 0,
        };
      }
    }

    // If we sliced before EOF, the trailing record is cut by chunk boundary.
    // If at EOF without trailing newline, check if trailing segment is valid JSON or an in-progress append.
    let trailingDiscardBytes = 0;
    if (readStart + readLen < fileSize) {
      const lastNl = sliceBuf.lastIndexOf(0x0a);
      if (lastNl !== -1 && lastNl >= initialDiscardBytes) {
        trailingDiscardBytes = bytesRead - (lastNl + 1);
      } else {
        // Giant line with no newline in the entire maxBytesWindow!
        // Bounded scan: scan at most 64KiB beyond readStart + readLen
        let giantEnd = readStart + readLen;
        const scanBuf = Buffer.alloc(64 * 1024);
        const toRead = Math.min(scanBuf.length, fileSize - giantEnd);
        let foundNl = false;
        if (toRead > 0) {
          const n = fs.readSync(fd, scanBuf, 0, toRead, giantEnd);
          if (n > 0) {
            const nlIdx = scanBuf.subarray(0, n).indexOf(0x0a);
            if (nlIdx !== -1) {
              giantEnd += nlIdx + 1;
              foundNl = true;
            } else {
              giantEnd += n;
            }
          }
        }
        return {
          lines: [],
          hasMore: giantEnd < fileSize,
          limited: true,
          nextByteOffset: giantEnd,
          seekingNewline: !foundNl,
          totalScanned: 0,
        };
      }
    } else {
      const lastNl = sliceBuf.lastIndexOf(0x0a);
      if (lastNl !== -1 && lastNl < bytesRead - 1) {
        const trailing = sliceBuf.subarray(lastNl + 1).toString('utf-8').trim();
        if (trailing) {
          try {
            JSON.parse(trailing);
          } catch {
            trailingDiscardBytes = bytesRead - (lastNl + 1);
          }
        }
      } else if (lastNl === -1 && bytesRead > 0) {
        const trailing = sliceBuf.toString('utf-8').trim();
        if (trailing) {
          try {
            JSON.parse(trailing);
          } catch {
            return {
              lines: [],
              hasMore: false,
              limited: isInitialTail && fileSize > maxBytesWindow,
              nextByteOffset: readStart,
              seekingNewline: false,
              totalScanned: 0,
            };
          }
        }
      }
    }

    const completeBuf = sliceBuf.subarray(initialDiscardBytes, bytesRead - trailingDiscardBytes);
    const text = completeBuf.toString('utf-8');

    const rawLines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((line) => Boolean(line) && (!includeRecord || includeRecord(line)));

    if (isInitialTail) {
      const rawCount = rawLines.length;
      const lines = rawCount > limit ? rawLines.slice(-limit) : rawLines;
      const limited = rawCount > limit || fileSize > maxBytesWindow;
      const nextByteOffset = readStart + readLen - trailingDiscardBytes;
      return {
        lines,
        hasMore: nextByteOffset < fileSize,
        limited,
        nextByteOffset,
        seekingNewline: false,
        totalScanned: lines.length,
      };
    } else {
      let lines: string[];
      let nextByteOffset: number;
      let hasMore: boolean;
      let limited: boolean;

      if (rawLines.length > limit) {
        lines = rawLines.slice(0, limit);
        let pos = 0;
        let lineCount = 0;
        let lineStart = 0;
        for (let i = 0; i < completeBuf.length; i++) {
          if (completeBuf[i] === 0x0a) {
            const line = completeBuf.subarray(lineStart, i).toString('utf-8').trim();
            lineStart = i + 1;
            if (!line || (includeRecord && !includeRecord(line))) continue;
            lineCount++;
            if (lineCount === limit) {
              pos = i + 1;
              break;
            }
          }
        }
        if (lineCount < limit) pos = completeBuf.length;
        nextByteOffset = readStart + initialDiscardBytes + pos;
        hasMore = true;
        limited = readLen === maxBytesWindow && readStart + readLen < fileSize;
      } else {
        lines = rawLines;
        if (trailingDiscardBytes > 0) {
          nextByteOffset = readStart + readLen - trailingDiscardBytes;
        } else {
          nextByteOffset = readStart + readLen;
        }
        hasMore = nextByteOffset < fileSize;
        limited = readLen === maxBytesWindow && (readStart + readLen < fileSize);
      }

      return {
        lines,
        hasMore,
        limited,
        nextByteOffset,
        seekingNewline: false,
        totalScanned: lines.length,
      };
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function toIsoOrNull(val: any): ISO | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0 || val > 1e15) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Must contain time and explicit timezone indicator (e.g. 09:38:45Z, 09:38:45+00:00, 09:38:45-05:00)
    // Reject ambiguous SQL timestamp strings lacking timezone (e.g. "2026-10-15 09:38:45" or "2026-10-15")
    const tzMatch = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
    if (!tzMatch.test(trimmed)) {
      return null;
    }
    const d = new Date(trimmed.replace(' ', 'T'));
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return null;
}

export interface RunAssociation {
  associated: boolean;
  association?: 'coordinator-terminal' | 'worker-workspace';
  coordinatorNodeId?: Id | null;
}

// In-memory mappings between source identifiers and API IDs
export interface OrcaSourceMaps {
  projectSourceMap: Map<Id, { sourceId: string; repoIds: string[]; paths: string[] }>;
  nodeSourceMap: Map<Id, { handle?: string; worktreeId?: string; paneKey?: string; endpointIncarnation?: string }>;
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

// 1. Fetch project inventory
export async function collectInventory(
  runner: CommandRunner = defaultCommandRunner
): Promise<{ inventory: Inventory; meta: SourceMeta; runtimeId: string | null; appVersion: string | null }> {
  const attemptedAt = new Date().toISOString();
  let runtimeId: string | null = null;
  let appVersion: string | null = globalSourceMaps.observedAppVersion;
  let partial = false;

  try {
    const [projectListRes, setupsRes, repoListRes, statusRes] = await Promise.allSettled([
      runOrca<any>(['project', 'list', '--json'], runner),
      runOrca<any>(['project', 'setups', '--json'], runner),
      runOrca<any>(['repo', 'list', '--json'], runner),
      runOrca<any>(['status', '--json'], runner),
    ]);

    if (statusRes.status === 'fulfilled') {
      const sResult = statusRes.value.result;
      const ver = sResult?.runtime?.appVersion;
      if (typeof ver === 'string') {
        appVersion = ver;
        globalSourceMaps.observedAppVersion = ver;
      }
      runtimeId = runtimeId || sResult?.runtime?.runtimeId || statusRes.value._meta?.runtimeId || null;
    }

    const allSourcesFailed =
      projectListRes.status === 'rejected' &&
      setupsRes.status === 'rejected' &&
      repoListRes.status === 'rejected';

    if (allSourcesFailed) {
      let failureMsg = 'All inventory sources failed';
      if (projectListRes.status === 'rejected') {
        failureMsg = projectListRes.reason?.message || failureMsg;
      }
      return {
        inventory: { projects: [] },
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: true,
          issue: {
            code: 'RUNTIME_UNAVAILABLE',
            message: failureMsg,
            retryable: true,
          },
        },
        runtimeId,
        appVersion,
      };
    }

    const projects: Project[] = [];
    const sourceProjectMap = new Map<string, Project>();

    if (projectListRes.status === 'fulfilled') {
      runtimeId = projectListRes.value._meta?.runtimeId ?? null;
      const rawProjects = projectListRes.value.result?.projects ?? [];
      for (const p of rawProjects) {
        if (!p.id) continue;
        const apiId = hashId('proj', p.id);
        const proj: Project = {
          id: apiId,
          name: p.displayName || p.id,
          kind: p.kind === 'git' ? 'git' : p.kind === 'folder' ? 'folder' : 'unknown',
          sourceProjectId: p.id,
          repoIds: Array.isArray(p.sourceRepoIds) ? p.sourceRepoIds : [],
          paths: [],
          hostIds: [],
        };
        sourceProjectMap.set(p.id, proj);
      }
    } else {
      partial = true;
    }

    if (setupsRes.status === 'fulfilled') {
      runtimeId = runtimeId || setupsRes.value._meta?.runtimeId || null;
      const rawSetups = setupsRes.value.result?.setups || setupsRes.value.result || [];
      const setupsList = Array.isArray(rawSetups) ? rawSetups : [];
      for (const s of setupsList) {
        if (!s.projectId) continue;
        const proj = sourceProjectMap.get(s.projectId);
        if (proj) {
          if (s.path && !proj.paths.includes(s.path)) proj.paths.push(s.path);
          if (s.hostId && !proj.hostIds.includes(s.hostId)) proj.hostIds.push(s.hostId);
          if (s.repoId && !proj.repoIds.includes(s.repoId)) proj.repoIds.push(s.repoId);
        } else {
          // Setup without project in project list
          const apiId = hashId('proj', s.projectId);
          const newProj: Project = {
            id: apiId,
            name: s.displayName || s.projectId,
            kind: s.kind === 'git' ? 'git' : s.kind === 'folder' ? 'folder' : 'unknown',
            sourceProjectId: s.projectId,
            repoIds: s.repoId ? [s.repoId] : [],
            paths: s.path ? [s.path] : [],
            hostIds: s.hostId ? [s.hostId] : [],
          };
          sourceProjectMap.set(s.projectId, newProj);
        }
      }
    }

    if (repoListRes.status === 'fulfilled') {
      runtimeId = runtimeId || repoListRes.value._meta?.runtimeId || null;
      const rawRepos = repoListRes.value.result?.repos || [];
      for (const r of rawRepos) {
        if (!r.id) continue;
        // Check if repo belongs to an existing project
        let matched = false;
        for (const proj of sourceProjectMap.values()) {
          if (proj.repoIds.includes(r.id)) {
            matched = true;
            if (r.path && !proj.paths.includes(r.path)) proj.paths.push(r.path);
          }
        }
        if (!matched) {
          const apiId = hashId('proj', `repo:${r.id}`);
          const newProj: Project = {
            id: apiId,
            name: r.displayName || r.id,
            kind: r.kind === 'git' ? 'git' : 'folder',
            sourceProjectId: `repo:${r.id}`,
            repoIds: [r.id],
            paths: r.path ? [r.path] : [],
            hostIds: ['local'],
          };
          sourceProjectMap.set(newProj.sourceProjectId!, newProj);
        }
      }
    }

    for (const p of sourceProjectMap.values()) {
      projects.push(p);
      globalSourceMaps.projectSourceMap.set(p.id, {
        sourceId: p.sourceProjectId || p.id,
        repoIds: p.repoIds,
        paths: p.paths,
      });
    }

    const observedAt = new Date().toISOString();
    return {
      inventory: { projects },
      meta: {
        availability: projects.length > 0 ? 'ready' : 'empty',
        observedAt,
        attemptedAt,
        stale: false,
        partial,
        issue: null,
      },
      runtimeId,
      appVersion,
    };
  } catch (err: any) {
    return {
      inventory: { projects: [] },
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: true,
        issue: {
          code: err.issue?.code || 'RUNTIME_UNAVAILABLE',
          message: err.message || 'Failed to collect inventory',
          retryable: true,
        },
      },
      runtimeId,
      appVersion,
    };
  }
}

// 2. Collect Graph for a project
export async function collectGraph(
  projectId: Id,
  selectedRunId?: Id | null,
  runner: CommandRunner = defaultCommandRunner
): Promise<{ graph: Graph; meta: SourceMeta; runtimeId: string | null; appVersion: string | null }> {
  const attemptedAt = new Date().toISOString();
  let runtimeId: string | null = null;
  let partial = false;

  const projectEntry = globalSourceMaps.projectSourceMap.get(projectId);
  if (!projectEntry) {
    throw new CliError('PROJECT_NOT_FOUND', `Project ${projectId} not found in inventory`);
  }

  try {
    // A. Query worktree ps
    const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '200', '--json'], runner);
    runtimeId = psRes._meta?.runtimeId ?? null;
    const allWorktrees: any[] = psRes.result?.worktrees ?? [];
    if (psRes.result?.truncated) partial = true;

    // Filter worktrees for this project
    const projectWorktrees = allWorktrees.filter((w) => {
      if (w.repoId && projectEntry.repoIds.includes(w.repoId)) return true;
      if (w.path && projectEntry.paths.some((p) => p.toLowerCase() === w.path.toLowerCase())) return true;
      return false;
    });

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const nodeMap = new Map<Id, Node>();
    const paneKeyToNodeId = new Map<string, Id>();
    const terminalHandleToNodeId = new Map<string, Id>();
    const worktreeIdToNodeId = new Map<string, Id>();

    // B. Build worktree nodes and fetch terminals for each worktree
    for (const wt of projectWorktrees) {
      const wtNodeId = hashId('node', wt.worktreeId || wt.path || wt.displayName);
      worktreeIdToNodeId.set(wt.worktreeId, wtNodeId);

      const isFolder = wt.workspaceKind === 'folder' || wt.isFolder;
      const wtNode: Node = {
        id: wtNodeId,
        kind: 'worktree',
        label: isFolder ? `Folder: ${wt.displayName || wt.repo || 'workspace'}` : (wt.displayName || wt.branch || wt.repo || 'Worktree'),
        worktreeId: wt.worktreeId || null,
        runId: null,
        agentType: null,
        branch: isFolder ? null : (wt.branch || null),
        path: wt.path || null,
        state: mapToState(wt.status || wt.workspaceStatus),
        rawState: wt.status || wt.workspaceStatus || null,
        workspaceStatus: wt.workspaceStatus || null,
        taskOutcome: null,
        liveness: normalizeLiveness(wt.terminalVerdict),
        model: null,
        effort: null,
        observedAt: toIsoOrNull(wt.lastActivityAt || wt.lastOutputAt),
        lastActivityAt: toIsoOrNull(wt.lastActivityAt || wt.lastOutputAt),
        stale: false,
        taskIds: [],
        preview: wt.preview ? stripAnsi(wt.preview.slice(0, 300)) : null,
        outputAvailable: Boolean(wt.preview || wt.liveTerminalCount > 0),
      };
      nodes.push(wtNode);
      nodeMap.set(wtNodeId, wtNode);
      globalSourceMaps.nodeSourceMap.set(wtNodeId, { worktreeId: wt.worktreeId });

      // Fetch terminals in this worktree
      let terminals: any[] = [];
      try {
        const termRes = await runOrca<any>(['terminal', 'list', '--worktree', `id:${wt.worktreeId}`, '--limit', '100', '--json'], runner);
        terminals = termRes.result?.terminals ?? [];
      } catch {
        // partial terminal discovery
        partial = true;
      }

      // Index terminals by tabId:leafId and by handle
      const terminalByPane = new Map<string, any>();
      for (const t of terminals) {
        if (t.tabId && t.leafId) {
          terminalByPane.set(`${t.tabId}:${t.leafId}`, t);
        }
        if (t.paneKey) {
          terminalByPane.set(t.paneKey, t);
        }
      }

      // C. Build agent nodes from wt.agents
      const agents: any[] = Array.isArray(wt.agents) ? wt.agents : [];
      const handledTerminalHandles = new Set<string>();

      for (const ag of agents) {
        const paneKey = ag.paneKey;
        const matchingTerminal = paneKey ? terminalByPane.get(paneKey) : null;
        const handle = matchingTerminal?.handle;
        if (handle) handledTerminalHandles.add(handle);

        const agentNodeId = hashId('node', paneKey || handle || `${wt.worktreeId}:agent:${nodes.length}`);
        if (paneKey) paneKeyToNodeId.set(paneKey, agentNodeId);
        if (handle) terminalHandleToNodeId.set(handle, agentNodeId);

        const agState = mapToState(ag.state);
        const liveness = matchingTerminal?.connected ? 'live' : normalizeLiveness(wt.terminalVerdict);

        const agNode: Node = {
          id: agentNodeId,
          kind: 'agent',
          label: ag.taskTitle || ag.displayName || ag.agentType || 'Agent',
          worktreeId: wt.worktreeId || null,
          runId: null, // will be attached when runs are associated
          agentType: ag.agentType || matchingTerminal?.agentIdentity || null,
          branch: null,
          path: wt.path || null,
          state: agState,
          rawState: ag.state || null,
          workspaceStatus: wt.workspaceStatus || null,
          taskOutcome: null,
          liveness,
          model: ag.model || matchingTerminal?.model || null,
          effort: ag.effort || matchingTerminal?.effort || null,
          observedAt: toIsoOrNull(ag.updatedAt || ag.stateStartedAt),
          lastActivityAt: toIsoOrNull(ag.updatedAt || matchingTerminal?.lastOutputAt),
          stale: false,
          taskIds: [],
          preview: matchingTerminal?.preview ? stripAnsi(matchingTerminal.preview.slice(0, 300)) : null,
          outputAvailable: Boolean(handle),
        };
        nodes.push(agNode);
        nodeMap.set(agentNodeId, agNode);
        const agEndpointIncarnation = matchingTerminal?.ptyId && matchingTerminal?.incarnationId
          ? `${matchingTerminal.ptyId}:${matchingTerminal.incarnationId}`
          : undefined;
        globalSourceMaps.nodeSourceMap.set(agentNodeId, { handle, worktreeId: wt.worktreeId, paneKey, endpointIncarnation: agEndpointIncarnation });

        // Worktree contains agent edge
        edges.push({
          id: hashId('edge', `${wtNodeId}->${agentNodeId}:membership`),
          source: wtNodeId,
          target: agentNodeId,
          kind: 'contains',
          evidence: 'workspace-membership',
          active: agNode.state === 'working',
        });
      }

      // D. Shell / unattached terminals become terminal nodes
      for (const term of terminals) {
        if (handledTerminalHandles.has(term.handle)) continue;

        const termNodeId = hashId('node', term.handle);
        terminalHandleToNodeId.set(term.handle, termNodeId);

        const termNode: Node = {
          id: termNodeId,
          kind: 'terminal',
          label: term.title ? stripAnsi(term.title) : `Terminal ${term.handle}`,
          worktreeId: wt.worktreeId || null,
          runId: null,
          agentType: term.agentIdentity || null,
          branch: null,
          path: wt.path || null,
          state: term.connected ? 'idle' : 'unknown',
          rawState: term.connected ? 'connected' : 'disconnected',
          workspaceStatus: wt.workspaceStatus || null,
          taskOutcome: null,
          liveness: term.connected ? 'live' : 'exited',
          model: term.model || null,
          effort: term.effort || null,
          observedAt: toIsoOrNull(term.lastOutputAt),
          lastActivityAt: toIsoOrNull(term.lastOutputAt),
          stale: false,
          taskIds: [],
          preview: term.preview ? stripAnsi(term.preview.slice(0, 300)) : null,
          outputAvailable: Boolean(term.handle),
        };
        nodes.push(termNode);
        nodeMap.set(termNodeId, termNode);
        const termEndpointIncarnation = term.ptyId && term.incarnationId
          ? `${term.ptyId}:${term.incarnationId}`
          : undefined;
        globalSourceMaps.nodeSourceMap.set(termNodeId, { handle: term.handle, worktreeId: wt.worktreeId, endpointIncarnation: termEndpointIncarnation });

        edges.push({
          id: hashId('edge', `${wtNodeId}->${termNodeId}:membership`),
          source: wtNodeId,
          target: termNodeId,
          kind: 'contains',
          evidence: 'workspace-membership',
          active: false,
        });
      }
    }

    // Pass 2: Establish parent-child and parent-pane edges now that all worktrees and panes are indexed
    for (const wt of projectWorktrees) {
      // E. Parent-child worktree edges
      if (wt.parentWorktreeId) {
        const parentNodeId = worktreeIdToNodeId.get(wt.parentWorktreeId);
        const wtNodeId = worktreeIdToNodeId.get(wt.worktreeId);
        if (parentNodeId && wtNodeId && parentNodeId !== wtNodeId) {
          edges.push({
            id: hashId('edge', `${parentNodeId}->${wtNodeId}:lineage`),
            source: parentNodeId,
            target: wtNodeId,
            kind: 'lineage',
            evidence: 'parent-worktree',
            active: true,
          });
        }
      }

      // F. Agent parent-pane edges
      const agents: any[] = Array.isArray(wt.agents) ? wt.agents : [];
      for (const ag of agents) {
        if (ag.parentPaneKey && ag.paneKey) {
          const parentNodeId = paneKeyToNodeId.get(ag.parentPaneKey);
          const childNodeId = paneKeyToNodeId.get(ag.paneKey);
          if (parentNodeId && childNodeId && parentNodeId !== childNodeId) {
            const childNode = nodeMap.get(childNodeId);
            edges.push({
              id: hashId('edge', `${parentNodeId}->${childNodeId}:parent-pane`),
              source: parentNodeId,
              target: childNodeId,
              kind: 'delegates',
              evidence: 'parent-pane',
              active: childNode?.state === 'working',
            });
          }
        }
      }
    }

    // G. Discover Runs and associate with this project
    const associatedRuns: Run[] = [];
    let candidateRuns: any[] = [];
    try {
      const runListRes = await runOrca<any>(['orchestration', 'run-list', '--limit', '50', '--json'], runner);
      candidateRuns = runListRes.result?.runs ?? [];
    } catch {
      partial = true;
    }

    let inspectedWorkersCount = 0;
    const MAX_WORKER_INSPECTIONS = 5;

    for (const r of candidateRuns) {
      if (!r.id) continue;
      const cacheKey = `${projectId}::${r.id}`;
      const cachedAssoc = globalSourceMaps.runAssociationCache.get(cacheKey);

      let association: 'coordinator-terminal' | 'worker-workspace' | null = null;
      let coordinatorNodeId: Id | null = null;

      if (cachedAssoc) {
        if (cachedAssoc.associated) {
          association = cachedAssoc.association!;
          coordinatorNodeId =
            cachedAssoc.coordinatorNodeId ??
            (r.coordinator_handle ? terminalHandleToNodeId.get(r.coordinator_handle) || null : null);
        }
      } else {
        // Fast path: Coordinator handle match requires 0 CLI calls
        if (r.coordinator_handle && terminalHandleToNodeId.has(r.coordinator_handle)) {
          association = 'coordinator-terminal';
          coordinatorNodeId = terminalHandleToNodeId.get(r.coordinator_handle)!;
          globalSourceMaps.runAssociationCache.set(cacheKey, {
            associated: true,
            association,
            coordinatorNodeId,
          });
        } else if (inspectedWorkersCount < MAX_WORKER_INSPECTIONS) {
          inspectedWorkersCount++;
          try {
            const wListRes = await runOrca<any>(
              ['orchestration', 'worker-list', '--run', r.id, '--limit', '100', '--json'],
              runner
            );
            const workers: any[] = wListRes.result?.workers ?? [];
            for (const w of workers) {
              const wWorktreeId = w.resource?.worktreeId || w.projection?.workspace?.id;
              if (wWorktreeId && worktreeIdToNodeId.has(wWorktreeId)) {
                association = 'worker-workspace';
                break;
              }
            }
            globalSourceMaps.runAssociationCache.set(cacheKey, {
              associated: Boolean(association),
              association: association || undefined,
            });
          } catch {
            partial = true;
          }
        } else {
          // Exceeded inspection budget for this tick
          partial = true;
        }
      }

      if (association) {
        const runApiId = hashId('run', r.id);
        const runObj: Run = {
          id: runApiId,
          sourceRunId: r.id,
          objective: r.objective || r.id,
          coordinatorNodeId,
          association,
        };
        associatedRuns.push(runObj);

        // If coordinator node found, update kind to 'orchestrator'
        if (coordinatorNodeId) {
          const coordNode = nodeMap.get(coordinatorNodeId);
          if (coordNode) {
            coordNode.kind = 'orchestrator';
            coordNode.runId = runApiId;
            try {
              const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
              const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');
              if (fs.existsSync(lastStatusPath)) {
                const raw = JSON.parse(fs.readFileSync(lastStatusPath, 'utf-8'));
                const coordHandle = r.coordinator_handle;
                const coordPane = globalSourceMaps.nodeSourceMap.get(coordNode.id)?.paneKey;
                const entries = raw.entries || {};
                let transcriptPath: string | null = null;
                for (const k of Object.keys(entries)) {
                  const ent = entries[k];
                  if ((coordPane && k === coordPane) || ent.handle === coordHandle || ent.paneKey === coordHandle || k === coordHandle) {
                    const cModel = ent.payload?.model || ent.turn_context?.model || ent.payload?.turn_context?.model || null;
                    const cEffort = ent.payload?.effort || ent.turn_context?.effort || ent.payload?.turn_context?.effort || null;
                    if (cModel) coordNode.model = String(cModel);
                    if (cEffort) coordNode.effort = String(cEffort);
                    if (typeof ent.providerSession?.transcriptPath === 'string') {
                      transcriptPath = ent.providerSession.transcriptPath;
                    }
                    break;
                  }
                }
                // If model/effort still missing on coordinator, inspect proven JSONL turn_context
                if ((!coordNode.model || !coordNode.effort) && transcriptPath && fs.existsSync(transcriptPath)) {
                  const allowedRoots = getAllowedTranscriptRoots();
                  if (isPathInsideRoots(transcriptPath, allowedRoots)) {
                    const fd = fs.openSync(transcriptPath, 'r');
                    try {
                      const stat = fs.fstatSync(fd);
                      const readBytes = Math.min(stat.size, 512 * 1024);
                      if (readBytes > 0) {
                        const buf = Buffer.alloc(readBytes);
                        const n = fs.readSync(fd, buf, 0, readBytes, 0);
                        const text = buf.subarray(0, n).toString('utf-8');
                        const lines = text.split('\n');
                        for (const line of lines) {
                          const trimmed = line.trim();
                          if (!trimmed) continue;
                          try {
                            const obj = JSON.parse(trimmed);
                            if (obj.type === 'turn_context' && obj.payload) {
                              if (!coordNode.model && obj.payload.model) coordNode.model = String(obj.payload.model);
                              if (!coordNode.effort && obj.payload.effort) coordNode.effort = String(obj.payload.effort);
                              if (coordNode.model && coordNode.effort) break;
                            }
                          } catch {}
                        }
                      }
                    } finally {
                      fs.closeSync(fd);
                    }
                  }
                }
              }
            } catch {}
          }
        }
      }
    }

    // H. Select active run
    let activeRun: Run | null = null;
    if (selectedRunId) {
      activeRun = associatedRuns.find((r) => r.id === selectedRunId) || null;
      if (!activeRun) {
        throw new CliError('RUN_NOT_FOUND', `Run ${selectedRunId} not found in project ${projectId}`);
      }
    } else if (associatedRuns.length > 0) {
      // Pick newest
      activeRun = associatedRuns[0];
    }

    // Preserve selected-run worker evidence & delegation
    if (activeRun) {
      // Invalidate existing dispatch bindings for this project and activeRun before discovering
      for (const key of Array.from(globalSourceMaps.dispatchMap.keys())) {
        if (key.startsWith(`${projectId}::${activeRun.id}::`)) {
          globalSourceMaps.dispatchMap.delete(key);
        }
      }

      try {
        const activeWorkers: any[] = [];
        let workerCursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const listArgs = ['orchestration', 'worker-list', '--run', activeRun.sourceRunId, '--limit', '100'];
          if (workerCursor) {
            listArgs.push('--cursor', workerCursor);
          }
          listArgs.push('--json');
          const workersRes = await runOrca<any>(listArgs, runner);
          const pageWorkers: any[] = workersRes.result?.workers ?? [];
          activeWorkers.push(...pageWorkers);
          const nextCursor = workersRes.result?.page?.nextCursor ?? workersRes.result?.nextCursor;
          if (!nextCursor || pageWorkers.length === 0) {
            break;
          }
          workerCursor = nextCursor;
        }

        const handleToWorkers = new Map<string, any[]>();
        for (const w of activeWorkers) {
          const handle = w.agentTerminalHandle || w.resource?.terminalHandle;
          if (handle) {
            if (!handleToWorkers.has(handle)) handleToWorkers.set(handle, []);
            handleToWorkers.get(handle)!.push(w);
          }
        }

        const handleToSelectedWorker = new Map<string, any>();

        for (const [handle, workersList] of handleToWorkers.entries()) {
          const targetNodeId = terminalHandleToNodeId.get(handle);
          if (targetNodeId) {
            const dispatchKey = `${projectId}::${activeRun.id}::${targetNodeId}`;
            const targetSource = globalSourceMaps.nodeSourceMap.get(targetNodeId);

            let selectedWorker: any = null;

            if (workersList.length === 1) {
              selectedWorker = workersList[0];
            } else {
              // Disambiguate reused worker dispatches using proven facts:
              // 1. Filter out dispatches that failed readiness or never materialized
              const materialized = workersList.filter(
                (w) => w.resource && w.resource.state !== 'absent' && w.projection?.stage?.detail !== 'agent_readiness'
              );

              let candidates = materialized.length > 0 ? materialized : workersList;

              // 2. If node has an endpointIncarnation, match exactly
              if (targetSource?.endpointIncarnation) {
                const incMatch = candidates.filter(
                  (w) => w.resource?.endpointIncarnation === targetSource.endpointIncarnation
                );
                if (incMatch.length > 0) {
                  candidates = incMatch;
                }
              }

              // 3. Match owner dispatch ID (where ownerDispatchId === dispatchId)
              const ownerMatch = candidates.filter((w) => {
                const dispId = w.dispatchId || (typeof w.id === 'string' && w.id.startsWith('ctx_') ? w.id : null);
                return dispId && (w.resource?.ownerDispatchId === dispId || w.resource?.originDispatchId === dispId);
              });

              if (ownerMatch.length === 1) {
                selectedWorker = ownerMatch[0];
              } else if (candidates.length === 1) {
                selectedWorker = candidates[0];
              } else {
                // 4. Try matching task IDs if node has associated tasks
                const targetNode = nodeMap.get(targetNodeId);
                if (targetNode && targetNode.taskIds.length > 0) {
                  const taskMatch = candidates.filter((w) => targetNode.taskIds.includes(w.taskId));
                  if (taskMatch.length === 1) {
                    selectedWorker = taskMatch[0];
                  }
                }

                // 5. Check orchestration.db worker_terminal_resources as authority
                if (!selectedWorker) {
                  let db: DatabaseSync | null = null;
                  try {
                    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
                    const orchDb = path.join(appData, 'orca', 'orchestration.db');
                    if (fs.existsSync(orchDb)) {
                      db = new DatabaseSync(orchDb, { readOnly: true });
                      const resRow = db
                        .prepare('SELECT owner_dispatch_id, origin_dispatch_id FROM worker_terminal_resources WHERE terminal_handle = ?')
                        .get(handle) as any;
                      if (resRow?.owner_dispatch_id) {
                        const dbMatch = candidates.find((w) => {
                          const dispId = w.dispatchId || (typeof w.id === 'string' && w.id.startsWith('ctx_') ? w.id : null);
                          return dispId === resRow.owner_dispatch_id;
                        });
                        if (dbMatch) selectedWorker = dbMatch;
                      }
                    }
                  } catch {} finally {
                    try {
                      db?.close();
                    } catch {}
                  }
                }
              }
            }

            if (!selectedWorker && workersList.length > 1) {
              globalSourceMaps.dispatchMap.set(dispatchKey, { dispatchId: '', ambiguous: true });
            } else if (selectedWorker) {
              handleToSelectedWorker.set(handle, selectedWorker);
              const dispId =
                selectedWorker.dispatchId ||
                (typeof selectedWorker.id === 'string' && selectedWorker.id.startsWith('ctx_') ? selectedWorker.id : null);
              let toolInfo: { name: string; input: string | null } | null = null;
              if (selectedWorker.projection?.tool?.name) {
                toolInfo = {
                  name: String(selectedWorker.projection.tool.name),
                  input: selectedWorker.projection.tool.input ? String(selectedWorker.projection.tool.input) : null,
                };
              }
              if (dispId) {
                globalSourceMaps.dispatchMap.set(dispatchKey, {
                  dispatchId: dispId,
                  ambiguous: false,
                  tool: toolInfo,
                });
              }
            }
          }
        }

        for (const [handle, w] of handleToSelectedWorker.entries()) {
          const targetNodeId = terminalHandleToNodeId.get(handle);
          if (targetNodeId) {
            const targetNode = nodeMap.get(targetNodeId);
            if (targetNode) {
              targetNode.runId = activeRun.id;
              if (w.projection?.stage?.activity) {
                targetNode.rawState = w.projection.stage.activity;
                targetNode.state = mapToState(w.projection.stage.activity);
              } else if (w.workerState) {
                targetNode.rawState = w.workerState;
                targetNode.state = mapToState(w.workerState);
              }

              if (w.projection?.outcome) {
                targetNode.taskOutcome = w.projection.outcome;
              } else if (w.outcome) {
                targetNode.taskOutcome = w.outcome;
              }

              if (w.projection?.liveness?.verdict) {
                targetNode.liveness = normalizeLiveness(w.projection.liveness.verdict);
              }

              if (w.projection?.liveness?.observedAt) {
                targetNode.observedAt = toIsoOrNull(w.projection.liveness.observedAt) || targetNode.observedAt;
              }

              let workerModel =
                w.startOptions?.launch?.effective?.model ||
                w.projection?.provider?.model ||
                w.projection?.session?.model ||
                w.startOptions?.launch?.model ||
                w.model ||
                null;
              let workerEffort =
                w.startOptions?.launch?.effective?.effort ||
                w.projection?.provider?.effort ||
                w.projection?.session?.effort ||
                w.startOptions?.launch?.effort ||
                w.effort ||
                null;

              const dispId =
                w.dispatchId ||
                (typeof w.id === 'string' && w.id.startsWith('ctx_') ? w.id : null);
              const targetSource = globalSourceMaps.nodeSourceMap.get(targetNodeId);
              let endpointIncarnation = w.resource?.endpointIncarnation || targetSource?.endpointIncarnation || null;
              let originDispatchId = w.resource?.originDispatchId || null;

              if (!endpointIncarnation || !originDispatchId) {
                let db: DatabaseSync | null = null;
                try {
                  const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
                  const orchDb = path.join(appData, 'orca', 'orchestration.db');
                  if (fs.existsSync(orchDb)) {
                    db = new DatabaseSync(orchDb, { readOnly: true });
                    const resRow = db
                      .prepare('SELECT endpoint_incarnation, origin_dispatch_id FROM worker_terminal_resources WHERE terminal_handle = ?')
                      .get(handle) as any;
                    if (resRow) {
                      if (!endpointIncarnation && resRow.endpoint_incarnation) {
                        endpointIncarnation = resRow.endpoint_incarnation;
                      }
                      if (!originDispatchId && resRow.origin_dispatch_id) {
                        originDispatchId = resRow.origin_dispatch_id;
                      }
                    }
                  }
                } catch {} finally {
                  try {
                    db?.close();
                  } catch {}
                }
              }

              const cacheKey = dispId ? `${dispId}::${endpointIncarnation || ''}` : null;
              if (cacheKey && (!workerModel || !workerEffort)) {
                if (workerLaunchCache.has(cacheKey)) {
                  const cached = workerLaunchCache.get(cacheKey)!;
                  if (!workerModel && cached.model) workerModel = cached.model;
                  if (!workerEffort && cached.effort) workerEffort = cached.effort;
                } else if (dispId) {
                  let effModel: string | null = null;
                  let effEffort: string | null = null;
                  try {
                    const showRes = await runOrca<any>(['orchestration', 'worker-show', '--dispatch', dispId, '--json'], runner);
                    const launch = showRes.result?.worker?.startOptions?.launch;
                    effModel = launch?.effective?.model || null;
                    effEffort = launch?.effective?.effort || null;
                    if (!originDispatchId && showRes.result?.terminalResource?.originDispatchId) {
                      originDispatchId = showRes.result.terminalResource.originDispatchId;
                    }
                  } catch {}

                  if ((!effModel || !effEffort) && originDispatchId && originDispatchId !== dispId) {
                    const originCacheKey = `${originDispatchId}::${endpointIncarnation || ''}`;
                    if (workerLaunchCache.has(originCacheKey)) {
                      const originCached = workerLaunchCache.get(originCacheKey)!;
                      if (!effModel && originCached.model) effModel = originCached.model;
                      if (!effEffort && originCached.effort) effEffort = originCached.effort;
                    } else {
                      try {
                        const originRes = await runOrca<any>(['orchestration', 'worker-show', '--dispatch', originDispatchId, '--json'], runner);
                        const originWorker = originRes.result?.worker;
                        const originInc =
                          originWorker?.resource?.endpointIncarnation ||
                          originWorker?.endpointIncarnation ||
                          originRes.result?.terminalResource?.endpointIncarnation ||
                          originRes.result?.dispatch?.processIncarnation ||
                          (originRes.result?.terminal?.ptyId && originRes.result?.terminal?.incarnationId
                            ? `${originRes.result.terminal.ptyId}:${originRes.result.terminal.incarnationId}`
                            : null) ||
                          null;
                        const originHandle =
                          originWorker?.agentTerminalHandle ||
                          originWorker?.terminalHandle ||
                          originRes.result?.terminal?.handle ||
                          originRes.result?.dispatch?.assigneeHandle ||
                          null;
                        const sameIncarnation = Boolean(endpointIncarnation && originInc && originInc === endpointIncarnation);
                        const sameHandle = Boolean(handle && originHandle && originHandle === handle);
                        if (sameIncarnation && sameHandle) {
                          const originLaunch = originWorker?.startOptions?.launch;
                          const originModel = originLaunch?.effective?.model || null;
                          const originEffort = originLaunch?.effective?.effort || null;
                          workerLaunchCache.set(originCacheKey, { model: originModel, effort: originEffort });
                          if (!effModel && originModel) effModel = originModel;
                          if (!effEffort && originEffort) effEffort = originEffort;
                        } else {
                          workerLaunchCache.set(originCacheKey, { model: null, effort: null });
                        }
                      } catch {
                        workerLaunchCache.set(originCacheKey, { model: null, effort: null });
                      }
                    }
                  }

                  if (!effModel || !effEffort) {
                    try {
                      const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
                      const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');
                      if (fs.existsSync(lastStatusPath)) {
                        const raw = JSON.parse(fs.readFileSync(lastStatusPath, 'utf-8'));
                        const entries = raw.entries || {};
                        for (const k of Object.keys(entries)) {
                          const ent = entries[k];
                          if (
                            ent.handle === handle ||
                            ent.terminalHandle === handle ||
                            ent.paneKey === handle ||
                            (targetSource?.paneKey && ent.paneKey === targetSource.paneKey) ||
                            k === handle
                          ) {
                            const m = ent.payload?.model || ent.turn_context?.model || ent.payload?.turn_context?.model || null;
                            const ef = ent.payload?.effort || ent.turn_context?.effort || ent.payload?.turn_context?.effort || null;
                            if (!effModel && m) effModel = String(m);
                            if (!effEffort && ef) effEffort = String(ef);
                            break;
                          }
                        }
                      }
                    } catch {}
                  }

                  workerLaunchCache.set(cacheKey, { model: effModel, effort: effEffort });
                  if (!workerModel && effModel) workerModel = effModel;
                  if (!workerEffort && effEffort) workerEffort = effEffort;
                }
              }

              targetNode.model = workerModel ? String(workerModel) : null;
              targetNode.effort = workerEffort ? String(workerEffort) : null;

              // Delegation edge from coordinator to worker
              if (activeRun.coordinatorNodeId && activeRun.coordinatorNodeId !== targetNodeId) {
                const edgeId = hashId('edge', `${activeRun.coordinatorNodeId}->${targetNodeId}:run-dispatch`);
                if (!edges.some((e) => e.id === edgeId)) {
                  edges.push({
                    id: edgeId,
                    source: activeRun.coordinatorNodeId,
                    target: targetNodeId,
                    kind: 'delegates',
                    evidence: 'run-dispatch',
                    active: targetNode.state === 'working',
                  });
                }
              }
            }
          }
        }
      } catch {
        partial = true;
      }
    } else {
      for (const key of Array.from(globalSourceMaps.dispatchMap.keys())) {
        if (key.startsWith(`${projectId}::`)) {
          globalSourceMaps.dispatchMap.delete(key);
        }
      }
    }

    const tasks: Task[] = [];
    const activities: Activity[] = [];

    // I. Collect Tasks for active run
    if (activeRun) {
      try {
        const taskRes = await runOrca<any>(['orchestration', 'task-list', '--run', activeRun.sourceRunId, '--json'], runner);
        const rawTasks: any[] = taskRes.result?.tasks ?? [];

        for (const t of rawTasks) {
          const taskId = hashId('task', `${activeRun.id}:${t.id}`);
          const assigneeNodeId = t.assignee_handle ? terminalHandleToNodeId.get(t.assignee_handle) || null : null;
          const tState = mapToState(t.status);

          let depIds: Id[] = [];
          if (typeof t.deps === 'string') {
            try {
              const parsed = JSON.parse(t.deps);
              if (Array.isArray(parsed)) {
                depIds = parsed.map((d: any) => hashId('task', `${activeRun!.id}:${d}`));
              }
            } catch {
              // deps parsing
            }
          } else if (Array.isArray(t.deps)) {
            depIds = t.deps.map((d: any) => hashId('task', `${activeRun!.id}:${d}`));
          }

          const taskObj: Task = {
            id: taskId,
            runId: activeRun.id,
            title: t.task_title || t.id,
            spec: t.spec || null,
            specTruncated: Boolean(t.spec_truncated),
            rawStatus: String(t.status || 'unknown'),
            state: tState,
            assigneeNodeId,
            result: t.result || null,
            dependencyIds: depIds,
            createdAt: toIsoOrNull(t.created_at),
            completedAt: toIsoOrNull(t.completed_at),
          };
          tasks.push(taskObj);

          if (assigneeNodeId) {
            const assigneeNode = nodeMap.get(assigneeNodeId);
            if (assigneeNode) {
              assigneeNode.taskIds.push(taskId);
              assigneeNode.runId = activeRun.id;
              if (t.result && !assigneeNode.taskOutcome) assigneeNode.taskOutcome = t.result;
            }
          }

          // Build activity entry from task
          if (t.status) {
            activities.push({
              id: hashId('act', `${taskId}:${t.status}:${t.created_at || attemptedAt}`),
              nodeId: assigneeNodeId,
              taskId,
              at: toIsoOrNull(t.completed_at || t.created_at) || attemptedAt,
              timestampKind: (t.completed_at || t.created_at) ? 'source' : 'observed',
              kind: 'task-status',
              text: `Task '${t.task_title || t.id}' status: ${t.status}`,
            });
          }
        }
      } catch {
        partial = true;
      }
    }

    // J. Progress calculation
    let completed = 0;
    let failed = 0;
    let working = 0;
    let waiting = 0;
    let blocked = 0;
    let unknown = 0;

    for (const t of tasks) {
      if (t.state === 'completed') completed++;
      else if (t.state === 'failed') failed++;
      else if (t.state === 'working') working++;
      else if (t.state === 'waiting') waiting++;
      else if (t.state === 'blocked') blocked++;
      else unknown++;
    }

    const total = tasks.length;
    const progressCoverage = !activeRun ? 'unavailable' : partial ? 'partial' : 'complete';
    const percent = (total > 0 && progressCoverage === 'complete') ? Math.floor((completed / total) * 100) : null;

    const progress: Progress = {
      total,
      completed,
      failed,
      working,
      waiting,
      blocked,
      unknown,
      percent,
      coverage: progressCoverage,
      basis: 'completed-tasks',
    };

    // Node activities
    for (const n of nodes) {
      if (n.lastActivityAt) {
        activities.push({
          id: hashId('act', `${n.id}:${n.state}:${n.lastActivityAt}`),
          nodeId: n.id,
          taskId: null,
          at: n.lastActivityAt,
          timestampKind: 'source',
          kind: n.kind === 'agent' ? 'agent-status' : 'output-observed',
          text: `${n.label} state: ${n.state}`,
        });
      }
    }

    activities.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const boundedActivity = activities.slice(0, 100);

    const observedAt = new Date().toISOString();
    return {
      graph: {
        runs: associatedRuns,
        selectedRunId: activeRun?.id ?? null,
        nodes,
        edges,
        tasks,
        progress,
        activity: boundedActivity,
      },
      meta: {
        availability: nodes.length > 0 ? 'ready' : 'empty',
        observedAt,
        attemptedAt,
        stale: false,
        partial,
        issue: null,
      },
      runtimeId,
      appVersion: globalSourceMaps.observedAppVersion,
    };
  } catch (err: any) {
    if (err instanceof CliError && (err.issue.code === 'PROJECT_NOT_FOUND' || err.issue.code === 'RUN_NOT_FOUND')) {
      throw err;
    }
    return {
      graph: {
        runs: [],
        selectedRunId: null,
        nodes: [],
        edges: [],
        tasks: [],
        progress: {
          total: 0,
          completed: 0,
          failed: 0,
          working: 0,
          waiting: 0,
          blocked: 0,
          unknown: 0,
          percent: null,
          coverage: 'unavailable',
          basis: 'completed-tasks',
        },
        activity: [],
      },
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: true,
        issue: {
          code: err.issue?.code || 'RUNTIME_UNAVAILABLE',
          message: err.message || 'Failed to collect graph data',
          retryable: true,
        },
      },
      runtimeId,
      appVersion: globalSourceMaps.observedAppVersion,
    };
  }
}

// Helper to resolve coordinator transcript via local exact-source metadata
// Helper to resolve coordinator transcript via local exact-source metadata
export async function resolveCoordinatorConversation(
  projectId: Id,
  node: Node,
  activeRun: Run | null,
  options?: { cursor?: string | null; limit?: number }
): Promise<Section<ConversationPage>> {
  if (!activeRun) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'No active run for coordinator conversation',
          retryable: false,
        },
      },
    };
  }

  // Validate actual node-associated run
  if (node.runId && activeRun.id && node.runId !== activeRun.id) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: `Node runId ${node.runId} does not match active run ${activeRun.id}`,
          retryable: false,
        },
      },
    };
  }

  const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
  const orcaDir = path.join(appData, 'orca');
  const orchDbPath = path.join(orcaDir, 'orchestration.db');
  const lastStatusPath = path.join(orcaDir, 'agent-hooks', 'last-status.json');

  let coordPaneKey: string | null = null;
  let coordHandle: string | null = null;
  let coordSessionId: string | null = null;

  if (fs.existsSync(orchDbPath)) {
    let odb: DatabaseSync | null = null;
    try {
      odb = new DatabaseSync(orchDbPath, { readOnly: true });
      const runRow = activeRun.sourceRunId
        ? (odb
            .prepare(
              'SELECT coordinator_handle, coordinator_pane_key, coordinator_orca_session_id FROM runs WHERE id = ?'
            )
            .get(activeRun.sourceRunId) as any)
        : null;
      if (runRow) {
        coordHandle = runRow.coordinator_handle || null;
        coordPaneKey = runRow.coordinator_pane_key || null;
        coordSessionId = runRow.coordinator_orca_session_id || null;
      }
    } catch {} finally {
      try {
        odb?.close();
      } catch {}
    }
  }

  const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
  let isMatchingCoord = activeRun.coordinatorNodeId === node.id;
  if (coordHandle && nodeSource?.handle === coordHandle) {
    isMatchingCoord = true;
  }
  if (coordPaneKey && nodeSource?.paneKey === coordPaneKey) {
    isMatchingCoord = true;
  }

  if (!isMatchingCoord) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: `Node ${node.id} is not the coordinator for run ${activeRun.sourceRunId}`,
          retryable: false,
        },
      },
    };
  }

  if (!coordPaneKey && nodeSource?.paneKey) {
    coordPaneKey = nodeSource.paneKey;
  }
  if (!coordHandle && nodeSource?.handle) {
    coordHandle = nodeSource.handle;
  }

  let transcriptPath: string | null = null;
  let provider: string | null = null;
  let providerSessionId: string | null = null;

  if (coordPaneKey && fs.existsSync(lastStatusPath)) {
    try {
      const rawStatus = fs.readFileSync(lastStatusPath, 'utf-8');
      const statusData = JSON.parse(rawStatus);
      const entry = statusData.entries?.[coordPaneKey];
      if (entry && entry.providerSession) {
        if (typeof entry.providerSession.transcriptPath === 'string') {
          transcriptPath = entry.providerSession.transcriptPath;
        }
        providerSessionId = entry.providerSession.id || null;
        provider = entry.source || entry.agentPresence?.agent || entry.payload?.agentType || null;
      }
    } catch {}
  }

  if (!transcriptPath && coordSessionId) {
    const journalDbPath = path.join(orcaDir, 'agent-session-journal.db');
    if (fs.existsSync(journalDbPath)) {
      let jdb: DatabaseSync | null = null;
      try {
        jdb = new DatabaseSync(journalDbPath, { readOnly: true });
        const rec = jdb
          .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
          .get(coordSessionId) as any;
        if (rec?.record_json) {
          const parsedRec = JSON.parse(rec.record_json);
          if (parsedRec.transcriptPath && typeof parsedRec.transcriptPath === 'string') {
            transcriptPath = parsedRec.transcriptPath;
            provider = parsedRec.provider || provider;
            providerSessionId = parsedRec.sessionId || providerSessionId;
          }
        }
      } catch {} finally {
        try {
          jdb?.close();
        } catch {}
      }
    }
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Coordinator transcript provenance not found or unsupported',
          retryable: false,
        },
      },
    };
  }

  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) {
      throw new Error('Not a regular file');
    }
  } catch {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Coordinator transcript is not a regular file',
          retryable: false,
        },
      },
    };
  }

  const allowedRoots = getAllowedTranscriptRoots();
  if (!isPathInsideRoots(transcriptPath, allowedRoots)) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Coordinator transcript path is outside allowed provider directories',
          retryable: false,
        },
      },
    };
  }

  const opaqueSourceIdentity = hashId('src', providerSessionId || transcriptPath);

  let startOffset: number | null = null;
  let seekingNewline = false;
  if (options?.cursor) {
    pruneCursors();
    const stored = cursorStore.get(options.cursor);
    if (
      !stored ||
      stored.projectId !== projectId ||
      stored.nodeId !== node.id ||
      (stored.runId ?? null) !== (activeRun?.id ?? null) ||
      stored.sourceIdentity !== opaqueSourceIdentity
    ) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid or cross-bound cursor token');
    }
    startOffset = parseInt(stored.upstreamCursor, 10) || 0;
    seekingNewline = Boolean(stored.seekingNewline);
  }

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const normalizedMessages: ConversationMessage[] = [];
  let omittedContent = false;
  let currentOffset = startOffset;
  let currentSeeking = seekingNewline;
  let lastReadResult: BoundedTranscriptReadResult | null = null;
  let loopCount = 0;
  const MAX_PAGE_ITERATIONS = 5;

  while (loopCount < MAX_PAGE_ITERATIONS) {
    loopCount++;
    let readResult: BoundedTranscriptReadResult;
    try {
      readResult = await readBoundedTranscriptLines(
        transcriptPath, currentOffset, limit, 8 * 1024 * 1024, currentSeeking, isCodexChatRecord
      );
    } catch (err: any) {
      if (loopCount === 1) {
        return {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt: new Date().toISOString(),
            stale: false,
            partial: false,
            issue: {
              code: 'CLI_FAILED',
              message: cleanErrorMessage(err.message || 'Failed to read coordinator transcript file'),
              retryable: true,
            },
          },
        };
      }
      break;
    }

    lastReadResult = readResult;
    currentOffset = readResult.nextByteOffset;
    currentSeeking = Boolean(readResult.seekingNewline);

    const { lines } = readResult;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'response_item' && (obj.payload?.type === 'message' || Boolean(obj.payload?.role))) {
          const payloadRole = obj.payload.role;
          if (payloadRole !== 'assistant' && payloadRole !== 'user') {
            omittedContent = true;
            continue;
          }
          const role: 'agent' | 'user' = payloadRole === 'assistant' ? 'agent' : 'user';
          const contentBlocks = Array.isArray(obj.payload.content) ? obj.payload.content : [];
          const textBlocks: string[] = [];

          for (const b of contentBlocks) {
            if ((b.type === 'output_text' || b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string') {
              const trimmed = b.text.trim();
              if (
                role === 'user' &&
                (trimmed.startsWith('<environment_context>') ||
                  trimmed.startsWith('<skills_instructions>') ||
                  trimmed.startsWith('<permissions instructions>') ||
                  trimmed.startsWith('<collaboration_mode>') ||
                  trimmed.startsWith('<multi_agent_role>') ||
                  trimmed.startsWith('<multi_agent_mode>') ||
                  trimmed.startsWith('# AGENTS.md instructions') ||
                  trimmed.startsWith('<skill>'))
              ) {
                omittedContent = true;
                continue;
              }
              if (trimmed) {
                textBlocks.push(b.text);
              }
            } else {
              omittedContent = true;
            }
          }

          if (textBlocks.length === 0) {
            omittedContent = true;
            continue;
          }

          const text = textBlocks.join('\n');
          const at = toIsoOrNull(obj.timestamp);
          const rawMsgId = obj.payload.id || (typeof obj.ordinal === 'number' ? String(obj.ordinal) : hashId('record', line));
          const msgId = hashId('msg', `${opaqueSourceIdentity}:${rawMsgId}`);

          normalizedMessages.push({
            id: msgId,
            role,
            text,
            at,
          });

          if (normalizedMessages.length >= limit) {
            break;
          }
        }
      } catch {
        omittedContent = true;
      }
    }

    if (normalizedMessages.length >= limit || !readResult.hasMore) {
      break;
    }
  }

  const finalReadResult = lastReadResult!;
  const hasMore = Boolean(finalReadResult?.hasMore);
  const limited = Boolean(finalReadResult?.limited) || (loopCount >= MAX_PAGE_ITERATIONS && normalizedMessages.length < limit);

  let publicNextCursor: string | null = null;
  if (finalReadResult && !(options?.cursor && normalizedMessages.length === 0 && !hasMore)) {
    pruneCursors();
    publicNextCursor = 'cur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    cursorStore.set(publicNextCursor, {
      upstreamCursor: String(finalReadResult.nextByteOffset),
      projectId,
      nodeId: node.id,
      runId: activeRun?.id ?? null,
      dispatchId: '',
      sourceIdentity: opaqueSourceIdentity,
      sourceMode: 'coordinator-transcript',
      expiresAt: Date.now() + CURSOR_TTL_MS,
      seekingNewline: Boolean(finalReadResult.seekingNewline),
    });
  }

  const page: ConversationPage = {
    messages: normalizedMessages,
    source: 'transcript',
    sourceIdentity: opaqueSourceIdentity,
    provider: provider || 'codex',
    cursor: options?.cursor ?? null,
    nextCursor: publicNextCursor,
    limited: hasMore || limited,
    truncated: false,
    warnings: [],
  };

  return {
    data: page,
    meta: {
      availability: normalizedMessages.length > 0 ? 'ready' : 'empty',
      observedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      stale: false,
      partial: omittedContent || hasMore || limited,
      issue: null,
    },
  };
}

// A planner step is only a chat turn when the provider recorded public reply text.
// Thinking-only steps and tool calls are not assistant replies.
export function isCodexChatRecord(line: string): boolean {
  try {
    const record = JSON.parse(line);
    const payload = record.payload;
    if (record.type !== 'response_item' || !['user', 'assistant'].includes(payload?.role)) return false;
    return Array.isArray(payload.content) && payload.content.some((block: any) => {
      if (!['input_text', 'output_text', 'text'].includes(block?.type) || typeof block.text !== 'string') return false;
      const text = block.text.trim();
      return Boolean(text) && !(payload.role === 'user' && /^(<(environment_context|skills_instructions|permissions instructions|collaboration_mode|multi_agent_role|multi_agent_mode|skill)>|# AGENTS\.md instructions)/.test(text));
    });
  } catch {
    return false;
  }
}

export function isAntigravityChatRecord(line: string): boolean {
  try {
    const record = JSON.parse(line);
    return (record.type === 'USER_INPUT' || record.type === 'PLANNER_RESPONSE') &&
      typeof record.content === 'string' && Boolean(record.content.trim());
  } catch {
    return false;
  }
}

// Helper to resolve Antigravity conversation transcript via proven hook session
export async function resolveAntigravityConversation(
  projectId: Id,
  node: Node,
  activeRun: Run | null,
  options?: { cursor?: string | null; limit?: number }
): Promise<Section<ConversationPage>> {
  if (node.runId && activeRun?.id && node.runId !== activeRun.id) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: `Node runId ${node.runId} does not match active run ${activeRun.id}`,
          retryable: false,
        },
      },
    };
  }

  const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
  const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');

  if (!fs.existsSync(lastStatusPath)) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Orca agent hook status not found',
          retryable: false,
        },
      },
    };
  }

  let conversationId: string | null = null;
  let worktreeId: string | null = null;
  const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);

  try {
    const rawStatus = fs.readFileSync(lastStatusPath, 'utf-8');
    const statusData = JSON.parse(rawStatus);
    const entries = statusData.entries ?? {};

    let matchedEntry: any = null;
    if (nodeSource?.paneKey && entries[nodeSource.paneKey]) {
      matchedEntry = entries[nodeSource.paneKey];
    }

    if (matchedEntry && matchedEntry.source === 'antigravity') {
      if (
        matchedEntry.providerSession?.key === 'conversation_id' &&
        typeof matchedEntry.providerSession.id === 'string'
      ) {
        conversationId = matchedEntry.providerSession.id;
        worktreeId = matchedEntry.worktreeId || null;
      }
    }
  } catch {}

  if (!conversationId || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Antigravity session provenance not found in hook entries',
          retryable: false,
        },
      },
    };
  }

  // Validate workspace if both worktreeId and node.worktreeId exist
  if (worktreeId && node.worktreeId) {
    const normEntryWt = path.normalize(worktreeId).toLowerCase();
    const normNodeWt = path.normalize(node.worktreeId).toLowerCase();
    if (normEntryWt !== normNodeWt && worktreeId !== node.worktreeId) {
      return {
        data: null,
        meta: {
          availability: 'unsupported',
          observedAt: null,
          attemptedAt: new Date().toISOString(),
          stale: false,
          partial: false,
          issue: {
            code: 'CONVERSATION_UNSUPPORTED',
            message: 'Antigravity session workspace mismatch',
            retryable: false,
          },
        },
      };
    }
  }

  const geminiBase =
    process.env.GEMINI_APPDATA_DIR ||
    process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity-cli');

  // Verify exact native DB if present
  const convDbPath = path.join(geminiBase, 'conversations', `${conversationId}.db`);
  if (fs.existsSync(convDbPath)) {
    let cdb: DatabaseSync | null = null;
    try {
      cdb = new DatabaseSync(convDbPath, { readOnly: true });
      const row: any = cdb.prepare('SELECT cascade_id FROM trajectory_meta WHERE cascade_id = ?').get(conversationId);
      if (!row || row.cascade_id !== conversationId) {
        return {
          data: null,
          meta: {
            availability: 'unsupported',
            observedAt: null,
            attemptedAt: new Date().toISOString(),
            stale: false,
            partial: false,
            issue: {
              code: 'CONVERSATION_UNSUPPORTED',
              message: 'Antigravity conversation database trajectory cascade ID mismatch',
              retryable: false,
            },
          },
        };
      }
    } catch {
    } finally {
      try {
        cdb?.close();
      } catch {}
    }
  }

  // Look for vendor-supported transcript in brain folder
  const transcriptPath = path.join(
    geminiBase,
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );

  if (!fs.existsSync(transcriptPath)) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message:
            'Antigravity binary protobuf trajectory decoder unavailable without schema definition; vendor transcript log not found.',
          retryable: false,
        },
      },
    };
  }

  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) {
      throw new Error('Not a regular file');
    }
  } catch {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Antigravity transcript file is not a valid regular file',
          retryable: false,
        },
      },
    };
  }

  const allowedRoots = getAllowedTranscriptRoots();
  if (!isPathInsideRoots(transcriptPath, allowedRoots)) {
    return {
      data: null,
      meta: {
        availability: 'unsupported',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code: 'CONVERSATION_UNSUPPORTED',
          message: 'Antigravity transcript path is outside allowed provider directories',
          retryable: false,
        },
      },
    };
  }

  const opaqueSourceIdentity = hashId('src', conversationId);

  let startOffset: number | null = null;
  let seekingNewline = false;
  if (options?.cursor) {
    pruneCursors();
    const stored = cursorStore.get(options.cursor);
    if (
      !stored ||
      stored.projectId !== projectId ||
      stored.nodeId !== node.id ||
      (stored.runId ?? null) !== (activeRun?.id ?? null) ||
      stored.sourceIdentity !== opaqueSourceIdentity
    ) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid or cross-bound cursor token');
    }
    startOffset = parseInt(stored.upstreamCursor, 10) || 0;
    seekingNewline = Boolean(stored.seekingNewline);
  }

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const normalizedMessages: ConversationMessage[] = [];
  let omittedContent = false;
  let currentOffset = startOffset;
  let currentSeeking = seekingNewline;
  let lastReadResult: BoundedTranscriptReadResult | null = null;
  let loopCount = 0;
  const MAX_PAGE_ITERATIONS = 5;

  while (loopCount < MAX_PAGE_ITERATIONS) {
    loopCount++;
    let readResult: BoundedTranscriptReadResult;
    try {
      readResult = await readBoundedTranscriptLines(
        transcriptPath, currentOffset, limit, 8 * 1024 * 1024, currentSeeking, isAntigravityChatRecord
      );
    } catch (err: any) {
      if (loopCount === 1) {
        return {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt: new Date().toISOString(),
            stale: false,
            partial: false,
            issue: {
              code: 'CLI_FAILED',
              message: cleanErrorMessage(err.message || 'Failed to read Antigravity transcript file'),
              retryable: true,
            },
          },
        };
      }
      break;
    }

    lastReadResult = readResult;
    currentOffset = readResult.nextByteOffset;
    currentSeeking = Boolean(readResult.seekingNewline);

    const { lines } = readResult;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'USER_INPUT') {
          let text = typeof obj.content === 'string' ? obj.content : '';
          if (text.includes('<USER_REQUEST>')) {
            const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (match) text = match[1].trim();
          }
          const trimmed = text.trim();
          if (
            trimmed.startsWith('<environment_context>') ||
            trimmed.startsWith('<skills_instructions>') ||
            trimmed.startsWith('<permissions instructions>') ||
            trimmed.startsWith('<collaboration_mode>') ||
            trimmed.startsWith('<multi_agent_role>') ||
            trimmed.startsWith('<multi_agent_mode>') ||
            trimmed.startsWith('# AGENTS.md instructions') ||
            trimmed.startsWith('<skill>') ||
            trimmed.startsWith('<USER_SETTINGS_CHANGE>')
          ) {
            omittedContent = true;
            continue;
          }
          if (!trimmed) {
            omittedContent = true;
            continue;
          }
          const msgId = hashId('msg', `${opaqueSourceIdentity}:${obj.step_index ?? hashId('record', line)}`);
          normalizedMessages.push({
            id: msgId,
            role: 'user',
            text: trimmed,
            at: toIsoOrNull(obj.created_at),
          });
          if (normalizedMessages.length >= limit) {
            break;
          }
        } else if (obj.type === 'PLANNER_RESPONSE') {
          const text = typeof obj.content === 'string' ? obj.content.trim() : '';
          if (!text) {
            omittedContent = true;
            continue;
          }
          const msgId = hashId('msg', `${opaqueSourceIdentity}:${obj.step_index ?? hashId('record', line)}`);
          normalizedMessages.push({
            id: msgId,
            role: 'agent',
            text,
            at: toIsoOrNull(obj.created_at),
          });
          if (normalizedMessages.length >= limit) {
            break;
          }
        } else {
          omittedContent = true;
        }
      } catch {
        omittedContent = true;
      }
    }

    if (normalizedMessages.length >= limit || !readResult.hasMore) {
      break;
    }
  }

  const finalReadResult = lastReadResult!;
  const hasMore = Boolean(finalReadResult?.hasMore);
  const limited = Boolean(finalReadResult?.limited) || (loopCount >= MAX_PAGE_ITERATIONS && normalizedMessages.length < limit);

  let publicNextCursor: string | null = null;
  if (finalReadResult && !(options?.cursor && normalizedMessages.length === 0 && !hasMore)) {
    pruneCursors();
    publicNextCursor = 'cur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    cursorStore.set(publicNextCursor, {
      upstreamCursor: String(finalReadResult.nextByteOffset),
      projectId,
      nodeId: node.id,
      runId: activeRun?.id ?? null,
      dispatchId: '',
      sourceIdentity: opaqueSourceIdentity,
      sourceMode: 'antigravity-transcript',
      expiresAt: Date.now() + CURSOR_TTL_MS,
      seekingNewline: Boolean(finalReadResult.seekingNewline),
    });
  }

  const page: ConversationPage = {
    messages: normalizedMessages,
    source: 'transcript',
    sourceIdentity: opaqueSourceIdentity,
    provider: 'antigravity',
    cursor: options?.cursor ?? null,
    nextCursor: publicNextCursor,
    limited: hasMore || limited,
    truncated: false,
    warnings: [],
  };

  return {
    data: page,
    meta: {
      availability: normalizedMessages.length > 0 ? 'ready' : 'empty',
      observedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      stale: false,
      partial: omittedContent || hasMore || limited,
      issue: null,
    },
  };
}

// 3. Read node details & conversation
export async function collectNodeDetails(
  projectId: Id,
  nodeId: Id,
  options?: { runId?: Id | null; cursor?: string | null; limit?: number; preloadedGraph?: Graph },
  runner: CommandRunner = defaultCommandRunner
): Promise<NodeDetails> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const graph = options?.preloadedGraph ?? (await collectGraph(projectId, options?.runId ?? null, runner)).graph;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new CliError('NODE_NOT_FOUND', `Node ${nodeId} not found in project ${projectId}`);
  }

  const tasks = graph.tasks.filter((t) => node.taskIds.includes(t.id));
  const activity = graph.activity.filter((a) => a.nodeId === nodeId);

  if (node.kind !== 'agent' && node.kind !== 'orchestrator') {
    return {
      node,
      tasks,
      activity,
      currentTool: null,
      conversation: {
        data: null,
        meta: {
          availability: 'unsupported',
          observedAt: null,
          attemptedAt: new Date().toISOString(),
          stale: false,
          partial: false,
          issue: {
            code: 'CONVERSATION_UNSUPPORTED',
            message: 'Conversation history is only supported for agent and orchestrator nodes',
            retryable: false,
          },
        },
      },
    };
  }

  const activeRunId = options?.runId ?? graph.selectedRunId;
  const activeRun = graph.runs.find((r) => r.id === activeRunId) || null;
  const isCoordinator = node.kind === 'orchestrator' || (activeRun && activeRun.coordinatorNodeId === nodeId);

  const bindingKey = `${projectId}::${activeRunId}::${nodeId}`;
  const binding = globalSourceMaps.dispatchMap.get(bindingKey);

  const currentTool: { name: string; input: string | null } | null = binding?.tool ?? null;

  let storedCursorObj: StoredCursor | undefined;
  let upstreamCursor: string | undefined;
  let expectedSourceIdentity: string | undefined;

  if (options?.cursor) {
    pruneCursors();
    const stored = cursorStore.get(options.cursor);
    if (
      !stored ||
      stored.projectId !== projectId ||
      stored.nodeId !== nodeId ||
      (stored.runId ?? null) !== (activeRunId ?? null)
    ) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid or cross-bound cursor token');
    }
    if (
      binding?.dispatchId &&
      stored.dispatchId &&
      stored.dispatchId !== binding.dispatchId &&
      stored.sourceMode === 'worker-read-transcript'
    ) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid or cross-bound cursor token');
    }
    storedCursorObj = stored;
    upstreamCursor = stored.upstreamCursor;
    expectedSourceIdentity = stored.sourceIdentity;
  }

  let conversationSection: Section<ConversationPage>;

  if (isCoordinator || storedCursorObj?.sourceMode === 'coordinator-transcript') {
    conversationSection = await resolveCoordinatorConversation(projectId, node, activeRun, options);
    return {
      node,
      tasks,
      activity,
      currentTool,
      conversation: conversationSection,
    };
  }

  // Recognize opaque local cursor before calling worker-read:
  // Fallback page continuation for Antigravity
  if (
    storedCursorObj?.sourceMode === 'antigravity-transcript' ||
    (node.agentType === 'antigravity' && (!binding || !binding.dispatchId || binding.ambiguous))
  ) {
    conversationSection = await resolveAntigravityConversation(projectId, node, activeRun, options);
    return {
      node,
      tasks,
      activity,
      currentTool,
      conversation: conversationSection,
    };
  }

  if (storedCursorObj?.sourceMode === 'terminal') {
    // Never send local/terminal cursor to transcript CLI.
    // Reset cursor to fetch fresh transcript window.
    upstreamCursor = undefined;
  }

  if (!binding || !binding.dispatchId || binding.ambiguous) {
    if (node.agentType === 'antigravity') {
      conversationSection = await resolveAntigravityConversation(projectId, node, activeRun, options);
    } else {
      const isAmbiguous = Boolean(binding?.ambiguous);
      conversationSection = {
        data: null,
        meta: {
          availability: 'unsupported',
          observedAt: null,
          attemptedAt: new Date().toISOString(),
          stale: false,
          partial: false,
          issue: {
            code: 'CONVERSATION_UNSUPPORTED',
            message: isAmbiguous
              ? 'Ambiguous worker dispatch binding for node'
              : 'Node does not have an active worker dispatch binding',
            retryable: false,
          },
        },
      };
    }
  } else {
    const dispatchId = binding.dispatchId;

    try {
      const readArgs = ['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'transcript'];
      if (upstreamCursor) {
        readArgs.push('--cursor', upstreamCursor);
      }
      readArgs.push('--limit', String(limit), '--json');

      let readRes: any;
      let cursorWasReset = false;
      try {
        readRes = await runOrca<any>(readArgs, runner);
      } catch (workerErr: any) {
        const isPinnedError =
          workerErr.message?.includes('The worker-read cursor is pinned to terminal output') ||
          workerErr.message?.includes('pinned to terminal output');
        if (isPinnedError) {
          if (options?.cursor) {
            cursorStore.delete(options.cursor);
          }
          if (node.agentType === 'antigravity' || globalSourceMaps.nodeSourceMap.get(node.id)?.paneKey) {
            const agRes = await resolveAntigravityConversation(projectId, node, activeRun, { ...options, cursor: null });
            if (agRes.meta.availability !== 'unsupported') {
              if (agRes.data) {
                agRes.data.warnings = [
                  ...(agRes.data.warnings || []),
                  'The worker-read cursor was pinned to terminal output and was reset to recent transcript window.',
                ];
              }
              agRes.meta.partial = true;
              return {
                node,
                tasks,
                activity,
                currentTool,
                conversation: agRes,
              };
            }
          }
          // Retry worker-read fresh without cursor
          const retryArgs = ['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'transcript', '--limit', String(limit), '--json'];
          readRes = await runOrca<any>(retryArgs, runner);
          cursorWasReset = true;
        } else {
          throw workerErr;
        }
      }
      const res = readRes.result;

      if (res?.source !== 'transcript' || res?.sourceExact !== true) {
        conversationSection = {
          data: null,
          meta: {
            availability: 'unsupported',
            observedAt: null,
            attemptedAt: new Date().toISOString(),
            stale: false,
            partial: false,
            issue: {
              code: 'CONVERSATION_UNSUPPORTED',
              message: 'Transcript source is not exact or unsupported',
              retryable: false,
            },
          },
        };
      } else if (
        !res ||
        typeof res !== 'object' ||
        typeof res.sourceIdentity !== 'string' ||
        !res.sourceIdentity.trim() ||
        !res.transcript ||
        typeof res.transcript !== 'object' ||
        !Array.isArray(res.transcript.messages)
      ) {
        conversationSection = {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt: new Date().toISOString(),
            stale: false,
            partial: false,
            issue: {
              code: 'INVALID_UPSTREAM',
              message: 'Malformed transcript payload from upstream',
              retryable: false,
            },
          },
        };
      } else {
        const rawSourceIdentity = res.sourceIdentity.trim();
        if (expectedSourceIdentity && expectedSourceIdentity !== rawSourceIdentity) {
          conversationSection = {
            data: null,
            meta: {
              availability: 'unavailable',
              observedAt: null,
              attemptedAt: new Date().toISOString(),
              stale: false,
              partial: false,
              issue: {
                code: 'SOURCE_CHANGED',
                message: 'Source transcript has changed. Reset cursor and reload.',
                retryable: true,
              },
            },
          };
        } else {
          const rawMessages = res.transcript.messages;
          const malformedMessage = rawMessages.some(
            (m: any) => !m || typeof m !== 'object' || m.id === undefined || m.id === null || String(m.id).trim() === ''
          );

          if (malformedMessage) {
            conversationSection = {
              data: null,
              meta: {
                availability: 'unavailable',
                observedAt: null,
                attemptedAt: new Date().toISOString(),
                stale: false,
                partial: false,
                issue: {
                  code: 'INVALID_UPSTREAM',
                  message: 'Transcript message missing valid identity',
                  retryable: false,
                },
              },
            };
          } else {
            const opaqueSourceIdentity = hashId('src', rawSourceIdentity);
            const normalizedMessages: ConversationMessage[] = [];
            let omittedContent = false;

            for (const m of rawMessages) {
              if (m.role !== 'assistant' && m.role !== 'user') {
                omittedContent = true;
                continue;
              }
              const role: 'agent' | 'user' = m.role === 'assistant' ? 'agent' : 'user';
              const blocks = Array.isArray(m.blocks) ? m.blocks : [];
              const textBlocks: string[] = [];
              for (const b of blocks) {
                if (b && b.type === 'text' && typeof b.text === 'string') {
                  textBlocks.push(b.text);
                } else {
                  omittedContent = true;
                }
              }
              if (textBlocks.length === 0) {
                omittedContent = true;
                continue;
              }
              const text = textBlocks.join('\n');
              const msgId = hashId('msg', `${opaqueSourceIdentity}:${m.id}`);
              const at = toIsoOrNull(m.timestamp);
              normalizedMessages.push({
                id: msgId,
                role,
                text,
                at,
              });
            }

            let latestNextCursor: string | null = res.transcript?.nextCursor || null;
            let autoPages = 1;
            while (normalizedMessages.length === 0 && latestNextCursor && autoPages < 5) {
              autoPages++;
              try {
                const nextArgs = [
                  'orchestration',
                  'worker-read',
                  '--dispatch',
                  dispatchId,
                  '--source',
                  'transcript',
                  '--cursor',
                  latestNextCursor,
                  '--limit',
                  String(limit),
                  '--json',
                ];
                const nextReadRes = await runOrca<any>(nextArgs, runner);
                const nextData = nextReadRes.result;
                if (
                  !nextData ||
                  nextData.source !== 'transcript' ||
                  nextData.sourceExact !== true ||
                  !nextData.transcript ||
                  !Array.isArray(nextData.transcript.messages)
                ) {
                  break;
                }
                const nextRawId = nextData.sourceIdentity?.trim();
                if (nextRawId && nextRawId !== rawSourceIdentity) {
                  break;
                }
                const nextRawMsgs = nextData.transcript.messages;
                for (const m of nextRawMsgs) {
                  if (m.role !== 'assistant' && m.role !== 'user') {
                    omittedContent = true;
                    continue;
                  }
                  const role: 'agent' | 'user' = m.role === 'assistant' ? 'agent' : 'user';
                  const blocks = Array.isArray(m.blocks) ? m.blocks : [];
                  const textBlocks: string[] = [];
                  for (const b of blocks) {
                    if (b && b.type === 'text' && typeof b.text === 'string') {
                      textBlocks.push(b.text);
                    } else {
                      omittedContent = true;
                    }
                  }
                  if (textBlocks.length === 0) {
                    omittedContent = true;
                    continue;
                  }
                  const text = textBlocks.join('\n');
                  const msgId = hashId('msg', `${opaqueSourceIdentity}:${m.id}`);
                  const at = toIsoOrNull(m.timestamp);
                  normalizedMessages.push({
                    id: msgId,
                    role,
                    text,
                    at,
                  });
                  if (normalizedMessages.length >= limit) {
                    break;
                  }
                }
                if (!nextData.transcript.nextCursor || nextData.transcript.nextCursor === latestNextCursor) {
                  latestNextCursor = null;
                  break;
                }
                latestNextCursor = nextData.transcript.nextCursor;
              } catch {
                break;
              }
            }

            const limited = Boolean(res.transcript?.limited) || (autoPages >= 5 && normalizedMessages.length < limit);
            const hasClipping = Array.isArray(res.clipping) && res.clipping.length > 0;
            const truncated = res.contentComplete === false || hasClipping;
            const partial = limited || truncated || omittedContent || cursorWasReset;

            const warnings: string[] = [];
            if (cursorWasReset) {
              warnings.push('The worker-read cursor was pinned to terminal output and was reset to recent transcript window.');
            }
            if (Array.isArray(res.warnings)) {
              for (const w of res.warnings) {
                if (typeof w === 'string') {
                  const sanitized = w.replace(/[a-zA-Z]:\\[^\s]+/g, '[path]').replace(/\/[^\s]+/g, '[path]').slice(0, 200);
                  warnings.push(sanitized);
                }
              }
            }
            if (Array.isArray(res.clipping)) {
              for (const c of res.clipping) {
                if (typeof c === 'string') {
                  const sanitized = c.replace(/[a-zA-Z]:\\[^\s]+/g, '[path]').replace(/\/[^\s]+/g, '[path]').slice(0, 200);
                  warnings.push(sanitized);
                }
              }
            }

            let publicNextCursor: string | null = null;
            const finalUpstreamCursor = latestNextCursor || res.transcript?.nextCursor;
            if (finalUpstreamCursor) {
              pruneCursors();
              publicNextCursor = 'cur_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
              cursorStore.set(publicNextCursor, {
                upstreamCursor: finalUpstreamCursor,
                projectId,
                nodeId,
                runId: activeRunId ?? null,
                dispatchId,
                sourceIdentity: rawSourceIdentity,
                sourceMode: 'worker-read-transcript',
                expiresAt: Date.now() + CURSOR_TTL_MS,
              });
            }

            const page: ConversationPage = {
              messages: normalizedMessages,
              source: 'transcript',
              sourceIdentity: opaqueSourceIdentity,
              provider: res.provider ? String(res.provider) : null,
              cursor: options?.cursor ?? null,
              nextCursor: publicNextCursor,
              limited,
              truncated,
              warnings,
            };

            conversationSection = {
              data: page,
              meta: {
                availability: normalizedMessages.length > 0 ? 'ready' : 'empty',
                observedAt: new Date().toISOString(),
                attemptedAt: new Date().toISOString(),
                stale: false,
                partial,
                issue: null,
              },
            };
          }
        }
      }
    } catch (err: any) {
      if (err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT') {
        throw err;
      }
      const isPinnedToTerminal =
        err.message?.includes('pinned to terminal output') ||
        err.issue?.message?.includes('pinned to terminal output');
      const isSourceChanged =
        err.message?.includes('source_changed') ||
        err.issue?.code === 'SOURCE_CHANGED' ||
        err.issue?.message?.includes('source_changed');
      const isUnsupported =
        err.issue?.code === 'CONVERSATION_UNSUPPORTED' ||
        err.message?.includes('transcript_required') ||
        err.message?.includes('provider_unsupported') ||
        err.message?.includes('session_not_reported') ||
        err.message?.includes('release_completed') ||
        isPinnedToTerminal;

      if (
        isUnsupported &&
        (node.agentType === 'antigravity' || globalSourceMaps.nodeSourceMap.get(node.id)?.paneKey)
      ) {
        const agRes = await resolveAntigravityConversation(projectId, node, activeRun, options);
        if (agRes.meta.availability !== 'unsupported') {
          if (isPinnedToTerminal && agRes.data) {
            agRes.data.warnings = [
              ...(agRes.data.warnings || []),
              'The worker-read cursor was pinned to terminal output and was reset to recent transcript window.',
            ];
            agRes.meta.partial = true;
          }
          conversationSection = agRes;
          return {
            node,
            tasks,
            activity,
            currentTool,
            conversation: conversationSection,
          };
        }
      }

      const rawMsg = err.issue?.message || err.message || 'Failed to read worker transcript';
      const cleanMsg = cleanErrorMessage(rawMsg);

      const code: ErrorCode = isSourceChanged
        ? 'SOURCE_CHANGED'
        : isUnsupported
        ? 'CONVERSATION_UNSUPPORTED'
        : (err.issue?.code || 'CLI_FAILED');

      const message = isSourceChanged
        ? 'Source transcript has changed. Reset cursor and reload.'
        : cleanMsg;

      conversationSection = {
        data: null,
        meta: {
          availability: isUnsupported ? 'unsupported' : 'unavailable',
          observedAt: null,
          attemptedAt: new Date().toISOString(),
          stale: false,
          partial: false,
          issue: {
            code,
            message,
            retryable: !isUnsupported && !isSourceChanged,
          },
        },
      };
    }
  }

  return {
    node,
    tasks,
    activity,
    currentTool,
    conversation: conversationSection,
  };
}
