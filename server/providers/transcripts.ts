import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BoundedTranscriptReadResult } from '../integrations/orca.js';

export const localTranscriptProviders = ['codex', 'claude', 'omp', 'pi', 'opencode', 'kilocode', 'kilo'];

// Only public user/assistant text is projected. Tool output, thinking, and
// provider-injected bookkeeping never become conversation turns.
export function publicTranscriptRecord(line: string, provider: string): any | null {
  if (!localTranscriptProviders.includes(provider)) return null;
  const record = JSON.parse(line);
  if (provider === 'codex' || provider === 'opencode' || provider === 'kilo' || provider === 'kilocode') return record;
  if (provider === 'claude' && !['user', 'assistant'].includes(record.type)) return null;
  if (['pi', 'omp'].includes(provider) && record.type !== 'message') return null;
  const message = record.message;
  if (record.isApiErrorMessage || message?.model === '<synthetic>') return null;
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  if (message.role === 'user' && (record.isMeta || record.isSynthetic || record.isCompactSummary)) return null;
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  if (provider === 'claude' && message.role === 'user') {
    const text = Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim() : '';
    if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)\b/.test(text)) return null;
  }
  return { type: 'response_item', timestamp: record.timestamp,
    payload: { type: 'message', role: message.role, id: record.uuid || record.id || message.id,
      content: Array.isArray(content) ? content.filter((b: any) => b.type === 'text' && typeof b.text === 'string') : [] } };
}

export function transcriptSettings(record: any): { model?: string; effort?: string } {
  const message = record.message;
  if (record.isApiErrorMessage || message?.model === '<synthetic>') return {};
  const model = message?.role === 'assistant' ? message.model : record.type === 'model_change' ? record.modelId : null;
  const effort = record.effort ?? message?.effort ?? record.thinkingLevel;
  return { ...(typeof model === 'string' && model.trim() ? { model } : {}),
    ...(typeof effort === 'string' && effort.trim() ? { effort } : {}) };
}

export function openCodeDatabase(provider: string, sessionId: string, allowed: (file: string) => boolean): string | null {
  const directory = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    provider === 'opencode' ? 'opencode' : 'kilo');
  const selected = provider === 'opencode' ? process.env.OPENCODE_DB : process.env.KILO_DB;
  const candidates = selected && path.isAbsolute(selected)
    ? [selected] : [path.join(directory, provider === 'opencode' ? 'opencode.db' : 'kilo.db')];
  for (const file of candidates) {
    if (!allowed(file) || !fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId)) return file;
    } finally { db.close(); }
  }
  return null;
}

export function readOpenCodePage(file: string, sessionId: string, offset: number | null, limit: number): BoundedTranscriptReadResult {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT rowid, id, time_created,
      CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
      FROM message WHERE session_id = ? AND rowid > ? ORDER BY rowid ${offset === null ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(sessionId, offset ?? 0, limit + 1) as any[];
    const selected = rows.slice(0, limit);
    if (offset === null) selected.reverse();
    let bytes = 0;
    const lines = selected.flatMap((row) => {
      if (!row.data) return [];
      bytes += Buffer.byteLength(row.data);
      if (bytes > 8 * 1024 * 1024) throw new Error('Provider page exceeds byte limit');
      const message = JSON.parse(row.data);
      if (!['user', 'assistant'].includes(message.role)) return [];
      const parts = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
        FROM part WHERE session_id = ? AND message_id = ? ORDER BY rowid LIMIT 1001`).all(sessionId, row.id) as any[];
      if (parts.length > 1000) throw new Error('Provider message exceeds part limit');
      const content = parts.flatMap((part) => {
        if (!part.data) return [];
        bytes += Buffer.byteLength(part.data);
        if (bytes > 8 * 1024 * 1024) throw new Error('Provider page exceeds byte limit');
        const value = JSON.parse(part.data);
        return value.type === 'text' && !value.synthetic && typeof value.text === 'string' ? [{ type: 'text', text: value.text }] : [];
      });
      return content.length ? [JSON.stringify({ type: 'response_item', timestamp: new Date(row.time_created).toISOString(),
        payload: { type: 'message', role: message.role, id: row.id, content } })] : [];
    });
    return { lines, hasMore: offset !== null && rows.length > limit, limited: offset === null && rows.length > limit,
      nextByteOffset: selected.at(-1)?.rowid ?? offset ?? 0, totalScanned: selected.length };
  } finally { db.close(); }
}

export function readOpenCodeModel(file: string, sessionId: string): { model: string | null; effort: string | null } | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare(`SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
      AND length(CAST(data AS BLOB)) <= 2097152 ORDER BY rowid DESC LIMIT 1`).get(sessionId) as any;
    if (!row) return null;
    const m = JSON.parse(row.data);
    return { model: typeof m.modelID === 'string' ? m.modelID : null,
      effort: typeof m.variant === 'string' ? m.variant : null };
  } finally { db.close(); }
}
