import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowModel, WorkflowProvider, OrganizationNode } from '../../shared/contracts.js';
import { resolveAgent } from './sessions.js';
import { codexRequest } from './codexThread.js';
import { CliError } from '../integrations/cli.js';
import { invalid } from './workflowConfig.js';
import { OpenCodeChatControls } from './openCodeChatControls.js';
import { dshCatalog } from './dshCatalog.js';
import { dshOptions } from './dsh.js';
import type { AdeStore } from './store.js';

const dshCacheKey = 'workflow-models:dsh';

function dshModels(value: unknown): WorkflowModel[] {
  if (!Array.isArray(value)) return [];
  const safe = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,199}$/.test(id);
  return value.slice(0, 200).flatMap((row: any) => {
    if (!safe(row?.id) || typeof row.label !== 'string') return [];
    const efforts = Array.isArray(row.efforts) ? [...new Set<string>(row.efforts.flatMap((effort: unknown) => safe(effort) ? [effort] : []))].slice(0, 16) : [];
    return [{ id: row.id, label: row.label.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160), efforts }];
  });
}

export function mergeDshModels(fresh: WorkflowModel[], observed: WorkflowModel[]): WorkflowModel[] {
  const details = new Map(observed.map(model => [model.id, model]));
  return fresh.map(model => {
    const native = details.get(model.id);
    return native ? { ...model, label: native.label || model.label, efforts: native.efforts } : model;
  });
}

