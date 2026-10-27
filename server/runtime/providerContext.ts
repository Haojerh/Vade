import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentContextUsage } from '../../shared/contracts.js';
import { isPathInsideRoots, toIsoOrNull } from '../providers/transcriptUtils.js';
import { protobufField } from '../providers/antigravity.js';
import type { SessionRecord } from './store.js';

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const unknown = (reason: string): AgentContextUsage => ({ usedTokens: null, windowTokens: null, observedAt: null, source: 'Native session database', measurement: 'last-request', reason });

/** Metadata advertised by the native model catalog, never a guessed default. */
export function nativeModelContextWindow(model: any): number | undefined {
  const window = count(model?.limit?.context);
  return window !== null && window > 0 ? window : undefined;
}

/** OpenCode records uncached input separately from cache read/write. Read one
 * request, never session aggregate spend or frozen migrated v1 rows for v2.
 * Native schemas: Orca main/opencode-usage/opencode-usage-row-parsing.ts and
 * opencode2-session-usage.test.ts. Capacity is intentionally unknown: the
 * persisted usage rows do not identify a model-specific window.
 */
export function readDatabaseContext(record: SessionRecord, file: string): AgentContextUsage {
  if (record.provider === 'antigravity') return readAntigravityContext(record, file);
  if (!['opencode', 'opencode2', 'kilo'].includes(record.provider)) return unknown('This provider does not expose verified context measurements in its session database.');
  if (!record.providerThreadId || !/^ses_[a-zA-Z0-9]{1,100}$/.test(record.providerThreadId)) return unknown('The native session is not bound yet.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=100');
    const v2 = record.provider === 'opencode2';
    const table = v2 ? 'session_v2' : 'session';
    const session = db.prepare(`SELECT directory FROM ${table} WHERE id = ? AND parent_id IS NULL`).get(record.providerThreadId);
    if (typeof session?.directory !== 'string' || ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(String(session.directory))) === '')) return unknown('The native session workspace changed.');
    const rows = v2
      ? db.prepare(`SELECT type, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 20`).all(record.providerThreadId)
      : db.prepare(`SELECT time_created, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT 20`).all(record.providerThreadId);
    let bytes = 0;
    let selectedModel: string | null = null;
    const modelId = (message: any): string | null => {
      const model = message?.model;
      const id = message?.modelID ?? message?.modelId ?? model?.modelID ?? model?.id;
      const provider = message?.providerID ?? message?.providerId ?? model?.providerID;
      return typeof id === 'string' && id.length <= 200 ? typeof provider === 'string' && provider.length <= 100 && !id.startsWith(provider + '/') ? `${provider}/${id}` : id : null;
    };
    try {
      const model = db.prepare(`SELECT CASE WHEN length(CAST(model AS BLOB)) <= 4096 THEN model END AS model FROM ${table} WHERE id = ?`).get(record.providerThreadId)?.model;
      if (typeof model === 'string' && model.trim()) {
        selectedModel = model.trim().startsWith('{') ? modelId({ model: JSON.parse(model) }) : model.trim().length <= 200 ? model.trim() : null;
      }
    } catch { /* Older versions do not persist the current model separately. */ }
    for (const row of rows) {
      if (typeof row.data !== 'string') return unknown('The latest native record exceeds the context read limit.');
      bytes += Buffer.byteLength(row.data); if (bytes > 1024 * 1024) return unknown('Recent native records exceed the context read limit.');
      let message: any;
      try { message = JSON.parse(row.data); } catch { return unknown('The latest native context record could not be decoded.'); }
      const role = v2 ? row.type : message.role;
      if (role === 'user') { selectedModel ??= modelId(message); continue; }
      if (role !== 'assistant') continue;
      if (message.synthetic || message.isMeta || message.isApiErrorMessage || message.summary) return unknown('Context will update after the next native model request.');
      const measuredModel = modelId(message);
      if (selectedModel && measuredModel && selectedModel !== measuredModel) return unknown('The model changed; context will update after its next request.');
      const tokens = message.tokens;
      const input = count(tokens?.input), output = count(tokens?.output), read = count(tokens?.cache?.read), write = count(tokens?.cache?.write);
      // A missing/zero latest request must not resurrect an earlier model's usage.
      if (input === null || output === null || tokens?.cache?.read !== undefined && read === null || tokens?.cache?.write !== undefined && write === null) return unknown('The latest native request has not reported token usage yet.');
      const used = input + (read ?? 0) + (write ?? 0);
      if (!Number.isSafeInteger(used) || used <= 0) return unknown('The latest native request has not reported token usage yet.');
      return { usedTokens: used, windowTokens: null, ...(measuredModel ? { model: measuredModel } : {}), inputTokens: input, outputTokens: output, ...(read !== null ? { cacheReadTokens: read } : {}), ...(write !== null ? { cacheWriteTokens: write } : {}), observedAt: toIsoOrNull(message.time?.completed ?? message.time?.created ?? row.time_created), source: 'Native session database', measurement: 'last-request', reason: 'The native history records request input usage, but does not report the model context limit.' };
    }
    return unknown('No model request has reported context usage in this session yet.');
  } catch { return unknown('Context measurements are unavailable for this native session format.'); }
  finally { db?.close(); }
}

