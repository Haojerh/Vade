import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Id, ISO, State } from '../../../shared/contracts.js';

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

export function isGenericShellTitle(title: string | null | undefined): boolean {
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

const INJECTED_USER_PREFIXES = [
  '<environment_context>',
  '<skills_instructions>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<multi_agent_role>',
  '<multi_agent_mode>',
  '# AGENTS.md instructions',
  '<skill>',
];

export function isSystemInjectedUserText(trimmed: string, includeUserSettingsChange = false): boolean {
  if (INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return true;
  }
  return includeUserSettingsChange && trimmed.startsWith('<USER_SETTINGS_CHANGE>');
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

function scanBeyondWindowForNewline(fd: number, startOffset: number, fileSize: number): { endOffset: number; foundNl: boolean } {
  let giantEnd = startOffset;
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
  return { endOffset: giantEnd, foundNl };
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

    const isInitialTail = startByteOffset === null || startByteOffset === undefined;
    let readStart = 0;
    let readLen = 0;

    if (isInitialTail) {
      readStart = fileSize > maxBytesWindow ? fileSize - maxBytesWindow : 0;
      readLen = fileSize > maxBytesWindow ? maxBytesWindow : fileSize;
    } else {
      readStart = Math.min(startByteOffset, fileSize);
      if (readStart >= fileSize) {
        return { lines: [], hasMore: false, limited: seekingNewline, nextByteOffset: fileSize, seekingNewline, totalScanned: 0 };
      }
      readLen = Math.min(maxBytesWindow, fileSize - readStart);
    }

    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, readStart);
    const sliceBuf = buf.subarray(0, bytesRead);

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
      const { endOffset, foundNl } = scanBeyondWindowForNewline(fd, readStart + bytesRead, fileSize);
      return {
        lines: [],
        hasMore: endOffset < fileSize,
        limited: true,
        nextByteOffset: endOffset,
        seekingNewline: !foundNl,
        totalScanned: 0,
      };
    }

    let initialDiscardBytes = 0;
    if (isInitialTail && readStart > 0) {
      const firstNl = sliceBuf.indexOf(0x0a);
      if (firstNl !== -1) {
        initialDiscardBytes = firstNl + 1;
      } else {
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

    let trailingDiscardBytes = 0;
    if (readStart + readLen < fileSize) {
      const lastNl = sliceBuf.lastIndexOf(0x0a);
      if (lastNl !== -1 && lastNl >= initialDiscardBytes) {
        trailingDiscardBytes = bytesRead - (lastNl + 1);
      } else {
        const { endOffset, foundNl } = scanBeyondWindowForNewline(fd, readStart + readLen, fileSize);
        return {
          lines: [],
          hasMore: endOffset < fileSize,
          limited: true,
          nextByteOffset: endOffset,
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
    }

    if (rawLines.length > limit) {
      const lines = rawLines.slice(0, limit);
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
      const nextByteOffset = readStart + initialDiscardBytes + pos;
      return {
        lines,
        hasMore: true,
        limited: readLen === maxBytesWindow && readStart + readLen < fileSize,
        nextByteOffset,
        seekingNewline: false,
        totalScanned: lines.length,
      };
    }

    const nextByteOffset =
      trailingDiscardBytes > 0 ? readStart + readLen - trailingDiscardBytes : readStart + readLen;
    return {
      lines: rawLines,
      hasMore: nextByteOffset < fileSize,
      limited: readLen === maxBytesWindow && readStart + readLen < fileSize,
      nextByteOffset,
      seekingNewline: false,
      totalScanned: rawLines.length,
    };
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