/** Fixed metadata-only ACP exchange; never prompt, authenticate or mutate a live session. */
export function codeBuddyWorkflowCatalog(resolved: { executable: string; args: string[] }): Promise<WorkflowModel[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-codebuddy-catalog-'));
  let closed = Promise.resolve();
  return new Promise<WorkflowModel[]>((resolve, reject) => {
    const child = spawn(resolved.executable, [...resolved.args, '--acp', '--no-session-persistence', '--permission-mode', 'dontAsk', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let buffer = '', bytes = 0, settled = false, initialized = false;
    const finish = (models?: WorkflowModel[]) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
      models?.length ? resolve(models) : reject(new CliError('RUNTIME_UNAVAILABLE', 'CodeBuddy model capabilities could not be read. Check native sign-in and retry the catalog.'));
    };
    const send = (value: object) => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n'); };
    const timer = setTimeout(() => finish(), 25000);
    child.stdin.on('error', () => finish());
    child.once('error', () => finish()); child.once('exit', () => finish());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { finish(); return; }
      buffer += chunk;
      let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        if (message?.method) {
          // Catalog reads cannot grant permissions, read files or execute tools.
          if (typeof message.id === 'string' || typeof message.id === 'number') send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Catalog client does not provide tools' } });
        } else if (message?.id === 1 && !initialized) {
          if (message.error || message.result?.protocolVersion !== 1) { finish(); return; }
          initialized = true;
          send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
        } else if (message?.id === 2 && initialized) {
          const rows = message.result?.models?.availableModels;
          if (message.error || !Array.isArray(rows)) { finish(); return; }
          const models: WorkflowModel[] = [], seen = new Set<string>();
          for (const row of rows.slice(0, 200)) {
            if (typeof row?.modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(row.modelId) || seen.has(row.modelId)) continue;
            seen.add(row.modelId);
            const efforts = Array.isArray(row._meta?.effortOptions) ? [...new Set<string>(row._meta.effortOptions.flatMap((option: any) => typeof option?.value === 'string' && /^(?:minimal|low|medium|high|xhigh|max)$/.test(option.value) ? [option.value] : []))] : [];
            // Native display names can be identical for distinct routing IDs.
            const window = row._meta?.maxInputTokens;
            models.push({ id: row.modelId, label: row.modelId, efforts, ...(Number.isSafeInteger(window) && window > 0 && window <= 1e12 ? { contextWindow: window } : {}) });
          }
          finish(models);
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Vade model catalog', version: '1' } } });
  }).finally(async () => { await closed; await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
}

function listing(resolved: { executable: string; args: string[] }, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, [...resolved.args, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', bytes = 0, settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(output); };
    const failure = () => new CliError('CLI_FAILED', 'Provider model discovery failed. Check its installation and sign-in.');
    const timer = setTimeout(() => finish(failure()), 15000);
    child.on('error', () => finish(failure()));
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) finish(failure()); else output += chunk.toString(); });
    child.on('exit', code => finish(code === 0 ? undefined : failure()));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export class WorkflowModels {
  constructor(private store?: AdeStore) {}
  private openCode = new OpenCodeChatControls();
  private cache = new Map<WorkflowProvider, { at: number; models: WorkflowModel[] }>();
  private pending = new Map<WorkflowProvider, Promise<WorkflowModel[]>>();
  async list(provider: WorkflowProvider): Promise<WorkflowModel[]> {
    let dshObserved: WorkflowModel[] = [];
    if (provider === 'dsh') {
      for (const project of this.store?.projects() ?? []) for (const record of this.store!.sessions(project.id)) {
        if (record.provider !== 'dsh') continue;
        try {
          const options = dshOptions(this.store!.directory, record);
          if (!options.models.length) continue;
          dshObserved = options.models.map(model => ({ id: model.id, label: model.label, efforts: model.efforts.map(effort => effort.value) }));
          if (!record.closed) { this.rememberDsh(dshObserved); return dshObserved; }
        } catch { /* Closed or setup-pending sessions retain the last complete observation below. */ }
      }
      if (dshObserved.length) this.rememberDsh(dshObserved);
      dshObserved = dshObserved.length ? dshObserved : this.rememberedDsh();
    }
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.at < 60000) return cached.models;
    const reusable = cached && Date.now() - cached.at < 300000 ? cached.models : undefined;
    const previous = this.pending.get(provider); if (previous) return reusable ?? previous;
    const request = this.discover(provider).then(discovered => {
      const models = provider === 'dsh' ? mergeDshModels(discovered, dshObserved) : discovered;
      if (!models.length) throw new CliError('RUNTIME_UNAVAILABLE', 'This provider did not expose a model catalog. Use its default model or update the provider.');
      this.cache.set(provider, { at: Date.now(), models }); return models;
    }).finally(() => this.pending.delete(provider));
    this.pending.set(provider, request);
    if (reusable) { void request.catch(() => {}); return reusable; }
    return request;
  }
  private rememberedDsh(): WorkflowModel[] {
    try {
      const row = this.store?.db.prepare("SELECT value FROM preferences WHERE key = ?").get(dshCacheKey);
      if (!row || typeof row.value !== 'string' || row.value.length > 256 * 1024) return [];
      return dshModels(JSON.parse(String(row.value)));
    } catch { return []; }
  }
  private rememberDsh(models: WorkflowModel[]): void {
    if (!this.store || !models.length) return;
    try { this.store.db.prepare('INSERT OR REPLACE INTO preferences VALUES (?, ?)').run(dshCacheKey, JSON.stringify(dshModels(models))); }
    catch { /* The fresh provider-owned observation remains usable if persistence fails. */ }
  }
  private async discover(provider: WorkflowProvider): Promise<WorkflowModel[]> {
    if (provider === 'dsh') return dshCatalog();
    if (provider === 'opencode' || provider === 'opencode2' || provider === 'kilo') {
      return (await this.openCode.catalog(provider, process.cwd())).map(model => ({ id: model.id, label: model.label, efforts: model.efforts.map(effort => effort.value) }));
    }
    const resolved = resolveAgent(provider);
    if (!resolved) throw new CliError('CLI_MISSING', 'Install this provider before selecting a model');
    if (provider === 'codex') return codexRequest(resolved, process.cwd(), async call => {
      const models: WorkflowModel[] = []; let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const value = await call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const row of Array.isArray(value?.data) ? value.data : []) if (typeof row.model === 'string' && !row.hidden) models.push({ id: row.model, label: row.displayName || row.model, efforts: (row.supportedReasoningEfforts ?? []).map((entry: any) => entry.reasoningEffort).filter((v: any) => typeof v === 'string') });
        cursor = typeof value?.nextCursor === 'string' ? value.nextCursor : null; if (!cursor) break;
      }
      return models.slice(0, 200);
    });
    if (provider === 'codebuddy') {
      return codeBuddyWorkflowCatalog(resolved);
    }
    if (provider === 'antigravity') {
      const raw = await listing(resolved, ['models']);
      // The installed native CLI emits model ID and label separated by a tab.
      const models: WorkflowModel[] = raw.split(/\r?\n/).flatMap(line => {
        const [id, label] = line.split('\t');
        return id && label && /^[a-zA-Z0-9._/-]{1,200}$/.test(id) ? [{ id, label: label.trim(), efforts: [] }] : [];
      }).slice(0, 200);
      // Offer only effort variants actually reported by this installed CLI.
      for (const model of models) {
        const match = model.id.match(/^(.*)-(low|medium|high|xhigh|max)$/);
        if (!match) continue;
        model.effortModels = Object.fromEntries(models.flatMap(candidate => {
          const variant = candidate.id.match(/^(.*)-(low|medium|high|xhigh|max)$/);
          return variant?.[1] === match[1] ? [[variant[2], candidate.id]] : [];
        }));
        model.efforts = Object.keys(model.effortModels);
      }
      return models;
    }
    const raw = await listing(resolved, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'], JSON.stringify({ type: 'control_request', request_id: 'vade-model-discovery', request: { subtype: 'list_models' } }) + '\n');
    for (const line of raw.split(/\r?\n/)) {
      let message: any; try { message = JSON.parse(line); } catch { continue; }
      const rows = message?.type === 'control_response' ? message.response?.response?.models : null;
      if (Array.isArray(rows)) return rows.filter(row => !row.disabled && typeof row.value === 'string').slice(0, 200).map(row => ({ id: row.value, label: row.displayName || row.value, efforts: row.supportsEffort && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels : [] }));
    }
    return [];
  }
  async validate(node: Pick<OrganizationNode, 'provider' | 'model' | 'effort'>): Promise<void> {
    if (!node.model) { if (node.effort) invalid('Effort requires a selected model'); return; }
    const model = (await this.list(node.provider)).find(row => row.id === node.model);
    if (!model || (node.effort && !model.efforts.includes(node.effort))) invalid('Select an available model and supported effort');
  }
  async launchOptions(node: OrganizationNode): Promise<{ model: string | null; effort: string | null }> {
    await this.validate(node);
    if (node.provider === 'antigravity' && node.model && node.effort) {
      const model = (await this.list(node.provider)).find(model => model.id === node.model)!;
      return { model: model.effortModels![node.effort], effort: null };
    }
    return { model: node.model, effort: node.effort };
  }
}
