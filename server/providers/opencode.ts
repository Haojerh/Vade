import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BoundedTranscriptReadResult } from '../integrations/orca/utils.js';
import { stripAnsiCodes } from './shared.js';

function openCodeDatabaseCandidates(provider: string): { selected: string | undefined; candidates: string[] } {
  const directory = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    provider === 'opencode' ? 'opencode' : 'kilo'
  );
  const selected = provider === 'opencode' ? process.env.OPENCODE_DB : process.env.KILO_DB;
  const candidates: string[] = [];
  if (selected && path.isAbsolute(selected)) {
    candidates.push(selected);
  } else {
    candidates.push(path.join(directory, provider === 'opencode' ? 'opencode.db' : 'kilo.db'));
    if (provider === 'kilo' || provider === 'kilocode') {
      const altKilo = path.join(os.homedir(), '.kilocode', 'kilo.db');
      if (fs.existsSync(altKilo)) candidates.push(altKilo);
    }
  }
  return { selected, candidates };
}

export function openCodeDatabase(provider: string, sessionId: string, allowed: (file: string) => boolean): string | null {
  const { candidates } = openCodeDatabaseCandidates(provider);
  for (const file of candidates) {
    if (!allowed(file) || !fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId)) return file;
    } catch {
    } finally {
      db.close();
    }
  }
  return null;
}

