import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Id,
  Node,
  Run,
  Section,
  ConversationPage,
  ConversationMessage,
  ToolActivity,
} from '../../shared/contracts.js';
import { toolActivityFromCall } from './toolActivity.js';
import { cleanErrorMessage } from '../integrations/cli.js';
import {
  hashId,
  stripAnsi,
  isGenericShellTitle,
  isSystemInjectedUserText,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
  readBoundedTranscriptLines,
  readOlderTranscriptLines,
  BoundedTranscriptReadResult,
  toIsoOrNull,
} from '../integrations/orca/utils.js';
import {
  globalSourceMaps,
  NodeSourceEntry,
  issueStoredCursor,
  validateStoredCursor,
} from '../integrations/orca/state.js';

// Verified against agy's bundled cortex.proto descriptors (2026-10-16):
// CortexStepGeneratorMetadata.planner_config = 3;
// CascadePlannerConfig.model_name = 28;
// CortexStepGeneratorMetadata.chat_model = 1;
// ChatModelMetadata.response_model = 19.
// Read only these fields; never search prompt/tool text for model names.
function protobufField(bytes: Uint8Array, field: number, scalar?: (field: number, value: number) => void): Uint8Array | null {
  let offset = 0;
  let value: Uint8Array | null = null;
  const varint = () => {
    let result = 0;
    let shift = 0;
    while (offset < bytes.length && shift < 56) {
      const byte = bytes[offset++];
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) {
        if (!Number.isSafeInteger(result)) throw new Error('Invalid protobuf integer');
        return result;
      }
      shift += 7;
    }
    throw new Error('Invalid protobuf varint');
  };
  while (offset < bytes.length) {
    const tag = varint();
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number < 1) throw new Error('Invalid protobuf field');
    if (wire === 0) {
      const integer = varint();
      scalar?.(number, integer);
    } else if (wire === 2) {
      const size = varint();
      if (offset + size > bytes.length) throw new Error('Invalid protobuf length');
      if (number === field) value = bytes.subarray(offset, offset + size);
      offset += size;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Invalid protobuf fixed field');
    } else {
      throw new Error('Unsupported protobuf wire type');
    }
  }
  return value;
}

/** Verified against bundled cortex.proto and codeium_common.proto in agy 2026-10-18.
 * CortexStepMetadata: created_at=1, tool_call=4, modified_tool_call=29.
 * ChatToolCall: id=1, name=2, arguments_json=3. All other fields are excluded.
 */
export function readAntigravityToolActivity(conversationId: string, allowed: (file: string) => boolean): ToolActivity[] {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(conversationId)) throw new Error('Invalid Antigravity conversation identity');
  const base = process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity-cli');
  const file = path.join(base, 'conversations', `${conversationId}.db`);
  if (!allowed(file)) throw new Error('Antigravity tool metadata is outside allowed provider directories');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(conversationId)) {
      throw new Error('Antigravity conversation identity changed');
    }
    const rows = db.prepare(`SELECT idx, CASE WHEN length(metadata) <= 524288 THEN metadata END AS metadata
      FROM steps ORDER BY idx DESC LIMIT 200`).all();
    let bytes = 0;
    const result: ToolActivity[] = [];
    for (const row of rows.reverse()) {
      if (!(row.metadata instanceof Uint8Array)) continue;
      bytes += row.metadata.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('Antigravity tool metadata exceeds byte limit');
      try {
        const call = protobufField(row.metadata, 29) ?? protobufField(row.metadata, 4);
        if (!call) continue;
        const text = (field: number) => {
          const value = protobufField(call, field);
          return value ? Buffer.from(value).toString('utf8') : '';
        };
        const name = text(2);
        if (!name) continue;
        const timestamp = protobufField(row.metadata, 1);
        let seconds: number | null = null, nanos = 0;
        if (timestamp) protobufField(timestamp, 0, (field, value) => {
          if (field === 1) seconds = value;
          if (field === 2) nanos = value;
        });
        const at = seconds === null ? null : Number(seconds) * 1000 + nanos / 1e6;
        const item = toolActivityFromCall(`antigravity:${conversationId}`, text(1) || `step:${row.idx}`, name, text(3), at);
        if (item) result.push(item);
      } catch { /* Ignore malformed individual rows; never guess from output or reasoning. */ }
    }
    return result;
  } finally { db.close(); }
}

