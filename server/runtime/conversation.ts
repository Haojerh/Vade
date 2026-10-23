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
import { isOpenCode, verifyOpenCode, withOpenCode } from './openCodeSessions.js';
import { readOpenCodePage, readOpenCodeModel } from '../providers/opencode.js';
import { readOpenCodeV2Page, readOpenCodeV2Model, openCodeV2Tools } from '../providers/openCodeV2.js';
import { databaseToolActivity, mergeToolActivity, transcriptToolActivity } from '../providers/toolActivity.js';

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
        const metadata = record.provider === 'codex' && row.type === 'session_meta' ? row.payload : ['claude','codebuddy'].includes(record.provider) ? row : null;
        const id = record.provider === 'codex' ? metadata?.id : metadata?.sessionId;
        if (id === record.providerThreadId && typeof metadata.cwd === 'string' && [record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(metadata.cwd)) === '')) return true;
      } catch { /* A partial or non-message record cannot establish provenance. */ }
    }
    return false;
  } finally { fs.closeSync(fd); }
}

/** Private local-command evidence, never public conversation. Start at the exact
 * owned transcript's current byte cursor so historical acknowledgements cannot confirm a new setting. */
export function codeBuddyCommandOutput(record: SessionRecord): () => string {
  const root = path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects');
  const file = record.provider === 'codebuddy' && record.providerThreadId ? findFile(root, record.providerThreadId, 1) : null;
  if (!file || !verifyJsonSession(file, record)) throw new CliError('RUNTIME_UNAVAILABLE', 'The exact CodeBuddy command history is not available yet. Use Terminal until its session is recorded.');
  const original = fs.statSync(file), offset = original.size;
  const initial = fs.openSync(file, 'r');
  const last = Buffer.alloc(1);
  let skipFirst = false;
  try { if (offset) { fs.readSync(initial, last, 0, 1, offset - 1); skipFirst = last[0] !== 10; } } finally { fs.closeSync(initial); }
  return () => {
    const fd = fs.openSync(file, 'r');
    try {
      const current = fs.fstatSync(fd), size = current.size - offset;
      if (current.dev !== original.dev || current.ino !== original.ino || size < 0 || size > 262144) throw new CliError('RUNTIME_UNAVAILABLE', 'CodeBuddy command history changed or exceeded its read limit. Inspect Terminal before retrying.');
      const buffer = Buffer.alloc(size); fs.readSync(fd, buffer, 0, size, offset);
      const lines = buffer.toString('utf8').split('\n');
      if (skipFirst) lines.shift();
      return lines.flatMap(line => {
        try {
          const row = JSON.parse(line);
          if (row.type !== 'message' || row.role !== 'user' || row.sessionId !== record.providerThreadId || row.providerData?.skipRun !== true
            || typeof row.cwd !== 'string' || ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')) return [];
          return Array.isArray(row.content) ? row.content.flatMap((part: any) => part?.type === 'input_text' && typeof part.text === 'string'
            && part.text.startsWith('<local-command-stdout>') && part.text.endsWith('</local-command-stdout>') ? [part.text.slice(22, -23)] : []) : [];
        } catch { return []; }
      }).join('\n');
    } finally { fs.closeSync(fd); }
  };
}

export function publicMessage(record: SessionRecord, line: string, sourceIdentity: string) {
  const visible = (message: ReturnType<typeof parseCoordinatorTranscriptLine>['message']) => {
    if (!message || message.role !== 'user' || !message.text.startsWith('[Vade workflow assignment; protocol 1.0.0]')) return message;
    if (!message.text.includes('\nYou are the orchestrator.')) return null;
    const marker = '\nOriginal user request:\n', start = message.text.indexOf(marker);
    return start < 0 ? null : { ...message, text: message.text.slice(start + marker.length) };
  };
  try {
    const row = JSON.parse(line);
    if (record.provider !== 'antigravity') {
      if (['claude','codebuddy'].includes(record.provider) && row.sessionId && row.sessionId !== record.providerThreadId) return null;
      return visible(parseCoordinatorTranscriptLine(line, record.provider, sourceIdentity).message);
    }
    if (['USER_EXPLICIT', 'USER'].includes(row.source) && ['USER_INPUT', 'REQUEST'].includes(row.type)) {
      return visible(parseAntigravityTranscriptLine(JSON.stringify({ ...row, type: 'USER_INPUT' }), sourceIdentity).message);
    }
    return row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' ? parseAntigravityTranscriptLine(line, sourceIdentity).message : null;
  } catch { return null; }
}

export class AdeConversations {
  watch(record: SessionRecord, changed: () => void): () => void {
    let watcher: fs.FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { file } = this.resolve(record);
      // Watch the parent so atomic transcript replacement is observed as well.
      watcher = fs.watch(path.dirname(file), (_event, name) => {
        if (name && ![path.basename(file), ...(isOpenCode(record.provider) ? [path.basename(file) + '-wal'] : [])].includes(name.toString())) return;
        clearTimeout(timer); timer = setTimeout(changed, 75);
      });
      watcher.on('error', () => { watcher?.close(); });
    } catch { /* A not-yet-bound transcript is discovered by the polling fallback. */ }
    return () => { clearTimeout(timer); watcher?.close(); };
  }
  private paths = new Map<string, string>();

  private resolve(record: SessionRecord): { file: string; root: string } {
    if (isOpenCode(record.provider)) { const file = verifyOpenCode(record); return { file, root: path.dirname(file) }; }
    if (!validCodexThreadId(record.providerThreadId)) throw new Error('No verified provider conversation binding');
    const id = record.providerThreadId;
    const agy = record.provider === 'antigravity';
    const root = agy ? process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli')
      : record.provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
      : record.provider === 'codebuddy' ? path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects')
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

  private metadataCache = new Map<string, { stamp: string; value: Awaited<ReturnType<AdeConversations['readMetadata']>> }>();
  private metadataPending = new Map<string, Promise<Awaited<ReturnType<AdeConversations['readMetadata']>>>>();
  async metadata(record: SessionRecord): Promise<Awaited<ReturnType<AdeConversations['readMetadata']>>> {
    // Antigravity also reads a separate database, so transcript stamps alone cannot cache it.
    if (record.provider === 'antigravity' || isOpenCode(record.provider)) return this.readMetadata(record);
    try {
      const { file } = this.resolve(record), stat = fs.statSync(file);
      const key = `${record.projectId}:${record.id}:${record.provider}:${record.providerThreadId}:${record.cwd}`;
      const stamp = `${file}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
      const cached = this.metadataCache.get(key); if (cached?.stamp === stamp) return cached.value;
      const pendingKey = `${key}:${stamp}`, previous = this.metadataPending.get(pendingKey); if (previous) return previous;
      const pending = this.readMetadata(record).then(value => {
        if (value.toolActivity.meta.availability === 'ready' || value.toolActivity.meta.availability === 'empty') {
          if (this.metadataCache.size >= 128) this.metadataCache.delete(this.metadataCache.keys().next().value!);
          this.metadataCache.set(key, { stamp, value });
        }
        return value;
      }).finally(() => this.metadataPending.delete(pendingKey));
      this.metadataPending.set(pendingKey, pending); return pending;
    } catch { return this.readMetadata(record); }
  }

  private async readMetadata(record: SessionRecord): Promise<{ preview: string | null; model: string | null; effort: string | null; toolActivity: Section<ToolActivity[]> }> {
    const now = new Date().toISOString();
    const result = { preview: null as string | null, model: null as string | null, effort: null as string | null, toolActivity: {
      data: null, meta: { availability: 'unavailable', attemptedAt: now, observedAt: null, partial: true, stale: false,
        issue: { code: 'RUNTIME_UNAVAILABLE', message: 'Metadata is not available for this exact provider session yet.', retryable: true } },
    } as Section<ToolActivity[]> };
    try {
      const { file, root } = this.resolve(record), id = record.providerThreadId!;
      const nativePage = record.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      const latest = isOpenCode(record.provider) ? nativePage(file, id, null, 1) : await readOlderTranscriptLines(file, fs.statSync(file).size, 1, 1024 * 1024, false,
        line => Boolean(publicMessage(record, line, id)));
      result.preview = latest.lines.length ? publicMessage(record, latest.lines[0], id)?.text.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
      let tools: ToolActivity[];
      if (isOpenCode(record.provider)) {
        Object.assign(result, (record.provider === 'opencode2' ? readOpenCodeV2Model : readOpenCodeModel)(file, id) ?? {});
        tools = (record.provider === 'opencode2' ? openCodeV2Tools : databaseToolActivity)(file, id);
      } else if (record.provider === 'antigravity') {
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
            if (record.provider === 'codebuddy') return { model: row.providerData?.model, effort: row.providerData?.effort };
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
      result.toolActivity = { data: mergeToolActivity(tools),
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
      if (cursor && (cursor.direction !== query.direction || (!isOpenCode(record.provider) && Number(cursor.upstreamCursor) > stat.size))) throw new CliError('INVALID_ARGUMENT', 'Conversation cursor direction or source changed');
      const parse = (line: string) => publicMessage(record, line, sourceIdentity);
      const database = isOpenCode(record.provider);
      const revision = database ? withOpenCode(record.provider as 'opencode' | 'opencode2' | 'kilo', db => {
        if (record.provider === 'opencode2') return String(db.prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 200)').get(id)?.updated ?? 0);
        const messages = db.prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT 200)').get(id);
        const parts = db.prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM part WHERE session_id = ? ORDER BY rowid DESC LIMIT 200)').get(id);
        return String(Math.max(Number(messages?.updated) || 0, Number(parts?.updated) || 0));
      }) : '';
      const databaseOffset = cursor ? Number(cursor.upstreamCursor.split(':')[0]) : null;
      const nativePage = record.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      let result = database ? nativePage(file, id, databaseOffset, Math.min(200, Math.max(1, query.limit ?? 20)), query.direction) : await (older || !cursor ? readOlderTranscriptLines : readBoundedTranscriptLines)(file, cursor ? Number(cursor.upstreamCursor) : stat.size,
        Math.min(200, Math.max(1, query.limit ?? 20)), 1024 * 1024, cursor?.seekingNewline ?? false, line => Boolean(parse(line)));
      if (database && cursor && !older && !result.lines.length && cursor.upstreamCursor.split(':')[1] !== revision) {
        const tail = nativePage(file, id, null, Math.min(20, query.limit ?? 20));
        result = { ...result, lines: tail.lines };
      }
      // Reuse unchanged forward cursors so idle streams do not exhaust the bounded cursor store.
      const offset = !older && !cursor && !isOpenCode(record.provider) ? stat.size : result.nextByteOffset;
      const upstreamCursor = database ? `${offset}:${revision}` : String(offset);
      const nextCursor = older && !result.hasMore ? null : cursor && upstreamCursor === cursor.upstreamCursor && Boolean(result.seekingNewline) === Boolean(cursor.seekingNewline) ? query.cursor! : issueStoredCursor({
        ...expected, upstreamCursor, direction: query.direction, sourceMode: isOpenCode(record.provider) ? 'opencode-db' : agy ? 'antigravity-transcript' : 'coordinator-transcript', seekingNewline: result.seekingNewline,
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