export function readOpenCodePage(
  file: string,
  sessionId: string,
  offset: number | null,
  limit: number
): BoundedTranscriptReadResult {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    let bytes = 0;
    const lines: string[] = [];
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
      if (!['user', 'assistant'].includes(message.role)) return null;

      const parts = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) <= 2097152 THEN data END AS data
        FROM part WHERE session_id = ? AND message_id = ? ORDER BY rowid LIMIT 1001`).all(sessionId, row.id) as any[];
      if (parts.length > 1000) throw new Error('Provider message exceeds part limit');

      const content = parts.flatMap((part) => {
        if (!part.data) return [];
        bytes += Buffer.byteLength(part.data);
        if (bytes > 8 * 1024 * 1024) throw new Error('Provider page exceeds byte limit');
        const value = JSON.parse(part.data);
        return value.type === 'text' && !value.synthetic && typeof value.text === 'string' && value.text.trim()
          ? [{ type: 'text', text: value.text }] : [];
      });
      if (!content.length) return null;
      return JSON.stringify({
        type: 'response_item',
        timestamp: new Date(row.time_created).toISOString(),
        payload: { type: 'message', role: message.role, id: row.id, content },
      });
    };

    if (offset === null) {
      let cursorRowId: number | null = null;
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
          if (row.rowid > maxScannedRowId) maxScannedRowId = row.rowid;
          const line = decodeMessage(row);
          if (line !== null) {
            oldestIncludedRowId = row.rowid;
            lines.push(line);
            if (lines.length >= limit) break;
          }
        }
      }

      if (oldestIncludedRowId !== null) {
        const older = db.prepare('SELECT 1 FROM message WHERE session_id = ? AND rowid < ? LIMIT 1').get(sessionId, oldestIncludedRowId);
        if (older) hasMoreOlder = true;
      }

      lines.reverse();

      return {
        lines,
        hasMore: false,
        limited: hasMoreOlder,
        nextByteOffset: maxScannedRowId,
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
        maxScannedRowId = cursorRowId;

        for (const row of batch) {
          const line = decodeMessage(row);
          if (line !== null) {
            lines.push(line);
            if (lines.length >= limit) break;
          }
        }
      }

      const newer = db.prepare('SELECT 1 FROM message WHERE session_id = ? AND rowid > ? LIMIT 1').get(sessionId, maxScannedRowId);
      if (newer) hasMoreNewer = true;

      return {
        lines,
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

export function findOpenCodeSession(
  provider: string,
  labelOrId: string,
  allowed?: ((file: string) => boolean) | null,
  options?: { worktreePath?: string | null; ptyId?: string | null }
): { dbPath: string; sessionId: string } | null {
  const { selected, candidates } = openCodeDatabaseCandidates(provider);

  const clean = labelOrId
    .replace(/^✳\s*/, '')
    .replace(/^(?:OC|OpenCode|Kilo(?:\s+(?:CLI|Code))?|KC)\s*\|\s*/i, '')
    .replace(/\.{2,}$/, '')
    .split(/\s*\|\s*/)[0]
    .trim();

  // 1. Check Orca AI vault cache (only if not overridden by explicit DB env var)
  if (!selected) {
    try {
      const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
      const vaultCache = path.join(appData, 'orca', 'ai-vault', 'session-parse-cache.json');
      if (fs.existsSync(vaultCache)) {
        const data = JSON.parse(fs.readFileSync(vaultCache, 'utf-8'));
        const entries = Array.isArray(data.entries) ? data.entries : [];
        for (const [, val] of entries) {
          const s = val?.session;
          if (s && (s.agent === provider || (['kilo', 'kilocode'].includes(provider) && ['kilo', 'kilocode'].includes(s.agent)))) {
            const matchTitle = s.title && clean && (s.title.toLowerCase() === clean.toLowerCase() || clean.toLowerCase().includes(s.title.toLowerCase()) || s.title.toLowerCase().includes(clean.toLowerCase()));
            const matchId = s.sessionId && (s.sessionId === clean || labelOrId.includes(s.sessionId));
            if ((matchTitle || matchId) && s.filePath && fs.existsSync(s.filePath) && (!allowed || allowed(s.filePath))) {
              return { dbPath: s.filePath, sessionId: s.sessionId };
            }
          }
        }
      }
    } catch {}
  }

  const sesMatch = labelOrId.match(/\b(ses_[a-zA-Z0-9]+)\b/);
  const explicitSessionId = sesMatch ? sesMatch[1] : null;
  const isGeneric = !clean || ['opencode', 'kilo', 'kilocode', 'agent', 'cli', 'code', 'terminal'].includes(clean.toLowerCase());

  for (const file of candidates) {
    if ((allowed && !allowed(file)) || !fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      // A. Explicit session ID
      if (explicitSessionId) {
        try {
          const row = db.prepare('SELECT id FROM session WHERE id = ?').get(explicitSessionId) as any;
          if (row?.id) return { dbPath: file, sessionId: row.id };
        } catch {}
      }

      // B. Match by title if clean label is non-generic
      if (!isGeneric) {
        try {
          const rows = db.prepare('SELECT id, title, directory FROM session ORDER BY rowid DESC').all() as any[];
          if (options?.worktreePath) {
            const normWt = path.normalize(options.worktreePath).toLowerCase();
            const matchInWt = rows.find((r) => {
              const normDir = r.directory ? path.normalize(r.directory).toLowerCase() : '';
              if (normDir !== normWt) return false;
              const t = (r.title || '').toLowerCase().trim();
              const c = clean.toLowerCase();
              return t === c || t.startsWith(c) || t.includes(c) || c.includes(t);
            });
            if (matchInWt?.id) return { dbPath: file, sessionId: matchInWt.id };
          }

          const matchAny = rows.find((r) => {
            const t = (r.title || '').toLowerCase().trim();
            const c = clean.toLowerCase();
            return t === c || t.startsWith(c) || t.includes(c) || c.includes(t);
          });
          if (matchAny?.id) return { dbPath: file, sessionId: matchAny.id };
        } catch {
          // Fallback if session table has no directory column (e.g. mock test db)
          try {
            const row = db
              .prepare('SELECT id FROM session WHERE id = ? OR title LIKE ? OR title LIKE ? LIMIT 1')
              .get(clean, clean + '%', '%' + clean + '%') as any;
            if (row?.id) return { dbPath: file, sessionId: row.id };
          } catch {}
        }
      }

      // C. Match via terminal history checkpoint (for custom tab titles)
      if (options?.ptyId) {
        const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
        const encodedPty = encodeURIComponent(options.ptyId);
        const cpPath = path.join(appData, 'orca', 'terminal-history', encodedPty, 'checkpoint.json');
        if (fs.existsSync(cpPath)) {
          try {
            const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
            if (cp.snapshotAnsi) {
              const cleanSnapshot = stripAnsiCodes(cp.snapshotAnsi);
              const rows = db.prepare('SELECT id, title, directory FROM session ORDER BY rowid DESC').all() as any[];
              const matchCp = rows.find((r) => {
                if (!r.title || r.title.length < 3) return false;
                if (options?.worktreePath) {
                  const normDir = r.directory ? path.normalize(r.directory).toLowerCase() : '';
                  const normWt = path.normalize(options.worktreePath).toLowerCase();
                  if (normDir && normWt && normDir !== normWt) return false;
                }
                return cleanSnapshot.includes(r.title);
              });
              if (matchCp?.id) return { dbPath: file, sessionId: matchCp.id };
            }
          } catch {}
        }
      }
    } catch {
    } finally {
      db.close();
    }
  }
  return null;
}