export function readAntigravityModel(
  conversationId: string,
  isAllowedPath: (file: string) => boolean
): { model: string; effort: string | null } | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) return null;
  const base = process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity-cli');
  const file = path.join(base, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(file) || !isAllowedPath(file)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare('SELECT cascade_id FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(conversationId)) return null;
    const row = db.prepare(`
      SELECT CASE WHEN length(data) <= 2097152 THEN data ELSE NULL END AS data
      FROM gen_metadata ORDER BY idx DESC LIMIT 1
    `).get() as { data: Uint8Array | null } | undefined;
    if (!row?.data) return null;
    const planner = protobufField(row.data, 3);
    const modelBytes = planner ? protobufField(planner, 28) : null;
    const chat = modelBytes ? null : protobufField(row.data, 1);
    const responseBytes = chat ? protobufField(chat, 19) : null;
    const model = Buffer.from(modelBytes ?? responseBytes ?? []).toString('utf8').trim();
    if (!model || model.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) return null;
    // Antigravity's model list uses explicit effort presets in these IDs.
    const preset = modelBytes ? model.match(/^((?:gemini-|claude-|gpt-oss-).+)-(low|medium|high|xhigh|max)$/) : null;
    return preset ? { model: preset[1], effort: preset[2] } : { model, effort: null };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function unsupportedSection(message: string): Section<ConversationPage> {
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
        message,
        retryable: false,
      },
    },
  };
}

function extractCheckpointPrompt(appData: string, nodeSource?: NodeSourceEntry): string | null {
  const rawPtyId =
    nodeSource?.ptyId ||
    (nodeSource?.endpointIncarnation
      ? nodeSource.endpointIncarnation.slice(0, nodeSource.endpointIncarnation.lastIndexOf(':'))
      : null);
  if (!rawPtyId) return null;

  const cpPath = path.join(appData, 'orca', 'terminal-history', encodeURIComponent(rawPtyId), 'checkpoint.json');
  if (!fs.existsSync(cpPath)) return null;

  try {
    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    if (!cp.snapshotAnsi) return null;
    const cleanText = stripAnsi(cp.snapshotAnsi);
    const prompts = cleanText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^>\s+/.test(l) && !/^>\s+(Accept-edits|Reject-edits|Esc to|for shortcuts)/i.test(l))
      .map((l) => l.replace(/^>\s+/, '').trim());
    return prompts.length > 0 ? prompts[0] : null;
  } catch {
    return null;
  }
}

function matchVaultCacheSession(appData: string, searchTarget: string): { conversationId: string; title?: string; source: string } | null {
  const vaultCachePath = path.join(appData, 'orca', 'ai-vault', 'session-parse-cache.json');
  if (!fs.existsSync(vaultCachePath)) return null;

  try {
    const cache = JSON.parse(fs.readFileSync(vaultCachePath, 'utf-8'));
    if (!Array.isArray(cache.entries)) return null;
    const targetLower = searchTarget.toLowerCase().trim();

    for (const [, data] of cache.entries) {
      const s = data?.session;
      if (!s || s.agent !== 'antigravity' || !s.sessionId) continue;
      const sTitle = s.title ? s.title.toLowerCase().trim() : '';
      const sPrompt = s.lastUserPrompt ? s.lastUserPrompt.toLowerCase().trim() : '';
      if (
        sTitle === targetLower ||
        sPrompt === targetLower ||
        targetLower.includes(sTitle) ||
        (sTitle && targetLower.startsWith(sTitle.slice(0, 30)))
      ) {
        return { conversationId: s.sessionId, title: s.title || undefined, source: 'vault-cache' };
      }
    }
  } catch {}
  return null;
}

function matchSummariesDbSession(searchTarget: string): { conversationId: string; title?: string; source: string } | null {
  const geminiBase =
    process.env.GEMINI_APPDATA_DIR ||
    process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const summariesDbPath = path.join(geminiBase, 'conversation_summaries.db');
  if (!fs.existsSync(summariesDbPath)) return null;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(summariesDbPath, { readOnly: true });
    const targetLower = searchTarget.toLowerCase().trim();
    const rows = db
      .prepare('SELECT conversation_id, title, preview FROM conversation_summaries ORDER BY last_modified_time DESC')
      .all() as any[];

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
  return null;
}

