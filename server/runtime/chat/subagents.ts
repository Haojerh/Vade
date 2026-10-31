import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ConversationPage, Id, ISO, NodeDetailsQuery, Section, SourceMeta, Subagent, SubagentConversation } from '../../../shared/contracts.js';
import type { SessionRecord } from '../store.js';
import { hashId, readOlderTranscriptLines, toIsoOrNull } from '../../providers/common/transcriptUtils.js';
import { isOpenCode, openCodeFile, withOpenCode } from '../../providers/opencode/openCodeSessions.js';
import { validCodexThreadId } from '../../providers/codex/codexThread.js';
import { publicTranscriptRecord } from '../../providers/common/shared.js';
import { readOpenCodePage } from '../../providers/opencode/opencode.js';
import { readOpenCodeV2Page } from '../../providers/opencode/openCodeV2.js';
import { issueStoredCursor, validateStoredCursor } from '../../providers/common/conversationCursors.js';
import { databaseToolActivity, mergeToolActivity, transcriptToolActivity } from '../../providers/common/toolActivity.js';
import { parseAntigravityTranscriptLine } from '../../providers/antigravity/antigravity.js';

/** Bounded, read-only discovery of native child agents recorded for one exact session.
 *  A provider that records no child linkage returns an empty section, never a guess. */

function sec<T>(data: T | null, availability: SourceMeta['availability'] = 'ready', message?: string): Section<T> {
  const now = new Date().toISOString();
  return { data, meta: { availability, attemptedAt: now, observedAt: availability === 'ready' || availability === 'empty' ? now : null,
    partial: false, stale: false, issue: message ? { code: availability === 'unsupported' ? 'CONVERSATION_UNSUPPORTED' : 'RUNTIME_UNAVAILABLE', message, retryable: false } : null } };
}

const MAX_CHILDREN = 50;
const TTL_MS = 8000;
const cache = new Map<string, { at: number; stamp: string; value: Section<Subagent[]> }>();
const pending = new Map<string, Promise<Section<Subagent[]>>>();

/** Transcript handles stay in-process only; they never reach the browser. */
type Handle =
  | { kind: 'file'; file: string; provider: string }
  | { kind: 'inline'; file: string; agentId: string }
  | { kind: 'database'; file: string; childId: string; provider: 'opencode' | 'opencode2' | 'kilo' }
  | { kind: 'unavailable'; reason: string };
const handles = new Map<string, Handle>();

function remember(id: Id, handle: Handle): Id {
  if (handles.size >= 500) handles.delete(handles.keys().next().value!);
  handles.set(id, handle);
  return id;
}

function childId(record: SessionRecord, provider: string, native: string): Id {
  return hashId('sub', `${record.provider}:${record.providerThreadId ?? record.id}:${provider}:${native}`);
}

function stampOf(target: string): string {
  try {
    const stat = fs.statSync(target);
    return `${stat.mtimeMs}:${stat.size}:${stat.isDirectory() ? 'd' : 'f'}`;
  } catch { return 'missing'; }
}

function firstLine(file: string, max = 65536): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(max);
      const read = fs.readSync(fd, buffer, 0, max, 0);
      const text = buffer.subarray(0, read).toString('utf8');
      const newline = text.indexOf('\n');
      return newline < 0 ? text : text.slice(0, newline);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function tailText(file: string, max = 262144): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return '';
    const start = Math.max(0, stat.size - max);
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      const read = fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.subarray(0, read).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function listFiles(root: string, accept: (name: string) => boolean, limit: number, depth: number): string[] {
  const out: string[] = [];
  const visit = (directory: string, level: number) => {
    if (out.length >= limit || level > depth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, level + 1);
      else if (entry.isFile() && accept(entry.name)) out.push(target);
    }
  };
  visit(root, 0);
  return out;
}

