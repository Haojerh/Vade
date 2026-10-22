import os from 'node:os';
import path from 'node:path';
import type { LocalConnection, LocalConnectionsData, ProviderUsage, Section, UsageData, UsageWindow } from '../../shared/contracts.js';
import { GH_PATH, type CommandRunner } from '../integrations/cli.js';
import { executableOnPath, resolveAgent } from './sessions.js';
import { hasCredential, ProviderAccounts, readCredentialJson } from './providerAccounts.js';

// Provider endpoint/response contracts checked against stablyai/orca's MIT-licensed
// src/main/rate-limits adapters. This adapter has no dependency on Orca.

export function quotaWindow(label: string, percent: unknown, reset: unknown): UsageWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const date = typeof reset === 'number' ? new Date(reset * 1000) : typeof reset === 'string' ? new Date(reset) : null;
  return { label: label.slice(0, 100), usedPercent: Math.round(percent * 10) / 10,
    resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null };
}

export function codexQuota(data: any): UsageWindow[] {
  return [['primary_window', 'Session'], ['secondary_window', 'Weekly']].flatMap(([key, fallback]) => {
    const w = data?.rate_limit?.[key];
    const seconds = w?.limit_window_seconds;
    const label = typeof seconds === 'number' && seconds > 0 ? seconds >= 86400 ? `${Math.round(seconds / 86400)}d` : `${Math.round(seconds / 3600)}h` : fallback;
    const value = quotaWindow(label, w?.used_percent, w?.reset_at);
    return value ? [value] : [];
  });
}

export function claudeQuota(data: any): UsageWindow[] {
  return [['five_hour', '5h'], ['seven_day', '7d'], ['seven_day_opus', 'Opus 7d'], ['seven_day_sonnet', 'Sonnet 7d']].flatMap(([key, label]) => {
    const value = quotaWindow(label, data?.[key]?.utilization ?? data?.[key]?.used_percentage, data?.[key]?.resets_at);
    return value ? [value] : [];
  });
}

export function agyQuota(data: any): UsageWindow[] {
  if (data?.command?.name !== 'usage' || !Array.isArray(data.command.data?.groups)) return [];
  return data.command.data.groups.slice(0, 12).flatMap((group: any) => !Array.isArray(group?.buckets) ? [] : group.buckets.slice(0, 8).flatMap((bucket: any) => {
    if (bucket?.disabled === true || typeof bucket?.remaining_fraction !== 'number' || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1) return [];
    const value = quotaWindow(`${typeof group.name === 'string' ? group.name : 'Quota'} ${typeof bucket.window === 'string' ? bucket.window : ''}`.trim(), (1 - bucket.remaining_fraction) * 100, bucket.reset_time);
    return value ? [value] : [];
  }));
}

