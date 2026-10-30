import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError } from '../../integrations/cli.js';
import { codeBuddyEffortAcknowledgement } from '../../providers/codebuddy/codeBuddySettings.js';
import { parseCoordinatorTranscriptLine } from '../../providers/common/publicTranscript.js';
import { claudeLocalCommandEffort, claudeLocalCommandModel } from '../../providers/common/shared.js';
import { isPathInsideRoots } from '../../providers/common/transcriptUtils.js';
import type { NativeUserAnchor } from './controls/providerRewind.js';
import type { SessionRecord } from '../store.js';

/** Native item_completed events connect one public draft to its native UserMessage.
 * Never match message text or assume response-item IDs equal native item IDs. */
export function codexRecordedUserAnchors(lines: string[], source: string): Map<string, NativeUserAnchor> {
  const result = new Map<string, NativeUserAnchor>();
  let turn: string | undefined;
  let pending: string[] = [];
  let completed = false;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.type === 'event_msg' && row.payload?.type === 'task_started') {
        turn = typeof row.payload.turn_id === 'string' ? row.payload.turn_id : undefined;
        pending = [];
        completed = false;
        continue;
      }
      if (row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(row.payload?.type)) {
        turn = undefined;
        pending = [];
        continue;
      }
      if (!turn || completed) continue;
      const message = parseCoordinatorTranscriptLine(line, 'codex', source).message;
      if (message?.role === 'user') pending.push(message.id);
      if (row.type === 'event_msg' && row.payload?.type === 'item_completed' && row.payload.turn_id === turn && row.payload.item?.type === 'UserMessage') {
        const id = row.payload.item.id;
        if (pending.length === 1 && typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
          result.set(pending[0], { provider: 'codex', field: 'codex-item-id', nativeId: id });
        }
        completed = true;
        pending = [];
      }
    } catch { /* Incomplete native records provide no anchor. */ }
  }
  return result;
}

/** Exact-session local command records supply settings without entering public chat. */
export function codeBuddyRecordedSettings(lines: string[], record: SessionRecord): { model?: string | null; effort?: string | null } {
  const aliases = new Map<string, Set<string>>();
  const evidence: Array<{ model?: string; effort?: string; commandModel?: string; output: string }> = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (
        row.sessionId !== record.providerThreadId ||
        typeof row.cwd !== 'string' ||
        ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')
      ) {
        continue;
      }
      const output =
        row.type === 'message' && row.role === 'user' && row.providerData?.skipRun === true && Array.isArray(row.content)
          ? row.content
              .flatMap((part: any) =>
                part?.type === 'input_text' &&
                typeof part.text === 'string' &&
                part.text.startsWith('<local-command-stdout>') &&
                part.text.endsWith('</local-command-stdout>')
                  ? [part.text.slice(22, -23)]
                  : [],
              )
              .join('\n')
          : '';
      for (const match of output.matchAll(/^\s*-\s+(.+?)\s+\(([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\)(?:\s+← current)?\s*$/gm)) {
        const ids = aliases.get(match[1]) ?? new Set<string>();
        ids.add(match[2]);
        aliases.set(match[1], ids);
      }
      for (const match of output.matchAll(/^\s*-\s+([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})(?:\s+← current)?\s*$/gm)) {
        const ids = aliases.get(match[1]) ?? new Set<string>();
        ids.add(match[1]);
        aliases.set(match[1], ids);
      }
      const commandModel =
        row.type === 'message' && row.role === 'user' && row.providerData?.skipRun === true && Array.isArray(row.content)
          ? row.content
              .flatMap((part: any) =>
                part?.type === 'input_text' && typeof part.text === 'string' && /^<command-name>\/?model<\/command-name>/.test(part.text)
                  ? [part.text.match(/<command-args>([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})<\/command-args>/)?.[1]]
                  : [],
              )
              .find(Boolean)
          : undefined;
      evidence.push({
        model: row.providerData?.skipRun === true ? undefined : row.providerData?.model,
        effort: row.providerData?.skipRun === true ? undefined : row.providerData?.effort,
        commandModel,
        output,
      });
    } catch { /* Ignore incomplete or foreign records. */ }
  }
  const result: { model?: string | null; effort?: string | null } = {};
  let requestedModel: string | undefined;
  let ultracode = false;
  for (const row of evidence) {
    if (row.commandModel) requestedModel = row.commandModel;
    if (typeof row.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(row.model)) {
      if (row.model !== result.model && !ultracode) result.effort = null;
      result.model = row.model;
      if (!ultracode && typeof row.effort === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(row.effort)) result.effort = row.effort;
    }
    const current =
      row.output.match(/^\s*-\s+.+?\s+\(([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\)\s+← current\s*$/m)?.[1] ??
      row.output.match(/^\s*-\s+([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\s+← current\s*$/m)?.[1];
    const switched = row.output.match(/^Switched (?:model|this session) to (.+?)(?:\.|, but the global default could not be saved\.)\s*$/m)?.[1];
    const ids = switched ? aliases.get(switched) : undefined;
    const model = current ?? (ids?.has(requestedModel ?? '') ? requestedModel : ids?.size === 1 ? [...ids][0] : undefined);
    if (model) {
      if (model !== result.model && !ultracode) result.effort = null;
      result.model = model;
    } else if (switched && ids && ids.size > 1) {
      result.model = null;
      if (!ultracode) result.effort = null;
    }
    if (switched || current || /^(?:Error:|Failed to switch)/m.test(row.output)) requestedModel = undefined;
    const effort = codeBuddyEffortAcknowledgement(row.output);
    if (effort) {
      ultracode = effort === 'ultracode';
      result.effort = effort;
    }
  }
  return result;
}

// Only exact UUID filenames under provider roots are eligible. Directory work is bounded.
export function findTranscriptFile(root: string, id: string, depth: number): string | null {
  let remaining = 4096;
  const visit = (directory: string, level: number): string | null => {
    if (!isPathInsideRoots(directory, [root])) return null;
    const entries = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = entries.readSync())) {
        if (--remaining < 0) return null;
        if (entry.isFile() && (entry.name === `${id}.jsonl` || entry.name.endsWith(`-${id}.jsonl`))) return path.join(directory, entry.name);
        if (level && entry.isDirectory()) {
          const match = visit(path.join(directory, entry.name), level - 1);
          if (match) return match;
        }
      }
    } finally {
      entries.closeSync();
    }
    return null;
  };
  try { return visit(root, depth); } catch { return null; }
}

export function verifyJsonSession(file: string, record: SessionRecord): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, size).toString('utf8').split('\n').slice(0, 100)) {
      try {
        const row = JSON.parse(line);
        const metadata =
          record.provider === 'codex' && row.type === 'session_meta' ? row.payload : ['claude', 'codebuddy'].includes(record.provider) ? row : null;
        const id = record.provider === 'codex' ? metadata?.id : metadata?.sessionId;
        if (
          id === record.providerThreadId &&
          typeof metadata.cwd === 'string' &&
          [record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(metadata.cwd)) === '')
        ) {
          return true;
        }
      } catch { /* A partial or non-message record cannot establish provenance. */ }
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Private local-command evidence, never public conversation. Start at the exact
 * owned transcript's current byte cursor so historical acknowledgements cannot confirm a new setting. */
