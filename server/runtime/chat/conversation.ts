import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentContextUsage,
  ConversationPage,
  ConversationRound,
  NodeDetailsQuery,
  ProviderActivity,
  RewindConversationRequest,
  Section,
  ToolActivity,
} from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { readAntigravityModel, readAntigravityToolActivity } from '../../providers/antigravity/antigravity.js';
import { claudeAutoCompactWindows } from '../../providers/claude/claudeSettings.js';
import { isContextRecord, transcriptContextUsage, unknownContext } from '../../providers/common/contextUsage.js';
import { issueStoredCursor, validateStoredCursor } from '../../providers/common/conversationCursors.js';
import {
  CONVERSATION_PAGE_READ_BYTES,
  imageContentDigest,
  MAX_CONVERSATION_PAGE_IMAGE_BYTES,
  readRecordAt,
  readRecordedImage,
  recordedUserImages,
  recordsTranscriptImages,
  verifyConversationImageId,
} from '../../providers/common/conversationImages.js';
import { openCodeRecordedLine, readOpenCodeModel, readOpenCodePage } from '../../providers/opencode/opencode.js';
import { openCodeV2RecordedLine, openCodeV2Tools, readOpenCodeV2Model, readOpenCodeV2Page } from '../../providers/opencode/openCodeV2.js';
import { databaseProviderActivity, transcriptProviderActivity } from '../../providers/common/providerActivity.js';
import { claudeLocalCommandEffort, claudeLocalCommandModel, transcriptSettings } from '../../providers/common/shared.js';
import { databaseToolActivity, mergeToolActivity, transcriptToolActivity } from '../../providers/common/toolActivity.js';
import { hashId, isPathInsideRoots, readBoundedTranscriptLines, readOlderTranscriptLines } from '../../providers/common/transcriptUtils.js';
import { publicMessage } from './publicProjection.js';
import {
  claudeSettingConfirmation,
  codeBuddyCommandOutput,
  codeBuddyRecordedSettings,
  codexRecordedUserAnchors,
  findTranscriptFile,
  verifyJsonSession,
} from './transcriptHelpers.js';
import { forkClaudeBefore } from '../../providers/claude/claudeRewind.js';
import { codeBuddyBranch } from '../../providers/codebuddy/codeBuddyBranch.js';
import { validCodexThreadId } from '../../providers/codex/codexThread.js';
import {
  antigravityNativeRounds,
  claudeNativeRounds,
  codeBuddyNativeRounds,
  codexNativeRounds,
  dshNativeRounds,
  mergeConversationRounds,
  nativeRoundRows,
  openCodeNativeRounds,
  openCodeV2NativeRounds,
} from './conversationRounds.js';
import { dshTranscript } from '../../providers/dsh/dsh.js';
import { isOpenCode, verifyOpenCode, withOpenCode } from '../../providers/opencode/openCodeSessions.js';
import { readDatabaseContext } from '../../providers/common/providerContext.js';
import { publicRewindTarget } from './controls/providerRewind.js';
import { readStagedUserImage, stagedUserImages } from './stagedConversationImages.js';
import type { SessionRecord } from '../store.js';

export {
  claudeSettingConfirmation,
  codeBuddyCommandOutput,
  codeBuddyRecordedSettings,
  codexRecordedUserAnchors,
  publicMessage,
};

function unavailable(message: string): Section<ConversationPage> {
  return {
    data: null,
    meta: {
      availability: 'unavailable',
      observedAt: null,
      attemptedAt: new Date().toISOString(),
      partial: false,
      stale: false,
      issue: { code: 'RUNTIME_UNAVAILABLE', message, retryable: true },
    },
  };
}

export class AdeConversations {
  private roundCache = new Map<string, { stamp: string; rounds: ConversationRound[] }>();

