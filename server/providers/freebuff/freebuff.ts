import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  AgentChatModel,
  AgentChatOptions,
  AgentContextUsage,
  ConversationMessage,
  ConversationPage,
  ConversationRound,
  ProviderActivity,
  ToolActivity,
} from '../../../shared/contracts.js';
import type { SessionRecord } from '../../runtime/store.js';
import { isPathInsideRoots, toIsoOrNull } from '../common/transcriptUtils.js';
import { toolActivityFromCall } from '../common/toolActivity.js';
import { FREEBUFF_BUNDLED_MODELS, freebuffContextWindow, freebuffModelsFromCatalog } from './freebuffCatalog.js';

export const validFreebuffId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:\-T+Z]{0,119}$/.test(id);

export function freebuffConfigDir(): string {
  const custom = process.env.FREEBUFF_CONFIG_DIR;
  if (custom && path.isAbsolute(custom)) return custom;
  return path.join(os.homedir(), '.config', 'manicode');
}

export function freebuffProjectsDir(): string {
  return path.join(freebuffConfigDir(), 'projects');
}

export function freebuffProjectChatsDir(cwd: string): string {
  return path.join(freebuffProjectsDir(), path.basename(cwd), 'chats');
}

/** The account record the native CLI stores next to its token. Display metadata only. */
export interface FreebuffAccount { id: string; label: string }

function readJsonFile(file: string): any {
  try {
    const handle = fs.openSync(file, 'r');
    try {
      if (fs.fstatSync(handle).size > 65536) return null;
      return JSON.parse(fs.readFileSync(handle, 'utf8'));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

export function freebuffAccount(): FreebuffAccount | null {
  const record = readJsonFile(path.join(freebuffConfigDir(), 'credentials.json'));
  const entry = record?.default ?? record;
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id.slice(0, 128) : '';
  const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 120) : '';
  const email = typeof entry.email === 'string' ? entry.email.trim().slice(0, 160) : '';
  const label = name && email ? `${name} (${email})` : email || name || '';
  return label ? { id: id || 'system', label } : null;
}

let cachedFreebuffToken: { token: string | null; readAt: number } | null = null;
/** The native token, read from the credentials file or (Windows) the Credential Manager
 *  entry `Bun.secrets` wrote as `freebuff-cli/<credentials path>`. Never logged or sent. */
export async function freebuffToken(): Promise<string | null> {
  if (cachedFreebuffToken && Date.now() - cachedFreebuffToken.readAt < 60000) return cachedFreebuffToken.token;
  const credPath = path.join(freebuffConfigDir(), 'credentials.json');
  const entry = readJsonFile(credPath)?.default ?? readJsonFile(credPath);
  if (typeof entry?.authToken === 'string' && entry.authToken.length > 0) {
    cachedFreebuffToken = { token: entry.authToken, readAt: Date.now() };
    return entry.authToken;
  }
  if (entry?.tokenStore === 'keychain' && process.platform === 'win32') {
    // The marshalled struct's field names must differ from the struct name, or
    // Add-Type rejects the whole source and every read returns nothing.
    const target = `freebuff-cli/${credPath}`;
    const ps = `Add-Type @'\nusing System; using System.Runtime.InteropServices; public class FreebuffCredential { [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CredRead(string t, int ty, int r, out IntPtr p); [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Record { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; } public static string Read(string t) { IntPtr p; if (CredRead(t, 1, 0, out p)) { var c = (Record)Marshal.PtrToStructure(p, typeof(Record)); byte[] b = new byte[c.BlobSize]; Marshal.Copy(c.Blob, b, 0, c.BlobSize); return System.Text.Encoding.UTF8.GetString(b); } return null; } }\n'@; [FreebuffCredential]::Read('${target.replace(/'/g, "''")}')`;
    const result = await new Promise<string>((resolve) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        resolve(!error && stdout ? stdout.trim() : '');
      });
    });
    const token = result || null;
    cachedFreebuffToken = { token, readAt: Date.now() };
    return token;
  }
  cachedFreebuffToken = { token: null, readAt: Date.now() };
  return null;
}

const CATALOG_URL = 'https://www.codebuff.com/api/v1/freebuff/models';
const CATALOG_MIN_TTL_MS = 5 * 60 * 1000;
const CATALOG_MAX_TTL_MS = 30 * 60 * 1000;
const CATALOG_RETRY_MS = 30 * 1000;
let catalogCache: { at: number; models: AgentChatModel[]; live: boolean; ttl: number } | null = null;
let catalogRefresh: Promise<void> | null = null;
let catalogLoadedFromDisk = false;

