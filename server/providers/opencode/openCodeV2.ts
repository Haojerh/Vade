import { DatabaseSync } from 'node:sqlite';
import type { ToolActivity } from '../../../shared/contracts.js';
import type { BoundedTranscriptReadResult } from '../common/transcriptUtils.js';
import { toolActivityFromCall } from '../common/toolActivity.js';

function open(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=100'); return db; }
  catch (error) { db.close(); throw error; }
}

/** Public content blocks for one tagged v2 message. Attachments are the provider's own
 * recorded image bytes; the `[Image N]` placeholder stays for marker stripping. */
function v2Content(message: any): any[] {
  const text = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === 'text' && !part.synthetic && typeof part.text === 'string')
    : typeof message.text === 'string' ? [{ type: 'text', text: message.text }]
      : Array.isArray(message.text) ? message.text.filter((part: unknown) => typeof part === 'string').map((text: string) => ({ type: 'text', text })) : [];
  const images = Array.isArray(message.files) ? message.files.flatMap((file: any) =>
    typeof file?.data === 'string' && typeof file?.mime === 'string' && file.mime.startsWith('image/') && /^image\/[a-z]+$/.test(file.mime)
      ? [{ type: 'input_image', image_url: `data:${file.mime};base64,${file.data}` }] : []) : [];
  return [...text, ...images];
}

/** Rebuild the exact public row for one recorded v2 message cursor. */
export function openCodeV2RecordedLine(file: string, session: string, seq: number): string | null {
  const db = open(file);
  try {
    const row = db.prepare(`SELECT id, seq, type, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
      FROM session_message WHERE session_id = ? AND seq = ?`).get(session, seq) as any;
    if (typeof row?.data !== 'string' || !['user', 'assistant'].includes(String(row.type))) return null;
    const message = JSON.parse(row.data);
    if (message.synthetic || message.isMeta || message.isApiErrorMessage) return null;
    const content = v2Content(message);
    if (!content.some((part: any) => part.type === 'input_image' || part.text?.trim())) return null;
    return JSON.stringify({ type: 'response_item', timestamp: new Date(Number(row.time_created)).toISOString(), payload: { type: 'message', role: row.type, id: row.id, content } });
  } catch { return null; }
  finally { db.close(); }
}

/** OpenCode 2 stores tagged messages inline, independently of the v1 part table. */
export function readOpenCodeV2Page(file: string, session: string, offset: number | null, limit: number, direction?: 'older'): BoundedTranscriptReadResult {
  const db = open(file);
  try {
    const backwards = offset === null || direction === 'older', lines: string[] = [], offsets: number[] = [];
    let position = offset, bytes = 0, totalScanned = 0, newest = offset ?? 0;
    while (lines.length < limit && totalScanned < 10000) {
      const rows = db.prepare(`SELECT id, seq, type, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
        FROM session_message WHERE session_id = ? ${position === null ? '' : `AND seq ${backwards ? '<' : '>'} ?`}
        ORDER BY seq ${backwards ? 'DESC' : 'ASC'} LIMIT 50`).all(...(position === null ? [session] : [session, position]));
      if (!rows.length) break;
      for (const row of rows) {
        totalScanned++; position = Number(row.seq); newest = Math.max(newest, position);
        if (typeof row.data !== 'string' || !['user', 'assistant','compaction'].includes(String(row.type))) continue;
        bytes += Buffer.byteLength(row.data);
        if (bytes > 8 * 1024 * 1024) throw new Error('Provider page exceeds byte limit');
        const message = JSON.parse(row.data);
        if (message.synthetic || message.isMeta || message.isApiErrorMessage) continue;
        if(row.type==='compaction'){
          if(message.status!=='completed')continue;
          lines.push(JSON.stringify({type:'compacted',id:row.id,timestamp:new Date(Number(row.time_created)).toISOString()}));
          offsets.push(position);
          if(lines.length>=limit)break;
          continue;
        }
        const content = v2Content(message);
        if (!content.some((part: any) => part.type === 'input_image' || part.text?.trim())) continue;
        lines.push(JSON.stringify({ type: 'response_item', timestamp: new Date(Number(row.time_created)).toISOString(), payload: { type: 'message', role: row.type, id: row.id, content } }));
        offsets.push(position);
        if (lines.length >= limit) break;
      }
    }
    const more = position !== null && Boolean(db.prepare(`SELECT 1 FROM session_message WHERE session_id = ? AND seq ${backwards ? '<' : '>'} ? LIMIT 1`).get(session, position));
    if (backwards) { lines.reverse(); offsets.reverse(); }
    return { lines, offsets, totalScanned, nextByteOffset: direction === 'older' ? position ?? 0 : newest, hasMore: direction === 'older' ? more : !backwards && more, limited: backwards && more };
  } finally { db.close(); }
}

export function readOpenCodeV2Model(file: string, session: string): { model: string | null; effort: string | null } {
  const db = open(file);
  try {
    const row = db.prepare('SELECT substr(model,1,4096) AS model FROM session_v2 WHERE id = ?').get(session);
    if (typeof row?.model !== 'string' || !row.model.trim()) return { model: null, effort: null };
    const value = row.model.trim().startsWith('{') ? JSON.parse(row.model) : { id: row.model };
    const id = value.id ?? value.modelID;
    return { model: typeof id === 'string' && id.length <= 200 ? typeof value.providerID === 'string' && !id.includes('/') ? `${value.providerID}/${id}` : id : null,
      effort: typeof value.variant === 'string' && value.variant.length <= 80 ? value.variant : null };
  } finally { db.close(); }
}

export function openCodeV2Tools(file: string, session: string): ToolActivity[] {
  const db = open(file);
  try {
    const rows = db.prepare(`SELECT id, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data
      FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 200`).all(session);
    let bytes = 0;
    return rows.reverse().flatMap(row => {
      if (typeof row.data !== 'string') return [];
      bytes += Buffer.byteLength(row.data); if (bytes > 8 * 1024 * 1024) throw new Error('Provider tool metadata exceeds byte limit');
      const value = JSON.parse(row.data);
      if (!Array.isArray(value.content)) return [];
      return value.content.slice(0, 200).flatMap((part: any, index: number) => {
        if (part?.type !== 'tool') return [];
        const item = toolActivityFromCall(session, part.id ?? `${row.id}:${index}`, part.name, part.state?.input, part.time?.ran ?? part.time?.created ?? row.time_created);
        return item ? [item] : [];
      });
    }).slice(-200);
  } finally { db.close(); }
}
