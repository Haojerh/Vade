import { DatabaseSync } from 'node:sqlite';
import type { BoundedTranscriptReadResult } from '../common/transcriptUtils.js';

/** One recorded part as a public content block. Images are the provider's own recorded
 * attachment bytes (a data URL); any other file reference stays private. */
function partContent(value: any): any[] {
  if (value.type === 'file' && typeof value.url === 'string' && value.url.startsWith('data:image/')) return [{ type: 'input_image', image_url: value.url }];
  return value.type === 'text' && !value.synthetic && typeof value.text === 'string' && value.text.trim() ? [{ type: 'text', text: value.text }] : [];
}

/** Rebuild the exact public row for one recorded message cursor, so the image route can
 * re-read one attachment without scanning a page. */
export function openCodeRecordedLine(file: string, sessionId: string, rowId: number): string | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=100');
    const row = db.prepare(`SELECT id, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
      FROM message WHERE session_id = ? AND rowid = ?`).get(sessionId, rowId) as any;
    if (!row?.data) return null;
    const message = JSON.parse(row.data);
    if (!['user', 'assistant'].includes(message.role)) return null;
    const parts = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
      FROM part WHERE session_id = ? AND message_id = ? ORDER BY rowid LIMIT 1001`).all(sessionId, row.id) as any[];
    if (parts.length > 1000) return null;
    const content = parts.flatMap(part => part.data ? partContent(JSON.parse(part.data)) : []);
    if (!content.length) return null;
    return JSON.stringify({ type: 'response_item', timestamp: new Date(row.time_created).toISOString(), payload: { type: 'message', role: message.role, id: row.id, content } });
  } catch { return null; }
  finally { db.close(); }
}

export function readOpenCodePage(
  file: string,
  sessionId: string,
  offset: number | null,
  limit: number,
  direction?: 'older'
): BoundedTranscriptReadResult {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    let bytes = 0;
    const lines: string[] = [];
    const offsets: number[] = [];
    let maxScannedRowId = offset ?? 0;
    let hasMoreNewer = false;
    let hasMoreOlder = false;
    let totalScanned = 0;
    const BATCH_SIZE = Math.max(limit * 2, 50);
    const MAX_SCAN = 10000;

    // Both scan directions share filtering, part limits and the page byte budget.
    const decodeMessage = (row: any): string | null => {
      if (!row.data) return null;
      bytes += Buffer.byteLength(row.data);
      if (bytes > 8 * 1024 * 1024) throw new Error('Provider page exceeds byte limit');

      const message = JSON.parse(row.data);
      // OpenCode/Kilo stores the generated summary as a private assistant turn immediately
      // after an explicit compaction part. Keep that body out of public chat.
      if (message.summary === true && message.mode === 'compaction') return null;
      if (!['user', 'assistant'].includes(message.role)) return null;

      const parts = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
        FROM part WHERE session_id = ? AND message_id = ? ORDER BY rowid LIMIT 1001`).all(sessionId, row.id) as any[];
      if (parts.length > 1000) throw new Error('Provider message exceeds part limit');

      let compacted = false;
      const content = parts.flatMap((part) => {
        if (!part.data) return [];
        bytes += Buffer.byteLength(part.data);
        if (bytes > 8 * 1024 * 1024) throw new Error('Provider page exceeds byte limit');
        const value = JSON.parse(part.data);
        if (value.type === 'compaction' && typeof value.auto === 'boolean' && typeof value.tail_start_id === 'string') {
          compacted = true;
          return [];
        }
        return partContent(value);
      });
      if (compacted) return JSON.stringify({
        type: 'compacted',
        id: row.id,
        timestamp: new Date(row.time_created).toISOString(),
      });
      if (!content.length) return null;
      return JSON.stringify({
        type: 'response_item',
        timestamp: new Date(row.time_created).toISOString(),
        payload: { type: 'message', role: message.role, id: row.id, content },
      });
    };

    if (offset === null || direction === 'older') {
      let cursorRowId: number | null = offset;
      let oldestIncludedRowId: number | null = null;

      while (lines.length < limit && totalScanned < MAX_SCAN) {
        const query = cursorRowId === null
          ? `SELECT rowid, id, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
             FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`
          : `SELECT rowid, id, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
             FROM message WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`;
        const batch: any[] = cursorRowId === null
          ? db.prepare(query).all(sessionId, BATCH_SIZE) as any[]
          : db.prepare(query).all(sessionId, cursorRowId, BATCH_SIZE) as any[];

        if (!batch.length) break;
        totalScanned += batch.length;
        cursorRowId = batch[batch.length - 1].rowid;

        for (const row of batch) {
          if (direction === 'older') oldestIncludedRowId = row.rowid;
          if (row.rowid > maxScannedRowId) maxScannedRowId = row.rowid;
          const line = decodeMessage(row);
          if (line !== null) {
            oldestIncludedRowId = row.rowid;
            lines.push(line);
            offsets.push(row.rowid);
            if (lines.length >= limit) break;
          }
        }
      }

      if (oldestIncludedRowId !== null) {
        const older = db.prepare('SELECT 1 FROM message WHERE session_id = ? AND rowid < ? LIMIT 1').get(sessionId, oldestIncludedRowId);
        if (older) hasMoreOlder = true;
      }

      lines.reverse();
      offsets.reverse();

      return {
        lines,
        offsets,
        hasMore: direction === 'older' && hasMoreOlder,
        limited: hasMoreOlder,
        nextByteOffset: direction === 'older' ? oldestIncludedRowId ?? 0 : maxScannedRowId,
        totalScanned,
      };
    } else {
      let cursorRowId = offset;
      while (lines.length < limit && totalScanned < MAX_SCAN) {
        const batch: any[] = db.prepare(`SELECT rowid, id, time_created, CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
          FROM message WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`)
          .all(sessionId, cursorRowId, BATCH_SIZE) as any[];

        if (!batch.length) break;
        totalScanned += batch.length;
        cursorRowId = batch[batch.length - 1].rowid;

        for (const row of batch) {
          maxScannedRowId = row.rowid;
          const line = decodeMessage(row);
          if (line !== null) {
            lines.push(line);
            offsets.push(row.rowid);
            if (lines.length >= limit) break;
          }
        }
      }

      const newer = db.prepare('SELECT 1 FROM message WHERE session_id = ? AND rowid > ? LIMIT 1').get(sessionId, maxScannedRowId);
      if (newer) hasMoreNewer = true;

      return {
        lines,
        offsets,
        hasMore: hasMoreNewer,
        limited: false,
        nextByteOffset: maxScannedRowId,
        totalScanned,
      };
    }
  } finally {
    db.close();
  }
}

