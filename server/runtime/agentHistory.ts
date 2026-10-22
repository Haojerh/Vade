import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentHistorySession, AgentHistoryPage, AdeProvider } from '../../shared/contracts.js';
import type { AdeStore, SessionRecord } from './store.js';
import { publicMessage } from './conversation.js';
import { validCodexThreadId } from './codexThread.js';
import { agyConversationSaved } from './agyBinding.js';
import { CliError } from '../integrations/cli.js';
import { isPathInsideRoots } from '../integrations/orca/utils.js';

type Provider = Exclude<AdeProvider, 'terminal'>;
interface Indexed { id: string; provider: Provider; threadId: string; cwd: string | null; title: string; lastMessage: string | null; messageCount: number; limited: boolean; updatedAt: string; model: string | null; file: string; root: string }
const opaque = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
const clean = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const agyRoot = () => process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');

/** Bounded provider-native index. Paths and launch selectors never come from the browser. */
export class AgentHistory {
  private entries: Indexed[] = [];
  private parsed = new Map<string, { stamp: string; entry: Indexed | null }>();
  private pending?: Promise<void>;
  private scannedAt = 0;
  private scannedFiles = 0;
  private limited = false;
  private warnings: string[] = [];
  private closed = false;
  close(): void { this.closed = true; }
  private cacheKey = JSON.stringify([process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR, agyRoot(), os.homedir()]);
  constructor(private store: AdeStore) {
    try {
      const row = store.db.prepare("SELECT value FROM preferences WHERE key = 'history-index' AND length(value) <= 4000000").get();
      if (row) {
        const value = JSON.parse(String(row.value));
        const valid = (entry: Indexed | null) => {
          if (!entry) return true;
          const root = entry.provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
            : entry.provider === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects') : entry.provider === 'antigravity' ? path.join(agyRoot(), 'brain') : null;
          return root && typeof entry.file === 'string' && entry.file.length <= 4096 && entry.root === root && path.isAbsolute(entry.file)
            && path.relative(root, entry.file).split(path.sep)[0] !== '..' && validCodexThreadId(entry.threadId) && entry.id === opaque(`${entry.provider}:${entry.threadId}`);
        };
        if (value.key === this.cacheKey && Array.isArray(value.entries) && value.entries.length <= 2000 && value.entries.every((entry: Indexed) => Boolean(entry) && valid(entry))
          && Array.isArray(value.parsed) && value.parsed.length <= 2000 && value.parsed.every((row: any) => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1]?.stamp === 'string' && valid(row[1].entry))) {
          this.entries = value.entries; this.parsed = new Map(value.parsed); this.scannedAt = Number.isFinite(value.scannedAt) ? Math.min(Date.now(), value.scannedAt) : 0;
          this.scannedFiles = Number(value.scannedFiles) || 0; this.limited = Boolean(value.limited);
        }
      }
    } catch { /* Rebuild an unavailable index from bounded native sources. */ }
  }

  async refresh(force = false): Promise<void> {
    if (this.closed) return;
    if (!force && Date.now() - this.scannedAt < 30000) return;
    if (!this.pending) this.pending = this.scan().catch(() => { if (!this.closed) this.warnings = ['History refresh could not be completed. Refresh to retry.']; }).finally(() => { this.pending = undefined; });
    if (!force && this.entries.length) return;
    await this.pending;
  }

  private async scan(): Promise<void> {
    const candidates: { file: string; root: string; provider: Provider; size: number; mtime: number }[] = [];
    let remaining = 20000; this.warnings = []; this.limited = false;
    const roots: [Provider, string, number][] = [
      ['codex', path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), 3],
      ['claude', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'), 1],
      ['antigravity', path.join(agyRoot(), 'brain'), 4],
    ];
    const walk = async (directory: string, root: string, provider: Provider, depth: number): Promise<void> => {
      const handle = await fs.promises.opendir(directory);
      for await (const entry of handle) {
        if (--remaining < 0) { this.limited = true; break; }
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && depth) await walk(file, root, provider, depth - 1).catch(() => { this.warnings.push(`${provider}: a history folder could not be read.`); });
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && (provider !== 'antigravity' || (entry.name === 'transcript.jsonl' && path.relative(root, file).split(path.sep).slice(1).join('/') === '.system_generated/logs/transcript.jsonl'))) {
          const stat = await fs.promises.stat(file);
          candidates.push({ file, root, provider, size: stat.size, mtime: stat.mtimeMs });
        }
      }
    };
    for (const [provider, root, depth] of roots) {
      try { await walk(root, root, provider, depth); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warnings.push(`${provider}: history is unavailable.`); }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    this.scannedFiles = candidates.length;
    if (candidates.length > 2000) this.limited = true;
    let budget = 64 * 1024 * 1024;
    if (this.closed) return;
    const entries = new Map<string, Indexed>(), owned = this.store.projects().flatMap(project => this.store.sessions(project.id));
    const workspaces = await this.agyWorkspaces();
    const selected = candidates.slice(0, 2000);
    for (let offset = 0; offset < selected.length; offset += 4) {
      const rows = await Promise.all(selected.slice(offset, offset + 4).map(async candidate => {
        const stamp = `${candidate.mtime}:${candidate.size}`, cached = this.parsed.get(candidate.file);
        let row: Indexed | null;
        if (cached?.stamp === stamp) row = cached.entry;
        else {
          if (budget <= 0) { this.limited = true; return null; }
          const bytes = Math.min(candidate.size, 4 * 1024 * 1024, budget); budget -= bytes;
          try { row = await this.parse(candidate, bytes, workspaces); }
          catch { row = null; this.warnings.push(`${candidate.provider}: a session could not be indexed.`); }
          this.parsed.set(candidate.file, { stamp, entry: row });
        }
        return row;
      }));
      if (this.closed) return;
      for (let row of rows) {
        if (row) {
          const owner = owned.find(record => record.provider === row!.provider && record.providerThreadId === row!.threadId);
          if (owner) row = { ...row, cwd: owner.cwd, title: this.store.title(owner.id, row.title) };
          if (!entries.has(row.id)) entries.set(row.id, row);
        }
      }
    }
    this.entries = [...entries.values()]; this.scannedAt = Date.now();
    const files = new Set(candidates.slice(0, 2000).map(candidate => candidate.file));
    for (const file of this.parsed.keys()) if (!files.has(file)) this.parsed.delete(file);
    this.warnings = [...new Set(this.warnings)];
    const cache = JSON.stringify({ key: this.cacheKey, entries: this.entries, parsed: [...this.parsed], scannedAt: this.scannedAt, scannedFiles: this.scannedFiles, limited: this.limited });
    if (!this.closed && Buffer.byteLength(cache) <= 4000000) this.store.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('history-index', ?)").run(cache);
  }

  private async parse(candidate: { file: string; root: string; provider: Provider; size: number; mtime: number }, bytes: number, workspaces: Map<string, string | null>): Promise<Indexed | null> {
    const { file, root, provider } = candidate;
    if (!isPathInsideRoots(file, [root])) return null;
    const fd = await fs.promises.open(file, 'r');
    let text: string;
    try {
      if (candidate.size <= bytes) {
        const buffer = Buffer.alloc(bytes), result = await fd.read(buffer, 0, bytes, 0); text = buffer.subarray(0, result.bytesRead).toString('utf8');
      } else {
        const headBytes = Math.min(65536, Math.floor(bytes / 2)), tailBytes = bytes - headBytes;
        const head = Buffer.alloc(headBytes), tail = Buffer.alloc(tailBytes);
        await fd.read(head, 0, headBytes, 0); await fd.read(tail, 0, tailBytes, candidate.size - tailBytes);
        const prefix = head.toString('utf8'), suffix = tail.toString('utf8');
        text = prefix.slice(0, prefix.lastIndexOf('\n') + 1) + suffix.slice(suffix.indexOf('\n') + 1);
      }
    }
    finally { await fd.close(); }
    const limited = candidate.size > bytes;
    const lines = text.split('\n');
    let threadId: string | undefined, cwd: string | null = null;
    if (provider === 'antigravity') {
      threadId = path.relative(root, file).split(path.sep)[0];
      if (!validCodexThreadId(threadId) || !agyConversationSaved({ providerThreadId: threadId } as SessionRecord)) return null;
      cwd = workspaces.get(threadId) ?? null;
    } else {
      for (const line of lines.slice(0, 100)) {
        try {
          const row = JSON.parse(line), metadata = provider === 'codex' ? row.type === 'session_meta' ? row.payload : null : row;
          const id = provider === 'codex' ? metadata?.id : metadata?.sessionId;
          if (validCodexThreadId(id) && typeof metadata.cwd === 'string' && path.isAbsolute(metadata.cwd) && metadata.cwd.length <= 4096) { threadId = id; cwd = path.resolve(metadata.cwd); break; }
        } catch { /* Incomplete/non-metadata rows do not establish identity. */ }
      }
    }
    if (!threadId) return null;
    if (provider !== 'antigravity' && !path.basename(file).endsWith(`${threadId}.jsonl`)) return null;
    const id = opaque(`${provider}:${threadId}`), record = { provider, providerThreadId: threadId } as SessionRecord;
    let title = '', lastMessage: string | null = null, updatedAt = new Date(candidate.mtime).toISOString(), model: string | null = null;
    const messages = new Set<string>();
    for (const [index, line] of lines.entries()) {
      // Large JSONL scans must leave the HTTP/SSE event loop responsive.
      if (index && index % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      if (line.length > 1024 * 1024) continue;
      const message = publicMessage(record, line, id);
      if (message && !messages.has(message.id)) {
        messages.add(message.id); lastMessage = clean(message.text, 300);
        if (!title && message.role === 'user') title = clean(message.text, 120);
        if (message.at && Number.isFinite(Date.parse(message.at))) updatedAt = message.at;
      }
      try {
        const row = JSON.parse(line);
        if (provider === 'claude' && row.sessionId && row.sessionId !== threadId) continue;
        if (row.type === 'custom-title' && typeof row.customTitle === 'string') title = clean(row.customTitle, 120);
        const observed = provider === 'codex' && row.type === 'turn_context' ? row.payload?.model : provider === 'claude' ? row.message?.model : null;
        if (typeof observed === 'string' && observed !== '<synthetic>') model = clean(observed, 200);
      } catch { /* Malformed rows are not public history. */ }
    }
    return { id, provider, threadId, cwd, title: title || (provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : 'Antigravity'), lastMessage, messageCount: messages.size, limited, updatedAt, model, file, root };
  }

  private async agyWorkspaces(): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const add = (id: unknown, cwd: unknown) => {
      if (!validCodexThreadId(id) || typeof cwd !== 'string' || cwd.length > 4096 || !path.isAbsolute(cwd)) return;
      const normalized = path.resolve(cwd);
      result.set(id, result.has(id) && result.get(id) !== normalized ? null : normalized);
    };
    const read = async (name: string) => { try { const file = path.join(agyRoot(), name); if (!isPathInsideRoots(file, [agyRoot()]) || (await fs.promises.stat(file)).size > 4 * 1024 * 1024) return ''; return await fs.promises.readFile(file, 'utf8'); } catch { return ''; } };
    for (const line of (await read('history.jsonl')).split('\n').slice(-10000)) { try { const row = JSON.parse(line); add(row.conversationId, row.workspace); } catch {} }
    try {
      const last = JSON.parse(await read('cache/last_conversations.json'));
      for (const [cwd, id] of Object.entries(last).slice(0, 10000)) add(id, cwd);
    } catch {}
    try {
      const projects = JSON.parse(await read('cache/projects.json')), metadata = JSON.parse(await read('cache/conversation_metadata.json'));
      const paths = new Map<string, string>();
      for (const [key, value] of Object.entries(projects).slice(0, 10000)) if (typeof value === 'string') {
        if (path.isAbsolute(key)) paths.set(value, key); else if (path.isAbsolute(value)) paths.set(key, value);
      }
      for (const [id, value] of Object.entries(metadata.conversations ?? {}).slice(0, 10000)) add(id, paths.get((value as { summary?: { ProjectID?: string } }).summary?.ProjectID ?? ''));
    } catch {}
    return result;
  }

  async get(id: string): Promise<Indexed> {
    await this.refresh();
    const entry = this.entries.find(row => row.id === id);
    if (!entry || !isPathInsideRoots(entry.file, [entry.root])) throw new CliError('INVALID_ARGUMENT', 'This indexed session is no longer available. Refresh history.');
    // Re-read exact provider metadata before launching; cached browser IDs cannot select arbitrary files.
    const stat = await fs.promises.stat(entry.file);
    const verified = await this.parse({ ...entry, size: stat.size, mtime: stat.mtimeMs }, Math.min(stat.size, 4 * 1024 * 1024), await this.agyWorkspaces());
    if (!verified || verified.id !== id) throw new CliError('INVALID_ARGUMENT', 'The provider session identity changed. Refresh history.');
    return verified;
  }

  list(options: { scope: 'workspace' | 'project' | 'all'; projectId?: string; paths: string[]; workspace?: string; search: string; offset: number }, active: (projectId: string, nodeId: string) => boolean): AgentHistoryPage {
    const projects = this.store.projects(), owned = projects.flatMap(project => this.store.sessions(project.id));
    let sessions: AgentHistorySession[] = this.entries.map(row => {
      const owner = owned.find(record => record.provider === row.provider && record.providerThreadId === row.threadId);
      const cwd = owner?.cwd ?? row.cwd;
      const project = owner ? projects.find(project => project.id === owner.projectId) : projects.filter(project => cwd && project.paths.some(root => isPathInsideRoots(cwd, [root]))).sort((a,b) => b.paths[0].length - a.paths[0].length)[0];
      const inSelected = cwd && options.paths.some(root => isPathInsideRoots(cwd, [root]));
      const projectId = inSelected ? options.projectId ?? null : project?.id ?? null;
      const groupName = projectId ? projects.find(project => project.id === projectId)!.name : cwd ? path.basename(cwd) || cwd : 'Unknown workspace';
      const running = owned.find(record => !record.closed && record.provider === row.provider && record.providerThreadId === row.threadId && active(record.projectId, record.id));
      return { id: row.id, provider: row.provider, title: owner ? this.store.title(owner.id, row.title) : row.title, cwd, lastMessage: row.lastMessage, messageCount: row.messageCount, limited: row.limited, updatedAt: row.updatedAt, model: row.model, projectId, groupId: projectId ?? opaque(cwd ?? 'unknown'), groupName, activeNodeId: running?.id ?? null, activeProjectId: running?.projectId ?? null };
    });
    const projectTotals = new Map<string, number>();
    for (const row of sessions) projectTotals.set(row.groupId, (projectTotals.get(row.groupId) ?? 0) + 1);
    if (options.scope === 'workspace') sessions = sessions.filter(row => row.cwd && options.workspace && path.resolve(row.cwd) === path.resolve(options.workspace));
    if (options.scope === 'project') sessions = sessions.filter(row => row.projectId === options.projectId);
    const search = options.search.toLowerCase();
    if (search) sessions = sessions.filter(row => `${row.title} ${row.lastMessage ?? ''} ${row.cwd ?? ''} ${row.provider}`.toLowerCase().includes(search));
    sessions.sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
    const groups = new Map<string, { id: string; name: string; total: number; projectTotal: number }>();
    for (const row of sessions) { const group = groups.get(row.groupId) ?? { id: row.groupId, name: row.groupName, total: 0, projectTotal: projectTotals.get(row.groupId)! }; group.total++; groups.set(row.groupId, group); }
    return { refreshing: Boolean(this.pending), sessions: sessions.slice(options.offset, options.offset + 50), groups: [...groups.values()], total: sessions.length, indexed: this.entries.length, scannedFiles: this.scannedFiles, scannedAt: new Date(this.scannedAt).toISOString(), limited: this.limited, nextOffset: options.offset + 50 < sessions.length ? options.offset + 50 : null, warnings: this.warnings };
  }
}
