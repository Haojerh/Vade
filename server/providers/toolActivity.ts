import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ToolActivity, ToolEditPreview } from '../../shared/contracts.js';

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

function recordedPatch(code: string): string | null {
  const direct = stringLiteral(code.match(/\bapply_patch\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)?.[1]);
  if (direct) return direct;
  // Codex code-mode calls often bind a literal patch before passing it to the
  // tool. Resolve only a recorded const string, never expressions or execution.
  const call = /\bapply_patch\(\s*([a-zA-Z_$][\w$]*)\s*\)/.exec(code);
  if (!call) return null;
  const name = call[1].replace(/[$]/g, '\\$');
  const declaration = new RegExp('\\bconst\\s+' + name + '\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\')\\s*;').exec(code.slice(0, call.index));
  if (!declaration) return null;
  const between = code.slice(declaration.index + declaration[0].length, call.index);
  if (new RegExp('\\b' + name + '\\s*(?:[+*/?-]?=|\\+\\+|--)').test(between)) return null;
  const patch = stringLiteral(declaration[1]);
  return patch?.startsWith('*** Begin Patch\n') ? patch : null;
}

export function toolLabel(name: string, rawInput: unknown, maxLength = 160): string {
  const input = inputObject(rawInput);
  // Code-mode wrappers carry literal tool arguments in `code`; inspect text only, never execute it.
  const code = typeof input.code === 'string' ? input.code : typeof input.patch === 'string' && /exec/i.test(name) ? input.patch : '';
  const commandLiteral = code.match(/\b(?:cmd|command)\s*["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/)?.[1];
  const wrappedCommand = stringLiteral(commandLiteral);
  const wrappedPatch = recordedPatch(code);
  const action = wrappedPatch || /edit|write|patch|replace|diff/i.test(name) ? 'Edit'
    : /read|view|cat/i.test(name) ? 'Read'
    : /exec|bash|shell|command|terminal/i.test(name) ? 'Run' : name;
  const patch = wrappedPatch ?? input.patch ?? input.patchText ?? input.diff;
  const patchPath = typeof patch === 'string' ? patch.match(/\*\*\* (?:Update|Add|Delete) File: ([^\r\n]+)/)?.[1] : null;
  const detail = action === 'Run' ? input.command ?? input.cmd ?? input.command_line ?? input.CommandLine ?? wrappedCommand
    : input.file_path ?? input.path ?? input.filePath ?? input.filename ?? input.AbsolutePath ?? input.TargetFile ?? input.FilePath ?? input.Path ?? patchPath ?? input.title;
  const safe = typeof detail === 'string' ? detail.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLength) : '';
  return `${action.slice(0, 60)}${safe ? `: ${safe}` : ''}`;
}

export function toolActivityFromCall(session: string, id: unknown, name: unknown, input: unknown, at: unknown): ToolActivity | null {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
  const timestamp = typeof at === 'number' ? new Date(at).toISOString()
    : typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
  return { id: `tool_${createHash('sha256').update(`${session}:${id}`).digest('base64url').slice(0, 24)}`, at: timestamp,
    label: toolLabel(name, input), detail: toolLabel(name, input, 2000),
    ...(toolLabel(name, input).startsWith('Edit') ? { edits: toolEditPreview(input) } : {}) };
}

// Only recorded edit arguments are inspected. Never read the current file or tool output.
export function toolEditPreview(raw: unknown): ToolEditPreview[] {
  const input = inputObject(raw);
  const code = typeof input.code === 'string' ? input.code : typeof input.patch === 'string' ? input.patch : '';
  const wrapped = recordedPatch(code);
  const patch = wrapped ?? input.patch ?? input.patchText ?? input.diff;
  const previews: ToolEditPreview[] = [];
  const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const addLine = (preview: ToolEditPreview, kind: 'add' | 'remove' | 'context', text: string) => {
    if (preview.lines.length >= 16) { preview.truncated = true; return; }
    const safe = clean(text);
    if (safe.length > 200) preview.truncated = true;
    preview.lines.push({ kind, text: safe.slice(0, 200) });
  };
  if (typeof patch === 'string' && /(?:\*\*\* (?:Update|Add|Delete) File:|^diff --git )/m.test(patch)) {
    let current: ToolEditPreview | undefined;
    const bounded = patch.slice(0, 64000);
    for (const line of bounded.split(/\r?\n/)) {
      const path = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/)?.[1] ?? line.match(/^diff --git a\/.+ b\/(.+)$/)?.[1];
      if (path) {
        if (previews.length >= 2) { previews[1].truncated = true; break; }
        current = { path: clean(path).slice(0, 500), lines: [], truncated: patch.length > bounded.length };
        previews.push(current);
      } else if (current && line.startsWith('@@')) {
        if (!current.location) current.location = clean(line).slice(0, 200);
        else addLine(current, 'context', line);
      } else if (current && !line.startsWith('---') && !line.startsWith('+++') && /^[+\- ]/.test(line)) {
        addLine(current, line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context', line.slice(1));
      }
    }
    return previews.filter((preview) => preview.lines.some((line) => line.kind !== 'context'));
  }
  const path = input.file_path ?? input.path ?? input.filePath ?? input.filename ?? input.TargetFile ?? input.AbsolutePath ?? input.FilePath ?? input.Path;
  if (typeof path !== 'string') return [];
  if (typeof patch === 'string' && patch.includes('<<<<<<< SEARCH')) {
    const bounded = patch.slice(0, 64000);
    const matches = [...bounded.matchAll(/<<<<<<< SEARCH\r?\n(?::start_line:(\d+)\r?\n)?-------\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g)];
    const edits = toolEditPreview({ path, edits: matches.slice(0, 2).map((match) => ({ StartLine: Number(match[1]), oldText: match[2], newText: match[3] })) });
    if (matches.length > 2 || patch.length > bounded.length) edits.forEach((edit) => { edit.truncated = true; });
    return edits;
  }
  const chunks = Array.isArray(input.ReplacementChunks) ? input.ReplacementChunks : Array.isArray(input.edits) ? input.edits : [input];
  for (const chunk of chunks.slice(0, 2)) {
    const before = chunk.old_string ?? chunk.oldString ?? chunk.oldText ?? chunk.TargetContent ?? chunk.Target;
    const after = chunk.new_string ?? chunk.newString ?? chunk.newText ?? chunk.ReplacementContent ?? chunk.Replacement ?? chunk.content ?? chunk.Content;
    if (typeof before !== 'string' && typeof after !== 'string') continue;
    const start = chunk.StartLine ?? input.StartLine;
    const preview: ToolEditPreview = { path: clean(path).slice(0, 500), lines: [], truncated: chunks.length > 2,
      ...(Number.isInteger(start) && start > 0 ? { location: `Line ${start}` } : {}) };
    for (const [kind, text] of [['remove', before], ['add', after]] as const) {
      if (typeof text !== 'string') continue;
      const lines = text.slice(0, 32000).split(/\r?\n/);
      if (text.length > 32000 || lines.length > 8) preview.truncated = true;
      for (const line of lines.slice(0, 8)) addLine(preview, kind, line);
    }
    previews.push(preview);
  }
  return previews;
}

export function transcriptToolActivity(provider: string, session: string, line: string): ToolActivity[] {
  try {
    const record = JSON.parse(line);
    if (record.sessionId && record.sessionId !== session) return [];
    if (provider === 'codebuddy') {
      if (!['function_call', 'function_call_result'].includes(record.type)) return [];
      const result = record.type === 'function_call_result';
      const calls = result && record.name === 'REPL' ? record.providerData?.toolResult?.replToolCalls?.calls : null;
      if (result && !Array.isArray(calls)) return [];
      const input = inputObject(result ? record.providerData?.arguments : record.arguments);
      const item = toolActivityFromCall(session, record.callId ?? record.call_id ?? record.id, record.name, input, record.timestamp);
      if (item && record.name === 'REPL') {
        if (typeof input.description === 'string') item.label = `REPL: ${input.description.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160)}`;
        const code = record.providerData?.argumentsDisplayText ?? input.code;
        if (typeof code === 'string') item.detail = code.slice(0, 2000);
        if (Array.isArray(calls)) item.children = calls.slice(0, 20).flatMap((call: any) => {
          // The native REPL records child inputs separately from stdout and results.
          const child = toolActivityFromCall(session, call?.id, call?.name, call?.arguments, record.timestamp);
          return child ? [child] : [];
        });
      }
      return item ? [item] : [];
    }
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

export function mergeToolActivity(items: ToolActivity[]): ToolActivity[] {
  const calls = new Map<string, ToolActivity>();
  for (const item of items) {
    const previous = calls.get(item.id);
    calls.set(item.id, previous ? { ...previous, ...item, at: previous.at ?? item.at, detail: previous.detail ?? item.detail } : item);
  }
  return [...calls.values()].slice(-200);
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