async function requestUsage(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Usage unavailable'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty usage response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > 131072) throw new Error('Usage response too large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

const definitions: Omit<LocalConnection, 'installed' | 'connected' | 'message'>[] = [
  { id: 'github', label: 'GitHub', installUrl: 'https://cli.github.com/', loginCommand: 'gh auth login --web --hostname github.com' },
  { id: 'codex', label: 'Codex', installUrl: 'https://developers.openai.com/codex/cli', loginCommand: 'codex login' },
  { id: 'claude', label: 'Claude Code', installUrl: 'https://code.claude.com/docs/en/setup', loginCommand: 'claude auth login' },
  { id: 'antigravity', label: 'Antigravity', installUrl: 'https://antigravity.google/', loginCommand: 'agy' },
];

export class LocalConnections {
  private revision = 0;
  private selectionKey = '';
  private cached: Section<UsageData> | null = null;
  private expires = 0;
  private pending?: Promise<Section<UsageData>>;
  private connectionCache = new Map<string, { section: Section<LocalConnectionsData>; expires: number }>();
  private connectionPending = new Map<string, Promise<Section<LocalConnectionsData>>>();
  constructor(private runner: CommandRunner, private options: {
    credentials?: () => Promise<[any, any]>;
    request?: typeof requestUsage;
    resolve?: typeof resolveAgent;
    now?: () => number;
    accounts?: ProviderAccounts;
  } = {}) {}

  invalidate(): void {
    this.revision++; this.cached = null; this.expires = 0; this.pending = undefined;
    this.connectionCache.clear(); this.connectionPending.clear();
  }
  private syncSelection(): void {
    const key = this.options.accounts?.selectionKey() ?? 'system';
    if (key !== this.selectionKey) { this.selectionKey = key; this.invalidate(); }
  }

  private now() { return this.options.now?.() ?? Date.now(); }
  private resolve(provider: 'codex' | 'claude' | 'antigravity') { return (this.options.resolve ?? resolveAgent)(provider); }

  private credentials() {
    if (this.options.credentials) return this.options.credentials();
    return Promise.all([
      readCredentialJson(this.options.accounts?.credentialPath('codex') ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json')),
      readCredentialJson(this.options.accounts?.credentialPath('claude') ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json')),
    ]);
  }

  connections(scope: 'all' | 'accounts' | 'integrations' = 'all', force = false): Promise<Section<LocalConnectionsData>> {
    this.syncSelection();
    if (scope === 'integrations') {
      const cached = this.connectionCache.get(scope);
      if (cached && (this.connectionPending.has(scope) || (!force && this.now() < cached.expires))) return Promise.resolve(cached.section);
      const section: Section<LocalConnectionsData> = { data: cached?.section.data ?? { host: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', connections: [{ ...definitions[0], installed: Boolean(executableOnPath('gh')), connected: null, message: '' }] }, meta: { ...this.meta('ready'), partial: true, stale: Boolean(cached) } };
      this.connectionCache.set(scope, { section, expires: 0 });
      const pending = this.detectConnections(this.revision, scope).catch(() => {
        this.connectionCache.set(scope, { section: { ...section, meta: { ...this.meta('unavailable'), partial: false, issue: { code: 'RUNTIME_UNAVAILABLE', message: 'GitHub sign-in check failed. Re-check to retry.', retryable: true } } }, expires: this.now() + 3000 });
        return section;
      }).finally(() => { if (this.connectionPending.get(scope) === pending) this.connectionPending.delete(scope); });
      this.connectionPending.set(scope, pending); return Promise.resolve(section);
    }
    const previous = this.connectionPending.get(scope); if (previous) return previous;
    const cached = this.connectionCache.get(scope); if (cached && this.now() < cached.expires) return Promise.resolve(cached.section);
    const pending = this.detectConnections(this.revision, scope).finally(() => { if (this.connectionPending.get(scope) === pending) this.connectionPending.delete(scope); });
    this.connectionPending.set(scope, pending); return pending;
  }

  private async detectConnections(revision: number, scope: 'all' | 'accounts' | 'integrations'): Promise<Section<LocalConnectionsData>> {
    const [codex, claude] = scope === 'integrations' ? [null, null] : await this.credentials();
    let githubInstalled = false, githubConnected = false;
    if (scope !== 'accounts') try {
      const result = await this.runner(GH_PATH, ['--version'], { timeoutMs: 5000, maxStdout: 4096, maxStderr: 1024 });
      githubInstalled = result.exitCode === 0;
      if (githubInstalled) {
        const auth = await this.runner(GH_PATH, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], { timeoutMs: 8000, maxStdout: 65536, maxStderr: 1024, env: { GH_DEBUG: '' } });
        const entries = JSON.parse(auth.stdout).hosts?.['github.com'];
        githubConnected = Array.isArray(entries) && entries.some(entry => entry.state === 'success');
      }
    } catch { /* Leave detection explicit. */ }
    const connections = await Promise.all(definitions.filter(def => scope === 'all' || (scope === 'integrations' ? def.id === 'github' : def.id !== 'github')).map(async def => {
      const installed = def.id === 'github' ? githubInstalled : Boolean(this.resolve(def.id));
      const connected = def.id === 'github' ? githubConnected : def.id === 'codex' ? hasCredential('codex', codex, !this.options.accounts || this.options.accounts.selected('codex') === 'system')
        : def.id === 'claude' ? hasCredential('claude', claude)
        : this.cached?.data?.providers.find(p => p.provider === 'antigravity')?.meta.availability === 'ready' ? true : null;
      const accounts = (def.id === 'codex' || def.id === 'claude') ? await this.options.accounts?.list(def.id) : undefined;
      return { ...def, installed, connected, accounts, message: !installed ? 'CLI not detected on this host.' : connected ? def.id === 'github' ? 'Authenticated through GitHub CLI.' : 'Selected sign-in detected. Usage is checked separately.'
        : def.id === 'antigravity' ? 'Open agy and complete its native sign-in, then re-check usage.' : 'Sign in with the native CLI on this host, then re-check.' };
    }));
    const result: Section<LocalConnectionsData> = { data: { host: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', connections }, meta: this.meta('ready') };
    if (revision === this.revision) { this.connectionCache.set(scope, { section: result, expires: this.now() + (scope === 'integrations' ? 30000 : 3000) }); }
    return result;
  }

  usage(force = false): Promise<Section<UsageData>> {
    this.syncSelection();
    if (this.pending) return this.pending;
    if (!force && this.cached && this.now() < this.expires) return Promise.resolve(this.cached);
    const pending = this.collect(this.revision).finally(() => { if (this.pending === pending) this.pending = undefined; });
    return this.pending = pending;
  }

  private meta(availability: 'ready' | 'unavailable') {
    const now = new Date(this.now()).toISOString();
    return { availability, observedAt: availability === 'ready' ? now : null, attemptedAt: now, stale: false, partial: false, issue: null };
  }

  private async collect(revision: number): Promise<Section<UsageData>> {
    const previousSnapshot = this.cached;
    const [codex, claude] = await this.credentials();
    const providers = await Promise.all(definitions.filter(d => d.id !== 'github').map(async def => {
      const previous = previousSnapshot?.data?.providers.find(p => p.provider === def.id);
      try {
        let windows: UsageWindow[] = [];
        if (def.id === 'codex') {
          if (!hasCredential('codex', { tokens: codex?.tokens })) throw new Error();
          windows = codexQuota(await (this.options.request ?? requestUsage)('https://chatgpt.com/backend-api/wham/usage', {
            Authorization: `Bearer ${codex.tokens.access_token}`, 'User-Agent': 'codex-cli', 'OpenAI-Beta': 'codex-1', originator: 'Codex Desktop',
            ...(typeof codex.tokens.account_id === 'string' ? { 'ChatGPT-Account-Id': codex.tokens.account_id } : {}),
          }));
        } else if (def.id === 'claude') {
          if (!hasCredential('claude', claude)) throw new Error();
          windows = claudeQuota(await (this.options.request ?? requestUsage)('https://api.anthropic.com/api/oauth/usage', {
            Authorization: `Bearer ${claude.claudeAiOauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0',
          }));
        } else {
          const agent = this.resolve('antigravity'); if (!agent) throw new Error();
          const options = { timeoutMs: 5000, maxStdout: 524288, maxStderr: 1024, env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } };
          const version = await this.runner(agent.executable, [...agent.args, '--version'], options);
          const match = version.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
          if (version.exitCode !== 0 || !match || !(Number(match[1]) > 1 || Number(match[1]) === 1 && (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 11))) throw new Error();
          const result = await this.runner(agent.executable, [...agent.args, '-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], { ...options, timeoutMs: 30000 });
          if (result.exitCode !== 0) throw new Error();
          windows = agyQuota(JSON.parse(result.stdout));
        }
        if (!windows.length) throw new Error();
        return { provider: def.id, label: def.label, windows, buckets: [], meta: {
          ...this.meta('ready'), stale: windows.some(w => w.resetsAt !== null && Date.parse(w.resetsAt) <= this.now()),
        } } satisfies ProviderUsage;
      } catch {
        return { provider: def.id, label: def.label, windows: previous?.windows ?? [], buckets: [], meta: {
          ...this.meta('unavailable'), observedAt: previous?.meta.observedAt ?? null, stale: Boolean(previous?.windows.length),
          issue: { code: 'RUNTIME_UNAVAILABLE' as const, message: 'Quota could not be read. Check the native CLI sign-in and retry. API-key accounts and OS-keychain-only credentials may not expose subscription quotas.', retryable: true },
        } } satisfies ProviderUsage;
      }
    }));
    const hasData = providers.some(p => p.meta.availability === 'ready');
    const result: Section<UsageData> = { data: { providers }, meta: { ...this.meta(hasData ? 'ready' : 'unavailable'), partial: providers.some(p => p.meta.availability !== 'ready'), stale: providers.some(p => p.meta.stale) } };
    if (revision === this.revision) {
      this.cached = result; this.expires = this.now() + (hasData ? 60000 : 10000);
      this.connectionCache.clear();
    }
    return result;
  }
}