/** ADE's own storage, so the last live catalog survives a restart. The provider endpoint
 *  is slow on some networks; a stale copy is still more accurate than the bundled table. */
function catalogCacheFile(): string {
  const directory = process.env.ADE_DATA_DIR ?? path.join(os.homedir(), '.ade');
  return path.join(directory, 'freebuff-catalog.json');
}

function loadCachedCatalog(): void {
  if (catalogLoadedFromDisk) return;
  catalogLoadedFromDisk = true;
  try {
    const file = catalogCacheFile();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 262_144) return;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = freebuffModelsFromCatalog(saved?.payload);
    if (!models.length) return;
    const fetchedAt = typeof saved?.fetchedAt === 'number' ? saved.fetchedAt : 0;
    const expiresAt = typeof saved?.expiresAt === 'number' ? saved.expiresAt : 0;
    catalogCache = { at: fetchedAt, models, live: true, ttl: Math.max(0, expiresAt - fetchedAt) };
  } catch { /* No usable cache: the bundled table and a live refresh remain. */ }
}

function saveCachedCatalog(payload: unknown, ttl: number): void {
  try {
    const file = catalogCacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ fetchedAt: Date.now(), expiresAt: Date.now() + ttl, payload }));
    fs.renameSync(temporary, file);
  } catch { /* A cache that cannot be written only costs a later fetch. */ }
}

/** Fetch the account's catalog once, sharing concurrent readers. */
function refreshFreebuffCatalog(): Promise<void> {
  if (catalogRefresh) return catalogRefresh;
  const settle = (models: AgentChatModel[], live: boolean, ttl = CATALOG_RETRY_MS) => {
    catalogCache = { at: Date.now(), models, live, ttl };
  };
  catalogRefresh = (async () => {
    const token = await freebuffToken();
    if (token) {
      try {
        const response = await fetch(CATALOG_URL, {
          headers: { Authorization: `Bearer ${token}`, 'x-freebuff-catalog-protocol': '1', 'x-freebuff-client': 'cli' },
          signal: AbortSignal.timeout(20000),
          redirect: 'error',
        });
        if (response.ok) {
          const payload = await response.json();
          const models = freebuffModelsFromCatalog(payload);
          if (models.length) {
            // The response states its own refresh time; a host clock far off is clamped.
            const refreshAt = Number(payload?.refreshAt);
            const ttl = Number.isFinite(refreshAt)
              ? Math.min(CATALOG_MAX_TTL_MS, Math.max(CATALOG_MIN_TTL_MS, refreshAt - Date.now()))
              : CATALOG_MIN_TTL_MS;
            settle(models, true, ttl);
            saveCachedCatalog(payload, ttl);
            return;
          }
        } else {
          await response.body?.cancel();
        }
      } catch { /* Offline or rejected: keep what is cached and retry later. */ }
    }
    settle(FREEBUFF_BUNDLED_MODELS, false);
  })().finally(() => { catalogRefresh = null; });
  return catalogRefresh;
}

/** The models this account may actually use, from the provider's own catalog endpoint.
 *  A cached copy is returned immediately while a refresh runs; only a cold start waits,
 *  and even then the bundled CLI catalog keeps the picker usable. */
export async function readFreebuffCatalog(options: { waitMs?: number } = {}): Promise<{ models: AgentChatModel[]; source: 'live' | 'bundled' }> {
  loadCachedCatalog();
  const cached = catalogCache;
  if (cached && Date.now() - cached.at < cached.ttl) return { models: cached.models, source: cached.live ? 'live' : 'bundled' };
  const pending = refreshFreebuffCatalog();
  // A stale-but-real catalog is better than blocking the picker on a slow network.
  if (cached?.live) return { models: cached.models, source: 'live' };
  const waitMs = options.waitMs ?? 2000;
  if (waitMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
  }
  const observed = catalogCache;
  return observed
    ? { models: observed.models, source: observed.live ? 'live' : 'bundled' }
    : { models: FREEBUFF_BUNDLED_MODELS, source: 'bundled' };
}

/** The last catalog read, for synchronous callers such as context accounting. */
export function freebuffCachedModels(): AgentChatModel[] {
  return catalogCache?.models ?? FREEBUFF_BUNDLED_MODELS;
}
export function freebuffChatDir(cwd: string, threadId: string): string {
  return path.join(freebuffProjectChatsDir(cwd), threadId);
}

export function freebuffTranscript(directory: string, record: SessionRecord): { file: string; root: string } {
  const root = freebuffProjectsDir();
  const threadId = record.providerThreadId;
  if (!threadId) throw new Error('Freebuff session has no bound chat ID');
  const chatFolder = freebuffChatDir(record.cwd, threadId);
  const file = path.join(chatFolder, 'chat-messages.json');
  return { file, root };
}

