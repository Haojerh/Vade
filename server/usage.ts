import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import type { ProviderUsage, Section, UsageData, UsageWindow } from '../shared/contracts.js';
import { CliError } from './cli.js';

const MAX_BYTES = 1024 * 1024;
const STALE_MS = 15 * 60 * 1000;

// Same local transport as Orca's CLI. This adapter can only read the cached
// accounts snapshot; it never forwards methods or parameters from HTTP input.
export async function readOrcaUsageSnapshot(): Promise<unknown> {
  const userData = process.env.ORCA_USER_DATA_PATH ||
    (process.env.ORCA_APPDATA_DIR ? path.join(process.env.ORCA_APPDATA_DIR, 'orca') :
      process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'orca') :
        process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'orca') :
          path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca'));
  const metadataFile = await fs.open(path.join(userData, 'orca-runtime.json'), 'r');
  let metadata: any;
  try {
    if ((await metadataFile.stat()).size > 64 * 1024) throw new Error('Invalid runtime metadata');
    metadata = JSON.parse(await metadataFile.readFile('utf8'));
  } finally {
    await metadataFile.close();
  }
  const transport = metadata.transports?.find((t: any) =>
    process.platform === 'win32' ? t.kind === 'named-pipe' : t.kind === 'unix');
  if (typeof transport?.endpoint !== 'string' || typeof metadata.authToken !== 'string' ||
    !metadata.authToken || typeof metadata.runtimeId !== 'string' ||
    (process.platform === 'win32' ? !transport.endpoint.startsWith('\\\\.\\pipe\\orca-') : !path.isAbsolute(transport.endpoint))) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Orca local runtime metadata is unavailable');
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(transport.endpoint);
    let buffer = '';
    let settled = false;
    const finish = (error: Error | null, data?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };
    const timeout = setTimeout(() => finish(new CliError('CLI_TIMEOUT', 'Orca usage read timed out', true)), 5000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({
      id, authToken: metadata.authToken, method: 'accounts.list', params: { refreshUsage: false },
    }) + '\n'));
    socket.on('error', () => finish(new CliError('RUNTIME_UNAVAILABLE', 'Cannot read usage from Orca', true)));
    socket.on('close', () => finish(new CliError('RUNTIME_UNAVAILABLE', 'Orca closed the usage connection', true)));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES) {
        finish(new CliError('INVALID_UPSTREAM', 'Orca usage response exceeds the read limit'));
        return;
      }
      let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame._keepalive === true) continue;
          if (frame.id !== id || frame._meta?.runtimeId !== metadata.runtimeId) throw new Error();
          if (frame.ok !== true) {
            finish(new CliError('RUNTIME_UNAVAILABLE', 'Orca does not expose a usage snapshot', false));
          } else {
            finish(null, frame.result);
          }
        } catch {
          finish(new CliError('INVALID_UPSTREAM', 'Invalid Orca usage response'));
        }
      }
    });
  });
}

function iso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function windowValue(raw: any, label: string): UsageWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent) ||
    raw.usedPercent < 0 || raw.usedPercent > 100) return null;
  return { label, usedPercent: Math.round(raw.usedPercent), resetsAt: iso(raw.resetsAt) };
}

export function normalizeUsageSnapshot(raw: any, now = Date.now()): Section<UsageData> {
  if (!raw?.rateLimits || typeof raw.rateLimits !== 'object' || Array.isArray(raw.rateLimits)) {
    throw new CliError('INVALID_UPSTREAM', 'Orca returned no usage snapshot');
  }
  const providers: ProviderUsage[] = [];
  const labels: Record<string, string> = { antigravity: 'Antigravity', codex: 'Codex', claude: 'Claude',
    gemini: 'Gemini', opencodeGo: 'OpenCode Go', kimi: 'Kimi', minimax: 'MiniMax', grok: 'Grok', cursor: 'Cursor', zcode: 'ZCode' };
  for (const [key, label] of Object.entries(labels)) {
    const value = raw.rateLimits[key];
    if (!value || typeof value !== 'object') continue;
    const windows = [[value.session, '5h'], [value.weekly, 'wk'], [value.monthly, 'mo'], [value.fableWeekly, 'Fable wk']]
      .map(([entry, name]) => windowValue(entry, name)).filter((entry): entry is UsageWindow => entry !== null);
    const buckets = (Array.isArray(value.buckets) ? value.buckets.slice(0, 50) : [])
      .filter((entry: any) => typeof entry?.name === 'string')
      .map((entry: any) => windowValue(entry, entry.name.slice(0, 160).replace(/\s*remaining\s*$/i, '').trim()))
      .filter((entry: UsageWindow | null): entry is UsageWindow => entry !== null);
    const observedAt = iso(value.updatedAt);
    const invalidStatus = !['idle', 'fetching', 'ok', 'error', 'unavailable'].includes(value.status);
    const failed = invalidStatus || value.status === 'error' || value.status === 'unavailable';
    const hasData = windows.length + buckets.length > 0;
    const partial = failed || !hasData ||
      [value.session, value.weekly, value.monthly, value.fableWeekly].filter(Boolean).length !== windows.length ||
      (Array.isArray(value.buckets) && value.buckets.length !== buckets.length);
    providers.push({ provider: key === 'opencodeGo' ? 'opencode' : key, label, windows, buckets, meta: {
      availability: hasData && !failed ? 'ready' : 'unavailable', observedAt, attemptedAt: new Date(now).toISOString(),
      stale: hasData && (failed || !observedAt || now - Date.parse(observedAt) > STALE_MS ||
        [...windows, ...buckets].some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now)),
      partial,
      issue: failed ? { code: 'RUNTIME_UNAVAILABLE', message: 'Orca could not update this provider’s usage', retryable: true } : null,
    } });
  }
  return { data: { providers }, meta: { availability: providers.some((p) => p.meta.availability === 'ready') ? 'ready' : providers.length ? 'unavailable' : 'empty',
    observedAt: providers.map((p) => p.meta.observedAt).filter((v): v is string => v !== null).sort().at(-1) ?? null,
    attemptedAt: new Date(now).toISOString(), stale: providers.some((p) => p.meta.stale),
    partial: providers.some((p) => p.meta.partial), issue: null } };
}

export class UsageCollector {
  private cached: Section<UsageData> | null = null;
  private expiresAt = 0;
  private inFlight: Promise<Section<UsageData>> | null = null;
  constructor(private readSnapshot: () => Promise<unknown> = readOrcaUsageSnapshot) {}

  get(): Promise<Section<UsageData>> {
    if (this.inFlight) return this.inFlight;
    if (this.cached && Date.now() < this.expiresAt) return Promise.resolve(this.cached);
    this.inFlight = this.collect().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async collect(): Promise<Section<UsageData>> {
    try {
      this.cached = normalizeUsageSnapshot(await this.readSnapshot());
    } catch (error) {
      const attemptedAt = new Date().toISOString();
      this.cached = { data: this.cached?.data ?? null, meta: {
        availability: 'unavailable', observedAt: this.cached?.meta.observedAt ?? null, attemptedAt,
        stale: Boolean(this.cached?.data), partial: true,
        issue: error instanceof CliError ? error.issue : { code: 'RUNTIME_UNAVAILABLE', message: 'Start Orca to read provider usage', retryable: true },
      } };
    }
    this.expiresAt = Date.now() + 10000;
    return this.cached;
  }
}