function findById(root: string, id: string, depth: number): string | null {
  let remaining = 4096;
  const visit = (directory: string, level: number): string | null => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (--remaining < 0) return null;
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === `${id}.jsonl`) return target;
      if (level && entry.isDirectory()) { const match = visit(target, level - 1); if (match) return match; }
    }
    return null;
  };
  return visit(root, depth);
}

function previewText(line: string | undefined): string | null {
  if (!line) return null;
  try {
    const record = JSON.parse(line);
    const content = record?.message?.content ?? record?.payload?.content ?? record?.content;
    if (typeof content === 'string' && content.trim()) return content.replace(/\s+/g, ' ').slice(0, 180);
    const parts = Array.isArray(content) ? content : [];
    const text = parts.filter((part: any) => ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map((part: any) => part.text).join(' ').trim();
    if (!text) return null;
    return text.replace(/\s+/g, ' ').slice(0, 180);
  } catch { return null; }
}

function lastAssistantPreview(text: string): string | null {
  const lines = text.split('\n').reverse();
  for (const line of lines.slice(0, 400)) {
    if (!line.includes('"assistant"') && !line.includes('"PLANNER_RESPONSE"')) continue;
    const preview = previewText(line);
    if (preview) return preview;
  }
  return null;
}

function isoFromMs(value: unknown): ISO | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

/** Codex records each child as its own rollout file with an exact parent thread id. */
function codexSection(record: SessionRecord): Section<Subagent[]> {
  const parent = record.providerThreadId;
  if (!validCodexThreadId(parent)) return sec([], 'empty');
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const files = listFiles(root, name => name.startsWith('rollout-') && name.endsWith('.jsonl'), 400, 3);
  const children: Subagent[] = [];
  for (const file of files) {
    if (children.length >= MAX_CHILDREN) break;
    let meta: any;
    try { meta = JSON.parse(firstLine(file) ?? 'null')?.payload; } catch { continue; }
    const spawn = meta?.source?.subagent?.thread_spawn;
    const parentId = typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id : meta?.parent_thread_id;
    if (parentId !== parent || typeof meta?.id !== 'string') continue;
    const tail = tailText(file);
    const lastStart = tail.lastIndexOf('"task_started"');
    const lastEnd = Math.max(tail.lastIndexOf('"task_complete"'), tail.lastIndexOf('"turn_aborted"'));
    const state: Subagent['state'] = lastStart > lastEnd ? 'working' : lastEnd >= 0 ? 'completed' : 'unknown';
    const id = remember(childId(record, 'codex', meta.id), { kind: 'file', file, provider: 'codex' });
    children.push({
      id,
      label: typeof meta?.agent_nickname === 'string' && meta.agent_nickname.trim() ? meta.agent_nickname.trim().slice(0, 80)
        : typeof meta?.agent_path === 'string' && meta.agent_path.trim() ? meta.agent_path.trim().slice(-60) : 'subagent',
      role: typeof meta?.agent_path === 'string' ? meta.agent_path.slice(0, 120) : null,
      state,
      model: null,
      startedAt: toIsoOrNull(meta?.timestamp),
      lastActivityAt: isoFromMs(fs.statSync(file).mtimeMs),
      preview: lastAssistantPreview(tail),
      transcript: 'available',
    });
  }
  children.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return sec(children, children.length ? 'ready' : 'empty');
}

/** OpenCode v1/v2 and Kilo keep children in the same database with `parent_id`. */
function openCodeSection(record: SessionRecord): Section<Subagent[]> {
  const parentId = record.providerThreadId;
  if (!isOpenCode(record.provider) || !parentId) return sec([], 'empty');
  const provider = record.provider as 'opencode' | 'opencode2' | 'kilo';
  return withOpenCode(provider, db => {
    const table = provider === 'opencode2' ? 'session_v2' : 'session';
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(row => row.name));
    const column = (name: string) => columns.has(name) ? name : `NULL AS ${name}`;
    const rows = db.prepare(`SELECT id, parent_id, ${column('title')}, ${column('time_created')}, ${column('time_updated')} FROM ${table} WHERE parent_id = ? ORDER BY rowid ASC LIMIT ${MAX_CHILDREN}`)
      .all(parentId) as any[];
    if (!rows.length) return sec([], 'empty');
    const file = openCodeFile(provider);
    const children: Subagent[] = rows.map(row => {
      let state: Subagent['state'] = 'unknown';
      if (provider !== 'opencode2') {
        try {
          const last = db.prepare(`SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY rowid DESC LIMIT 1`).get(row.id) as any;
          const message = last?.data ? JSON.parse(last.data) : null;
          if (message) state = message.time?.completed ? 'completed' : 'working';
        } catch { /* An unreadable child message keeps the state unknown. */ }
      }
      const id = remember(childId(record, provider, row.id), { kind: 'database', file, childId: row.id, provider });
      return {
        id,
        label: typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 80) : 'subagent',
        role: null,
        state,
        model: null,
        startedAt: isoFromMs(row.time_created),
        lastActivityAt: isoFromMs(row.time_updated),
        preview: null,
        transcript: 'available',
      } as Subagent;
    });
    return sec(children, 'ready');
  });
}