export function freebuffBinding(record: SessionRecord): string | undefined {
  if (record.provider !== 'freebuff') return record.providerThreadId;
  if (record.providerThreadId && validFreebuffId(record.providerThreadId)) {
    return record.providerThreadId;
  }
  const chatsDir = freebuffProjectChatsDir(record.cwd);
  try {
    if (!fs.existsSync(chatsDir)) return undefined;
    const entries = fs.readdirSync(chatsDir, { withFileTypes: true });
    const candidates = entries
      .filter(entry => entry.isDirectory() && validFreebuffId(entry.name))
      .map(entry => {
        const full = path.join(chatsDir, entry.name);
        try {
          return { id: entry.name, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { id: string; mtime: number } => item !== null)
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length > 0) {
      return candidates[0].id;
    }
  } catch {
    // Filesystem read error or unreadable directory
  }
  return undefined;
}

export function freebuffResumable(record: SessionRecord): boolean {
  if (record.provider !== 'freebuff' || !record.providerThreadId) return false;
  const chatFolder = freebuffChatDir(record.cwd, record.providerThreadId);
  return (
    fs.existsSync(path.join(chatFolder, 'chat-messages.json')) ||
    fs.existsSync(path.join(chatFolder, 'log.jsonl')) ||
    fs.existsSync(path.join(chatFolder, 'run-state.json'))
  );
}

export function readFreebuffMessages(file: string): any[] {
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Settings the native CLI writes for its own next message. Only observed values are
 *  returned: an unconfigured CLI has no model, and a default is never invented. */
export function readFreebuffModel(_file: string, _threadId: string): { model?: string; effort?: string } {
  try {
    const settingsFile = path.join(freebuffConfigDir(), 'settings.json');
    if (!fs.existsSync(settingsFile)) return {};
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const model = typeof settings.freebuffModelKey === 'string' ? settings.freebuffModelKey
      : typeof settings.freebuffModel === 'string' ? settings.freebuffModel
      : undefined;
    if (!model) return {};
    const effort = settings.freebuffReasoningEfforts?.[model] ?? settings.freebuffCatalogReasoningEfforts?.[model];
    return { model, ...(typeof effort === 'string' ? { effort } : {}) };
  } catch {
    return {};
  }
}

const FOOTER_EFFORT = /^(low|medium|high|xhigh|max)$/;

/** Freebuff has no model/effort launch flags. A new process reads these settings at
 *  startup, so a workflow launch writes them before spawning. This runs only outside
 *  a live TUI, never while the native store owns the file. */
export function writeFreebuffLaunchSettings(option: { model?: string; effort?: string }): void {
  const directory = freebuffConfigDir();
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'settings.json');
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* A new settings file. */ }
  if (typeof option.model === 'string' && option.model) settings.freebuffModel = option.model;
  const model = typeof option.model === 'string' && option.model ? option.model : settings.freebuffModel;
  if (typeof option.effort === 'string' && option.effort && typeof model === 'string' && model) {
    settings.freebuffReasoningEfforts = { ...(settings.freebuffReasoningEfforts ?? {}), [model]: option.effort };
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2));
  fs.renameSync(temporary, file);
}

/** The native status line is the running session's own effective model:
 *  ` DeepSeek V4.1 Flash 10/17 • high · ~\path · /model to change · Chat: …`.
 *  It is read from the rendered screen, so a setting changed in Terminal or in the
 *  native picker is reflected without re-reading a settings file. */
export function freebuffFooterModel(screen: string): { model?: string; effort?: string; label?: string } {
  for (const raw of screen.split('\n').reverse()) {
    const line = raw.replace(/\s+$/, '');
    if (!/\/model to change/.test(line)) continue;
    const marker = line.indexOf('·');
    if (marker < 0) continue;
    const head = line.slice(0, marker).trim();
    const separator = head.lastIndexOf('•');
    if (separator < 0) return { label: head };
    const label = head.slice(0, separator).trim();
    const effort = head.slice(separator + 1).trim();
    if (!label) return {};
    return {
      label,
      ...(FOOTER_EFFORT.test(effort) ? { effort } : {}),
    };
  }
  return {};
}

export function freebuffTools(file: string, threadId: string): ToolActivity[] {
  const messages = readFreebuffMessages(file);
  const activities: ToolActivity[] = [];
  for (const msg of messages) {
    if (msg.variant !== 'ai' || !Array.isArray(msg.blocks)) continue;
    const timestamp = toIsoOrNull(msg.timestamp) ?? new Date().toISOString();
    for (let idx = 0; idx < msg.blocks.length; idx++) {
      const block = msg.blocks[idx];
      if (block?.type !== 'tool' || !block.toolName) continue;
      const id = block.toolCallId ?? `call:${msg.id ?? 'ai'}:${idx}`;
      const item = toolActivityFromCall(threadId, id, block.toolName, block.input, timestamp);
      if (item) activities.push(item);
    }
  }
  return activities;
}

