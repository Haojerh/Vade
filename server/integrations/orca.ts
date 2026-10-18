import child_process from 'node:child_process';
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
  PrerequisitesStatus,
  RenameNodeTitleResponse,
  CreateAgentResponse,
} from '../../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, CliError, cleanErrorMessage, ORCA_PATH } from './cli.js';
import { readAntigravityModel } from '../providers/antigravity.js';
import { taskProgress } from '../services/progress.js';
import { attachmentPaste, attachmentReference, usesNativeImageAttachment } from '../services/attachments.js';
import {
  localTranscriptProviders,
  publicTranscriptRecord,
  transcriptSettings,
  openCodeDatabase,
  readOpenCodePage,
  readOpenCodeModel,
  findOpenCodeSession,
  findClaudeTranscript,
  findCodexTranscript,
  isCodexChatRecord,
} from '../providers/transcripts.js';

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
  if (lower.includes('heads up') || lower.includes('5h limit') || lower.includes('limit left')) return 'working';
  return 'unknown';
}

export function normalizeLiveness(raw: any): 'live' | 'exited' | 'unverifiable' | 'unknown' {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const lower = raw.toLowerCase().trim();
  if (lower === 'live' || lower === 'running' || lower === 'active') return 'live';
  if (lower.includes('heads up') || lower.includes('5h limit') || lower.includes('limit left')) return 'live';
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
    roots.push(path.join(userHome, '.claude'));
    roots.push(path.join(userHome, '.pi'));
    roots.push(path.join(userHome, '.omp'));
    roots.push(path.join(process.env.XDG_DATA_HOME || path.join(userHome, '.local', 'share'), 'opencode'));
    roots.push(path.join(process.env.XDG_DATA_HOME || path.join(userHome, '.local', 'share'), 'kilo'));
    roots.push(path.join(userHome, '.kilocode'));
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
  if (process.env.KILO_DB) {
    roots.push(path.resolve(path.dirname(process.env.KILO_DB)));
  }
  if (process.env.OPENCODE_DB) {
    roots.push(path.resolve(path.dirname(process.env.OPENCODE_DB)));
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
  nodeSourceMap: Map<Id, { handle?: string; worktreeId?: string; worktreePath?: string; paneKey?: string; endpointIncarnation?: string; ptyId?: string }>;
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

function isGenericShellTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const lower = title.toLowerCase().trim();
  return (
    lower.endsWith('cmd.exe') ||
    lower.endsWith('powershell.exe') ||
    lower.endsWith('pwsh.exe') ||
    lower.endsWith('/bash') ||
    lower.endsWith('/sh') ||
    lower.endsWith('/zsh') ||
    lower.includes('\\system32\\') ||
    lower.includes('/bin/')
  );
}

function extractLayoutTitles(visualLayouts: any[] | undefined): {
  tabTitleById: Map<string, string>;
  paneTitleByHandle: Map<string, string>;
  paneTitleByPaneKey: Map<string, string>;
} {
  const tabTitleById = new Map<string, string>();
  const paneTitleByHandle = new Map<string, string>();
  const paneTitleByPaneKey = new Map<string, string>();

  if (!Array.isArray(visualLayouts)) {
    return { tabTitleById, paneTitleByHandle, paneTitleByPaneKey };
  }

  function collectPanes(pane: any, tabTitle: string) {
    if (!pane || typeof pane !== 'object') return;
    if (pane.handle && typeof pane.handle === 'string') {
      paneTitleByHandle.set(pane.handle, tabTitle);
    }
    const paneKey = (pane.tabId && pane.leafId) ? `${pane.tabId}:${pane.leafId}` : (pane.paneKey || null);
    if (paneKey) {
      paneTitleByPaneKey.set(paneKey, tabTitle);
    }
    if (pane.first) collectPanes(pane.first, tabTitle);
    if (pane.second) collectPanes(pane.second, tabTitle);
    if (Array.isArray(pane.children)) {
      for (const child of pane.children) {
        collectPanes(child, tabTitle);
      }
    }
    if (Array.isArray(pane.panes)) {
      for (const child of pane.panes) {
        collectPanes(child, tabTitle);
      }
    }
  }

  function walkLayout(node: any) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        const rawTitle = typeof tab?.title === 'string' ? stripAnsi(tab.title).trim() : '';
        if (rawTitle && !isGenericShellTitle(rawTitle)) {
          if (tab.tabId) {
            tabTitleById.set(tab.tabId, rawTitle);
          }
          if (tab.panes) {
            collectPanes(tab.panes, rawTitle);
          }
        }
      }
    }
    if (node.first) walkLayout(node.first);
    if (node.second) walkLayout(node.second);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walkLayout(child);
      }
    }
    if (Array.isArray(node.items)) {
      for (const item of node.items) {
        walkLayout(item);
      }
    }
  }

  for (const layout of visualLayouts) {
    if (layout?.root) {
      walkLayout(layout.root);
    }
  }

  return { tabTitleById, paneTitleByHandle, paneTitleByPaneKey };
}

// Helper to query and filter project worktrees
async function fetchProjectWorktrees(
  projectEntry: { repoIds: string[]; paths: string[] },
  runner: CommandRunner
): Promise<{ projectWorktrees: any[]; runtimeId: string | null; partial: boolean }> {
  let partial = false;
  const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '200', '--json'], runner);
  const runtimeId = psRes._meta?.runtimeId ?? null;
  const allWorktrees: any[] = psRes.result?.worktrees ?? [];
  if (psRes.result?.truncated) partial = true;

  const projectWorktrees = allWorktrees.filter((w) => {
    if (w.repoId && projectEntry.repoIds.includes(w.repoId)) return true;
    if (w.path && projectEntry.paths.some((p) => p.toLowerCase() === w.path.toLowerCase())) return true;
    return false;
  });

  return { projectWorktrees, runtimeId, partial };
}

// Helper to batch-query worktree terminals with visual layouts
async function fetchWorktreeTerminals(
  projectWorktrees: any[],
  runner: CommandRunner
): Promise<{
  terminalsByWorktree: Map<string, any[]>;
  visualLayoutsByWorktree: Map<string, any[]>;
  partial: boolean;
}> {
  let partial = false;
  const terminalsByWorktree = new Map<string, any[]>();
  const visualLayoutsByWorktree = new Map<string, any[]>();

  for (let start = 0; start < projectWorktrees.length; start += 4) {
    await Promise.all(
      projectWorktrees.slice(start, start + 4).map(async (wt) => {
        try {
          const termRes = await runOrca<any>(
            ['terminal', 'list', '--worktree', `id:${wt.worktreeId}`, '--limit', '100', '--include-visual-layouts', '--json'],
            runner
          );
          terminalsByWorktree.set(wt.worktreeId, termRes.result?.terminals ?? []);
          visualLayoutsByWorktree.set(wt.worktreeId, termRes.result?.visualLayouts ?? []);
        } catch {
          try {
            const termResFallback = await runOrca<any>(
              ['terminal', 'list', '--worktree', `id:${wt.worktreeId}`, '--limit', '100', '--json'],
              runner
            );
            terminalsByWorktree.set(wt.worktreeId, termResFallback.result?.terminals ?? []);
          } catch {
            partial = true;
          }
        }
      })
    );
  }

  return { terminalsByWorktree, visualLayoutsByWorktree, partial };
}

