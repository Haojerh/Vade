import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { executableOnPath, resolveAgent } from './sessions.js';
import type { AccountProvider, ProviderAccount } from '../../shared/contracts.js';
import { CliError, type CommandRunner } from '../integrations/cli.js';
import { AdeStore } from './store.js';

export async function readCredentialJson(file: string): Promise<any> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if ((await handle.stat()).size > 65536) return null;
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= 65536 ? JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) : null;
  } catch { return null; } finally { await handle?.close(); }
}

export function hasCredential(provider: AccountProvider, value: any, system = false): boolean {
  const token = provider === 'codex' ? value?.tokens?.access_token || value?.OPENAI_API_KEY || (system ? process.env.OPENAI_API_KEY : null) : value?.claudeAiOauth?.accessToken;
  return typeof token === 'string' && token.length > 0 && token.length <= 16384 && !/[\r\n]/.test(token);
}

export class ProviderAccounts {
  private creating = false;
  private logins = new Map<string, { state: 'pending' | 'complete' | 'failed'; url?: string; process?: ChildProcess; timer?: NodeJS.Timeout }>();
  constructor(private store: AdeStore, private runner: CommandRunner, private resolve = resolveAgent) {}

  private rows(provider: AccountProvider) {
    return this.store.db.prepare('SELECT id, label FROM provider_accounts WHERE provider = ? ORDER BY rowid LIMIT 20').all(provider) as unknown as { id: string; label: string }[];
  }
  private directory(provider: AccountProvider, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id) || !this.rows(provider).some(row => row.id === id)) throw new CliError('INVALID_ARGUMENT', 'Unknown provider account');
    return path.join(this.store.directory, 'accounts', provider, id);
  }
  selected(provider: AccountProvider): string {
    return String(this.store.db.prepare('SELECT account_id FROM provider_account_selection WHERE provider = ?').get(provider)?.account_id ?? 'system');
  }
  selectionKey(): string { return `${this.selected('codex')}:${this.selected('claude')}`; }
  credentialPath(provider: AccountProvider, id = this.selected(provider)): string {
    const directory = id === 'system' ? provider === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') : this.directory(provider, id);
    return path.join(directory, provider === 'codex' ? 'auth.json' : '.credentials.json');
  }
  private loginCommand(provider: AccountProvider, id: string): string {
    const command = provider === 'codex' ? 'codex login' : 'claude auth login';
    if (id === 'system') return command;
    const directory = this.directory(provider, id);
    if (/[\r\n]/.test(directory)) throw new CliError('INVALID_ARGUMENT', 'Account directory cannot be used for sign-in');
    const variable = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const quoted = directory.replaceAll("'", process.platform === 'win32' ? "''" : "'\"'\"'");
    // User runs this explicit native login; HTTP never accepts executable commands or credentials.
    return process.platform === 'win32'
      ? `& { $previous = $env:${variable}; try { $env:${variable} = '${quoted}'; ${command} } finally { $env:${variable} = $previous } }`
      : `${variable}='${quoted}' ${command}`;
  }
  async list(provider: AccountProvider): Promise<ProviderAccount[]> {
    const active = this.selected(provider);
    return Promise.all([{ id: 'system', label: 'System default' }, ...this.rows(provider)].map(async row => {
      const credentials = await readCredentialJson(this.credentialPath(provider, row.id));
      const detected = hasCredential(provider, credentials, row.id === 'system');
      return { ...row, active: row.id === active, detected, loginCommand: this.loginCommand(provider, row.id), ...(this.logins.has(row.id) ? { signIn: { state: this.logins.get(row.id)!.state, url: this.logins.get(row.id)!.url } } : {}) };
    }));
  }
  async add(provider: AccountProvider, label: string): Promise<ProviderAccount> {
    if (this.creating) throw new CliError('RATE_LIMITED', 'An account profile is already being created');
    if (this.rows(provider).length >= 20) throw new CliError('RATE_LIMITED', 'At most 20 account profiles per provider');
    if (typeof label !== 'string' || !label.trim() || label.length > 60 || /[\x00-\x1f\x7f]/.test(label)) throw new CliError('INVALID_ARGUMENT', 'Enter an account name of 1–60 characters');
    if (this.rows(provider).some(row => row.label.toLowerCase() === label.trim().toLowerCase())) throw new CliError('INVALID_ARGUMENT', 'An account with that name already exists. Re-check the account list.');
    this.creating = true;
    const id = crypto.randomUUID();
    try {
      const root = path.join(this.store.directory, 'accounts', provider);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const directory = path.join(root, id);
      await fs.mkdir(directory, { mode: 0o700 });
      // Windows ignores POSIX mode bits: establish an owner-only inherited ACL
      // before a native provider is ever allowed to write credentials here.
      if (process.platform === 'win32') {
        const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        const who = await this.runner(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: 5000, maxStdout: 4096, maxStderr: 1024 });
        const sid = who.exitCode === 0 && who.stdout.match(/\bS-1-5-(?:\d+-)*\d+\b/)?.[0];
        if (!sid) throw new CliError('CLI_FAILED', 'Could not establish private account storage');
        const acl = await this.runner(path.join(system, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { timeoutMs: 5000, maxStdout: 4096, maxStderr: 1024 });
        if (acl.exitCode !== 0) throw new CliError('CLI_FAILED', 'Could not establish private account storage');
      }
      if (provider === 'codex') await fs.writeFile(path.join(directory, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: 'wx' });
      this.store.db.prepare('INSERT INTO provider_accounts VALUES (?, ?, ?)').run(id, provider, label.trim());
      return (await this.list(provider)).find(account => account.id === id)!;
    } finally { this.creating = false; }
  }
  async startLogin(provider: AccountProvider, id: string): Promise<void> {
    const directory = this.directory(provider, id);
    if (this.logins.get(id)?.state === 'pending') return;
    if ([...this.logins.values()].filter(login => login.state === 'pending').length >= 2) throw new CliError('RATE_LIMITED', 'Finish an existing sign-in first');
    const resolved = this.resolve(provider), node = executableOnPath('node');
    if (!resolved || !node) throw new CliError('CLI_MISSING', 'Install the provider CLI before signing in');
    const env: NodeJS.ProcessEnv = { ...process.env, [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: directory };
    delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE;
    const credential = this.credentialPath(provider, id);
    const before = await fs.stat(credential).then(stat => stat.mtimeMs).catch(() => 0);
    const child = fork(process.env.ADE_PTY_HOST || path.resolve('server/runtime/ptyHost.cjs'), [], { execPath: node, execArgv: [], env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const login: { state: 'pending' | 'complete' | 'failed'; url?: string; process?: ChildProcess; timer?: NodeJS.Timeout } = { state: 'pending', process: child };
    this.logins.set(id, login);
    const finish = (state: 'complete' | 'failed') => { if (login.state !== 'pending') return; login.state = state; delete login.url; clearInterval(login.timer); if (child.connected) child.send({ type: 'stop' }); setTimeout(() => child.kill(), 1000).unref(); };
    let checking = false;
    const started = Date.now();
    const check = async () => {
      if (checking || login.state !== 'pending') return;
      checking = true;
      try {
        const modified = await fs.stat(credential).then(stat => stat.mtimeMs).catch(() => 0);
        if (modified > before && hasCredential(provider, await readCredentialJson(credential))) finish('complete');
        else if (Date.now() - started > 10 * 60 * 1000) finish('failed');
      } finally { checking = false; }
    };
    login.timer = setInterval(() => void check(), 1000); login.timer.unref();
    let tail = '';
    child.on('message', (message: any) => {
      if (message.type === 'data' && typeof message.data === 'string') {
        tail = (tail + message.data).slice(-16384).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        for (const match of tail.matchAll(/https:\/\/[^\s<>"\x00-\x20]+/g)) {
          try { const url = new URL(match[0]); if (['auth.openai.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(url.hostname) && !url.username && !url.password && url.href.length < 8192) login.url = url.href; } catch { /* Partial URL. */ }
        }
      } else if (message.type === 'error') finish('failed');
    });
    child.on('error', () => finish('failed'));
    child.on('exit', () => { void (async () => { const modified = await fs.stat(credential).then(stat => stat.mtimeMs).catch(() => 0); finish(modified > before && hasCredential(provider, await readCredentialJson(credential)) ? 'complete' : 'failed'); })(); });
    child.send({ type: 'start', executable: resolved.executable, args: [...resolved.args, ...(provider === 'codex' ? ['login'] : ['auth', 'login'])], cwd: directory, cols: 1000 });
  }
  async remove(provider: AccountProvider, id: string): Promise<void> {
    const directory = path.resolve(this.directory(provider, id));
    const root = path.resolve(this.store.directory, 'accounts', provider);
    if (path.dirname(directory) !== root || (await fs.lstat(directory)).isSymbolicLink()) throw new CliError('INVALID_ARGUMENT', 'Invalid account directory');
    if (this.logins.get(id)?.state === 'pending') throw new CliError('INVALID_ARGUMENT', 'Finish sign-in before deleting this account');
    await fs.rm(directory, { recursive: true });
    if (this.selected(provider) === id) this.select(provider, 'system');
    this.store.db.prepare('DELETE FROM provider_accounts WHERE provider = ? AND id = ?').run(provider, id);
    this.logins.delete(id);
  }
  close(): void {
    for (const login of this.logins.values()) { clearInterval(login.timer); if (login.process?.connected) login.process.send({ type: 'stop' }); const child = login.process; if (child) setTimeout(() => child.kill(), 1000).unref(); }
    this.logins.clear();
  }
  select(provider: AccountProvider, id: string): void {
    if (id !== 'system') this.directory(provider, id);
    this.store.db.prepare('INSERT OR REPLACE INTO provider_account_selection VALUES (?, ?)').run(provider, id);
  }
}
