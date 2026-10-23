import { spawn } from 'node:child_process';
import type { AgentChatModel, AgentChatOptions, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { resolveAgent } from './sessions.js';
import type { ChatControlIO } from './chatControlTypes.js';
import { openCodeV2Models } from './openCodeSessions.js';

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const controls = { model: true, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
function footerModel(models: AgentChatModel[], screen: string): AgentChatModel | undefined {
  // The placeholder disappears after the first prompt and Kilo words it differently; use the bottom status rows then.
  const start = screen.lastIndexOf('Ask anything');
  const footer = normalized(start >= 0 ? screen.slice(start) : screen.split('\n').filter(line => line.trim()).slice(-6).join('\n'));
  const matches = models.filter(model => footer.includes(normalized(model.label))).sort((a, b) => normalized(b.label).length - normalized(a.label).length);
  return matches[0] && (!matches[1] || normalized(matches[0].label).length > normalized(matches[1].label).length) ? matches[0] : undefined;
}

/** Native catalogs and the owned TUI's /models picker; no peer ACP session or
 * provider database mutation can change the running terminal's selected model. */
export class OpenCodeChatControls {
  private cache = new Map<string, { at: number; models: AgentChatModel[] }>();
  private pending = new Map<string, Promise<AgentChatModel[]>>();
  private async catalog(provider: 'opencode' | 'opencode2' | 'kilo', cwd: string): Promise<AgentChatModel[]> {
    const key = `${provider}:${cwd}`, cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.models;
    const previous = this.pending.get(key); if (previous) return previous;
    const resolved = resolveAgent(provider);
    if (!resolved) throw new CliError('CLI_MISSING', 'Install this provider before selecting its model');
    const request = (provider === 'opencode2' ? openCodeV2Models(resolved, cwd) : new Promise<AgentChatModel[]>((resolve, reject) => {
      const child = spawn(resolved.executable, [...resolved.args, 'models', '--verbose'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '', bytes = 0, settled = false;
      const finish = (error?: Error) => {
        if (settled) return; settled = true; clearTimeout(timer); child.kill();
        if (error) { reject(error); return; }
        try {
          const models: AgentChatModel[] = [];
          for (const block of output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n(?=[a-zA-Z0-9_.-]+\/[^\r\n]+\r?\n\{)/)) {
            const newline = block.indexOf('\n'), id = block.slice(0, newline).trim();
            if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/@+-]{1,200}$/.test(id)) continue;
            const model = JSON.parse(block.slice(newline + 1));
            if (model.status === 'deprecated' || typeof model.name !== 'string' || !clean(model.name).trim()) continue;
            const variants = model.variants && typeof model.variants === 'object' && !Array.isArray(model.variants)
              ? Object.keys(model.variants).filter(value => /^[a-zA-Z0-9_-]{1,80}$/.test(value) && model.variants[value]?.disabled !== true).slice(0, 32) : [];
            models.push({ id, label: clean(model.name), description: clean(String(model.providerID ?? id.split('/')[0])), efforts: variants.length ? ['default', ...variants.filter(value => value !== 'default')].map(value => ({ value, label: value === 'default' ? 'Default' : value })) : [] });
            if (models.length >= 500) break;
          }
          if (!models.length) throw new Error();
          resolve(models);
        } catch { reject(new CliError('RUNTIME_UNAVAILABLE', 'The native model catalog could not be decoded. Update the provider CLI and retry.')); }
      };
      const timer = setTimeout(() => finish(new CliError('CLI_TIMEOUT', 'Native model discovery timed out')), 15000);
      child.on('error', () => finish(new CliError('CLI_FAILED', 'Native model discovery failed')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) finish(new CliError('CLI_FAILED', 'Native model catalog exceeds the read limit')); else output += chunk; });
      child.on('exit', code => finish(code === 0 ? undefined : new CliError('CLI_FAILED', 'Native model discovery failed')));
    })).then(models => {
      if (!models.length) throw new CliError('RUNTIME_UNAVAILABLE', 'The native model catalog is empty. Connect a provider in Terminal and retry.');
      if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: Date.now(), models }); return models;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request); return request;
  }
  async read(provider: 'opencode' | 'opencode2' | 'kilo', cwd: string, observed: { model?: string | null; effort?: string | null }, screen: string): Promise<AgentChatOptions> {
    const models = await this.catalog(provider, cwd);
    const effective = footerModel(models, screen) ?? models.find(model => model.id === observed.model) ?? models.find(model => observed.model && model.id.slice(model.id.indexOf('/') + 1) === observed.model);
    return { provider, transport: 'terminal', models, current: { ...(effective ? { model: effective.id } : observed.model ? { model: observed.model } : {}), ...(observed.effort && (!effective || effective.id === observed.model || effective.id.slice(effective.id.indexOf('/') + 1) === observed.model) ? { effort: observed.effort } : {}) }, controls: { ...controls, effort: Boolean(effective?.efforts.length) } };
  }
  async apply(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ChatControlIO): Promise<AgentChatOptions> {
    if (request.key === 'effort') return this.applyEffort(options, request.value, io);
    const model = options.models.find(model => model.id === request.value);
    if (request.key !== 'model' || !model) throw new CliError('INVALID_ARGUMENT', 'Select a model from the native catalog');
    if (options.current.model === model.id) return options;
    // A duplicated display name cannot identify a provider safely in this TUI.
    if (options.models.filter(row => normalized(row.label) === normalized(model.label)).length !== 1) throw new CliError('RUNTIME_UNAVAILABLE', 'This model name exists under multiple providers. Choose its provider in the native Terminal picker.');
    await io.write('\x1b[200~/models\x1b[201~'); await io.write('\r');
    await io.waitFor(screen => /Select model/i.test(screen));
    await io.write(`\x1b[200~${model.label}\x1b[201~`);
    const filtered = await io.waitFor(screen => /Select model/i.test(screen) && screen.split('\n').some(line => line.trim() === model.label));
    const body = filtered.slice(filtered.toLowerCase().indexOf('select model')).split('Ask anything')[0];
    const labels = [...options.models].sort((a, b) => b.label.length - a.label.length);
    const rows = body.split('\n').flatMap(line => {
      if (line.trim() === model.label) return [];
      const match = labels.find(row => line.includes(row.label) && line.slice(line.indexOf(row.label) + row.label.length).trim());
      return match ? [match] : [];
    });
    const index = rows.findIndex(row => row.id === model.id);
    if (index < 0 || index > 20) throw new CliError('RUNTIME_UNAVAILABLE', 'The exact model row could not be identified. Finish selection in Terminal.');
    // Native filtering resets selection to its first row; preserve the actual
    // rendered order rather than assuming fuzzy search ranks the exact name first.
    if (index) await io.write('\x1b[B'.repeat(index));
    await io.write('\r');
    const screen = await io.waitFor(screen => /Select variant/i.test(screen) || (!/Select model/i.test(screen) && footerModel(options.models, screen)?.id === model.id));
    if (/Select variant/i.test(screen)) { await io.write('\x1b'); await io.waitFor(screen => !/Select variant|Select model/i.test(screen) && footerModel(options.models, screen)?.id === model.id); }
    return { ...options, current: { model: model.id }, controls: { ...options.controls, effort: Boolean(model.efforts.length) }, unconfirmed: false };
  }

  private async applyEffort(options: AgentChatOptions, value: string, io: ChatControlIO): Promise<AgentChatOptions> {
    const model = options.models.find(row => row.id === options.current.model);
    const choice = model?.efforts.find(row => row.value === value);
    if (!model || !choice) throw new CliError('INVALID_ARGUMENT', 'Select an effort from the current native model catalog');
    const title = value === 'default' ? 'Default' : value;
    await io.write('\x1b[200~/variants\x1b[201~'); await io.write('\r');
    await io.waitFor(screen => /Select variant/.test(screen));
    await io.write(`\x1b[200~${title}\x1b[201~`);
    const filtered = await io.waitFor(screen => /Select variant/.test(screen) && screen.split('\n').filter(line => line.trim().replace(/^●\s*/, '') === title).length >= 2);
    const rows = filtered.slice(filtered.indexOf('Select variant')).split('\n').flatMap(line => {
      const label = line.trim().replace(/^●\s*/, '');
      return model.efforts.some(row => (row.value === 'default' ? 'Default' : row.value) === label) ? [label] : [];
    });
    // The first matching line is the filter. Native filtering resets selection
    // to row zero; use the observed row order rather than variant sort order.
    if (rows[0] !== title) throw new CliError('RUNTIME_UNAVAILABLE', 'The native variant filter could not be identified. Finish selection in Terminal.');
    rows.shift();
    const index = rows.indexOf(title);
    if (index < 0 || index > 32 || rows.filter(row => row === title).length !== 1) throw new CliError('RUNTIME_UNAVAILABLE', 'The exact native variant row could not be identified');
    if (index) await io.write('\x1b[B'.repeat(index));
    await io.write('\r');
    await io.waitFor(screen => !/Select variant/.test(screen) && footerModel(options.models, screen)?.id === model.id);
    // Reopen read-only to verify the native current marker, including Default,
    // which may be omitted from the ordinary footer. Never infer success from Enter.
    await io.write('\x1b[200~/variants\x1b[201~'); await io.write('\r');
    await io.waitFor(screen => /Select variant/.test(screen) && screen.split('\n').some(line => /^\s*●/.test(line) && line.trim().replace(/^●\s*/, '') === title));
    await io.write('\x1b'); await io.waitFor(screen => !/Select variant/.test(screen));
    return { ...options, current: { ...options.current, effort: value }, unconfirmed: false };
  }
}