// Helper to build worktree, agent, and terminal nodes plus membership and hierarchy edges
function buildWorktreeAndAgentNodes(
  projectWorktrees: any[],
  terminalsByWorktree: Map<string, any[]>,
  visualLayoutsByWorktree: Map<string, any[]>
): {
  nodes: Node[];
  edges: Edge[];
  nodeMap: Map<Id, Node>;
  paneKeyToNodeId: Map<string, Id>;
  terminalHandleToNodeId: Map<string, Id>;
  worktreeIdToNodeId: Map<string, Id>;
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nodeMap = new Map<Id, Node>();
  const paneKeyToNodeId = new Map<string, Id>();
  const terminalHandleToNodeId = new Map<string, Id>();
  const worktreeIdToNodeId = new Map<string, Id>();

  for (const wt of projectWorktrees) {
    const wtNodeId = hashId('node', wt.worktreeId || wt.path || wt.displayName);
    worktreeIdToNodeId.set(wt.worktreeId, wtNodeId);

    const isFolder = wt.workspaceKind === 'folder' || wt.isFolder;
    const wtLabel = isFolder
      ? `Folder: ${wt.comment?.trim() || wt.displayName || wt.repo || 'workspace'}`
      : (wt.displayName || wt.comment?.trim() || wt.branch || wt.repo || 'Worktree');
    const wtNode: Node = {
      id: wtNodeId,
      kind: 'worktree',
      label: wtLabel,
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
    globalSourceMaps.nodeSourceMap.set(wtNodeId, { worktreeId: wt.worktreeId, worktreePath: wt.path });

    const terminals = terminalsByWorktree.get(wt.worktreeId) ?? [];
    const visualLayouts = visualLayoutsByWorktree.get(wt.worktreeId) ?? [];
    const { tabTitleById, paneTitleByHandle, paneTitleByPaneKey } = extractLayoutTitles(visualLayouts);

    const terminalByPane = new Map<string, any>();
    for (const t of terminals) {
      if (t.tabId && t.leafId) {
        terminalByPane.set(`${t.tabId}:${t.leafId}`, t);
      }
      if (t.paneKey) {
        terminalByPane.set(t.paneKey, t);
      }
    }

    const agents: any[] = Array.isArray(wt.agents) ? wt.agents : [];
    const handledTerminalHandles = new Set<string>();

    for (const ag of agents) {
      const paneKey = ag.paneKey;
      const matchingTerminal = paneKey ? terminalByPane.get(paneKey) : null;
      const handle = matchingTerminal?.handle;
      if (handle) handledTerminalHandles.add(handle);
      if (paneKey) handledTerminalHandles.add(paneKey);

      const agentNodeId = hashId('node', paneKey || handle || `${wt.worktreeId}:agent:${nodes.length}`);
      if (paneKey) paneKeyToNodeId.set(paneKey, agentNodeId);
      if (handle) terminalHandleToNodeId.set(handle, agentNodeId);

      let agState = mapToState(ag.state);
      let liveness = matchingTerminal?.connected ? 'live' : normalizeLiveness(wt.terminalVerdict);
      if ((agState === 'unknown' || liveness === 'unverifiable') && matchingTerminal?.preview && (matchingTerminal.preview.includes('5h limit') || matchingTerminal.preview.includes('heads up'))) {
        agState = 'working';
        liveness = 'live';
      }

      const customTabTitle =
        (paneKey && paneTitleByPaneKey.get(paneKey)) ||
        (handle && paneTitleByHandle.get(handle)) ||
        (matchingTerminal?.tabId && tabTitleById.get(matchingTerminal.tabId)) ||
        (matchingTerminal?.title && !isGenericShellTitle(matchingTerminal.title) ? stripAnsi(matchingTerminal.title).trim() : null);

      const agLabel = (!isGenericShellTitle(customTabTitle) && customTabTitle) || ag.taskTitle || ag.displayName || ag.agentType || 'Agent';

      const agNode: Node = {
        id: agentNodeId,
        kind: 'agent',
        label: agLabel,
        worktreeId: wt.worktreeId || null,
        runId: null,
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
      globalSourceMaps.nodeSourceMap.set(agentNodeId, {
        handle,
        worktreeId: wt.worktreeId,
        paneKey,
        endpointIncarnation: agEndpointIncarnation,
        ptyId: matchingTerminal?.ptyId,
      });

      edges.push({
        id: hashId('edge', `${wtNodeId}->${agentNodeId}:membership`),
        source: wtNodeId,
        target: agentNodeId,
        kind: 'contains',
        evidence: 'workspace-membership',
        active: agNode.state === 'working',
      });
    }

    for (const term of terminals) {
      const termPaneKey = (term.tabId && term.leafId) ? `${term.tabId}:${term.leafId}` : (term.paneKey || null);
      if (handledTerminalHandles.has(term.handle) || (termPaneKey && handledTerminalHandles.has(termPaneKey))) continue;

      const isAgent = Boolean(term.agentIdentity);
      const termNodeId = hashId('node', termPaneKey || term.handle);
      terminalHandleToNodeId.set(term.handle, termNodeId);
      if (termPaneKey) paneKeyToNodeId.set(termPaneKey, termNodeId);

      const customTabTitle =
        (term.tabId && tabTitleById.get(term.tabId)) ||
        (term.handle && paneTitleByHandle.get(term.handle)) ||
        (termPaneKey && paneTitleByPaneKey.get(termPaneKey));

      const termLabel = isAgent
        ? (customTabTitle || (!isGenericShellTitle(term.title) ? (term.title ? stripAnsi(term.title).trim() : null) : null) || term.agentIdentity || 'Agent')
        : (customTabTitle || (term.title ? stripAnsi(term.title).trim() : null) || `Terminal ${term.handle}`);

      const termNode: Node = {
        id: termNodeId,
        kind: isAgent ? 'agent' : 'terminal',
        label: termLabel,
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
      globalSourceMaps.nodeSourceMap.set(termNodeId, {
        handle: term.handle,
        worktreeId: wt.worktreeId,
        paneKey: termPaneKey || undefined,
        endpointIncarnation: termEndpointIncarnation,
        ptyId: term.ptyId,
      });

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

  return { nodes, edges, nodeMap, paneKeyToNodeId, terminalHandleToNodeId, worktreeIdToNodeId };
}

// Helper to discover and associate orchestration runs with project worktrees
async function discoverAssociatedRuns(
  projectId: Id,
  terminalHandleToNodeId: Map<string, Id>,
  worktreeIdToNodeId: Map<string, Id>,
  nodeMap: Map<Id, Node>,
  runner: CommandRunner
): Promise<{ associatedRuns: Run[]; partial: boolean }> {
  const associatedRuns: Run[] = [];
  let candidateRuns: any[] = [];
  let partial = false;

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

      if (coordinatorNodeId) {
        const coordNode = nodeMap.get(coordinatorNodeId);
        if (coordNode) {
          coordNode.kind = 'orchestrator';
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

  return { associatedRuns, partial };
}

// Helper to select active run by ID or fallback to newest
function resolveActiveRun(
  selectedRunId: Id | null | undefined,
  associatedRuns: Run[],
  projectId: Id
): Run | null {
  if (selectedRunId) {
    const activeRun = associatedRuns.find((r) => r.id === selectedRunId) || null;
    if (!activeRun) {
      throw new CliError('RUN_NOT_FOUND', `Run ${selectedRunId} not found in project ${projectId}`);
    }
    return activeRun;
  }
  return associatedRuns.length > 0 ? associatedRuns[0] : null;
}

// Helper to bind active run workers, disambiguate dispatches, and enrich worker model/effort
async function bindActiveRunWorkers(
  projectId: Id,
  activeRun: Run | null,
  nodeMap: Map<Id, Node>,
  terminalHandleToNodeId: Map<string, Id>,
  edges: Edge[],
  runner: CommandRunner
): Promise<{ partial: boolean }> {
  let partial = false;
  if (!activeRun) {
    for (const key of Array.from(globalSourceMaps.dispatchMap.keys())) {
      if (key.startsWith(`${projectId}::`)) {
        globalSourceMaps.dispatchMap.delete(key);
      }
    }
    return { partial };
  }

  const coordinator = activeRun.coordinatorNodeId && nodeMap.get(activeRun.coordinatorNodeId);
  if (coordinator) coordinator.runId = activeRun.id;

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
          const materialized = workersList.filter(
            (w) => w.resource && w.resource.state !== 'absent' && w.projection?.stage?.detail !== 'agent_readiness'
          );

          let candidates = materialized.length > 0 ? materialized : workersList;

          if (targetSource?.endpointIncarnation) {
            const incMatch = candidates.filter(
              (w) => w.resource?.endpointIncarnation === targetSource.endpointIncarnation
            );
            if (incMatch.length > 0) {
              candidates = incMatch;
            }
          }

          const ownerMatch = candidates.filter((w) => {
            const dispId = w.dispatchId || (typeof w.id === 'string' && w.id.startsWith('ctx_') ? w.id : null);
            return dispId && (w.resource?.ownerDispatchId === dispId || w.resource?.originDispatchId === dispId);
          });

          if (ownerMatch.length === 1) {
            selectedWorker = ownerMatch[0];
          } else if (candidates.length === 1) {
            selectedWorker = candidates[0];
          } else {
            const targetNode = nodeMap.get(targetNodeId);
            if (targetNode && targetNode.taskIds.length > 0) {
              const taskMatch = candidates.filter((w) => targetNode.taskIds.includes(w.taskId));
              if (taskMatch.length === 1) {
                selectedWorker = taskMatch[0];
              }
            }

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
          const stageState = mapToState(w.projection?.stage?.activity);
          const workerMappedState = mapToState(w.workerState);
          if (stageState !== 'unknown') {
            targetNode.rawState = w.projection.stage.activity;
            targetNode.state = stageState;
          } else if (workerMappedState !== 'unknown') {
            targetNode.rawState = w.workerState;
            targetNode.state = workerMappedState;
          } else if (w.projection?.stage?.activity) {
            targetNode.rawState = w.projection.stage.activity;
            targetNode.state = stageState;
          } else if (w.workerState) {
            targetNode.rawState = w.workerState;
            targetNode.state = workerMappedState;
          }

          if (w.projection?.outcome) {
            targetNode.taskOutcome = w.projection.outcome;
          } else if (w.outcome) {
            targetNode.taskOutcome = w.outcome;
          }

          if (w.projection?.liveness?.verdict) {
            const normLiveness = normalizeLiveness(w.projection.liveness.verdict);
            if (normLiveness === 'unverifiable' && targetNode.liveness === 'live' && (w.projection.liveness?.reason === 'missing_status' || targetNode.preview?.includes('5h limit') || targetNode.preview?.includes('heads up'))) {
              // Retain live status proven by connected terminal or limit warning
            } else {
              targetNode.liveness = normLiveness;
            }
          }
          if (targetNode.preview && (targetNode.preview.includes('5h limit') || targetNode.preview.includes('heads up'))) {
            if (targetNode.liveness === 'unverifiable' || targetNode.liveness === 'unknown') {
              targetNode.liveness = 'live';
            }
            if (targetNode.state === 'unknown') {
              targetNode.state = 'working';
            }
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
              } catch (showErr) {
                if (process.env.NODE_ENV !== 'test') {
                  const msg = showErr instanceof Error ? showErr.message : String(showErr);
                  console.debug(`[collectGraph] worker-show failed for dispatch ${dispId}: ${msg}`);
                }
              }

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
                  } catch (originErr) {
                    if (process.env.NODE_ENV !== 'test') {
                      const msg = originErr instanceof Error ? originErr.message : String(originErr);
                      console.debug(`[collectGraph] worker-show failed for originDispatch ${originDispatchId}: ${msg}`);
                    }
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

  return { partial };
}

// Helper to collect tasks and task status activities for active run
async function collectActiveRunTasks(
  activeRun: Run | null,
  terminalHandleToNodeId: Map<string, Id>,
  nodeMap: Map<Id, Node>,
  attemptedAt: string,
  runner: CommandRunner
): Promise<{ tasks: Task[]; taskCoverage: Progress['coverage']; taskActivities: Activity[]; partial: boolean }> {
  const tasks: Task[] = [];
  let taskCoverage: Progress['coverage'] = 'unavailable';
  const taskActivities: Activity[] = [];
  let partial = false;

  if (!activeRun) {
    return { tasks, taskCoverage, taskActivities, partial };
  }

  try {
    const taskRes = await runOrca<any>(['orchestration', 'task-list', '--run', activeRun.sourceRunId, '--json'], runner);
    if (!Array.isArray(taskRes.result?.tasks)) throw new Error('Invalid task inventory');
    const rawTasks: any[] = taskRes.result.tasks;
    taskCoverage = taskRes.result.truncated || taskRes.result.partial ? 'partial' : 'complete';
    if (taskCoverage === 'partial') partial = true;

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
        } catch {}
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

      if (t.status) {
        taskActivities.push({
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
    taskCoverage = tasks.length ? 'partial' : 'unavailable';
    partial = true;
  }

  return { tasks, taskCoverage, taskActivities, partial };
}

// Helper to enrich agent models and effort from hooks and transcripts
async function enrichAgentModelsAndEffort(nodes: Node[]): Promise<void> {
  // Pane hooks cover agents launched outside orchestration as well as workers.
  try {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const statusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');
    const entries = JSON.parse(fs.readFileSync(statusPath, 'utf-8')).entries ?? {};
    for (const node of nodes) {
      if (node.kind !== 'agent' && node.kind !== 'orchestrator') continue;
      const paneKey = globalSourceMaps.nodeSourceMap.get(node.id)?.paneKey;
      const entry = paneKey ? entries[paneKey] : null;
      if (!entry || (entry.worktreeId && entry.worktreeId !== node.worktreeId) ||
        (entry.source && node.agentType && entry.source !== node.agentType)) continue;
      const model = entry.payload?.model;
      const effort = entry.payload?.effort;
      if (typeof model === 'string' && model.trim()) node.model = model;
      if (typeof effort === 'string' && effort.trim()) node.effort = effort;

      if (node.agentType === 'antigravity' && entry.providerSession?.key === 'conversation_id' &&
        typeof entry.providerSession.id === 'string') {
        const observed = readAntigravityModel(entry.providerSession.id,
          (file) => isPathInsideRoots(file, getAllowedTranscriptRoots()));
        if (observed) {
          node.model = observed.model;
          node.effort = observed.effort;
        }
      }

      // Codex records effective settings per turn. Inspect the recent bounded
      // window so model/effort changes are reflected rather than the first turn.
      const transcriptPath = entry.providerSession?.transcriptPath;
      if (entry.providerSession?.id && ['opencode', 'kilo', 'kilocode'].includes(node.agentType || '')) {
        try {
          const file = openCodeDatabase(node.agentType!, entry.providerSession.id,
            (file) => isPathInsideRoots(file, getAllowedTranscriptRoots()));
          const observed = file ? readOpenCodeModel(file, entry.providerSession.id) : null;
          if (observed) { node.model = observed.model; node.effort = observed.effort; }
        } catch {}
      }
      if (entry.providerSession?.id && ['claude', 'pi', 'omp'].includes(node.agentType || '') &&
        typeof transcriptPath === 'string' && isPathInsideRoots(transcriptPath, getAllowedTranscriptRoots())) {
        try {
          const recent = await readBoundedTranscriptLines(transcriptPath, null, 200, 512 * 1024);
          for (const line of recent.lines) {
            const record = JSON.parse(line);
            if (record.sessionId && record.sessionId !== entry.providerSession.id) continue;
            const observed = transcriptSettings(record);
            if (observed.model) node.model = observed.model;
            if (observed.effort) node.effort = observed.effort;
          }
        } catch {}
      }
      if (node.agentType !== 'codex' || !entry.providerSession?.id ||
        typeof transcriptPath !== 'string' || !isPathInsideRoots(transcriptPath, getAllowedTranscriptRoots())) continue;
      try {
        for (const window of [512 * 1024, 16 * 1024 * 1024]) {
          const recent = await readBoundedTranscriptLines(transcriptPath, null, 1, window, false, (line) => {
            try { return JSON.parse(line).type === 'turn_context'; } catch { return false; }
          });
          if (!recent.lines.length) continue;
          const context = JSON.parse(recent.lines[0]).payload;
          if (typeof context?.model === 'string' && context.model.trim()) node.model = context.model;
          if (typeof context?.effort === 'string' && context.effort.trim()) node.effort = context.effort;
          break;
        }
      } catch {}
    }
  } catch {}

  // For any agent nodes that didn't get model/effort from live hooks (e.g. standalone or resumed sessions)
  for (const node of nodes) {
    if (node.kind !== 'agent' && node.kind !== 'orchestrator') continue;
    if (node.model) continue;

    if (['opencode', 'kilo', 'kilocode'].includes(node.agentType || '')) {
      try {
        const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
        const rawPtyId = nodeSource?.ptyId || (nodeSource?.endpointIncarnation ? nodeSource.endpointIncarnation.slice(0, nodeSource.endpointIncarnation.lastIndexOf(':')) : null);
        const worktreePath = node.worktreeId ? (node.worktreeId.includes('::') ? node.worktreeId.split('::')[1] : node.worktreeId) : null;
        const found = findOpenCodeSession(
          node.agentType!,
          node.label,
          (file) => isPathInsideRoots(file, getAllowedTranscriptRoots()),
          { worktreePath, ptyId: rawPtyId }
        );
        if (found) {
          const observed = readOpenCodeModel(found.dbPath, found.sessionId);
          if (observed?.model) node.model = observed.model;
          if (observed?.effort) node.effort = observed.effort;
        }
      } catch {}
    }
  }
}

// Helper to assemble progress and bounded activity
function buildGraphActivitiesAndProgress(
  nodes: Node[],
  tasks: Task[],
  taskCoverage: Progress['coverage'],
  taskActivities: Activity[]
): { progress: Progress; boundedActivity: Activity[] } {
  const progress = taskProgress(tasks, taskCoverage);
  const activities: Activity[] = [...taskActivities];

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
  return { progress, boundedActivity };
}

// Helper to build empty graph failure payload
function buildEmptyGraphFailure(
  runtimeId: string | null,
  attemptedAt: string,
  err: any
): { graph: Graph; meta: SourceMeta; runtimeId: string | null; appVersion: string | null } {
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
    // A. Query and filter project worktrees
    const wtResult = await fetchProjectWorktrees(projectEntry, runner);
    runtimeId = wtResult.runtimeId;
    if (wtResult.partial) partial = true;

    // B. Query worktree terminals in parallel batches
    const termResult = await fetchWorktreeTerminals(wtResult.projectWorktrees, runner);
    if (termResult.partial) partial = true;

    // C. Build worktree, agent, and terminal nodes plus membership and hierarchy edges
    const { nodes, edges, nodeMap, terminalHandleToNodeId, worktreeIdToNodeId } =
      buildWorktreeAndAgentNodes(wtResult.projectWorktrees, termResult.terminalsByWorktree, termResult.visualLayoutsByWorktree);

    // D. Discover and associate orchestration runs
    const runResult = await discoverAssociatedRuns(projectId, terminalHandleToNodeId, worktreeIdToNodeId, nodeMap, runner);
    if (runResult.partial) partial = true;

    // E. Resolve active run
    const activeRun = resolveActiveRun(selectedRunId, runResult.associatedRuns, projectId);

    // F. Bind active run workers and dispatches
    const workerResult = await bindActiveRunWorkers(projectId, activeRun, nodeMap, terminalHandleToNodeId, edges, runner);
    if (workerResult.partial) partial = true;

    // G. Collect tasks for active run
    const taskResult = await collectActiveRunTasks(activeRun, terminalHandleToNodeId, nodeMap, attemptedAt, runner);
    if (taskResult.partial) partial = true;

    // H. Enrich agent models and effort from hooks and transcripts
    await enrichAgentModelsAndEffort(nodes);

    // I. Build progress and activities
    const { progress, boundedActivity } = buildGraphActivitiesAndProgress(nodes, taskResult.tasks, taskResult.taskCoverage, taskResult.taskActivities);

    const observedAt = new Date().toISOString();
    return {
      graph: {
        runs: runResult.associatedRuns,
        selectedRunId: activeRun?.id ?? null,
        nodes,
        edges,
        tasks: taskResult.tasks,
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
    return buildEmptyGraphFailure(runtimeId, attemptedAt, err);
  }
}

// Resolve Codex transcripts from exact coordinator or standalone pane metadata.
export async function resolveCoordinatorConversation(
  projectId: Id,
  node: Node,
  activeRun: Run | null,
  options?: { cursor?: string | null; limit?: number },
  standaloneAgent = false
): Promise<Section<ConversationPage>> {
  if (!activeRun && !standaloneAgent) {
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
  const orcaDir = path.join(appData, 'orca');
  const orchDbPath = path.join(orcaDir, 'orchestration.db');
  const lastStatusPath = path.join(orcaDir, 'agent-hooks', 'last-status.json');

  let coordPaneKey: string | null = null;
  let coordHandle: string | null = null;
  let coordSessionId: string | null = null;

  if (!standaloneAgent && activeRun && fs.existsSync(orchDbPath)) {
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
  let isMatchingCoord = standaloneAgent || activeRun?.coordinatorNodeId === node.id;
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
          message: `Node ${node.id} is not the coordinator for run ${activeRun?.sourceRunId}`,
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
  let isSourceMismatch = false;

  if (coordPaneKey && fs.existsSync(lastStatusPath)) {
    try {
      const rawStatus = fs.readFileSync(lastStatusPath, 'utf-8');
      const statusData = JSON.parse(rawStatus);
      const entry = statusData.entries?.[coordPaneKey];
      if (entry) {
        if (standaloneAgent && entry.source && entry.source !== node.agentType) {
          isSourceMismatch = true;
        } else if (entry.providerSession && (!standaloneAgent ||
          (entry.source === node.agentType && localTranscriptProviders.includes(entry.source) &&
            (!entry.worktreeId || entry.worktreeId === node.worktreeId) &&
            typeof entry.providerSession.id === 'string' && entry.providerSession.id.trim()))) {
          if (typeof entry.providerSession.transcriptPath === 'string') {
            transcriptPath = entry.providerSession.transcriptPath;
          }
          providerSessionId = entry.providerSession.id || null;
          provider = entry.source || entry.agentPresence?.agent || entry.payload?.agentType || null;
        }
      }
    } catch {}
  }

  // Fallback for resumed or standalone Codex sessions
  if (!transcriptPath && node.agentType === 'codex' && !isSourceMismatch && node.label) {
    transcriptPath = findCodexTranscript(node.label);
    const journalDbPath = path.join(orcaDir, 'agent-session-journal.db');
    const cleanLabel = node.label.trim();
    const isGeneric = ['codex', 'terminal'].some((g) => cleanLabel.toLowerCase().startsWith(g));
    if (!transcriptPath && !isGeneric && fs.existsSync(journalDbPath)) {
      let jdb: DatabaseSync | null = null;
      try {
        jdb = new DatabaseSync(journalDbPath, { readOnly: true });
        const rows = jdb
          .prepare("SELECT record_json FROM agent_session_records WHERE json_extract(record_json, '$.provider') = 'codex' ORDER BY createdAt DESC LIMIT 20")
          .all() as any[];
        for (const row of rows) {
          if (!row.record_json) continue;
          const parsed = JSON.parse(row.record_json);
          const threadId = parsed.providerHandleChain?.[0]?.handle?.threadId;
          const matchesSpecific =
            parsed.sessionId === cleanLabel ||
            threadId === cleanLabel ||
            (parsed.title && (parsed.title.toLowerCase() === cleanLabel.toLowerCase() || cleanLabel.toLowerCase().includes(parsed.title.toLowerCase())));
          if (matchesSpecific && threadId) {
            const found = findCodexTranscript(threadId);
            if (found) {
              transcriptPath = found;
              providerSessionId = threadId;
              break;
            }
          }
        }
      } catch {} finally {
        try {
          jdb?.close();
        } catch {}
      }
    }
    if (transcriptPath) {
      provider = 'codex';
    }
  }

  // Fallback for resumed OpenCode / Kilo sessions
  if (!transcriptPath && ['opencode', 'kilo', 'kilocode'].includes(node.agentType || '') && !isSourceMismatch && node.label) {
    const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
    const rawPtyId = nodeSource?.ptyId || (nodeSource?.endpointIncarnation ? nodeSource.endpointIncarnation.slice(0, nodeSource.endpointIncarnation.lastIndexOf(':')) : null);
    const worktreePath = node.worktreeId ? (node.worktreeId.includes('::') ? node.worktreeId.split('::')[1] : node.worktreeId) : null;
    const ocMatch = findOpenCodeSession(
      node.agentType!,
      node.label,
      (file) => isPathInsideRoots(file, getAllowedTranscriptRoots()),
      { worktreePath, ptyId: rawPtyId }
    );
    if (ocMatch) {
      transcriptPath = ocMatch.dbPath;
      provider = node.agentType;
      providerSessionId = ocMatch.sessionId;
    }
  }

  // Fallback for resumed Claude sessions
  if (!transcriptPath && node.agentType === 'claude' && !isSourceMismatch && node.label) {
    const claudeMatch = findClaudeTranscript(node.label, (file) => isPathInsideRoots(file, getAllowedTranscriptRoots()));
    if (claudeMatch) {
      transcriptPath = claudeMatch.transcriptPath;
      provider = 'claude';
      providerSessionId = claudeMatch.sessionId;
    }
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

  const databaseProvider = provider && ['opencode', 'kilo', 'kilocode'].includes(provider);
  if (!transcriptPath && databaseProvider && providerSessionId) {
    try { transcriptPath = openCodeDatabase(provider!, providerSessionId, (file) => isPathInsideRoots(file, getAllowedTranscriptRoots())); } catch {}
  }

  if (databaseProvider && transcriptPath && providerSessionId && !node.model) {
    try {
      const observed = readOpenCodeModel(transcriptPath, providerSessionId);
      if (observed?.model) node.model = observed.model;
      if (observed?.effort) node.effort = observed.effort;
    } catch {}
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
          message: standaloneAgent
            ? 'Agent transcript provenance not found or unsupported'
            : 'Coordinator transcript provenance not found or unsupported',
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

  const opaqueSourceIdentity = hashId('src', `${provider}:${providerSessionId}:${transcriptPath}`);

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
      readResult = databaseProvider
        ? readOpenCodePage(transcriptPath, providerSessionId!, currentOffset, limit)
        : await readBoundedTranscriptLines(
          transcriptPath, currentOffset, limit, 8 * 1024 * 1024, currentSeeking, (line) => {
            try { const record = publicTranscriptRecord(line, provider || 'codex'); return record && isCodexChatRecord(JSON.stringify(record)); } catch { return false; }
          });
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
        const obj = publicTranscriptRecord(line, provider || 'codex');
        if (!obj) continue;
        if (obj.payload?.role === 'assistant' && obj.payload?.channel === 'analysis') continue;
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

export { findCodexTranscript };

// Helper to locate Antigravity session conversation ID from hooks, labels, terminal history checkpoints, or vault cache
export function findAntigravityConversationId(
  node: Node,
  nodeSource?: { handle?: string; worktreeId?: string; paneKey?: string; endpointIncarnation?: string; ptyId?: string }
): { conversationId: string; title?: string; worktreeId?: string; source: string } | null {
  const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
  const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');

  // 1. Direct match in last-status.json by paneKey (live running session)
  if (nodeSource?.paneKey && fs.existsSync(lastStatusPath)) {
    try {
      const rawStatus = fs.readFileSync(lastStatusPath, 'utf-8');
      const statusData = JSON.parse(rawStatus);
      const entry = statusData.entries?.[nodeSource.paneKey];
      if (
        entry &&
        entry.source === 'antigravity' &&
        entry.providerSession?.key === 'conversation_id' &&
        typeof entry.providerSession.id === 'string'
      ) {
        return {
          conversationId: entry.providerSession.id,
          worktreeId: entry.worktreeId || undefined,
          source: 'live-hook',
        };
      }
    } catch {}
  }

  // 2. UUID directly in node label
  if (node?.label) {
    const uuidMatch = node.label.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (uuidMatch) {
      return { conversationId: uuidMatch[0], source: 'label-uuid' };
    }
  }

  // Clean label
  const cleanLabel = (node?.label || '').replace(/^✳\s*/, '').replace(/^(?:antigravity|agy)\s*\|\s*/i, '').split(/\s*\|\s*/)[0].trim();
  const isGenericLabel = !cleanLabel || ['antigravity', 'agent', 'worker', 'coordinator', 'cmd.exe', 'powershell', 'bash', 'zsh', 'terminal'].some((g) => cleanLabel.toLowerCase().startsWith(g));

  // 3. Extract prompt from terminal history checkpoint if available
  let checkpointPrompt: string | null = null;
  const rawPtyId = nodeSource?.ptyId || (nodeSource?.endpointIncarnation ? nodeSource.endpointIncarnation.slice(0, nodeSource.endpointIncarnation.lastIndexOf(':')) : null);
  if (rawPtyId) {
    const encodedPty = encodeURIComponent(rawPtyId);
    const cpPath = path.join(appData, 'orca', 'terminal-history', encodedPty, 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try {
        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
        if (cp.snapshotAnsi) {
          const cleanText = stripAnsi(cp.snapshotAnsi);
          const prompts = cleanText
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /^>\s+/.test(l) && !/^>\s+(Accept-edits|Reject-edits|Esc to|for shortcuts)/i.test(l))
            .map((l) => l.replace(/^>\s+/, '').trim());
          if (prompts.length > 0) {
            checkpointPrompt = prompts[0];
          }
        }
      } catch {}
    }
  }

  const searchTarget = (!isGenericLabel ? cleanLabel : null) || checkpointPrompt;

  // 4. Search in Orca AI Vault session parse cache
  const vaultCachePath = path.join(appData, 'orca', 'ai-vault', 'session-parse-cache.json');
  if (searchTarget && fs.existsSync(vaultCachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(vaultCachePath, 'utf-8'));
      if (Array.isArray(cache.entries)) {
        for (const [, data] of cache.entries) {
          const s = data.session;
          if (s && s.agent === 'antigravity' && s.sessionId) {
            const sTitle = s.title ? s.title.toLowerCase().trim() : '';
            const sPrompt = s.lastUserPrompt ? s.lastUserPrompt.toLowerCase().trim() : '';
            const targetLower = searchTarget.toLowerCase().trim();
            if (sTitle === targetLower || sPrompt === targetLower || targetLower.includes(sTitle) || (sTitle && targetLower.startsWith(sTitle.slice(0, 30)))) {
              return { conversationId: s.sessionId, title: s.title || undefined, source: 'vault-cache' };
            }
          }
        }
      }
    } catch {}
  }

  // 5. Search in Antigravity conversation_summaries.db
  const geminiBase = process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const summariesDbPath = path.join(geminiBase, 'conversation_summaries.db');
  if (searchTarget && fs.existsSync(summariesDbPath)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(summariesDbPath, { readOnly: true });
      const targetLower = searchTarget.toLowerCase().trim();
      const rows = db.prepare('SELECT conversation_id, title, preview FROM conversation_summaries ORDER BY last_modified_time DESC').all() as any[];
      for (const row of rows) {
        const title = (row.title || '').toLowerCase().trim();
        const preview = (row.preview || '').toLowerCase().trim();
        if (title && (title === targetLower || targetLower.includes(title) || title.includes(targetLower))) {
          return { conversationId: row.conversation_id, title: row.title || undefined, source: 'summaries-db' };
        }
        if (preview && (preview.includes(targetLower) || targetLower.includes(preview.slice(0, 40)))) {
          return { conversationId: row.conversation_id, title: row.title || undefined, source: 'summaries-db-preview' };
        }
      }
    } catch {} finally {
      try { db?.close(); } catch {}
    }
  }

  return null;
}

export { isCodexChatRecord };

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

  const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
  const resolved = findAntigravityConversationId(node, nodeSource);

  if (!resolved) {
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
          message: 'Agent transcript provenance not found or unsupported',
          retryable: false,
        },
      },
    };
  }

  const conversationId = resolved.conversationId;
  const worktreeId = resolved.worktreeId || null;
  if (resolved.title && (isGenericShellTitle(node.label) || ['agent', 'antigravity', 'terminal'].some((g) => node.label.toLowerCase().startsWith(g)))) {
    node.label = resolved.title;
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

  if (isCoordinator || storedCursorObj?.sourceMode === 'coordinator-transcript' ||
    (localTranscriptProviders.includes(node.agentType || '') && !binding?.ambiguous && !binding?.dispatchId)) {
    conversationSection = await resolveCoordinatorConversation(projectId, node, activeRun, options, !isCoordinator);
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

const sendingTerminals = new Set<string>();

export async function sendAgentMessage(
  projectId: Id,
  nodeId: Id,
  message: string,
  runner: CommandRunner = defaultCommandRunner,
  attachments?: { provider: string | null; files: { path: string; name: string; image: boolean }[] }
): Promise<{ ok: boolean; message: string }> {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'Message cannot be empty');
  }
  const cleanMessage = message.trim();
  if (cleanMessage.length > 10000) {
    throw new CliError('INVALID_ARGUMENT', 'Message length exceeds maximum of 10000 characters');
  }

  // 1. Direct handle from nodeSourceMap
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  const handle = source?.handle;

  if (handle && /^term_[a-zA-Z0-9_-]+$/.test(handle)) {
    if (sendingTerminals.has(handle)) throw new CliError('RATE_LIMITED', 'A message is already being sent to this terminal');
    sendingTerminals.add(handle);
    try {
      if (attachments?.files.length) {
        for (const file of attachments.files) {
          if (!usesNativeImageAttachment(attachments.provider, file)) continue;
          const staged = await runOrca<any>(['terminal', 'send', '--terminal', handle, '--text', attachmentPaste(attachments.provider, file), '--json'], runner);
          if (staged.result?.send?.accepted === false) throw new CliError('CLI_FAILED', 'The agent refused an attachment; the message was not submitted');
        }
        // Allow TUIs to register attachment chips before the text-plus-Enter submission.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (attachments?.files.length) {
        // The text-plus-Enter CLI route trims leading whitespace. Stage a raw
        // multiline paste instead, then submit separately to preserve the break.
        const references = attachments.files.filter((file) => !usesNativeImageAttachment(attachments.provider, file)).map(attachmentReference);
        const text = `${references.join('\n')}\n${cleanMessage}`;
        const prompt = `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`;
        const staged = await runOrca<any>(['terminal', 'send', '--terminal', handle, '--text', prompt, '--json'], runner);
        if (staged.result?.send?.accepted === false) throw new CliError('CLI_FAILED', 'The agent refused the message text');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const args = attachments?.files.length
        ? ['terminal', 'send', '--terminal', handle, '--enter', '--json']
        : ['terminal', 'send', '--terminal', handle, '--text', cleanMessage, '--enter', '--json'];
      const res = await runOrca<any>(args, runner);
      if (!res.ok || res.result?.send?.accepted === false) {
        throw new CliError('CLI_FAILED', 'Failed to send message to agent terminal');
      }
      return { ok: true, message: 'Message sent to agent terminal' };
    } finally {
      sendingTerminals.delete(handle);
    }
  }

  if (attachments?.files.length) {
    throw new CliError('INVALID_ARGUMENT', 'Attachments require an exact local agent terminal');
  }

  // 2. Dispatch map lookup
  const dispatchKey = `${projectId}::${nodeId}`;
  const dispatchEntry = globalSourceMaps.dispatchMap.get(dispatchKey);
  if (dispatchEntry?.dispatchId) {
    const res = await runOrca<any>(
      [
        'orchestration',
        'send',
        '--subject',
        cleanMessage.slice(0, 50),
        '--body',
        cleanMessage,
        '--to',
        `dispatch:${dispatchEntry.dispatchId}`,
        '--json',
      ],
      runner
    );
    if (!res.ok) {
      throw new CliError('CLI_FAILED', 'Failed to send message to worker dispatch');
    }
    return { ok: true, message: 'Message sent to worker dispatch' };
  }

  // 3. Fallback: search worktree terminals if worktree is known
  if (source?.worktreeId) {
    try {
      const termRes = await runOrca<any>(['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '10', '--json'], runner);
      const terminals = termRes.result?.terminals ?? [];
      const activeTerm = terminals.find((t: any) => t.connected && t.handle);
      if (activeTerm?.handle && /^term_[a-zA-Z0-9_-]+$/.test(activeTerm.handle)) {
        const res = await runOrca<any>(['terminal', 'send', '--terminal', activeTerm.handle, '--text', cleanMessage, '--enter', '--json'], runner);
        if (res.ok) {
          return { ok: true, message: 'Message sent to active worktree terminal' };
        }
      }
    } catch {
      // Fall through
    }
  }

  throw new CliError('NODE_NOT_FOUND', `No active terminal or dispatch found for node ${nodeId}`);
}

export async function deleteWorktree(
  projectId: Id,
  nodeId: Id,
  runner: CommandRunner = defaultCommandRunner
): Promise<{ ok: boolean; message: string }> {
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  let worktreeId = source?.worktreeId;

  if (!worktreeId) {
    try {
      const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '100', '--json'], runner);
      const allWorktrees = psRes.result?.worktrees ?? [];
      const matched = allWorktrees.find((w: any) => {
        const wtNodeId = hashId('node', w.worktreeId || w.path || w.displayName);
        return wtNodeId === nodeId || w.worktreeId === nodeId || w.path === nodeId;
      });
      if (matched?.worktreeId) {
        worktreeId = matched.worktreeId;
      }
    } catch {
      // Fall through
    }
  }

  if (!worktreeId) {
    throw new CliError('NODE_NOT_FOUND', `Worktree node ${nodeId} not found`);
  }

  const selector = worktreeId.startsWith('id:') || worktreeId.startsWith('path:')
    ? worktreeId
    : `id:${worktreeId}`;

  await runOrca<any>(['worktree', 'rm', '--worktree', selector, '--force', '--json'], runner);
  globalSourceMaps.nodeSourceMap.delete(nodeId);
  return { ok: true, message: 'Worktree deleted successfully' };
}

export async function closeAgentTab(
  projectId: Id,
  nodeId: Id,
  runner: CommandRunner = defaultCommandRunner
): Promise<{ ok: boolean; message: string }> {
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  let handle = source?.handle;

  if (!handle || !/^term_[a-zA-Z0-9_-]+$/.test(handle)) {
    if (source?.worktreeId) {
      try {
        const termRes = await runOrca<any>(
          ['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '100', '--json'],
          runner
        );
        const terminals = termRes.result?.terminals ?? [];
        if (source.paneKey) {
          const matched = terminals.find((t: any) => `${t.tabId}:${t.leafId}` === source.paneKey || t.paneKey === source.paneKey);
          if (matched?.handle) {
            handle = matched.handle;
          }
        }
        if (!handle && terminals.length > 0) {
          const activeTerm = terminals.find((t: any) => t.connected && t.handle);
          if (activeTerm?.handle) {
            handle = activeTerm.handle;
          }
        }
      } catch {
        // Fall through
      }
    }
  }

  if (!handle || !/^term_[a-zA-Z0-9_-]+$/.test(handle)) {
    throw new CliError('NODE_NOT_FOUND', `No active terminal found for agent node ${nodeId}`);
  }

  await runOrca<any>(['terminal', 'close', '--terminal', handle, '--tab', '--json'], runner);

  if (source) {
    source.handle = undefined;
  }
  return { ok: true, message: 'Agent tab closed successfully' };
}

export async function renameNodeTitle(
  projectId: Id,
  nodeId: Id,
  title: string,
  runner: CommandRunner = defaultCommandRunner
): Promise<RenameNodeTitleResponse> {
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  let handle = source?.handle;

  if (!handle || !/^term_[a-zA-Z0-9_-]+$/.test(handle)) {
    if (source?.worktreeId) {
      try {
        const termRes = await runOrca<any>(
          ['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '100', '--json'],
          runner
        );
        const terminals = termRes.result?.terminals ?? [];
        if (source.paneKey) {
          const matched = terminals.find(
            (t: any) => `${t.tabId}:${t.leafId}` === source.paneKey || t.paneKey === source.paneKey
          );
          if (matched?.handle) {
            handle = matched.handle;
          }
        }
        if (!handle && terminals.length > 0) {
          const activeTerm = terminals.find((t: any) => t.connected && t.handle);
          if (activeTerm?.handle) {
            handle = activeTerm.handle;
          }
        }
      } catch {
        // Fall through
      }
    }
  }

  if (!handle || !/^term_[a-zA-Z0-9_-]+$/.test(handle)) {
    throw new CliError('NODE_NOT_FOUND', `No active terminal found for agent node ${nodeId}`);
  }

  const cleanTitle = (title || '').trim();
  const args = cleanTitle
    ? ['terminal', 'rename', '--terminal', handle, '--title', cleanTitle, '--json']
    : ['terminal', 'rename', '--terminal', handle, '--json'];

  await runOrca<any>(args, runner);
  return { ok: true, title: cleanTitle, message: 'Agent tab renamed successfully' };
}

export async function createWorktreeAgent(
  projectId: Id,
  nodeId: Id,
  command: string,
  title?: string,
  runner: CommandRunner = defaultCommandRunner
): Promise<CreateAgentResponse> {
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  let worktreeId = source?.worktreeId;
  let worktreePath = source?.worktreePath;

  if (!worktreeId && !worktreePath) {
    try {
      const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '100', '--json'], runner);
      const allWorktrees = psRes.result?.worktrees ?? [];
      const matched = allWorktrees.find((w: any) => {
        const wtNodeId = hashId('node', w.worktreeId || w.path || w.displayName);
        return wtNodeId === nodeId || w.worktreeId === nodeId || w.path === nodeId;
      });
      if (matched) {
        worktreeId = matched.worktreeId;
        worktreePath = matched.path;
      }
    } catch {
      // Fall through
    }
  }

  if (!worktreeId && !worktreePath) {
    throw new CliError('NODE_NOT_FOUND', `Worktree node ${nodeId} not found`);
  }

  const selector = worktreePath
    ? `path:${worktreePath}`
    : worktreeId!.startsWith('id:') || worktreeId!.startsWith('path:')
      ? worktreeId!
      : `id:${worktreeId}`;

  const cleanCmd = (command || '').trim();
  if (!cleanCmd) {
    throw new CliError('INVALID_ARGUMENT', 'Command is required');
  }

  const cleanTitle = (title || '').trim();
  const args = ['terminal', 'create', '--worktree', selector, '--command', cleanCmd];
  if (cleanTitle) {
    args.push('--title', cleanTitle);
  }
  args.push('--json');

  const res = await runOrca<any>(args, runner);
  const handle = res.result?.terminal?.handle || res.result?.handle;
  return {
    ok: true,
    handle,
    title: cleanTitle || undefined,
    message: 'Agent created successfully',
  };
}

export function resolveOrcaAppExecutable(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';

  const candidates: string[] = [
    // Windows standard locations
    path.join(localAppData, 'Programs', 'orca', 'Orca.exe'),
    path.join(programFiles, 'Orca', 'Orca.exe'),
    path.join(programFilesX86, 'Orca', 'Orca.exe'),
    // Relative to ORCA_PATH if ORCA_PATH is inside an installed bundle
    path.resolve(path.dirname(ORCA_PATH), '..', '..', 'Orca.exe'),
    // macOS standard locations
    '/Applications/Orca.app',
    path.join(homeDir, 'Applications', 'Orca.app'),
    // Linux standard locations
    '/usr/bin/orca-app',
    '/opt/Orca/orca',
    '/opt/orca/orca',
    path.join(homeDir, '.local', 'share', 'orca', 'orca'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore filesystem errors
    }
  }
  return null;
}

export function isCliOnPath(): boolean {
  try {
    if (process.platform === 'win32') {
      // 1. Check process.env.PATH
      const pathEnv = process.env.PATH || process.env.Path || '';
      const pathEntries = pathEnv.split(';').map((p) => p.trim());
      const isDirectlyOnEnvPath = pathEntries.some((entry) => {
        if (!entry) return false;
        try {
          return fs.existsSync(path.join(entry, 'orca.exe')) || fs.existsSync(path.join(entry, 'orca.cmd'));
        } catch {
          return false;
        }
      });
      if (isDirectlyOnEnvPath) return true;

      // 2. Check where.exe orca
      try {
        const whereOut = child_process.execSync('where.exe orca', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2000,
        });
        if (whereOut && whereOut.trim().length > 0) return true;
      } catch {
        // where.exe failed or not found
      }

      // 3. Check HKCU\Environment\Path in Windows registry
      try {
        const regOut = child_process.execSync('reg query "HKCU\\Environment" /v Path', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2000,
        });
        const match = regOut.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
        if (match && match[1]) {
          const userPathEntries = match[1].split(';').map((p) => p.trim());
          return userPathEntries.some((entry) => {
            if (!entry) return false;
            try {
              return fs.existsSync(path.join(entry, 'orca.exe')) || fs.existsSync(path.join(entry, 'orca.cmd'));
            } catch {
              return false;
            }
          });
        }
      } catch {
        // reg query failed
      }
      return false;
    } else {
      // Unix / macOS: check process.env.PATH and `which orca`
      const pathEnv = process.env.PATH || '';
      const pathEntries = pathEnv.split(':').map((p) => p.trim());
      const isOnPath = pathEntries.some((entry) => {
        if (!entry) return false;
        try {
          return fs.existsSync(path.join(entry, 'orca'));
        } catch {
          return false;
        }
      });
      if (isOnPath) return true;

      try {
        const whichOut = child_process.execSync('which orca', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        });
        return Boolean(whichOut && whichOut.trim().length > 0);
      } catch {
        return false;
      }
    }
  } catch {
    return false;
  }
}

export function detectOrcaCliInstallation(): boolean {
  return isCliOnPath();
}

export function detectOrcaAppInstallation(): boolean {
  return resolveOrcaAppExecutable() !== null;
}

export function detectOrcaCliSkillInstallation(): boolean {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const candidates: string[] = [
    // Claude Code
    path.join(homeDir, '.claude', 'skills', 'orca-cli'),
    // Canonical / Codex / general agent skills
    path.join(homeDir, '.agents', 'skills', 'orca-cli'),
    path.join(homeDir, '.codex', 'skills', 'orca-cli'),
    // Antigravity / Gemini CLI
    path.join(homeDir, '.gemini', 'config', 'skills', 'orca-cli'),
    path.join(homeDir, '.gemini', 'skills', 'orca-cli'),
    // Cursor
    path.join(homeDir, '.cursor', 'skills', 'orca-cli'),
    // Universal .skills / .orca
    path.join(homeDir, '.skills', 'orca-cli'),
    path.join(homeDir, '.orca', 'skills', 'orca-cli'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return true;
      }
    } catch {
      // Ignore filesystem errors
    }
  }
  return false;
}

export function detectOrchestrationSkillInstallation(): boolean {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  const candidates: string[] = [
    // Codex / general agent skills
    path.join(homeDir, '.codex', 'skills', 'orchestration'),
    path.join(homeDir, '.agents', 'skills', 'orchestration'),
    // Claude Code
    path.join(homeDir, '.claude', 'skills', 'orchestration'),
    // Antigravity / Gemini CLI
    path.join(homeDir, '.gemini', 'config', 'skills', 'orchestration'),
    path.join(homeDir, '.gemini', 'skills', 'orchestration'),
    // Cursor
    path.join(homeDir, '.cursor', 'skills', 'orchestration'),
    // OpenCode / Factory / Continue / etc.
    path.join(homeDir, '.config', 'opencode', 'skills', 'orchestration'),
    path.join(homeDir, '.factory', 'skills', 'orchestration'),
    path.join(homeDir, '.continue', 'skills', 'orchestration'),
    path.join(homeDir, '.trae-cn', 'skills', 'orchestration'),
    path.join(homeDir, '.grok', 'skills', 'orchestration'),
    path.join(homeDir, '.augment', 'skills', 'orchestration'),
    path.join(homeDir, '.config', 'muse', 'skills', 'orchestration'),
    path.join(homeDir, '.zcode', 'skills', 'orchestration'),
    // Universal .skills / .orca
    path.join(homeDir, '.skills', 'orchestration'),
    path.join(homeDir, '.orca', 'skills', 'orchestration'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return true;
      }
    } catch {
      // Ignore filesystem errors
    }
  }
  return false;
}

export function isOrcaAppProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = child_process.execSync('tasklist /FI "IMAGENAME eq Orca.exe" /FO CSV', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 2000,
      });
      const lines = out.split('\n').filter((l) => l.toLowerCase().includes('"orca.exe"'));
      if (lines.length === 0) return false;
      // Headless daemon-host is 1 or 2 processes with modest memory. The desktop app spawns 6+ processes.
      if (lines.length > 2) return true;
      for (const line of lines) {
        const match = line.match(/"([\d,]+)\s*K"/i);
        if (match) {
          const memK = parseInt(match[1].replace(/,/g, ''), 10);
          if (memK > 120000) return true;
        }
      }
      return false;
    } else if (process.platform === 'darwin') {
      const out = child_process.execSync('pgrep -x "Orca" || pgrep -f "Orca.app"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return out.trim().length > 0;
    } else {
      const out = child_process.execSync('pgrep -x "orca-app" || pgrep -x "orca"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return out.trim().length > 0;
    }
  } catch {
    return false;
  }
}

export interface CheckPrerequisitesOptions {
  checkAppInstallation?: () => boolean;
  checkAppOpen?: () => Promise<boolean> | boolean;
  checkCliInstallation?: () => boolean;
  checkCliSkillInstallation?: () => boolean;
  checkOrchestrationSkillInstallation?: () => boolean;
}

export async function checkPrerequisites(
  runner: CommandRunner = defaultCommandRunner,
  options?: CheckPrerequisitesOptions
): Promise<PrerequisitesStatus> {
  const checkApp = options?.checkAppInstallation ?? detectOrcaAppInstallation;
  const checkCli = options?.checkCliInstallation ?? detectOrcaCliInstallation;
  const checkCliSkill = options?.checkCliSkillInstallation ?? detectOrcaCliSkillInstallation;
  const checkOrchSkill = options?.checkOrchestrationSkillInstallation ?? detectOrchestrationSkillInstallation;

  let orcaApp = checkApp();
  let orcaAppOpen = false;
  let orcaCli = checkCli();
  let orchestrationSkill = false;
  let orcaCliSkill = false;
  let version: string | null = null;
  const issues: string[] = [];

  let statusResult: any = null;
  try {
    const res = await runOrca<any>(['status', '--json'], runner);
    statusResult = res?.result;
    const meta = res?._meta as any;
    if (meta?.appVersion || statusResult?.runtime?.appVersion) {
      version = meta?.appVersion || statusResult?.runtime?.appVersion || null;
    }
    if (statusResult?.app?.running === true || statusResult?.app) {
      orcaApp = true;
    }
  } catch (err: any) {
    if (
      err?.issue?.code === 'CLI_MISSING' ||
      (err?.message && (err.message.includes('ENOENT') || err.message.includes('not found') || err.message.includes('not recognized')))
    ) {
      orcaCli = false;
    }
  }

  // Check Skills: Authoritatively from Orca daemon if CLI runnable, otherwise fallback to user home dirs
  if (orcaCli) {
    const capabilities = statusResult?.runtime?.capabilities;
    const runtimeHasOrch = Array.isArray(capabilities)
      ? capabilities.some((cap: string) => typeof cap === 'string' && cap.startsWith('orchestration.'))
      : true;

    if (runtimeHasOrch) {
      let queriedSkills = false;
      try {
        const skillsRes = await runOrca<any>(['skills', 'installed', '--json'], runner);
        if (skillsRes?.result?.skills && Array.isArray(skillsRes.result.skills)) {
          queriedSkills = true;
          const installedSkills: any[] = skillsRes.result.skills;
          const isHomeOrBundled = (s: any) => s.sourceKind === 'home' || s.sourceKind === 'bundled';
          const hasOrch = installedSkills.some(
            (s: any) =>
              (s.name === 'orchestration' || s.id === 'orchestration') &&
              isHomeOrBundled(s)
          );
          const hasCli = installedSkills.some(
            (s: any) =>
              (s.name === 'orca-cli' || s.id === 'orca-cli') &&
              isHomeOrBundled(s)
          );
          orchestrationSkill = options?.checkOrchestrationSkillInstallation
            ? options.checkOrchestrationSkillInstallation()
            : hasOrch;
          orcaCliSkill = options?.checkCliSkillInstallation
            ? options.checkCliSkillInstallation()
            : hasCli;
        }
      } catch {
        // Fall through to file-based check
      }

      if (!queriedSkills) {
        orchestrationSkill = checkOrchSkill();
        orcaCliSkill = checkCliSkill();
      }
    } else {
      orchestrationSkill = false;
      orcaCliSkill = checkCliSkill();
    }
  } else {
    orchestrationSkill = false;
    orcaCliSkill = checkCliSkill();
  }

  // Determine if Orca desktop application is currently running / open
  if (options?.checkAppOpen) {
    orcaAppOpen = await Promise.resolve(options.checkAppOpen());
  } else if (statusResult?.app?.desktopWindowStatus === 'available') {
    orcaAppOpen = true;
  } else if (typeof statusResult?.app?.desktopWindowStatus === 'string' && statusResult.app.desktopWindowStatus !== 'available') {
    orcaAppOpen = false;
  } else if (statusResult?.app?.running === true) {
    orcaAppOpen = true;
  } else if (statusResult?.app?.running === false) {
    orcaAppOpen = false;
  } else if (orcaApp) {
    // If statusResult was not conclusive or CLI call failed, check the OS process table
    orcaAppOpen = isOrcaAppProcessRunning();
  }

  if (!orcaApp) {
    issues.push('Orca desktop application is not installed.');
  } else if (!orcaAppOpen) {
    issues.push('Orca desktop application is closed / not running.');
  }

  if (!orcaCli) {
    issues.push('Orca CLI is not installed or not in PATH.');
  }
  if (!orchestrationSkill) {
    issues.push('Orca Orchestration skill is not installed.');
  }
  if (!orcaCliSkill) {
    issues.push('Orca CLI skill (orca-cli) is not installed.');
  }

  const ready = orcaApp && orcaAppOpen && orcaCli && orchestrationSkill && orcaCliSkill;

  return {
    orcaApp,
    orcaAppOpen,
    orcaCli,
    orchestrationSkill,
    orcaCliSkill,
    ready,
    version,
    ...(issues.length > 0 ? { issues } : {}),
  };
}