/** agy.exe SHA256 074c7b99b7727dcd2c7437973454d0856181a1006c97a4fad91a1ed23c10ad44:
 * shipped cortex.proto descriptors establish gen.chat_model=1 -> chat_start=9
 * -> context_window_metadata=10, whose used=1 and max_context_tokens=4.
 * Only numeric fields and response model are read; prompt and tool text stay inert.
 */
export function readAntigravityContext(record: SessionRecord, file: string): AgentContextUsage {
  const missing = () => unknown('The latest native request has not reported context usage yet.');
  if (record.provider !== 'antigravity' || !record.providerThreadId || !/^[a-zA-Z0-9_-]{1,200}$/.test(record.providerThreadId) || path.basename(file) !== `${record.providerThreadId}.db` || !isPathInsideRoots(file, [path.dirname(file)])) return missing();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout=100');
    if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(record.providerThreadId)) return missing();
    const row = db.prepare('SELECT CASE WHEN length(data) <= 2097152 THEN data END AS data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    if (!(row?.data instanceof Uint8Array)) return missing();
    const chat = protobufField(row.data, 1), start = chat && protobufField(chat, 9), context = start && protobufField(start, 10);
    if (!context) return missing();
    let used: number | null = null, window: number | null = null;
    protobufField(context, 0, (field, value) => { if (field === 1) used = count(value); if (field === 4) window = count(value); });
    if (used === null || used <= 0) return missing();
    const usage = chat && protobufField(chat, 4), parts: Partial<AgentContextUsage> = {};
    if (usage) protobufField(usage, 0, (field, value) => {
      const parsed = count(value); if (parsed === null) return;
      if (field === 2) parts.inputTokens = parsed;
      if (field === 3) parts.outputTokens = parsed;
      if (field === 4) parts.cacheWriteTokens = parsed;
      if (field === 5) parts.cacheReadTokens = parsed;
    });
    const modelBytes = chat && protobufField(chat, 19), model = modelBytes ? Buffer.from(modelBytes).toString('utf8').trim() : '';
    let observedAt: string | null = null;
    const timestamp = start && protobufField(start, 4);
    if (timestamp) {
      let seconds = 0, nanos = 0;
      protobufField(timestamp, 0, (field, value) => { if (field === 1) seconds = value; if (field === 2) nanos = value; });
      if (seconds > 0 && nanos >= 0 && nanos < 1e9) observedAt = toIsoOrNull(seconds * 1000 + Math.floor(nanos / 1e6));
    }
    return { usedTokens: used, windowTokens: window && window > 0 ? window : null, ...parts, ...(model && model.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model) ? { model } : {}), observedAt, source: 'Native request context metadata', measurement: 'reported', estimated: true, reason: window ? 'Provider estimate from the saved request. Its recorded capacity can differ from the live Terminal /context view.' : 'The native request did not report its context limit.' };
  } catch { return missing(); }
  finally { db?.close(); }
}
