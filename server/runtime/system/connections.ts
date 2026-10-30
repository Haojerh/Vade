import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { LocalConnection, LocalConnectionsData, ProviderUsage, Section, UsageData, UsageWindow } from '../../../shared/contracts.js';
import { GH_PATH, type CommandRunner } from '../../integrations/cli.js';
import { executableOnPath, resolveAgent } from '../sessions/sessions.js';
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

// OpenCode Go's native API-key usage endpoint; unrelated model-provider keys
// cannot establish a Go subscription or supply its quota windows.
export function openCodeQuota(data: any): UsageWindow[] {
  if (!data?.usage?.rolling || !data.usage.weekly) return [];
  return [['rolling', '5h'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].flatMap(([key, label]) => {
    const meter = data.usage[key], window = quotaWindow(label, meter?.percent, meter?.resetsAt);
    return window ? [window] : [];
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

async function codeBuddyCredential(): Promise<any> {
  const base = process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.local', 'share');
  const file = path.join(base, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info');
  try { await fs.access(`${file}.logged-out`); return null; } catch { /* Native logout marker is absent. */ }
  const value = await readCredentialJson(file);
  const token = value?.auth?.accessToken, uid = value?.account?.uid;
  // Only the native international personal account verified against this endpoint.
  // Protected credential objects, API keys and other deployments remain native-only.
  return value?.auth?.domain === 'www.codebuddy.ai' && value.auth.tokenType === 'Bearer' && value.account?.type === 'personal'
    && typeof value.auth.expiresAt === 'number' && value.auth.expiresAt > Date.now()
    && typeof token === 'string' && token.length > 0 && token.length <= 16384 && !/[\r\n]/.test(token)
    && typeof uid === 'string' && uid.length > 0 && uid.length <= 256 ? value : null;
}

function codeBuddyAccountKey(credential: any): string {
  return credential ? crypto.createHash('sha256').update(JSON.stringify([credential.auth.domain, credential.account.uid])).digest('hex') : '';
}

export function codeBuddyQuota(data: any): UsageWindow[] {
  if (data?.code !== 0 || !Array.isArray(data.data?.CreditGroups)) return [];
  return data.data.CreditGroups.slice(0, 12).flatMap((group: any) => {
    if (![group?.CycleTotalCapacity, group?.CycleUsedCapacity].every(value => typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return [];
    const total = Number(group?.CycleTotalCapacity), used = Number(group?.CycleUsedCapacity);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(used) || used < 0 || used > total) return [];
    const label = typeof group.Name === 'string' && group.Name.trim() ? group.Name.trim().slice(0, 55) : 'Credits';
    return [quotaWindow(`${label} (${used.toFixed(2)} / ${total.toFixed(2)} credits)`, used / total * 100, null)!];
  });
}

class UsageRequestError extends Error { constructor(readonly status: number) { super('Usage unavailable'); } }
async function requestUsage(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers, ...(url === 'https://www.codebuddy.ai/billing/meter/get-user-resource-summary' ? { method: 'POST', body: '{}' } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new UsageRequestError(response.status); }
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
  { id: 'codebuddy', label: 'CodeBuddy', installUrl: 'https://www.codebuddy.ai/docs/cli/installation', loginCommand: 'codebuddy' },
  { id: 'opencode', label: 'OpenCode Go', installUrl: 'https://opencode.ai/docs/', loginCommand: 'opencode auth login --provider opencode-go' },
  { id: 'opencode2', label: 'OpenCode 2', installUrl: 'https://opencode.ai/docs/', loginCommand: 'opencode2 auth login' },
  { id: 'kilo', label: 'Kilo Code', installUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli', loginCommand: 'kilo auth login' },
  { id: 'dsh', label: 'DeepSeek Harness', installUrl: 'https://deepseek-harness.github.io/deepseek-harness/', loginCommand: 'dsh-tui .' },
  { id: 'antigravity', label: 'Antigravity', installUrl: 'https://antigravity.google/', loginCommand: 'agy' },
];

export class LocalConnections {
  private revision = 0;
  private selectionKey = '';
  private cached: Section<UsageData> | null = null;
  private codeBuddyAccount = '';
  private codeBuddyObservedAccount = '';
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
  private resolve(provider: Exclude<import('../../../shared/contracts.js').AdeProvider, 'terminal'>) { return (this.options.resolve ?? resolveAgent)(provider); }

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
        : def.id === 'codebuddy' ? Boolean(await codeBuddyCredential())
        : ['opencode2','kilo','dsh'].includes(def.id) ? null
        : def.id === 'opencode' ? hasCredential('opencode', await (this.options.accounts?.openCodeCredentials() ?? readCredentialJson(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json'))))
        : this.cached?.data?.providers.find(p => p.provider === 'antigravity')?.meta.availability === 'ready' ? true : null;
      const accounts = (def.id === 'codex' || def.id === 'claude' || def.id === 'opencode') ? await this.options.accounts?.list(def.id) : undefined;
      return { ...def, installed, connected, accounts, message: def.id === 'codebuddy' ? connected ? 'Native international personal account detected. Credits are checked separately.' : 'Credit usage requires a native international personal sign-in. View other accounts at https://www.codebuddy.ai/profile/plans-usage.' : def.id === 'opencode2' ? 'Uses the native CLI account. OpenCode Go usage profiles are managed under OpenCode Go.' : def.id === 'kilo' ? 'Uses the native CLI account. Saved account profiles and subscription usage are not exposed here.' : !installed ? 'CLI not detected on this host.' : connected ? def.id === 'github' ? 'Authenticated through GitHub CLI.' : 'Selected sign-in detected. Usage is checked separately.'
        : def.id === 'antigravity' ? 'Open agy and complete its native sign-in, then re-check usage.' : 'Sign in with the native CLI on this host, then re-check.' };
    }));
    const result: Section<LocalConnectionsData> = { data: { host: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux', connections }, meta: this.meta('ready') };
    if (revision === this.revision) { this.connectionCache.set(scope, { section: result, expires: this.now() + (scope === 'integrations' ? 30000 : 3000) }); }
    return result;
  }

  async usage(force = false): Promise<Section<UsageData>> {
    this.syncSelection();
    const account = codeBuddyAccountKey(await codeBuddyCredential());
    if (account !== this.codeBuddyAccount) {
      this.codeBuddyAccount = account;
      this.invalidate();
    }
    if (this.pending) return this.usageResponse(this.pending,this.revision);
    if (!force && this.cached && this.now() < this.expires) return Promise.resolve(this.cached);
    const revision=this.revision;
    const pending = this.collect(revision).finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending=pending;
    return this.usageResponse(pending,revision);
  }

  private async usageResponse(pending:Promise<Section<UsageData>>,revision:number):Promise<Section<UsageData>>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{const result=await Promise.race([pending,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),800);})]);
      if(revision!==this.revision)return this.usage();
      return result??this.cached!;
    }finally{clearTimeout(timer);}
  }

  private meta(availability: 'ready' | 'unavailable') {
    const now = new Date(this.now()).toISOString();
    return { availability, observedAt: availability === 'ready' ? now : null, attemptedAt: now, stale: false, partial: false, issue: null };
  }

  private async collect(revision: number): Promise<Section<UsageData>> {
    const previousSnapshot = this.cached;
    const codeBuddyAccount = this.codeBuddyAccount;
    const selected=definitions.filter(d => ['codex', 'claude', 'antigravity', 'opencode', 'codebuddy'].includes(d.id));
    const completed=new Map<string,ProviderUsage>();
    const publish=()=>{if(revision!==this.revision)return;const providers=selected.flatMap(def=>{const current=completed.get(def.id);if(current)return[current];const previous=previousSnapshot?.data?.providers.find(provider=>provider.provider===def.id);return previous?[{...previous,meta:{...previous.meta,stale:true}}]:[];});
      this.cached={data:{providers,pendingProviders:selected.filter(def=>!completed.has(def.id)).map(def=>def.id)},meta:{...this.meta(providers.some(provider=>provider.meta.availability==='ready')?'ready':'unavailable'),partial:true,stale:providers.some(provider=>provider.meta.stale)}};
    };
    publish();
    const [codex, claude] = await this.credentials();
    const providers = await Promise.all(selected.map(async def => {
      const previous = previousSnapshot?.data?.providers.find(p => p.provider === def.id);
      const read=async()=>{
      try {
        let windows: UsageWindow[] = [];
        if (def.id === 'codex') {
          if (!hasCredential('codex', { tokens: codex?.tokens })) throw new Error();
          windows = codexQuota(await (this.options.request ?? requestUsage)('https://chatgpt.com/backend-api/wham/usage', {
            Authorization: `Bearer ${codex.tokens.access_token}`, 'User-Agent': 'codex-cli', 'OpenAI-Beta': 'codex-1', originator: 'Codex Desktop',
            ...(typeof codex.tokens.account_id === 'string' ? { 'ChatGPT-Account-Id': codex.tokens.account_id } : {}),
          }));
        } else if (def.id === 'codebuddy') {
          const credential = await codeBuddyCredential();
          if (!credential) throw new Error();
          windows = codeBuddyQuota(await (this.options.request ?? requestUsage)('https://www.codebuddy.ai/billing/meter/get-user-resource-summary', {
            Authorization: `Bearer ${credential.auth.accessToken}`, 'X-User-Id': encodeURIComponent(credential.account.uid), 'Content-Type': 'application/json',
          }));
          const current = await codeBuddyCredential();
          if (current?.auth.accessToken !== credential.auth.accessToken || current?.account.uid !== credential.account.uid) throw new Error();
          if (revision === this.revision && windows.length) this.codeBuddyObservedAccount = codeBuddyAccountKey(current);
        } else if (def.id === 'opencode') {
          const credentials = await (this.options.accounts?.openCodeCredentials() ?? readCredentialJson(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json')));
          if (!hasCredential('opencode', credentials)) throw new Error('Missing native OpenCode Go key');
          windows = openCodeQuota(await (this.options.request ?? requestUsage)('https://opencode.ai/zen/go/v1/usage', { Authorization: `Bearer ${credentials['opencode-go'].key}`, Accept: 'application/json' }));
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
      } catch (error) {
        const keepPrevious = def.id !== 'codebuddy' || Boolean(codeBuddyAccount && codeBuddyAccount === this.codeBuddyObservedAccount && codeBuddyAccount === codeBuddyAccountKey(await codeBuddyCredential()));
        return { provider: def.id, label: def.label, windows: keepPrevious ? previous?.windows ?? [] : [], buckets: [], meta: {
          ...this.meta('unavailable'), observedAt: keepPrevious ? previous?.meta.observedAt ?? null : null, stale: keepPrevious && Boolean(previous?.windows.length),
          issue: { code: 'RUNTIME_UNAVAILABLE' as const, message: def.id === 'codebuddy' ? 'Credits require a readable native international personal sign-in. Enterprise, API-key and protected credentials are unsupported. View usage at https://www.codebuddy.ai/profile/plans-usage.' : def.id === 'opencode' ? error instanceof UsageRequestError && error.status === 403 ? 'This key has no OpenCode Go subscription.' : error instanceof UsageRequestError && error.status === 401 ? 'OpenCode rejected the selected API key. Reconnect OpenCode Go in the native CLI.' : 'Connect an OpenCode Go API key using the sign-in command in AI Providers, then re-check. Other provider keys do not expose Go subscription usage.' : 'Quota could not be read. Check the native CLI sign-in and retry. API-key accounts and OS-keychain-only credentials may not expose subscription quotas.', retryable: true },
        } } satisfies ProviderUsage;
      }
      };
      const provider=await read();completed.set(def.id,provider);publish();return provider;
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