export function freebuffProviderActivities(file: string): ProviderActivity[] {
  const messages = readFreebuffMessages(file);
  const items: ProviderActivity[] = [];
  for (const msg of messages) {
    if (msg.variant !== 'ai' || !Array.isArray(msg.blocks)) continue;
    const timestamp = toIsoOrNull(msg.timestamp);
    for (const block of msg.blocks) {
      if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
        items.push({
          id: `reasoning:${msg.id ?? 'ai'}`,
          at: timestamp,
          kind: 'reasoning',
          state: 'recorded',
        });
      }
    }
  }
  return items;
}

export function readFreebuffPage(
  file: string,
  threadId: string,
  query: { direction?: 'older' | 'newer'; limit?: number } = {},
): { messages: ConversationMessage[]; tools: ToolActivity[]; activities: ProviderActivity[] } {
  const raw = readFreebuffMessages(file);
  const messages: ConversationMessage[] = [];
  const tools: ToolActivity[] = [];
  const activities: ProviderActivity[] = [];

  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    const timestamp = toIsoOrNull(item.timestamp);
    if (item.variant === 'user') {
      const text = typeof item.content === 'string' ? item.content : '';
      messages.push({
        id: item.id ?? `user-${idx}`,
        role: 'user',
        text,
        at: timestamp,
      });
    } else if (item.variant === 'ai') {
      let text = typeof item.content === 'string' ? item.content : '';
      if (Array.isArray(item.blocks)) {
        for (let bIdx = 0; bIdx < item.blocks.length; bIdx++) {
          const block = item.blocks[bIdx];
          if (block?.type === 'tool' && block.toolName) {
            const toolCallId = block.toolCallId ?? `call:${item.id ?? idx}:${bIdx}`;
            const activity = toolActivityFromCall(threadId, toolCallId, block.toolName, block.input, timestamp ?? new Date().toISOString());
            if (activity) tools.push(activity);
          } else if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
            activities.push({
              id: `reasoning:${item.id ?? idx}:${bIdx}`,
              at: timestamp,
              kind: 'reasoning',
              state: 'recorded',
            });
          }
        }
      }
      messages.push({
        id: item.id ?? `agent-${idx}`,
        role: 'agent',
        text,
        at: timestamp,
      });
    }
  }

  return { messages, tools, activities };
}

export function freebuffNativeRounds(file: string, threadId: string, source: string): ConversationRound[] {
  const raw = readFreebuffMessages(file);
  const rounds: ConversationRound[] = [];
  let currentPrompt: { id: string; at: string | null } | null = null;
  let responseEnd: string | null = null;

  const flush = () => {
    if (currentPrompt) {
      const started = currentPrompt.at ?? new Date(0).toISOString();
      const ended = responseEnd ?? started;
      const startMs = Date.parse(started) || 0;
      const endMs = Date.parse(ended) || startMs;
      rounds.push({
        id: `round:${currentPrompt.id}`,
        messageIds: [currentPrompt.id],
        startedAt: started,
        endedAt: ended,
        outcome: 'completed',
        workedMs: Math.max(0, endMs - startMs),
        partial: false,
        measurement: 'native-duration',
      });
    }
    currentPrompt = null;
    responseEnd = null;
  };

  for (const item of raw) {
    const timestamp = toIsoOrNull(item.timestamp);
    if (item.variant === 'user') {
      flush();
      currentPrompt = {
        id: item.id ?? `user-${rounds.length}`,
        at: timestamp,
      };
    } else if (item.variant === 'ai' && currentPrompt) {
      responseEnd = timestamp ?? responseEnd;
    }
  }
  flush();
  return rounds;
}

export function freebuffContextUsage(record: SessionRecord): AgentContextUsage {
  const { model } = readFreebuffModel(
    path.join(freebuffChatDir(record.cwd, record.providerThreadId ?? 'default'), 'chat-messages.json'),
    record.providerThreadId ?? '',
  );
  return {
    ...(model ? { model } : {}),
    usedTokens: null,
    windowTokens: model ? freebuffContextWindow(model, freebuffCachedModels()) ?? null : null,
    observedAt: new Date().toISOString(),
    source: 'freebuff',
    measurement: 'last-request',
    ...(model ? {} : { reason: 'The native CLI has not recorded a model for this session yet.' }),
  };
}
