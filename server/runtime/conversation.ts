import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationPage, NodeDetailsQuery, Section, ToolActivity } from '../../shared/contracts.js';
import type { SessionRecord } from './store.js';
import { validCodexThreadId } from './codexThread.js';
import { CliError } from '../integrations/cli.js';
import { hashId, isPathInsideRoots, readBoundedTranscriptLines, readOlderTranscriptLines } from '../integrations/orca/utils.js';
import { issueStoredCursor, validateStoredCursor } from '../integrations/orca/state.js';
import { parseCoordinatorTranscriptLine } from '../integrations/orca/nodeDetails.js';
import { parseAntigravityTranscriptLine, readAntigravityModel, readAntigravityToolActivity } from '../providers/antigravity.js';
import { transcriptSettings } from '../providers/shared.js';
import { transcriptToolActivity } from '../providers/toolActivity.js';

function unavailable(message: string): Section<ConversationPage> {
  return { data: null, meta: { availability: 'unavailable', observedAt: null, attemptedAt: new Date().toISOString(), partial: false, stale: false,
    issue: { code: 'RUNTIME_UNAVAILABLE', message, retryable: true } } };
}

// Only exact UUID filenames under provider roots are eligible. Directory work is bounded.
function findFile(root: string, id: string, depth: number): string | null {
  let remaining = 4096;
  const visit = (directory: string, level: number): string | null => {
    if (!isPathInsideRoots(directory, [root])) return null;
    const entries = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = entries.readSync())) {
        if (--remaining < 0) return null;
        if (entry.isFile() && (entry.name === `${id}.jsonl` || entry.name.endsWith(`-${id}.jsonl`))) return path.join(directory, entry.name);
        if (level && entry.isDirectory()) { const match = visit(path.join(directory, entry.name), level - 1); if (match) return match; }
      }
    } finally { entries.closeSync(); }
    return null;
  };
  try { return visit(root, depth); } catch { return null; }
}

function verifyJsonSession(file: string, record: SessionRecord): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, size).toString('utf8').split('\n').slice(0, 100)) {
      try {
        const row = JSON.parse(line);
        const metadata = record.provider === 'codex' && row.type === 'session_meta' ? row.payload : record.provider === 'claude' ? row : null;
        const id = record.provider === 'codex' ? metadata?.id : metadata?.sessionId;
        if (id === record.providerThreadId && typeof metadata.cwd === 'string' && [record.cwd, record.sourceCwd].some(cwd => cwd && path.resolve(metadata.cwd) === path.resolve(cwd))) return true;
      } catch { /* A partial or non-message record cannot establish provenance. */ }
    }
    return false;
  } finally { fs.closeSync(fd); }
}

export function publicMessage(record: SessionRecord, line: string, sourceIdentity: string) {
  try {
    const row = JSON.parse(line);
    if (record.provider !== 'antigravity') {
      if (record.provider === 'claude' && row.sessionId && row.sessionId !== record.providerThreadId) return null;
      return parseCoordinatorTranscriptLine(line, record.provider, sourceIdentity).message;
    }
    if (['USER_EXPLICIT', 'USER'].includes(row.source) && ['USER_INPUT', 'REQUEST'].includes(row.type)) {
      return parseAntigravityTranscriptLine(JSON.stringify({ ...row, type: 'USER_INPUT' }), sourceIdentity).message;
    }
    return row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' ? parseAntigravityTranscriptLine(line, sourceIdentity).message : null;
  } catch { return null; }
}

export class AdeConversations {
  private paths = new Map<string, string>();