export function readOpenCodeModel(file: string, sessionId: string): { model: string | null; effort: string | null } | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    let model: string | null = null;
    let effort: string | null = null;

    // 1. Try reading from session table (stores model JSON in Kilo & OpenCode)
    try {
      const sessionRow = db.prepare('SELECT model FROM session WHERE id = ?').get(sessionId) as any;
      if (sessionRow?.model) {
        const parsed = typeof sessionRow.model === 'string' ? JSON.parse(sessionRow.model) : sessionRow.model;
        if (parsed) {
          if (typeof parsed.id === 'string' && parsed.id.trim()) model = parsed.id.trim();
          else if (typeof parsed.modelID === 'string' && parsed.modelID.trim()) model = parsed.modelID.trim();
          else if (typeof parsed.model === 'string' && parsed.model.trim()) model = parsed.model.trim();

          if (typeof parsed.variant === 'string' && parsed.variant.trim()) effort = parsed.variant.trim();
          else if (typeof parsed.effort === 'string' && parsed.effort.trim()) effort = parsed.effort.trim();
        }
      }
    } catch {}

    // 2. Try reading from assistant message (takes precedence or fills in blanks)
    try {
      const asstRow = db.prepare(`SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
        AND length(CAST(data AS BLOB)) <= 2097152 ORDER BY rowid DESC LIMIT 1`).get(sessionId) as any;
      if (asstRow?.data) {
        const m = JSON.parse(asstRow.data);
        if (typeof m.modelID === 'string' && m.modelID.trim()) model = m.modelID.trim();
        else if (typeof m.model === 'string' && m.model.trim()) model = m.model.trim();

        if (typeof m.variant === 'string' && m.variant.trim()) effort = m.variant.trim();
        else if (typeof m.effort === 'string' && m.effort.trim()) effort = m.effort.trim();
      }
    } catch {}

    // 3. Try reading from user message if model or effort is still missing
    if (!model || !effort) {
      try {
        const userRow = db.prepare(`SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
          AND length(CAST(data AS BLOB)) <= 2097152 ORDER BY rowid DESC LIMIT 1`).get(sessionId) as any;
        if (userRow?.data) {
          const u = JSON.parse(userRow.data);
          if (!model) {
            if (typeof u.model?.modelID === 'string' && u.model.modelID.trim()) model = u.model.modelID.trim();
            else if (typeof u.model?.id === 'string' && u.model.id.trim()) model = u.model.id.trim();
            else if (typeof u.modelID === 'string' && u.modelID.trim()) model = u.modelID.trim();
          }
          if (!effort) {
            if (typeof u.model?.variant === 'string' && u.model.variant.trim()) effort = u.model.variant.trim();
            else if (typeof u.variant === 'string' && u.variant.trim()) effort = u.variant.trim();
          }
        }
      } catch {}
    }

    if (!model && !effort) return null;
    return { model, effort };
  } finally {
    db.close();
  }
}
