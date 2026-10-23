import { spawn } from 'node:child_process';
import type { WorkflowModel, WorkflowProvider, OrganizationNode } from '../../shared/contracts.js';
import { resolveAgent } from './sessions.js';
import { codexRequest } from './codexThread.js';
import { CliError } from '../integrations/cli.js';
import { invalid } from './workflowConfig.js';

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
  private cache = new Map<WorkflowProvider, { at: number; models: WorkflowModel[] }>();
  private pending = new Map<WorkflowProvider, Promise<WorkflowModel[]>>();
  async list(provider: WorkflowProvider): Promise<WorkflowModel[]> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.at < 60000) return cached.models;
    const reusable = cached && Date.now() - cached.at < 300000 ? cached.models : undefined;
    const previous = this.pending.get(provider); if (previous) return reusable ?? previous;
    const request = this.discover(provider).then(models => {
      if (!models.length) throw new CliError('RUNTIME_UNAVAILABLE', 'This provider did not expose a model catalog. Use its default model or update the provider.');
      this.cache.set(provider, { at: Date.now(), models }); return models;
    }).finally(() => this.pending.delete(provider));
    this.pending.set(provider, request);
    if (reusable) { void request.catch(() => {}); return reusable; }
    return request;
  }
  private async discover(provider: WorkflowProvider): Promise<WorkflowModel[]> {
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
    if (provider === 'opencode' || provider === 'opencode2' || provider === 'kilo') {
      const raw = await listing(resolved, provider === 'opencode2' ? ['models', '--standalone'] : ['models']);
      return [...new Set(raw.split(/\r?\n/).map(line => line.trim()).filter(id => /^[a-zA-Z0-9_.:-]+\/[a-zA-Z0-9_.:/-]+$/.test(id)))].slice(0,200).map(id => ({ id, label: id, efforts: [] }));
    }
    if (provider === 'codebuddy') {
      const help = await listing(resolved, ['--help']);
      const values = help.match(/Currently supported: \(([^)]+)\)/)?.[1] ?? '';
      return values.split(',').map(id => id.trim()).filter(id => /^[a-zA-Z0-9_.:/-]{1,200}$/.test(id)).slice(0,200).map(id => ({ id, label: id, efforts: [] }));
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