  private nativeRounds(record: SessionRecord, file: string, source: string, stat: fs.Stats) {
    if (!['claude', 'codex', 'antigravity', 'codebuddy', 'dsh', 'opencode', 'opencode2', 'kilo'].includes(record.provider)) return [];
    let stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (isOpenCode(record.provider)) {
      stamp += [file + '-wal', file + '-shm']
        .map(candidate => {
          try {
            const value = fs.statSync(candidate);
            return `:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
          } catch {
            return ':0';
          }
        })
        .join('');
    }
    const cached = this.roundCache.get(source);
    if (cached?.stamp === stamp) return cached.rounds;
    let rounds: ConversationRound[];
    if (isOpenCode(record.provider)) {
      rounds = (record.provider === 'opencode2' ? openCodeV2NativeRounds : openCodeNativeRounds)(file, record.providerThreadId!, source);
    } else {
      const rows = nativeRoundRows(file, stat.size);
      const filtered = record.provider === 'codebuddy' ? rows.filter(line => codeBuddyBranch(file, record.providerThreadId!).allows(line)) : rows;
      rounds =
        record.provider === 'claude'
          ? claudeNativeRounds(record.providerThreadId!, filtered, source)
          : record.provider === 'codex'
            ? codexNativeRounds(record.providerThreadId!, filtered, source)
            : record.provider === 'antigravity'
              ? antigravityNativeRounds(filtered, source)
              : record.provider === 'codebuddy'
                ? codeBuddyNativeRounds(record.providerThreadId!, filtered, source)
                : dshNativeRounds(record.providerThreadId!, filtered, source);
    }
    if (this.roundCache.size >= 32) this.roundCache.delete(this.roundCache.keys().next().value!);
    this.roundCache.set(source, { stamp, rounds });
    return rounds;
  }

  constructor(
    private directory = process.env.ADE_DATA_DIR || path.join(os.homedir(), '.ade'),
    private nativeRewindAvailable: (record: SessionRecord) => boolean = () => false,
    private savedRounds: (record: SessionRecord) => ConversationRound[] = () => [],
  ) {}

  watch(record: SessionRecord, changed: () => void): () => void {
    let watcher: fs.FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { file } = this.resolve(record);
      watcher = fs.watch(path.dirname(file), (_event, name) => {
        if (name && ![path.basename(file), ...(isOpenCode(record.provider) ? [path.basename(file) + '-wal'] : [])].includes(name.toString())) return;
        clearTimeout(timer);
        timer = setTimeout(changed, 75);
      });
      watcher.on('error', () => { watcher?.close(); });
    } catch { /* A not-yet-bound transcript is discovered by the polling fallback. */ }
    return () => { clearTimeout(timer); watcher?.close(); };
  }

  private paths = new Map<string, string>();

  resumeAvailable(record: SessionRecord): boolean {
    if (record.provider === 'terminal') return false;
    try {
      this.resolve(record);
      return true;
    } catch {
      return false;
    }
  }

  private resolve(record: SessionRecord): { file: string; root: string } {
    if (record.provider === 'dsh') return dshTranscript(this.directory, record);
    if (isOpenCode(record.provider)) {
      const file = verifyOpenCode(record);
      return { file, root: path.dirname(file) };
    }
    if (!validCodexThreadId(record.providerThreadId)) throw new Error('No verified provider conversation binding');
    const id = record.providerThreadId;
    const agy = record.provider === 'antigravity';
    const root = agy
      ? process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli')
      : record.provider === 'codex'
        ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
        : record.provider === 'codebuddy'
          ? path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects')
          : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const key = `${root}:${record.provider}:${id}:${record.cwd}`;
    let file = this.paths.get(key);
    if (!file || !fs.existsSync(file)) {
      file = agy
        ? path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
        : findTranscriptFile(root, id, record.provider === 'codex' ? 3 : 1) ?? undefined;
    }
    if (!file || !isPathInsideRoots(file, [root])) throw new Error('No exact provider transcript');
    if (agy) {
      const database = path.join(root, 'conversations', `${id}.db`);
      if (!isPathInsideRoots(database, [root])) throw new Error('Antigravity conversation database is unavailable');
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(id)) {
          throw new Error('Antigravity conversation identity does not match');
        }
      } finally {
        db.close();
      }
    } else if (!verifyJsonSession(file, record)) {
      throw new Error('Transcript session or workspace does not match this agent');
    }
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Provider transcript is not a regular file');
    if (this.paths.size >= 200) this.paths.delete(this.paths.keys().next().value!);
    this.paths.set(key, file);
    return { file, root };
  }

  private metadataCache = new Map<string, { stamp: string; value: Awaited<ReturnType<AdeConversations['readMetadata']>> }>();
  private metadataPending = new Map<string, Promise<Awaited<ReturnType<AdeConversations['readMetadata']>>>>();

  async metadata(record: SessionRecord): Promise<Awaited<ReturnType<AdeConversations['readMetadata']>>> {
    if (record.provider === 'antigravity' || isOpenCode(record.provider)) return this.readMetadata(record);
    try {
      const { file } = this.resolve(record);
      const stat = fs.statSync(file);
      const key = `${record.projectId}:${record.id}:${record.provider}:${record.providerThreadId}:${record.cwd}`;
      const stamp = `${file}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
      const cached = this.metadataCache.get(key);
      if (cached?.stamp === stamp) return cached.value;
      const pendingKey = `${key}:${stamp}`;
      const previous = this.metadataPending.get(pendingKey);
      if (previous) return previous;
      const pending = this.readMetadata(record)
        .then(value => {
          if (value.toolActivity.meta.availability === 'ready' || value.toolActivity.meta.availability === 'empty') {
            if (this.metadataCache.size >= 128) this.metadataCache.delete(this.metadataCache.keys().next().value!);
            this.metadataCache.set(key, { stamp, value });
          }
          return value;
        })
        .finally(() => this.metadataPending.delete(pendingKey));
      this.metadataPending.set(pendingKey, pending);
      return pending;
    } catch {
      return this.readMetadata(record);
    }
  }

  private async readMetadata(record: SessionRecord): Promise<{
    preview: string | null;
    model: string | null;
    effort: string | null;
    contextUsage: AgentContextUsage;
    toolActivity: Section<ToolActivity[]>;
    providerActivity: Section<ProviderActivity[]>;
  }> {
    const now = new Date().toISOString();
    const result = {
      preview: null as string | null,
      model: null as string | null,
      effort: null as string | null,
      contextUsage: unknownContext(record.provider),
      providerActivity: {
        data: null,
        meta: { availability: 'unavailable', attemptedAt: now, observedAt: null, partial: true, stale: false, issue: null },
      } as Section<ProviderActivity[]>,
      toolActivity: {
        data: null,
        meta: {
          availability: 'unavailable',
          attemptedAt: now,
          observedAt: null,
          partial: true,
          stale: false,
          issue: { code: 'RUNTIME_UNAVAILABLE', message: 'Metadata is not available for this exact provider session yet.', retryable: true },
        },
      } as Section<ToolActivity[]>,
    };
    try {
      const { file, root } = this.resolve(record);
      const id = record.providerThreadId!;
      const nativeBranch = record.provider === 'codebuddy' ? codeBuddyBranch(file, id) : null;
      const allowed = (line: string) => nativeBranch?.allows(line) ?? true;
      const nativePage = record.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      const latest = isOpenCode(record.provider)
        ? nativePage(file, id, null, 1)
        : await readOlderTranscriptLines(
            file,
            fs.statSync(file).size,
            1,
            recordsTranscriptImages(record.provider) ? CONVERSATION_PAGE_READ_BYTES : 1024 * 1024,
            false,
            line => {
              const message = allowed(line) ? publicMessage(record, line, id) : null;
              return Boolean(message && !message.kind);
            },
          );
      result.preview = latest.lines.length
        ? publicMessage(record, latest.lines[0], id, latest.offsets?.[0])?.text.replace(/\s+/g, ' ').trim().slice(0, 300) || null
        : null;
      let tools: ToolActivity[];
      if (isOpenCode(record.provider)) {
        result.contextUsage = { ...readDatabaseContext(record, file), cacheAccounting: 'separate' };
        Object.assign(result, (record.provider === 'opencode2' ? readOpenCodeV2Model : readOpenCodeModel)(file, id) ?? {});
        tools = (record.provider === 'opencode2' ? openCodeV2Tools : databaseToolActivity)(file, id);
        const data = databaseProviderActivity(file, id, record.provider === 'opencode2');
        result.providerActivity = { data, meta: { availability: data.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null } };
      } else if (record.provider === 'antigravity') {
        const allowedPath = (candidate: string) => isPathInsideRoots(candidate, [root]);
        const contextFile = path.join(root, 'conversations', `${id}.db`);
        if (allowedPath(contextFile)) result.contextUsage = readDatabaseContext(record, contextFile);
        const model = readAntigravityModel(id, allowedPath);
        if (model) Object.assign(result, model);
        tools = readAntigravityToolActivity(id, allowedPath);
        result.providerActivity.meta.availability = 'unsupported';
      } else {
        const contextRows = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 4 * 1024 * 1024, false, line => allowed(line) && isContextRecord(line));
        result.contextUsage = transcriptContextUsage(
          record.provider,
          id,
          contextRows.lines,
          record.provider === 'claude' ? { claudeAutoCompact: claudeAutoCompactWindows() } : undefined,
        );
        const settings = (line: string) => {
          if (!allowed(line)) return {};
          try {
            const row = JSON.parse(line);
            if (row.sessionId && row.sessionId !== id) return {};
            if (record.provider === 'codex' || record.provider === 'dsh') {
              return row.type === 'turn_context' ? { model: row.payload?.model, effort: row.payload?.effort } : {};
            }
            if (record.provider === 'codebuddy') return { model: row.providerData?.model, effort: row.providerData?.effort };
            const effort = record.provider === 'claude' ? claudeLocalCommandEffort(row) : undefined;
            const model = record.provider === 'claude' ? claudeLocalCommandModel(row) : undefined;
            return { ...transcriptSettings(row), ...(effort ? { effort } : {}), ...(model ? { model } : {}) };
          } catch {
            return {};
          }
        };
        const recent = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 4 * 1024 * 1024, false, line => Boolean(settings(line).model || settings(line).effort));
        for (const line of recent.lines) {
          const observed = settings(line);
          if (typeof observed.model === 'string' && observed.model.length <= 200 && observed.model !== '<synthetic>') {
            if (result.model !== observed.model) result.effort = null;
            result.model = observed.model;
          }
          if (typeof observed.effort === 'string' && observed.effort.length <= 80) result.effort = observed.effort;
        }
        const activity = await readBoundedTranscriptLines(file, null, 200, 512 * 1024, false, line => allowed(line) && transcriptToolActivity(record.provider, id, line).length > 0);
        tools = activity.lines.flatMap(line => transcriptToolActivity(record.provider, id, line));
        const events = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 512 * 1024, false, allowed);
        const data = transcriptProviderActivity(record.provider, id, events.lines);
        result.providerActivity = { data, meta: { availability: data.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null } };
        if (record.provider === 'codebuddy') {
          const records = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 4 * 1024 * 1024, false, line => {
            if (!allowed(line)) return false;
            try {
              const row = JSON.parse(line);
              return Boolean(
                row.providerData?.model ||
                  row.providerData?.effort ||
                  (row.providerData?.skipRun === true &&
                    Array.isArray(row.content) &&
                    row.content.some((part: any) => part?.type === 'input_text' && typeof part.text === 'string' && /^(?:<command-name>\/?model<\/command-name>|<local-command-stdout>)/.test(part.text))),
              );
            } catch {
              return false;
            }
          });
          Object.assign(result, codeBuddyRecordedSettings(records.lines, record));
        }
      }
      result.toolActivity = {
        data: mergeToolActivity(tools),
        meta: { availability: tools.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null },
      };
    } catch { /* Missing exact-session evidence remains explicitly unavailable. */ }
    return result;
  }

  async rewindTarget(record: SessionRecord, request: RewindConversationRequest) {
    if (!['dsh', 'claude', 'codex'].includes(record.provider) || (record.provider === 'codex' && !this.nativeRewindAvailable(record))) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This terminal provider does not expose verified native rewind.');
    }
    const page = (await this.read(record, { direction: 'older', limit: 1 })).data;
    if (!page || page.sourceIdentity !== request.sourceIdentity || page.revision !== request.revision) {
      throw new CliError('INVALID_ARGUMENT', 'Conversation changed. Refresh before rewinding.');
    }
    const { file } = this.resolve(record);
    const stat = fs.statSync(file);
    if (record.provider === 'claude' && stat.size > 16 * 1024 * 1024) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This transcript exceeds the bounded native rewind limit.');
    }
    if (hashId('rev', `${page.sourceIdentity}:${stat.size}:${stat.mtimeMs}`) !== request.revision) {
      throw new CliError('INVALID_ARGUMENT', 'Conversation changed. Refresh before rewinding.');
    }
    const current = () => {
      const next = fs.statSync(file);
      return next.size === stat.size && next.mtimeMs === stat.mtimeMs && next.ino === stat.ino;
    };
    const rows = await readOlderTranscriptLines(file, stat.size, 2000, 16 * 1024 * 1024, false, line => {
      if (record.provider === 'codex') {
        try {
          const row = JSON.parse(line);
          if (row.type === 'event_msg' && (['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type) || (row.payload?.type === 'item_completed' && row.payload.item?.type === 'UserMessage'))) {
            return true;
          }
        } catch {}
      }
      const message = publicMessage(record, line, page.sourceIdentity);
      return Boolean(message && (message.rewindable || (record.provider === 'codex' && message.role === 'user' && publicRewindTarget('codex', line, page.sourceIdentity))));
    });
    if (!current()) throw new CliError('INVALID_ARGUMENT', 'Conversation changed. Refresh before rewinding.');
    for (const line of rows.lines) {
      const message = publicMessage(record, line, page.sourceIdentity);
      if (message?.id !== request.messageId || message.role !== 'user' || (record.provider !== 'codex' && !message.rewindable)) continue;
      const row = JSON.parse(line);
      if (
        recordedUserImages(record.provider, line, page.sourceIdentity, 0).images.length ||
        stagedUserImages(record.provider, line, path.join(this.directory, 'attachments'), page.sourceIdentity, 0).images.length
      ) {
        throw new CliError('RUNTIME_UNAVAILABLE', 'Messages with image attachments cannot be restored as text-only drafts.');
      }
      if (record.provider === 'codex') {
        const native = publicRewindTarget('codex', line, page.sourceIdentity);
        if (!native || native.messageId !== message.id || row.payload?.content?.some((part: any) => !['input_text', 'text'].includes(part?.type))) break;
        const anchor = codexRecordedUserAnchors(rows.lines, page.sourceIdentity).get(message.id);
        if (!anchor) throw new CliError('RUNTIME_UNAVAILABLE', 'This message has no unambiguous recorded native UserMessage boundary. Use Terminal to rewind.');
        return { anchor, message: message.text, current };
      }
      if (record.provider === 'claude') {
        const anchor = publicRewindTarget('claude', line, page.sourceIdentity)?.anchor;
        if (!anchor) break;
        return { message: message.text, current, materialize: () => forkClaudeBefore(file, record.providerThreadId!, anchor.nativeId, current) };
      }
      if (typeof row.payload?.id !== 'string' || row.payload.id.length > 200) break;
      return { beforeSeq: row.payload.nativeSeq as number, beforeMessageId: row.payload.id as string, message: message.text, current };
    }
    throw new CliError('INVALID_ARGUMENT', 'This public message is not an available native rewind target.');
  }

  private identity(record: SessionRecord, file: string): string {
    const stat = fs.statSync(file);
    const branch = record.provider === 'codebuddy' ? codeBuddyBranch(file, record.providerThreadId!).epoch : '';
    return hashId(
      'src',
      `${record.projectId}:${record.id}:${record.cwd}:${record.provider}:${record.providerThreadId}:${fs.realpathSync(file)}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}${record.provider === 'codebuddy' ? ':' + branch : ''}`,
    );
  }

  image(record: SessionRecord, sourceIdentity: string, id: string): { mimeType: string; bytes: Buffer } {
    const locator = verifyConversationImageId(id, sourceIdentity);
    if (!locator) throw new CliError('INVALID_ARGUMENT', 'This conversation image is not available.');
    const { file } = this.resolve(record);
    if (this.identity(record, file) !== sourceIdentity) {
      throw new CliError('INVALID_ARGUMENT', 'Conversation changed. Reload the conversation before opening its images.');
    }
    const line = isOpenCode(record.provider)
      ? record.provider === 'opencode2'
        ? openCodeV2RecordedLine(file, record.providerThreadId!, locator.offset)
        : openCodeRecordedLine(file, record.providerThreadId!, locator.offset)
      : readRecordAt(file, locator.offset);
    if (line && record.provider === 'codebuddy' && !codeBuddyBranch(file, record.providerThreadId!).allows(line)) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This image is not in the active conversation branch.');
    }
    const attachmentRoot = path.join(this.directory, 'attachments');
    const message = line ? publicMessage(record, line, sourceIdentity, locator.offset, undefined, attachmentRoot) : null;
    if (message?.role !== 'user' || !message.images?.some(image => image.id === id)) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This recorded image changed or is no longer part of the public session.');
    }
    const image = line
      ? readRecordedImage(record.provider, line, locator.index) ?? readStagedUserImage(record.provider, line, attachmentRoot, locator.index)
      : null;
    if (!image) throw new CliError('RUNTIME_UNAVAILABLE', 'This recorded image is no longer available.');
    if (imageContentDigest(image.bytes.toString('base64')) !== locator.contentDigest) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This recorded image changed. Reload the conversation before opening it.');
    }
    return image;
  }

  async read(record: SessionRecord, query: NodeDetailsQuery = {}): Promise<Section<ConversationPage>> {
    try {
      const { file } = this.resolve(record);
      const id = record.providerThreadId!;
      const agy = record.provider === 'antigravity';
      const stat = fs.statSync(file);
      const sourceIdentity = this.identity(record, file);
      const older = query.direction === 'older';
      const expected = { projectId: record.projectId, nodeId: record.id, runId: null, sourceIdentity };
      const cursor = query.cursor ? validateStoredCursor(query.cursor, expected) : null;
      if (cursor && (cursor.direction !== query.direction || (!isOpenCode(record.provider) && Number(cursor.upstreamCursor) > stat.size))) {
        throw new CliError('INVALID_ARGUMENT', 'Conversation cursor direction or source changed');
      }
      const branch = record.provider === 'codebuddy' ? codeBuddyBranch(file, id) : null;
      const parse = (line: string) => (branch && !branch.allows(line) ? null : publicMessage(record, line, sourceIdentity));
      const imageBudget = { remaining: MAX_CONVERSATION_PAGE_IMAGE_BYTES };
      const project = (line: string, offset?: number) => {
        if (branch && !branch.allows(line)) return null;
        const message = publicMessage(record, line, sourceIdentity, offset, imageBudget, path.join(this.directory, 'attachments'));
        if (
          record.provider === 'codex' &&
          this.nativeRewindAvailable(record) &&
          message?.role === 'user' &&
          !message.images?.length &&
          publicRewindTarget('codex', line, sourceIdentity)?.messageId === message.id
        ) {
          const row = JSON.parse(line);
          if (!row.payload?.content?.some((part: any) => !['input_text', 'text'].includes(part?.type))) return { ...message, rewindable: true };
        }
        return message;
      };
      const database = isOpenCode(record.provider);
      const revision = database
        ? withOpenCode(record.provider as 'opencode' | 'opencode2' | 'kilo', db => {
            if (record.provider === 'opencode2') {
              return String(
                db
                  .prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 200)')
                  .get(id)?.updated ?? 0,
              );
            }
            const messages = db
              .prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT 200)')
              .get(id);
            const parts = db
              .prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM part WHERE session_id = ? ORDER BY rowid DESC LIMIT 200)')
              .get(id);
            return String(Math.max(Number(messages?.updated) || 0, Number(parts?.updated) || 0));
          })
        : '';
      const databaseOffset = cursor ? Number(cursor.upstreamCursor.split(':')[0]) : null;
      const nativePage = record.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      const pageBytes = recordsTranscriptImages(record.provider) ? CONVERSATION_PAGE_READ_BYTES : 1024 * 1024;
      let result = database
        ? nativePage(file, id, databaseOffset, Math.min(200, Math.max(1, query.limit ?? 20)), query.direction)
        : await (older || !cursor ? readOlderTranscriptLines : readBoundedTranscriptLines)(
            file,
            cursor ? Number(cursor.upstreamCursor) : stat.size,
            Math.min(200, Math.max(1, query.limit ?? 20)),
            pageBytes,
            cursor?.seekingNewline ?? false,
            line => Boolean(parse(line)),
          );
      if (database && cursor && !older && !result.lines.length && cursor.upstreamCursor.split(':')[1] !== revision) {
        const tail = nativePage(file, id, null, Math.min(20, query.limit ?? 20));
        result = { ...result, lines: tail.lines };
      }
      const offset = !older && !cursor && !isOpenCode(record.provider) ? stat.size : result.nextByteOffset;
      const upstreamCursor = database ? `${offset}:${revision}` : String(offset);
      const nextCursor =
        older && !result.hasMore
          ? null
          : cursor && upstreamCursor === cursor.upstreamCursor && Boolean(result.seekingNewline) === Boolean(cursor.seekingNewline)
            ? query.cursor!
            : issueStoredCursor({
                ...expected,
                upstreamCursor,
                direction: query.direction,
                sourceMode: isOpenCode(record.provider) ? 'opencode-db' : agy ? 'antigravity-transcript' : 'coordinator-transcript',
                seekingNewline: result.seekingNewline,
              });
      const messages = result.lines.flatMap((line, index) => {
        const message = project(line, result.offsets?.[index]);
        return message ? [message] : [];
      });
      const rounds = mergeConversationRounds(this.savedRounds(record), this.nativeRounds(record, file, sourceIdentity, stat));
      const now = new Date().toISOString();
      return {
        data: {
          messages,
          rounds,
          source: 'transcript',
          sourceIdentity,
          ...(['dsh', 'claude'].includes(record.provider) || (record.provider === 'codex' && this.nativeRewindAvailable(record))
            ? { revision: hashId('rev', `${sourceIdentity}:${stat.size}:${stat.mtimeMs}`) }
            : {}),
          provider: record.provider,
          cursor: query.cursor ?? null,
          nextCursor,
          limited: result.hasMore || result.limited || record.provider === 'dsh' || Boolean(branch?.limited),
          truncated: false,
          warnings:
            record.provider === 'dsh'
              ? ['DSH history is a bounded public projection of this Vade-owned session.']
              : branch?.limited
                ? ['CodeBuddy active history is limited to the bounded native branch window.']
                : [],
        },
        meta: {
          availability: messages.length ? 'ready' : 'empty',
          observedAt: now,
          attemptedAt: now,
          partial: result.hasMore || result.limited,
          stale: false,
          issue: null,
        },
      };
    } catch (error) {
      if (error instanceof CliError) throw error;
      return unavailable('The exact provider transcript cannot be read yet. Use Terminal and retry after a recorded conversation turn.');
    }
  }
}