export function codeBuddyCommandOutput(record: SessionRecord): () => string {
  const root = path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects');
  const file = record.provider === 'codebuddy' && record.providerThreadId ? findTranscriptFile(root, record.providerThreadId, 1) : null;
  if (!file || !verifyJsonSession(file, record)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'The exact CodeBuddy command history is not available yet. Use Terminal until its session is recorded.');
  }
  const original = fs.statSync(file);
  const offset = original.size;
  const initial = fs.openSync(file, 'r');
  const last = Buffer.alloc(1);
  let skipFirst = false;
  try {
    if (offset) {
      fs.readSync(initial, last, 0, 1, offset - 1);
      skipFirst = last[0] !== 10;
    }
  } finally {
    fs.closeSync(initial);
  }
  return () => {
    const fd = fs.openSync(file, 'r');
    try {
      const current = fs.fstatSync(fd);
      const size = current.size - offset;
      if (current.dev !== original.dev || current.ino !== original.ino || size < 0 || size > 262144) {
        throw new CliError('RUNTIME_UNAVAILABLE', 'CodeBuddy command history changed or exceeded its read limit. Inspect Terminal before retrying.');
      }
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, offset);
      const lines = buffer.toString('utf8').split('\n');
      if (skipFirst) lines.shift();
      return lines
        .flatMap(line => {
          try {
            const row = JSON.parse(line);
            if (
              row.type !== 'message' ||
              row.role !== 'user' ||
              row.sessionId !== record.providerThreadId ||
              row.providerData?.skipRun !== true ||
              typeof row.cwd !== 'string' ||
              ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')
            ) {
              return [];
            }
            return Array.isArray(row.content)
              ? row.content.flatMap((part: any) =>
                  part?.type === 'input_text' &&
                  typeof part.text === 'string' &&
                  part.text.startsWith('<local-command-stdout>') &&
                  part.text.endsWith('</local-command-stdout>')
                    ? [part.text.slice(22, -23)]
                    : [],
                )
              : [];
          } catch {
            return [];
          }
        })
        .join('\n');
    } finally {
      fs.closeSync(fd);
    }
  };
}

/** Observe only records appended after the operation began; never replay controls. */
export function claudeSettingConfirmation(
  record: SessionRecord,
  request: { key: string; value: string },
  expectedLabel?: string,
): (() => boolean) | undefined {
  if (record.provider !== 'claude' || !['model', 'effort'].includes(request.key) || !record.providerThreadId) return;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const file = findTranscriptFile(root, record.providerThreadId, 1);
  if (!file || !verifyJsonSession(file, record)) return;
  const original = fs.statSync(file);
  const offset = original.size;
  const since = Date.now() - 1000;
  return () => {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const current = fs.fstatSync(fd);
      const length = current.size - offset;
      if (current.dev !== original.dev || current.ino !== original.ino || length < 0 || length > 262144) return false;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      return buffer
        .toString('utf8')
        .split('\n')
        .slice(0, 200)
        .some(line => {
          try {
            const row = JSON.parse(line);
            if (
              row.sessionId !== record.providerThreadId ||
              Date.parse(row.timestamp) < since ||
              !Number.isFinite(Date.parse(row.timestamp)) ||
              row.isSidechain ||
              row._fromSubAgent ||
              row.isMeta ||
              row.isSynthetic ||
              row.type !== 'system' ||
              row.subtype !== 'local_command' ||
              row.commandRun?.command !== request.key ||
              typeof row.cwd !== 'string' ||
              ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')
            ) {
              return false;
            }
            const recordedArgs = typeof row.commandRun.args === 'string' ? row.commandRun.args.trim() : '';
            if (recordedArgs && recordedArgs !== request.value) return false;
            if (request.key === 'effort') return claudeLocalCommandEffort(row) === request.value;
            const model = claudeLocalCommandModel(row);
            if (!model) return false;
            const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
            return [request.value, expectedLabel].some(value => value && normalize(value) === normalize(model));
          } catch {
            return false;
          }
        });
    } catch {
      return false;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
}