/** DSH records child sessions beside the parent in the same workspace folder. The native
 *  session file is compressed and may be appended while a turn is live, so the header is
 *  decoded from a bounded streamed prefix instead of a whole-file decompression. */
async function zstdFirstLine(file: string, limit = 65536): Promise<string | null> {
  const compressed = fs.readFileSync(file).subarray(0, 262144);
  const stream = zlib.createZstdDecompress();
  return await new Promise<string | null>(resolve => {
    let text = '';
    const finish = (value: string | null) => { stream.destroy(); resolve(value); };
    const settle = () => finish(text.includes('\n') ? text.slice(0, text.indexOf('\n')) : null);
    stream.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      if (text.includes('\n')) finish(text.slice(0, text.indexOf('\n')));
      else if (text.length > limit) finish(null);
    });
    stream.on('error', settle);
    stream.on('end', settle);
    stream.write(compressed);
    stream.end();
  });
}

async function dshSection(record: SessionRecord): Promise<Section<Subagent[]>> {
  const parent = record.providerThreadId;
  if (!parent) return sec([], 'empty');
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const directory = path.join(home, 'sessions', '--' + record.cwd.replace(/[:\\/]+/g, '-') + '--');
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return sec([], 'empty'); }
  const children: Subagent[] = [];
  for (const entry of entries.slice(0, 40)) {
    if (children.length >= MAX_CHILDREN) break;
    if (!entry.isDirectory() || entry.name === parent) continue;
    const file = path.join(directory, entry.name, 'session.v4.jsonl.zstd');
    let header: any;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
      const line = await zstdFirstLine(file);
      header = line ? JSON.parse(line) : null;
    } catch { continue; }
    if (header?.parentSession !== parent) continue;
    const id = remember(childId(record, 'dsh', String(header.id ?? entry.name)), { kind: 'unavailable', reason: 'DSH child sessions are stored as compressed native sessions; Vade does not decode them for chat yet.' });
    children.push({
      id,
      label: typeof header.title === 'string' && header.title.trim() ? header.title.trim().slice(0, 80) : String(header.id ?? entry.name).slice(0, 40),
      role: header.origin === 'subagent' ? 'subagent' : null,
      state: 'unknown',
      model: null,
      startedAt: isoFromMs(header.createdAt),
      lastActivityAt: isoFromMs(fs.statSync(file).mtimeMs),
      preview: null,
      transcript: 'unavailable',
      reason: 'DSH child sessions are recorded natively but not projected into chat.',
    });
  }
  children.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return sec(children, children.length ? 'ready' : 'empty');
}

/** Claude writes child transcripts under `<session>/subagents/` while the child runs and
 *  removes them on completion, so a present child file is an executing child. */