// Helper to locate Antigravity session conversation ID from hooks, labels, terminal history checkpoints, or vault cache
export function findAntigravityConversationId(
  node: Node,
  nodeSource?: NodeSourceEntry
): { conversationId: string; title?: string; worktreeId?: string; source: string } | null {
  const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
  const lastStatusPath = path.join(appData, 'orca', 'agent-hooks', 'last-status.json');

  // 1. Direct match in last-status.json by paneKey (live running session)
  if (nodeSource?.paneKey && fs.existsSync(lastStatusPath)) {
    try {
      const statusData = JSON.parse(fs.readFileSync(lastStatusPath, 'utf-8'));
      const entry = statusData.entries?.[nodeSource.paneKey];
      if (
        entry?.source === 'antigravity' &&
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

  // 3. Clean label or extract prompt from terminal history checkpoint
  const cleanLabel = (node?.label || '')
    .replace(/^✳\s*/, '')
    .replace(/^(?:antigravity|agy)\s*\|\s*/i, '')
    .split(/\s*\|\s*/)[0]
    .trim();
  const isGenericLabel =
    !cleanLabel ||
    ['antigravity', 'agent', 'worker', 'coordinator', 'cmd.exe', 'powershell', 'bash', 'zsh', 'terminal'].some((g) =>
      cleanLabel.toLowerCase().startsWith(g)
    );

  const searchTarget = (!isGenericLabel ? cleanLabel : null) || extractCheckpointPrompt(appData, nodeSource);
  if (!searchTarget) return null;

  // 4. Search in Orca AI Vault session parse cache or Antigravity conversation_summaries.db
  return matchVaultCacheSession(appData, searchTarget) || matchSummariesDbSession(searchTarget);
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

export function parseAntigravityTranscriptLine(
  line: string,
  opaqueSourceIdentity: string
): { message: ConversationMessage | null; omitted: boolean } {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'USER_INPUT') {
      let text = typeof obj.content === 'string' ? obj.content : '';
      if (text.includes('<USER_REQUEST>')) {
        const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (match) text = match[1].trim();
      }
      const trimmed = text.trim();
      if (!trimmed || isSystemInjectedUserText(trimmed, true)) {
        return { message: null, omitted: true };
      }
      const msgId = hashId('msg', `${opaqueSourceIdentity}:${obj.step_index ?? hashId('record', line)}`);
      return {
        message: {
          id: msgId,
          role: 'user',
          text: trimmed,
          at: toIsoOrNull(obj.created_at),
        },
        omitted: false,
      };
    }

    if (obj.type === 'PLANNER_RESPONSE') {
      const text = typeof obj.content === 'string' ? obj.content.trim() : '';
      if (!text) {
        return { message: null, omitted: true };
      }
      const msgId = hashId('msg', `${opaqueSourceIdentity}:${obj.step_index ?? hashId('record', line)}`);
      return {
        message: {
          id: msgId,
          role: 'agent',
          text,
          at: toIsoOrNull(obj.created_at),
        },
        omitted: false,
      };
    }

    return { message: null, omitted: true };
  } catch {
    return { message: null, omitted: true };
  }
}

function verifyAntigravityCascadeDb(geminiBase: string, conversationId: string): boolean {
  const convDbPath = path.join(geminiBase, 'conversations', `${conversationId}.db`);
  if (!fs.existsSync(convDbPath)) return true;

  let cdb: DatabaseSync | null = null;
  try {
    cdb = new DatabaseSync(convDbPath, { readOnly: true });
    const row: any = cdb.prepare('SELECT cascade_id FROM trajectory_meta WHERE cascade_id = ?').get(conversationId);
    return Boolean(row && row.cascade_id === conversationId);
  } catch {
    return true;
  } finally {
    try { cdb?.close(); } catch {}
  }
}

// Helper to resolve Antigravity conversation transcript via proven hook session
export async function resolveAntigravityConversation(
  projectId: Id,
  node: Node,
  activeRun: Run | null,
  options?: { cursor?: string | null; direction?: 'older'; limit?: number }
): Promise<Section<ConversationPage>> {
  if (node.runId && activeRun?.id && node.runId !== activeRun.id) {
    return unsupportedSection(`Node runId ${node.runId} does not match active run ${activeRun.id}`);
  }

  const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
  const resolved = findAntigravityConversationId(node, nodeSource);
  if (!resolved) {
    return unsupportedSection('Agent transcript provenance not found or unsupported');
  }

  const { conversationId, worktreeId = null } = resolved;
  if (
    resolved.title &&
    (isGenericShellTitle(node.label) || ['agent', 'antigravity', 'terminal'].some((g) => node.label.toLowerCase().startsWith(g)))
  ) {
    node.label = resolved.title;
  }

  // Validate workspace if both worktreeId and node.worktreeId exist
  if (worktreeId && node.worktreeId) {
    const normEntryWt = path.normalize(worktreeId).toLowerCase();
    const normNodeWt = path.normalize(node.worktreeId).toLowerCase();
    if (normEntryWt !== normNodeWt && worktreeId !== node.worktreeId) {
      return unsupportedSection('Antigravity session workspace mismatch');
    }
  }

  const geminiBase =
    process.env.GEMINI_APPDATA_DIR ||
    process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity-cli');

  if (!verifyAntigravityCascadeDb(geminiBase, conversationId)) {
    return unsupportedSection('Antigravity conversation database trajectory cascade ID mismatch');
  }

  const transcriptPath = path.join(geminiBase, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return unsupportedSection(
      'Antigravity binary protobuf trajectory decoder unavailable without schema definition; vendor transcript log not found.'
    );
  }

  try {
    if (!fs.statSync(transcriptPath).isFile()) {
      throw new Error('Not a regular file');
    }
  } catch {
    return unsupportedSection('Antigravity transcript file is not a valid regular file');
  }

  if (!isPathInsideRoots(transcriptPath, getAllowedTranscriptRoots())) {
    return unsupportedSection('Antigravity transcript path is outside allowed provider directories');
  }

  const opaqueSourceIdentity = hashId('src', conversationId);
  let startOffset: number | null = null;
  let seekingNewline = false;
  if (options?.cursor) {
    const stored = validateStoredCursor(options.cursor, {
      projectId,
      nodeId: node.id,
      runId: activeRun?.id ?? null,
      sourceIdentity: opaqueSourceIdentity,
    });
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
      readResult = await (options?.direction === 'older' ? readOlderTranscriptLines : readBoundedTranscriptLines)(
        transcriptPath,
        currentOffset,
        options?.direction === 'older' ? limit - normalizedMessages.length : limit,
        8 * 1024 * 1024,
        currentSeeking,
        options?.direction === 'older' ? line => Boolean(parseAntigravityTranscriptLine(line, opaqueSourceIdentity).message) : isAntigravityChatRecord
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

    const previousCount = normalizedMessages.length;
    for (const line of readResult.lines) {
      const { message, omitted } = parseAntigravityTranscriptLine(line, opaqueSourceIdentity);
      if (omitted) omittedContent = true;
      if (message) {
        normalizedMessages.push(message);
        if (normalizedMessages.length >= limit) break;
      }
    }

    if (options?.direction === 'older' && previousCount) normalizedMessages.unshift(...normalizedMessages.splice(previousCount));

    if (normalizedMessages.length >= limit || !readResult.hasMore) {
      break;
    }
  }

  const finalReadResult = lastReadResult!;
  const hasMore = Boolean(finalReadResult?.hasMore);
  const limited = Boolean(finalReadResult?.limited) || (loopCount >= MAX_PAGE_ITERATIONS && normalizedMessages.length < limit);

  let publicNextCursor: string | null = null;
  if (finalReadResult && (options?.direction === 'older' ? hasMore : !(options?.cursor && normalizedMessages.length === 0 && !hasMore))) {
    publicNextCursor = issueStoredCursor({
      upstreamCursor: String(finalReadResult.nextByteOffset),
      direction: options?.direction,
      projectId,
      nodeId: node.id,
      runId: activeRun?.id ?? null,
      dispatchId: '',
      sourceIdentity: opaqueSourceIdentity,
      sourceMode: 'antigravity-transcript',
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
