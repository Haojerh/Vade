import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspaceFile, WorkspaceListing, WorkspaceSearch, WorkspaceSearchOptions } from '../../shared/contracts.js';
import type { AdeGit } from './git.js';
import type { AdeStore } from './store.js';
import { CliError, defaultCommandRunner } from '../integrations/cli.js';
import { executableOnPath } from './sessions.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const MAX_FILE = 2 * 1024 * 1024;
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
function invalid(message: string): never { throw new CliError('INVALID_ARGUMENT', message); }
const message = (error: unknown) => error instanceof CliError ? error.issue.message : 'Git information is unavailable';
const decode = (bytes: Buffer) => {
  if (bytes.includes(0)) invalid('Binary files cannot be edited');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid('Only UTF-8 text files can be edited'); }
};
function observedStatus(statuses: Map<string, string>, name: string) {
  const own = statuses.get(name); if (own) return own;
  let parent = name;
  while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); const status = statuses.get(parent); if (status === '??' || status === '!!') return status; }
  return null;
}

export class WorkspaceFiles {
  private saving = new Set<string>();
  private roots = new Map<string, { at: number; value: Promise<{ root: string; git: boolean }> }>();
  private statuses = new Map<string, { at: number; value: Promise<{ statuses: Map<string, string>; error: string | null }> }>();
  private nameIndexes = new Map<string, { at: number; value: Promise<import('../integrations/cli.js').CommandResult> }>();
  constructor(private store: AdeStore, private git: AdeGit) {}
  async discoverRoots(projectId: string): Promise<import('../../shared/contracts.js').WorkspaceRoot[]> {
    const project = this.store.project(projectId);
    return (await this.git.worktrees(project)).map(tree => ({ id: tree.id, path: tree.path, branch: tree.branch, label: tree.main ? project.name : path.basename(tree.path) }));
  }
  private async root(projectId: string, worktreeId: string, fresh = false) {
    if (typeof worktreeId !== 'string' || worktreeId.length > 100) invalid('Choose a discovered worktree');
    const project = this.store.project(projectId), key = `${projectId}:${worktreeId}`, cached = this.roots.get(key);
    if (!fresh && cached && Date.now() - cached.at < 2000) return cached.value;
    const value = (async () => { const tree = await this.git.requireWorktree(project, worktreeId); return { root: await fs.realpath(tree.path), git: project.kind === 'git' }; })();
    if (this.roots.size >= 32) this.roots.delete(this.roots.keys().next().value!);
    this.roots.set(key, { at: Date.now(), value }); return value;
  }
  private relative(value: unknown, allowRoot = false): string {
    if (typeof value !== 'string' || value.length > 2000 || /[\\:\x00-\x1f\x7f]/.test(value) || path.isAbsolute(value)) invalid('Invalid relative file path');
    if (!value && allowRoot) return '';
    if (!value || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$/.test(part))) invalid('Invalid relative file path');
    return value;
  }
  private protectedPath(root: string, target: string, projectId: string) {
    const privatePath = path.relative(path.resolve(this.store.directory), target);
    const managedWorktree = path.relative(path.resolve(this.store.directory, 'worktrees', projectId), path.dirname(root)) === '';
    return !managedWorktree && (!privatePath || privatePath !== '..' && !privatePath.startsWith(`..${path.sep}`) && !path.isAbsolute(privatePath));
  }
  private async resolve(root: string, relative: string, projectId: string) {
    let target = root;
    for (const part of relative.split('/').filter(Boolean)) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink()) invalid('Symbolic links cannot be opened or edited');
    }
    const canonical = await fs.realpath(target), inside = path.relative(root, canonical);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) invalid('File is outside the selected worktree');
    if (this.protectedPath(root, canonical, projectId)) invalid('This folder contains private Vade settings and cannot be opened in Explorer');
    return canonical;
  }
  private async bytes(target: string) {
    const handle = await fs.open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE) invalid('Open a text file smaller than 2 MiB');
      const bytes = Buffer.alloc(MAX_FILE + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > MAX_FILE) invalid('Open a text file smaller than 2 MiB');
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }
  private status(root: string, enabled: boolean) {
    if (!enabled) return Promise.resolve({ statuses: new Map<string, string>(), error: null });
    const cached = this.statuses.get(root); if (cached && Date.now() - cached.at < 2500) return cached.value;
    const value = (async () => {
      try {
        const output = await this.git.run(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching']);
        const rows = output.split('\0'), statuses = new Map<string, string>();
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].length < 4) continue;
          const code = rows[i].slice(0, 2), name = rows[i].slice(3).replace(/\/$/, ''); statuses.set(name, code);
          if (/[RC]/.test(code)) i++;
        }
        return { statuses, error: null };
      } catch (error) { return { statuses: new Map<string, string>(), error: message(error) }; }
    })();
    if (this.statuses.size >= 32) this.statuses.delete(this.statuses.keys().next().value!);
    this.statuses.set(root, { at: Date.now(), value }); return value;
  }
  async list(projectId: string, worktreeId: string, relative = ''): Promise<WorkspaceListing> {
    this.relative(relative, true); const scope = await this.root(projectId, worktreeId), target = await this.resolve(scope.root, relative, projectId);
    const entries = [], git = await this.status(scope.root, scope.git), directory = await fs.opendir(target); let truncated = false;
    try {
      for await (const entry of directory) {
        if (entry.name.toLowerCase() === '.git') continue;
        if (entries.length >= 1000) { truncated = true; break; }
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (this.protectedPath(scope.root, path.join(scope.root, name), projectId)) continue;
        const own = observedStatus(git.statuses, name), prefix = `${name}/`;
        const statuses = [...git.statuses];
        const inherited = statuses.find(([key, status]) => status === '!!' && name.startsWith(`${key}/`))?.[1];
        const status = own ?? inherited ?? statuses.find(([key, status]) => key.startsWith(prefix) && status !== '!!' && /[MD]/.test(status))?.[1] ?? statuses.find(([key, status]) => key.startsWith(prefix) && status !== '!!')?.[1] ?? null;
        entries.push({ path: name, name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink(), status });
      }
    } finally { /* for-await closes the directory, including early exits. */ }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { entries, truncated, gitError: git.error };
  }
  async read(projectId: string, worktreeId: string, relative: string, baseline = false): Promise<WorkspaceFile> {
    this.relative(relative); const scope = await this.root(projectId, worktreeId), target = await this.resolve(scope.root, relative, projectId);
    const bytes = await this.bytes(target), text = decode(bytes); let original: string | null = null, gitError: string | null = null;
    if (scope.git && baseline) {
      try {
        // Only a bounded, validated, worktree-relative object selector reaches Git.
        const tracked = await this.git.run(scope.root, ['ls-files', '-z', '--', `:(literal)${relative}`]);
        if (tracked) {
          const head = await this.git.headCommit(scope.root);
          if (head) original = await this.git.run(scope.root, ['show', `${head}:${relative}`]);
          else original = '';
        } else original = '';
      } catch (error) { gitError = message(error); }
    }
    return { path: relative, text, version: hash(bytes), original, gitError, git: scope.git };
  }
  async save(projectId: string, worktreeId: string, relative: string, text: unknown, version: unknown): Promise<WorkspaceFile> {
    this.relative(relative);
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE || text.includes('\0') || typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) invalid('Invalid file contents or version');
    const scope = await this.root(projectId, worktreeId, true), target = await this.resolve(scope.root, relative, projectId);
    if (this.saving.has(target)) invalid('A save is already in progress for this file'); this.saving.add(target);
    const temp = path.join(path.dirname(target), `.vade-save-${crypto.randomUUID()}`);
    try {
      if (hash(await this.bytes(target)) !== version) invalid('File changed on disk. Reload it before saving; your edits have been kept.');
      const mode = (await fs.stat(target)).mode;
      await fs.writeFile(temp, text, { flag: 'wx', mode });
      if (await this.resolve(scope.root, relative, projectId) !== target || hash(await this.bytes(target)) !== version) invalid('File changed on disk. Reload it before saving; your edits have been kept.');
      await fs.rename(temp, target); this.statuses.delete(scope.root); this.nameIndexes.clear();
      // A later agent write must not become the version authorizing the next save.
      const written = Buffer.from(text, 'utf8');
      return { path: relative, text: written.toString('utf8'), version: hash(written), original: null, gitError: null, git: scope.git };
    } finally { this.saving.delete(target); await fs.unlink(temp).catch(() => {}); }
  }
  async open(projectId: string, worktreeId: string, target: unknown) {
    if (target !== 'system' && target !== 'vscode') invalid('Choose File Explorer or VS Code');
    const scope = await this.root(projectId, worktreeId, true); await this.resolve(scope.root, '', projectId);
    let executable: string | null, args: string[];
    if (target === 'system') { executable = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe') : executableOnPath(process.platform === 'darwin' ? 'open' : 'xdg-open'); args = [scope.root]; }
    else if (process.platform === 'darwin') { executable = executableOnPath('open'); args = ['-a', 'Visual Studio Code', scope.root]; }
    else {
      executable = executableOnPath('code');
      if (process.platform === 'win32') executable = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'), ...(process.env.PATH ?? '').split(path.delimiter).map(dir => path.resolve(dir.replace(/^"|"$/g, ''), '..', 'Code.exe'))].find((file): file is string => Boolean(file && existsSync(file))) ?? null;
      args = ['--', scope.root];
    }
    if (!executable) throw new CliError('CLI_MISSING', target === 'vscode' ? 'VS Code was not detected on this computer' : 'No system file manager was detected');
    await new Promise<void>((resolve, reject) => { const child = spawn(executable!, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true }); child.once('error', () => reject(new CliError('CLI_FAILED', 'Unable to open the selected application'))); child.once('spawn', () => { child.unref(); resolve(); }); });
    return { ok: true };
  }
  async search(projectId: string, worktreeId: string, query: string, mode: string, options: WorkspaceSearchOptions = {}): Promise<WorkspaceSearch> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\x00-\x1f]/.test(query) || !['names', 'contents'].includes(mode)) invalid('Enter a search of up to 200 characters');
    for (const pattern of [options.include, options.exclude]) if (pattern !== undefined && (typeof pattern !== 'string' || pattern.length > 500 || /[\x00-\x1f]/.test(pattern))) invalid('Invalid file search filter');
    const scope = await this.root(projectId, worktreeId), rg = executableOnPath('rg'); await this.resolve(scope.root, '', projectId);
    if (!rg) return this.fallbackSearch(projectId, worktreeId, query, mode, options);
    const privateRelative = path.relative(scope.root, path.resolve(this.store.directory)).replaceAll('\\', '/');
    if (privateRelative && !privateRelative.startsWith('../') && !path.isAbsolute(privateRelative) && /[?*\[\]{}!]/.test(privateRelative)) return this.fallbackSearch(projectId, worktreeId, query, mode, options);
    const args = ['--no-config', '--hidden', '--path-separator', '/'];
    if (options.showIgnored !== false) args.push('--no-ignore');
    for (const value of (options.include ?? '').split(',').map(item => item.trim()).filter(Boolean)) args.push('--glob', value);
    for (const value of (options.exclude ?? '').split(',').map(item => item.trim()).filter(Boolean)) args.push('--glob', `!${value}`);
    if (options.showDotfiles === false) args.push('--glob', '!**/.*');
    // Last globs win in ripgrep: user filters must never re-include runtime/Git data.
    args.push('--iglob', '!.git', '--iglob', '!**/.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.ade/**');
    if (privateRelative && !privateRelative.startsWith('../') && !path.isAbsolute(privateRelative)) args.push('--glob', `!${privateRelative}/**`);
    if (mode === 'names') args.push('--files', '--null');
    else {
      args.push('--json', '--max-count', '20', '--max-columns', '2000');
      if (!options.regex) args.push('--fixed-strings');
      if (!options.matchCase) args.push('--ignore-case');
      if (options.wholeWord) args.push('--word-regexp');
      args.push('-e', query);
    }
    args.push('--', '.');
    const indexKey = `${scope.root}\0${JSON.stringify(args)}`, cachedIndex = mode === 'names' ? this.nameIndexes.get(indexKey) : undefined;
    let result: import('../integrations/cli.js').CommandResult;
    if (cachedIndex && Date.now() - cachedIndex.at < 2500) result = await cachedIndex.value;
    else {
      const value = defaultCommandRunner(rg, args, { cwd: scope.root, timeoutMs: 5000, maxStdout: 2 * 1024 * 1024, maxStderr: 8192 });
      if (mode === 'names') { if (this.nameIndexes.size >= 4) this.nameIndexes.delete(this.nameIndexes.keys().next().value!); this.nameIndexes.set(indexKey, { at: Date.now(), value }); }
      result = await value;
    }
    if (result.exitCode > 1) invalid(result.stderr.trim().slice(0, 500) || 'Search unavailable. Narrow the search or check the expression.');
    const git = await this.status(scope.root, scope.git), matches: WorkspaceSearch['matches'] = [];
    if (mode === 'names') {
      const needle = query.toLowerCase();
      for (const raw of result.stdout.split('\0')) {
        const name = raw.replaceAll('\\', '/').replace(/^\.\//, '');
        if (name && name.toLowerCase().includes(needle)) matches.push({ path: name, status: observedStatus(git.statuses, name) });
        if (matches.length >= 200) break;
      }
    } else for (const raw of result.stdout.split('\n')) {
      let item: any; try { item = JSON.parse(raw); } catch { continue; }
      if (item.type !== 'match' || typeof item.data?.path?.text !== 'string' || typeof item.data?.lines?.text !== 'string') continue;
      const name = item.data.path.text.replaceAll('\\', '/').replace(/^\.\//, ''), preview: string = item.data.lines.text.replace(/[\r\n]+$/, '');
      const bytes = Buffer.from(preview), ranges: [number, number][] = (item.data.submatches ?? []).slice(0, 50).map((match: any) => [bytes.subarray(0, match.start).toString().length, bytes.subarray(0, match.end).toString().length]);
      matches.push({ path: name, line: item.data.line_number, preview, ranges });
      if (matches.length >= 200) break;
    }
    return { matches, truncated: matches.length >= 200 };
  }
  private async fallbackSearch(projectId: string, worktreeId: string, query: string, mode: string, options: WorkspaceSearchOptions): Promise<WorkspaceSearch> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || !['names', 'contents'].includes(mode)) invalid('Enter a search of up to 200 characters');
    const scope = await this.root(projectId, worktreeId), matches: WorkspaceSearch['matches'] = [], queue = [''];
    const git = await this.status(scope.root, scope.git);
    if (options.regex) invalid('Regular-expression search requires ripgrep to be installed');
    const started = Date.now(), needle = options.matchCase ? query : query.toLocaleLowerCase(); let scanned = 0, bytesRead = 0, truncated = false;
    while (queue.length) {
      if (scanned >= 10000 || Date.now() - started > 4000 || bytesRead > 16 * 1024 * 1024 || matches.length >= 200) { truncated = true; break; }
      const parent = queue.shift()!, target = await this.resolve(scope.root, parent, projectId), dir = await fs.opendir(target);
      for await (const entry of dir) {
        if (++scanned > 10000 || matches.length >= 200 || Date.now() - started > 4000) { truncated = true; break; }
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.ade'].includes(entry.name) || options.showDotfiles === false && entry.name.startsWith('.')) continue;
        const name = parent ? `${parent}/${entry.name}` : entry.name;
        if (options.showIgnored === false && observedStatus(git.statuses, name) === '!!') continue;
        if (this.protectedPath(scope.root, path.join(scope.root, name), projectId)) continue;
        if (entry.isDirectory()) { queue.push(name); continue; }
        if (!entry.isFile()) continue;
        if (options.include && !options.include.split(',').some(glob => path.matchesGlob(name, glob.trim()))) continue;
        if (options.exclude?.split(',').some(glob => path.matchesGlob(name, glob.trim()))) continue;
        if (mode === 'names') { if (name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ path: name, status: observedStatus(git.statuses, name) }); continue; }
        try {
          const file = await this.resolve(scope.root, name, projectId), stat = await fs.stat(file);
          if (stat.size > 256 * 1024 || bytesRead + stat.size > 16 * 1024 * 1024) { truncated = true; continue; }
          const bytes = await this.bytes(file); bytesRead += bytes.length; const lines = decode(bytes).split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < 200; i++) {
            const candidate = options.matchCase ? lines[i] : lines[i].toLocaleLowerCase(); const start = candidate.indexOf(needle);
            if (start >= 0 && (!options.wholeWord || !/[\w]/.test(candidate[start - 1] ?? '') && !/[\w]/.test(candidate[start + needle.length] ?? ''))) matches.push({ path: name, line: i + 1, preview: lines[i].slice(0, 2000), ranges: [[start, start + needle.length]] });
          }
        } catch { /* Unsupported/binary/unreadable files are excluded from content search. */ }
      }
    }
    return { matches, truncated: truncated || matches.length >= 200 };
  }
}
