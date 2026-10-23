import { spawn } from 'node:child_process';
import type { AgentChatModel, AgentChatOptions, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { resolveAgent } from './sessions.js';
import type { ChatControlIO } from './chatControlTypes.js';
import { openCodeV2Models } from './openCodeSessions.js';

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const controls = { model: true, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
const outputPosition = (io: ChatControlIO): number | string => io.outputCursor?.() ?? io.output();
// Wide Kilo pickers append a model-details column to the search and option rows.
const variantLabel = (line: string) => line.split(/\s+\u2502/)[0].trim().replace(/^[\u25cf\u2022]\s*/, '');
function pickerLines(screen: string, title: RegExp): string[] {
  const lines = screen.split('\n'), index = lines.findIndex(line => title.test(line));
  if (index < 0) return [];
  const column = Math.max(0, lines[index].search(title) - 2);
  const escape = /\besc\b/i.exec(lines[index]);
  const end = escape ? escape.index + escape[0].length : undefined;
  // The widget is overlaid on the composer. Text to its left belongs to the
  // underlying screen, not to the picker search field or options.
  return lines.slice(index).map(line => line.slice(column, end));
}
async function filteredPicker(io: ChatControlIO, predicate: (screen: string) => boolean): Promise<string> {
  await io.waitFor(predicate);
  // The input text can render one frame before the native fuzzy results and
  // highlighted row settle. Enter during that frame can select the old row.
  await new Promise(resolve => setTimeout(resolve, 100));
  return io.waitFor(predicate);
}
async function openPicker(command: '/models' | '/variants', title: RegExp, io: ChatControlIO): Promise<void> {
  const start = outputPosition(io);
  await io.write(`\x1b[200~${command}\x1b[201~`);
  // PTY write acknowledgement is not a native render acknowledgement. Wait
  // until the slash command reaches the composer before submitting it.
  await io.waitFor(screen => outputPosition(io) !== start && screen.split('\n').some(line => line.trim().replace(/^[\u2503\u2502]\s*/, '') === command));
  const submitted = outputPosition(io);
  await io.write('\r');
  await io.waitFor(screen => outputPosition(io) !== submitted && title.test(screen));
  // Dialog title paint can precede the native input's focus effect.
  await new Promise(resolve => setTimeout(resolve, 100));
  await io.waitFor(screen => title.test(screen));
}
function footerModel(models: AgentChatModel[], screen: string): AgentChatModel | undefined {
  // The placeholder disappears after the first prompt and Kilo words it differently; use the bottom status rows then.
  const start = screen.lastIndexOf('Ask anything');
  const footer = normalized(start >= 0 ? screen.slice(start) : screen.split('\n').filter(line => line.trim()).slice(-6).join('\n'));
  const matches = models.filter(model => footer.includes(normalized(model.label))).sort((a, b) => normalized(b.label).length - normalized(a.label).length);
  return matches[0] && (!matches[1] || normalized(matches[0].label).length > normalized(matches[1].label).length) ? matches[0] : undefined;
}

function footerEffort(model: AgentChatModel, screen: string): string | undefined {
  const footer = screen.split('\n').filter(line => line.trim()).slice(-6).reverse().find(line => line.includes(model.label));
  if (!footer) return;
  const suffix = footer.slice(footer.lastIndexOf(model.label) + model.label.length);
  const value = suffix.match(/(?:\s|[\u00b7\u2022])([a-zA-Z0-9_-]+)\s*$/)?.[1];
  if (model.efforts.some(effort => effort.value === value)) return value;
  // An observed model footer with no variant uses the native Default selection.
  if (model.efforts.some(effort => effort.value === 'default')) return 'default';
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
    const visible = footerModel(models, screen);
    const effective = visible ?? models.find(model => model.id === observed.model) ?? models.find(model => observed.model && model.id.slice(model.id.indexOf('/') + 1) === observed.model);
    const effort = visible ? footerEffort(visible, screen) : observed.effort && (!effective || effective.id === observed.model || effective.id.slice(effective.id.indexOf('/') + 1) === observed.model) ? observed.effort : undefined;
    return { provider, transport: 'terminal', models, current: { ...(effective ? { model: effective.id } : observed.model ? { model: observed.model } : {}), ...(effort ? { effort } : {}) }, controls: { ...controls, effort: Boolean(effective?.efforts.length) } };
  }
  async apply(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ChatControlIO): Promise<AgentChatOptions> {
    if (request.key === 'effort') return this.applyEffort(options, request.value, io);
    const model = options.models.find(model => model.id === request.value);
    if (request.key !== 'model' || !model) throw new CliError('INVALID_ARGUMENT', 'Select a model from the native catalog');
    if (options.current.model === model.id) return options;
    // A duplicated display name cannot identify a provider safely in this TUI.
    if (options.models.filter(row => normalized(row.label) === normalized(model.label)).length !== 1) throw new CliError('RUNTIME_UNAVAILABLE', 'This model name exists under multiple providers. Choose its provider in the native Terminal picker.');
    await openPicker('/models', /Select model/i, io);
    const pickerStart = outputPosition(io);
    await io.write(`\x1b[200~${model.label}\x1b[201~`);
    const filtered = await filteredPicker(io, screen => outputPosition(io) !== pickerStart && pickerLines(screen, /Select model/i).some(line => variantLabel(line) === model.label));
    const labels = [...options.models].sort((a, b) => b.label.length - a.label.length);
    const lines = pickerLines(filtered, /Select model/i), queryIndex = lines.findIndex(line => variantLabel(line) === model.label);
    const rows = lines.slice(queryIndex + 1).flatMap(line => {
      const value = variantLabel(line);
      const match = labels.find(row => value.startsWith(row.label) && (!value.slice(row.label.length) || /^\s/.test(value.slice(row.label.length))));
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
    await openPicker('/variants', /Select variant/i, io);
    const filteredAt = outputPosition(io);
    await io.write(`\x1b[200~${title}\x1b[201~`);
    const filtered = await filteredPicker(io, screen => outputPosition(io) !== filteredAt && pickerLines(screen, /Select variant/i).filter(line => variantLabel(line) === title).length >= 2);
    const rows = pickerLines(filtered, /Select variant/i).flatMap(line => {
      const label = variantLabel(line);
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
    await openPicker('/variants', /Select variant/i, io);
    await io.waitFor(screen => pickerLines(screen, /Select variant/i).some(line => /^\s*[\u25cf\u2022]/.test(line) && variantLabel(line) === title));
    await io.write('\x1b'); await io.waitFor(screen => !/Select variant/.test(screen));
    return { ...options, current: { ...options.current, effort: value }, unconfirmed: false };
  }
}
