import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderActivity } from '../../../shared/contracts.js';
import { cleanErrorMessage } from '../../integrations/cli.js';

const timestamp = (value: unknown): string | null => {
  const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const identity = (session: string, id: unknown) => createHash('sha256').update(`${session}:${id}`).digest('base64url').slice(0, 24);
const retireErrors = (items: ProviderActivity[]) => {
  for (let index = items.length - 1; index >= 0; index--) if (items[index].kind === 'error') items.splice(index, 1);
};
const publicText = (parts: any[]) => parts.some(part => ['text', 'output_text'].includes(part?.type) && !part.synthetic && typeof part.text === 'string' && part.text.trim());
const errorText = (error: any): string | undefined => {
  // OpenCode/Kilo record manual cancellation as a typed message error.
  if (error?.name === 'MessageAbortedError') return undefined;
  const value = typeof error === 'string' ? error : error?.data?.message ?? error?.message;
  return typeof value === 'string' ? cleanErrorMessage(value).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 2000) || undefined : undefined;
};

export function transcriptProviderActivity(provider: string, session: string, lines: string[]): ProviderActivity[] {
  const items: ProviderActivity[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.sessionId && row.sessionId !== session) continue;
      const p = provider === 'codex' ? row.payload : row.message ?? row;
      const id = row.uuid ?? row.id ?? p?.id ?? identity(session, line);
      const at = timestamp(row.timestamp);
      const content = Array.isArray(p?.content) ? p.content : [];
      if (!row.isApiErrorMessage && !row.error && (p?.role === 'assistant' || row.type === 'assistant') && publicText(content)) retireErrors(items);
      const reasoning = provider === 'codex' && row.type === 'response_item' && p?.type === 'reasoning'
        || provider === 'codebuddy' && row.type === 'reasoning'
        || ['claude', 'codebuddy'].includes(provider) && content.some((part: any) => ['thinking', 'reasoning', 'reasoning_text'].includes(part?.type));
      if (reasoning) items.push({ id: identity(session, `${id}:reasoning`), at, kind: 'reasoning', state: 'recorded' });
      // Synthetic provider errors are activity, never assistant conversation turns.
      if (row.isApiErrorMessage === true || row.type === 'error' || row.type === 'event_msg' && p?.type === 'error') {
        const message = errorText(row.error ?? p?.error ?? p?.message) ?? (row.isApiErrorMessage === true ? errorText(content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')) : undefined);
        if (message) items.push({ id: identity(session, `${id}:error`), at, kind: 'error', state: 'recorded', message });
      }
    } catch { /* Partial records do not establish activity. */ }
  }
  return items.slice(-20);
}

export function databaseProviderActivity(file: string, session: string, v2 = false): ProviderActivity[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=100');
    const rows = db.prepare(v2
      ? `SELECT id, time_created, type, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 50`
      : `SELECT id, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT 50`).all(session);
    const latest = rows[0]?.id;
    const result: ProviderActivity[] = [];
    let bytes = 0;
    for (const row of rows.reverse()) {
      if (typeof row.data !== 'string') continue;
      bytes += Buffer.byteLength(row.data); if (bytes > 2 * 1024 * 1024) break;
      const value = JSON.parse(row.data), at = timestamp(row.time_created);
      const message = errorText(value.error ?? (v2 && row.type === 'error' ? value : undefined))
        ?? (value.isApiErrorMessage === true && Array.isArray(value.content) ? errorText(value.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')) : undefined);
      if (message) result.push({ id: identity(session, `${row.id}:error`), at, kind: 'error', state: 'recorded', message });
      const parts: any[] = v2 ? Array.isArray(value.content) ? value.content.slice(0, 200) : []
        : db.prepare(`SELECT id, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data FROM part WHERE session_id = ? AND message_id = ? ORDER BY rowid LIMIT 200`).all(session, row.id).flatMap(part => {
          if (typeof part.data !== 'string') return [];
          bytes += Buffer.byteLength(part.data); if (bytes > 2 * 1024 * 1024) return [];
          return [{ ...JSON.parse(part.data), id: part.id }];
        });
      if (!message && !value.isApiErrorMessage && !value.synthetic && (value.role === 'assistant' || v2 && row.type === 'assistant') && publicText(parts)) retireErrors(result);
      for (const [index, part] of parts.entries()) {
        if (!['reasoning', 'thinking'].includes(part?.type)) continue;
        const active = row.id === latest && index === parts.length - 1 && typeof part.time?.start === 'number' && !part.time?.end && !value.time?.completed && !value.error;
        result.push({ id: identity(session, part.id ?? `${row.id}:${index}`), at: timestamp(part.time?.start) ?? at, kind: 'reasoning', state: active ? 'active' : 'recorded' });
      }
    }
    return result.slice(-20);
  } finally { db.close(); }
}