  private resolve(record: SessionRecord): { file: string; root: string } {
    if (!validCodexThreadId(record.providerThreadId)) throw new Error('No verified provider conversation binding');
    const id = record.providerThreadId;
    const agy = record.provider === 'antigravity';
    const root = agy ? process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli')
      : record.provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
      : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const key = `${root}:${record.provider}:${id}:${record.cwd}`;
    let file = this.paths.get(key);
    if (!file || !fs.existsSync(file)) file = agy ? path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl') : findFile(root, id, record.provider === 'codex' ? 3 : 1) ?? undefined;
    if (!file || !isPathInsideRoots(file, [root])) throw new Error('No exact provider transcript');
    if (agy) {
      const database = path.join(root, 'conversations', `${id}.db`);
      if (!isPathInsideRoots(database, [root])) throw new Error('Antigravity conversation database is unavailable');
      const db = new DatabaseSync(database, { readOnly: true });
      try { if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(id)) throw new Error('Antigravity conversation identity does not match'); }
      finally { db.close(); }
    } else if (!verifyJsonSession(file, record)) throw new Error('Transcript session or workspace does not match this agent');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Provider transcript is not a regular file');
    if (this.paths.size >= 200) this.paths.delete(this.paths.keys().next().value!);
    this.paths.set(key, file);
    return { file, root };
  }

  async metadata(record: SessionRecord): Promise<{ preview: string | null; model: string | null; effort: string | null; toolActivity: Section<ToolActivity[]> }> {
    const now = new Date().toISOString();
    const result = { preview: null as string | null, model: null as string | null, effort: null as string | null, toolActivity: {
      data: null, meta: { availability: 'unavailable', attemptedAt: now, observedAt: null, partial: true, stale: false,
        issue: { code: 'RUNTIME_UNAVAILABLE', message: 'Metadata is not available for this exact provider session yet.', retryable: true } },
    } as Section<ToolActivity[]> };
    try {
      const { file, root } = this.resolve(record), id = record.providerThreadId!;
      const latest = await readOlderTranscriptLines(file, fs.statSync(file).size, 1, 1024 * 1024, false,
        line => Boolean(publicMessage(record, line, id)));
      result.preview = latest.lines.length ? publicMessage(record, latest.lines[0], id)?.text.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
      let tools: ToolActivity[];
      if (record.provider === 'antigravity') {
        const allowed = (file: string) => isPathInsideRoots(file, [root]);
        const model = readAntigravityModel(id, allowed);
        if (model) Object.assign(result, model);
        tools = readAntigravityToolActivity(id, allowed);
      } else {
        const settings = (line: string) => {
          try {
            const row = JSON.parse(line);
            if (row.sessionId && row.sessionId !== id) return {};
            if (record.provider === 'codex') return row.type === 'turn_context'
              ? { model: row.payload?.model, effort: row.payload?.effort } : {};
            return transcriptSettings(row);
          } catch { return {}; }
        };
        // Scan settings separately so long tool records cannot hide an earlier turn context.
        const recent = await readOlderTranscriptLines(file, fs.statSync(file).size, 1, 4 * 1024 * 1024, false,
          line => Boolean(settings(line).model));
        for (const line of recent.lines) {
          const observed = settings(line);
          if (typeof observed.model === 'string' && observed.model.length <= 200 && observed.model !== '<synthetic>') {
            result.model = observed.model;
            result.effort = typeof observed.effort === 'string' && observed.effort.length <= 80 ? observed.effort : null;
          }
        }
        const activity = await readBoundedTranscriptLines(file, null, 200, 512 * 1024, false,
          line => transcriptToolActivity(record.provider, id, line).length > 0);
        tools = activity.lines.flatMap(line => transcriptToolActivity(record.provider, id, line));
      }
      result.toolActivity = { data: [...new Map(tools.map(item => [item.id, item])).values()].slice(-200),
        meta: { availability: tools.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null } };
    } catch { /* Missing exact-session evidence remains explicitly unavailable. */ }
    return result;
  }

  async read(record: SessionRecord, query: NodeDetailsQuery = {}): Promise<Section<ConversationPage>> {
    try {
      const { file } = this.resolve(record), id = record.providerThreadId!, agy = record.provider === 'antigravity', stat = fs.statSync(file);
      const sourceIdentity = hashId('src', `${record.projectId}:${record.id}:${record.cwd}:${record.provider}:${id}:${fs.realpathSync(file)}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`);
      const older = query.direction === 'older';
      const expected = { projectId: record.projectId, nodeId: record.id, runId: null, sourceIdentity };
      const cursor = query.cursor ? validateStoredCursor(query.cursor, expected) : null;
      if (cursor && (cursor.direction !== query.direction || Number(cursor.upstreamCursor) > stat.size)) throw new CliError('INVALID_ARGUMENT', 'Conversation cursor direction or source changed');
      const parse = (line: string) => publicMessage(record, line, sourceIdentity);
      const result = await (older || !cursor ? readOlderTranscriptLines : readBoundedTranscriptLines)(file, cursor ? Number(cursor.upstreamCursor) : stat.size,
        Math.min(200, Math.max(1, query.limit ?? 20)), 1024 * 1024, cursor?.seekingNewline ?? false, line => Boolean(parse(line)));
      // Reuse unchanged forward cursors so idle streams do not exhaust the bounded cursor store.
      const offset = !older && !cursor ? stat.size : result.nextByteOffset;
      const nextCursor = older && !result.hasMore ? null : cursor && offset === Number(cursor.upstreamCursor) && Boolean(result.seekingNewline) === Boolean(cursor.seekingNewline) ? query.cursor! : issueStoredCursor({
        ...expected, upstreamCursor: String(offset), direction: query.direction, sourceMode: agy ? 'antigravity-transcript' : 'coordinator-transcript', seekingNewline: result.seekingNewline,
      });
      const messages = result.lines.flatMap(line => { const message = parse(line); return message ? [message] : []; });
      const now = new Date().toISOString();
      return { data: { messages, source: 'transcript', sourceIdentity, provider: record.provider, cursor: query.cursor ?? null, nextCursor, limited: result.hasMore || result.limited, truncated: false, warnings: [] },
        meta: { availability: messages.length ? 'ready' : 'empty', observedAt: now, attemptedAt: now, partial: result.hasMore || result.limited, stale: false, issue: null } };
    } catch (error) {
      if (error instanceof CliError) throw error;
      return unavailable('The exact provider transcript cannot be read yet. Use Terminal and retry after a recorded conversation turn.');
    }
  }
}