function claudeSection(record: SessionRecord): Section<Subagent[]> {
  const parent = record.providerThreadId;
  if (!parent) return sec([], 'empty');
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const parentFile = findById(root, parent, 1);
  if (!parentFile) return sec([], 'empty');
  const directory = path.join(path.dirname(parentFile), parent, 'subagents');
  const children: Subagent[] = [];
  // Nested `agentRelPath` subdirectories are part of the native layout.
  const files = listFiles(directory, name => name.startsWith('agent-') && name.endsWith('.jsonl'), MAX_CHILDREN, 3);
  for (const file of files) {
    let head: any = null;
    try { head = JSON.parse(firstLine(file) ?? 'null'); } catch { continue; }
    const agentId = typeof head?.agentId === 'string' && head.agentId ? head.agentId : path.basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const id = remember(childId(record, 'claude', agentId), { kind: 'file', file, provider: 'claude' });
    children.push({
      id,
      label: (typeof head?.slug === 'string' && head.slug.trim() ? head.slug.trim() : agentId).slice(0, 80),
      role: null,
      state: 'working',
      model: null,
      startedAt: toIsoOrNull(head?.timestamp),
      lastActivityAt: isoFromMs(fs.statSync(file).mtimeMs),
      preview: previewText(fs.readFileSync(file, { encoding: 'utf8' }).split('\n').slice(0, 6).find(line => line.includes('"user"'))),
      transcript: 'available',
    });
  }
  // Claude removes a child's transcript directory when that child finishes, so a finished
  // child leaves only the parent's tool result; Vade never invents turns for it.
  return sec(children, children.length ? 'ready' : 'empty');
}

/** CodeBuddy persists a child as an ordinary session whose id starts with `agent-` and whose
 *  recorded session-meta names its parent. `_fromSubAgent` is an in-memory flag, not a row. */
function codeBuddySection(record: SessionRecord): Section<Subagent[]> {
  const parent = record.providerThreadId;
  if (!parent) return sec([], 'empty');
  const root = path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects');
  const file = findById(root, parent, 1);
  if (!file) return sec([], 'empty');
  const directory = path.dirname(file);
  let names: string[] = [];
  try { names = fs.readdirSync(directory).filter(name => /^agent-.+\.jsonl$/.test(name)).slice(0, MAX_CHILDREN); } catch { return sec([], 'empty'); }
  const children: Subagent[] = [];
  for (const name of names) {
    const childFile = path.join(directory, name);
    let head: any = null;
    try { head = JSON.parse(firstLine(childFile) ?? 'null'); } catch { continue; }
    const meta = head?.meta && typeof head.meta === 'object' ? head.meta : {};
    // Persisted meta keys may be namespaced (`codebuddy.ai/parentSessionId`).
    const link = ['parentSessionId', 'parent_session_id', 'parentId'].map(key => meta[key]).find(value => typeof value === 'string')
      ?? Object.entries(meta).filter(([key]) => /parentSessionId$/i.test(key)).map(([, value]) => value).find(value => typeof value === 'string')
      ?? (typeof head?.parentSessionId === 'string' ? head.parentSessionId : undefined);
    if (link !== parent) continue;
    const childSessionId = typeof head?.sessionId === 'string' && head.sessionId ? head.sessionId : name.replace(/\.jsonl$/, '');
    const id = remember(childId(record, 'codebuddy', childSessionId), { kind: 'file', file: childFile, provider: 'codebuddy' });
    children.push({
      id,
      label: (typeof meta.agentName === 'string' && meta.agentName.trim() ? meta.agentName.trim()
        : typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : childSessionId).slice(0, 80),
      role: typeof meta.parentToolCallId === 'string' ? meta.parentToolCallId.slice(0, 120) : null,
      state: typeof meta.status === 'string' && ['running', 'completed', 'failed'].includes(meta.status) ? meta.status as Subagent['state'] : 'unknown',
      model: null,
      startedAt: isoFromMs(head?.timestamp),
      lastActivityAt: isoFromMs(fs.statSync(childFile).mtimeMs),
      preview: null,
      transcript: 'available',
    });
  }
  return sec(children, children.length ? 'ready' : 'empty');
}

