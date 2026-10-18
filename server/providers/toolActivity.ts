import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ToolActivity } from '../../shared/contracts.js';

function inputObject(input: unknown): Record<string, any> {
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch { return { patch: input }; }
  }
  return input && typeof input === 'object' ? input as Record<string, any> : {};
}

function stringLiteral(literal: string | undefined): string | null {
  if (!literal) return null;
  try {
    if (literal.startsWith('"')) return JSON.parse(literal);
    return literal.slice(1, -1).replace(/\\(['\\nrt])/g, (_, value: string) => ({ n: '\n', r: '\r', t: '\t' }[value] ?? value));
  } catch { return null; }
}

export function toolLabel(name: string, rawInput: unknown, maxLength = 160): string {
  const input = inputObject(rawInput);
  // Code-mode wrappers carry literal tool arguments in `code`; inspect text only, never execute it.
  const code = typeof input.code === 'string' ? input.code : typeof input.patch === 'string' && /exec/i.test(name) ? input.patch : '';
  const commandLiteral = code.match(/\b(?:cmd|command)\s*["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)?.[1];
  const wrappedCommand = stringLiteral(commandLiteral);
  const wrappedPatch = stringLiteral(code.match(/\bapply_patch\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)?.[1]);
  const action = wrappedPatch || /edit|write|patch|replace/i.test(name) ? 'Edit'
    : /read|view|cat/i.test(name) ? 'Read'
    : /exec|bash|shell|command|terminal/i.test(name) ? 'Run' : name;
  const patch = wrappedPatch ?? input.patch;
  const patchPath = typeof patch === 'string' ? patch.match(/\*\*\* (?:Update|Add|Delete) File: ([^\r\n]+)/)?.[1] : null;
  const detail = action === 'Run' ? input.command ?? input.cmd ?? input.command_line ?? input.CommandLine ?? wrappedCommand
    : input.file_path ?? input.path ?? input.filePath ?? input.filename ?? input.AbsolutePath ?? input.TargetFile ?? input.FilePath ?? patchPath ?? input.title;
  const safe = typeof detail === 'string' ? detail.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLength) : '';
  return `${action.slice(0, 60)}${safe ? `: ${safe}` : ''}`;
}

export function toolActivityFromCall(session: string, id: unknown, name: unknown, input: unknown, at: unknown): ToolActivity | null {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
  const timestamp = typeof at === 'number' ? new Date(at).toISOString()
    : typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
  return { id: `tool_${createHash('sha256').update(`${session}:${id}`).digest('base64url').slice(0, 24)}`, at: timestamp,
    label: toolLabel(name, input), detail: toolLabel(name, input, 2000) };
}

export function transcriptToolActivity(provider: string, session: string, line: string): ToolActivity[] {
  try {
    const record = JSON.parse(line);
    if (record.sessionId && record.sessionId !== session) return [];
    if (provider === 'codex') {
      const p = record.payload;
      if (record.type !== 'response_item' || !['function_call', 'custom_tool_call'].includes(p?.type)) return [];
      const item = toolActivityFromCall(session, p.call_id, p.name, p.arguments ?? p.input, record.timestamp);
      return item ? [item] : [];
    }
    if (!['claude', 'pi', 'omp'].includes(provider) || record.message?.role !== 'assistant') return [];
    const content = record.message.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part: any) => {
      if (!['tool_use', 'toolCall'].includes(part?.type)) return [];
      const item = toolActivityFromCall(session, part.id, part.name, part.input ?? part.arguments, record.timestamp ?? record.message.timestamp);
      return item ? [item] : [];
    });
  } catch { return []; }
}

export function databaseToolActivity(file: string, session: string): ToolActivity[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, CASE WHEN length(CAST(data AS BLOB)) <= 262144 THEN data END AS data
      FROM part WHERE session_id = ? ORDER BY rowid DESC LIMIT 200`).all(session);
    let bytes = 0;
    return rows.reverse().flatMap((row) => {
      if (typeof row.data !== 'string') return [];
      bytes += Buffer.byteLength(row.data);
      if (bytes > 8 * 1024 * 1024) throw new Error('Provider tool metadata exceeds byte limit');
      try {
        const part = JSON.parse(row.data);
        if (part.type !== 'tool') return [];
        const item = toolActivityFromCall(session, part.callID ?? row.id, part.tool, part.state?.input, part.state?.time?.start);
        return item ? [item] : [];
      } catch { return []; }
    });
  } finally { db.close(); }
}