/** Antigravity records subagent invocations in the parent session transcript and child
 *  sessions in `brain/<childId>/` with their own transcript and message receipts. */
function antigravitySection(record: SessionRecord): Section<Subagent[]> {
  const parent = record.providerThreadId;
  if (!parent || !/^[a-zA-Z0-9_-]+$/.test(parent)) return sec([], 'empty');
  const base = process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR ||
    path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.gemini', 'antigravity-cli');
  const brainDir = path.join(base, 'brain');
  const parentTranscript = path.join(brainDir, parent, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(parentTranscript)) return sec([], 'empty');

  const discovered = new Map<string, { label: string; role: string | null; prompt: string | null; startedAt: ISO | null }>();
  let parentLines: string[] = [];
  try {
    parentLines = fs.readFileSync(parentTranscript, 'utf8').split('\n').filter(Boolean);
  } catch {
    return sec([], 'empty');
  }

  let latestInvoke: Array<{ Role?: string; TypeName?: string; Prompt?: string }> = [];
  for (const line of parentLines) {
    try {
      const row = JSON.parse(line);
      if (Array.isArray(row.tool_calls)) {
        for (const tc of row.tool_calls) {
          if (tc.name === 'invoke_subagent') {
            let args = tc.args;
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch {}
            }
            const subs = args?.Subagents ? (typeof args.Subagents === 'string' ? JSON.parse(args.Subagents) : args.Subagents) : [args];
            latestInvoke = (Array.isArray(subs) ? subs : [subs]).filter(Boolean);
          }
        }
      }
      if (typeof row.content === 'string' && /Created the following subagents?:/i.test(row.content)) {
        const match = row.content.match(/Created the following subagents?:\s*([\s\S]*?)(?:\nThe subagents?|\n*$)/i);
        if (match) {
          try {
            const data = JSON.parse(match[1]);
            const list = Array.isArray(data) ? data : [data];
            list.forEach((item: any, idx: number) => {
              if (item?.conversationId && typeof item.conversationId === 'string') {
                const inv = latestInvoke[idx] || latestInvoke[0] || {};
                const label = inv.Role || inv.TypeName || 'subagent';
                const role = inv.TypeName || inv.Role || null;
                discovered.set(item.conversationId, {
                  label,
                  role,
                  prompt: inv.Prompt || null,
                  startedAt: toIsoOrNull(row.created_at),
                });
              }
            });
          } catch {}
        }
      }
      if (typeof row.content === 'string') {
        const convMatches = row.content.matchAll(/conversation:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi);
        for (const cm of convMatches) {
          if (cm[1] && !discovered.has(cm[1])) {
            discovered.set(cm[1], {
              label: 'subagent',
              role: null,
              prompt: null,
              startedAt: toIsoOrNull(row.created_at),
            });
          }
        }
      }
      if (typeof row.content === 'string' && row.content.includes('active subagent(s):')) {
        const match = row.content.match(/active subagent\(s\):\s*([\s\S]*?)(?:\n*$)/);
        if (match) {
          try {
            const list = JSON.parse(match[1]);
            if (Array.isArray(list)) {
              for (const item of list) {
                if (item?.conversationId && typeof item.conversationId === 'string') {
                  const existing = discovered.get(item.conversationId) ?? {
                    label: item.role || item.type || 'subagent',
                    role: item.type || item.role || null,
                    prompt: null,
                    startedAt: toIsoOrNull(row.created_at),
                  };
                  if (item.role) existing.label = item.role;
                  if (item.type) existing.role = item.type;
                  discovered.set(item.conversationId, existing);
                }
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Scan brain directories for any child subagents assigned by this parent
  try {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === parent) continue;
      const cid = entry.name;
      if (discovered.has(cid)) continue;
      const mDir = path.join(brainDir, cid, '.system_generated', 'messages');
      if (!fs.existsSync(mDir)) continue;
      try {
        const mFiles = fs.readdirSync(mDir).filter(f => f.endsWith('.json'));
        for (const mf of mFiles) {
          try {
            const msgData = JSON.parse(fs.readFileSync(path.join(mDir, mf), 'utf8'));
            if (msgData.sender === parent) {
              discovered.set(cid, {
                label: 'subagent',
                role: null,
                prompt: typeof msgData.content === 'string' ? msgData.content : null,
                startedAt: toIsoOrNull(msgData.timestamp),
              });
              break;
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  // Correlate with verified child message receipts for non-truncated role & type names
  for (const [childConversationId, meta] of discovered) {
    const messagesDir = path.join(brainDir, childConversationId, '.system_generated', 'messages');
    if (fs.existsSync(messagesDir)) {
      try {
        const mFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
        for (const mf of mFiles) {
          try {
            const msgData = JSON.parse(fs.readFileSync(path.join(messagesDir, mf), 'utf8'));
            if (msgData.sender === parent && msgData.sourceMetadata?.tool?.toolCall) {
              const call = msgData.sourceMetadata.tool.toolCall;
              let args = call.argumentsJson;
              if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch {}
              }
              const subList = Array.isArray(args?.Subagents) ? args.Subagents : [args];
              const sub = subList[0] || {};
              if (sub.Role) meta.label = sub.Role;
              if (sub.TypeName) meta.role = sub.TypeName;
              if (sub.Prompt) meta.prompt = sub.Prompt;
              break;
            }
          } catch {}
        }
      } catch {}
    }
  }

  const children: Subagent[] = [];
  for (const [cid, meta] of discovered) {
    if (children.length >= MAX_CHILDREN) break;
    const childFile = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(childFile)) {
      const id = remember(childId(record, 'antigravity', cid), { kind: 'unavailable', reason: 'Child transcript not found on disk.' });
      children.push({
        id,
        label: meta.label,
        role: meta.role,
        state: 'unknown',
        model: null,
        startedAt: meta.startedAt,
        lastActivityAt: null,
        preview: null,
        transcript: 'unavailable',
        reason: 'Child transcript not found on disk.',
      });
      continue;
    }
    const stat = fs.statSync(childFile);
    const tail = tailText(childFile);
    const tailLines = tail.trim().split('\n').reverse();
    let state: Subagent['state'] = 'unknown';
    for (const l of tailLines.slice(0, 20)) {
      try {
        const j = JSON.parse(l);
        if (j.type !== 'EPHEMERAL_MESSAGE') {
          state = j.status === 'RUNNING' ? 'working' : j.status === 'ERROR' ? 'failed' : j.status === 'DONE' ? 'completed' : 'unknown';
          break;
        }
      } catch {}
    }
    if (state === 'unknown' && tail.length > 0) state = 'completed';
    const preview = lastAssistantPreview(tail);
    const id = remember(childId(record, 'antigravity', cid), { kind: 'file', file: childFile, provider: 'antigravity' });
    children.push({
      id,
      label: meta.label,
      role: meta.role,
      state,
      model: null,
      startedAt: meta.startedAt ?? isoFromMs(stat.birthtimeMs),
      lastActivityAt: isoFromMs(stat.mtimeMs),
      preview,
      transcript: 'available',
    });
  }
  children.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return sec(children, children.length ? 'ready' : 'empty');
}

function compute(record: SessionRecord): Promise<Section<Subagent[]>> {
  switch (record.provider) {
    case 'codex': return Promise.resolve(codexSection(record));
    case 'claude': return Promise.resolve(claudeSection(record));
    case 'opencode': case 'opencode2': case 'kilo': return Promise.resolve(openCodeSection(record));
    case 'dsh': return dshSection(record);
    case 'codebuddy': return Promise.resolve(codeBuddySection(record));
    case 'antigravity': return Promise.resolve(antigravitySection(record));
    default: return Promise.resolve(sec<Subagent[]>([], 'unsupported', 'This provider does not record child agents.'));
  }
}

function cacheKey(record: SessionRecord): string {
  const provider = record.provider;
  const root = provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
    : provider === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
    : provider === 'dsh' ? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions', '--' + record.cwd.replace(/[:\\/]+/g, '-') + '--')
    : provider === 'codebuddy' ? path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects')
    : provider === 'antigravity' ? (record.providerThreadId ? path.join(process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'brain', record.providerThreadId, '.system_generated', 'logs', 'transcript.jsonl') : '')
    : '';
  return `${record.provider}:${record.providerThreadId ?? record.id}:${root}:${root ? stampOf(root) : ''}`;
}

/** Tests observe a fresh read after changing recorded bytes. */
export function resetSubagentDiscoveryCache(): void {
  cache.clear();
  pending.clear();
  handles.clear();
}

export async function discoverSubagents(record: SessionRecord): Promise<Section<Subagent[]>> {
  let key: string;
  try { key = cacheKey(record); } catch { key = `${record.provider}:${record.id}`; }
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = compute(record)
    .catch(() => sec<Subagent[]>(null, 'unavailable', 'Child agents could not be read for this session.'))
    .then(value => {
      pending.delete(key);
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), stamp: key, value });
      return value;
    });
  pending.set(key, task);
  return task;
}

/** A provider schema difference in tool records must never hide the child's conversation. */
function readTools(read: () => import('../../../shared/contracts.js').ToolActivity[]): import('../../../shared/contracts.js').ToolActivity[] {
  try { return read(); } catch { return []; }
}

function page(sourceIdentity: string, messages: ConversationPage['messages'], nextCursor: string | null, limited: boolean, provider: string | null, cursor: string | null): Section<ConversationPage> {
  const now = new Date().toISOString();
  return { data: { messages, source: 'transcript', sourceIdentity, provider, cursor, nextCursor, limited, truncated: false, warnings: [] },
    meta: { availability: messages.length ? 'ready' : 'empty', observedAt: now, attemptedAt: now, partial: limited, stale: false, issue: null } };
}

/** One recorded child's own public turns and observed tool calls. Returns `unavailable`
 *  rather than an empty page when the provider keeps no separate child transcript. */
export async function readSubagentTranscript(record: SessionRecord, subagentId: Id, query: NodeDetailsQuery = {}): Promise<SubagentConversation> {
  if (!handles.has(subagentId)) {
    try { await compute(record); } catch { /* Fall through to the explicit unavailable answer. */ }
  }
  const handle = handles.get(subagentId);
  const empty = (message: string): SubagentConversation => ({ conversation: sec<ConversationPage>(null, 'unavailable', message), tools: [] });
  if (!handle) return empty('This child agent is no longer recorded. Refresh the session.');
  if (handle.kind === 'unavailable') return empty(handle.reason);
  const sourceIdentity = hashId('subsrc', `${record.provider}:${record.providerThreadId ?? record.id}:${subagentId}`);
  const expected = { projectId: record.projectId, nodeId: subagentId, runId: null, sourceIdentity };
  const limit = Math.min(200, Math.max(1, query.limit ?? 20));
  try {
    if (handle.kind === 'database') {
      const cursor = query.cursor ? validateStoredCursor(query.cursor, expected) : null;
      if (cursor && cursor.direction !== query.direction) throw new Error('Cursor direction changed');
      const offset = cursor ? Number(cursor.upstreamCursor) : null;
      const read = handle.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      const result = read(handle.file, handle.childId, offset, limit, query.direction);
      const messages = result.lines.flatMap(line => {
        const message = project(line, handle.provider, sourceIdentity);
        return message ? [message] : [];
      });
      const nextCursor = query.direction === 'older' && !result.hasMore ? null : issueStoredCursor({ ...expected, upstreamCursor: String(result.nextByteOffset),
        direction: query.direction, sourceMode: 'opencode-db' });
      return {
        conversation: page(sourceIdentity, messages, nextCursor, result.limited || result.hasMore, handle.provider, query.cursor ?? null),
        tools: readTools(() => mergeToolActivity(databaseToolActivity(handle.file, handle.childId))),
      };
    }
    const stat = fs.statSync(handle.file);
    const cursor = query.cursor ? validateStoredCursor(query.cursor, expected) : null;
    const older = query.direction === 'older';
    const from = cursor ? Number(cursor.upstreamCursor) : older ? stat.size : stat.size;
    const provider = handle.kind === 'inline' ? 'claude' : handle.provider;
    const include = (line: string): boolean => {
      if (handle.kind === 'inline') return line.includes(`"agentId":"${handle.agentId}"`) && (Boolean(project(line, 'claude', sourceIdentity, true)) || transcriptToolActivity('claude', handle.agentId, line).length > 0);
      // A child's own file contains only that child's rows, which Claude marks as sidechain.
      return Boolean(project(line, handle.provider, sourceIdentity, handle.provider === 'claude')) || transcriptToolActivity(handle.provider, subagentId, line).length > 0;
    };
    const result = await readOlderTranscriptLines(handle.file, from, limit, 1024 * 1024, false, include);
    const messages = result.lines.flatMap(line => {
      const message = handle.kind === 'inline' ? project(line, 'claude', sourceIdentity, true) : project(line, handle.provider, sourceIdentity, handle.provider === 'claude');
      return message ? [message] : [];
    });
    // Tool calls are read from the same bounded page so their order matches the turns.
    const tools = readTools(() => mergeToolActivity(result.lines.flatMap(line => transcriptToolActivity(provider, handle.kind === 'inline' ? handle.agentId : subagentId, line))));
    const nextCursor = !result.hasMore ? null : issueStoredCursor({ ...expected, upstreamCursor: String(result.nextByteOffset),
      direction: 'older', sourceMode: 'coordinator-transcript' });
    return { conversation: page(sourceIdentity, messages, nextCursor, result.limited || result.hasMore, provider, query.cursor ?? null), tools };
  } catch (error) {
    return empty(error instanceof Error ? error.message : 'The child transcript could not be read.');
  }
}

function projectAntigravity(line: string, sourceIdentity: string): ConversationPage['messages'][number] | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'SYSTEM_MESSAGE' && typeof obj.content === 'string') {
      const match = obj.content.match(/\[Message\][\s\S]*?\bcontent=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/);
      if (match && match[1].trim()) {
        const text = match[1].trim();
        const msgId = hashId('msg', `${sourceIdentity}:${obj.step_index ?? hashId('record', line)}`);
        return { id: msgId, role: 'user', text, at: toIsoOrNull(obj.created_at) };
      }
    }
    const parsed = parseAntigravityTranscriptLine(line, sourceIdentity);
    if (!parsed.omitted && parsed.message) {
      return parsed.message;
    }
    return null;
  } catch {
    return null;
  }
}

function project(line: string, provider: string, sourceIdentity: string, includeSidechain = false): ConversationPage['messages'][number] | null {
  if (provider === 'antigravity') {
    return projectAntigravity(line, sourceIdentity);
  }
  const record = publicTranscriptRecord(line, provider, includeSidechain);
  if (!record) return null;
  const payload = record.payload ?? {};
  if (record.type !== 'response_item' || (payload.type !== 'message' && !payload.role)) return null;
  const role = payload.role === 'assistant' ? 'agent' as const : payload.role === 'user' ? 'user' as const : null;
  if (!role) return null;
  const blocks: any[] = Array.isArray(payload.content) ? payload.content : [];
  const text = blocks.filter(block => ['output_text', 'input_text', 'text'].includes(block?.type) && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim();
  if (!text) return null;
  const rawId = payload.id ?? hashId('record', line);
  return { id: hashId('msg', `${sourceIdentity}:${rawId}`), role, text, at: toIsoOrNull(record.timestamp) };
}
