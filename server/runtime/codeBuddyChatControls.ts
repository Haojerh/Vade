import { spawn } from 'node:child_process';
import type { AgentChatModel, AgentChatOptions, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { resolveAgent } from './sessions.js';
import type { ChatControlIO } from './chatControlTypes.js';

const controls = { model: true, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
const safe = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/;
const strip = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const choice = (value: string) => ({ value, label: value === 'xhigh' ? 'XHigh' : value.charAt(0).toUpperCase() + value.slice(1) });
const invalid = (message: string): never => { throw new CliError('INVALID_ARGUMENT', message); };

/** Commands and acknowledgements verified in CodeBuddy Code 2.173.0. */
export class CodeBuddyChatControls {
  private catalogs = new Map<string, { at: number; models: AgentChatModel[] }>();
  private pending = new Map<string, Promise<AgentChatModel[]>>();
  private efforts = new Map<string, { model: string; values: string[] }>();

  private async catalog(cwd: string): Promise<AgentChatModel[]> {
    const cached = this.catalogs.get(cwd);
    if (cached && Date.now() - cached.at < 60000) return cached.models;
    const pending = this.pending.get(cwd); if (pending) return pending;
    const resolved = resolveAgent('codebuddy');
    if (!resolved) throw new CliError('CLI_MISSING', 'Install CodeBuddy Code before choosing a model');
    const request = new Promise<AgentChatModel[]>((resolve, reject) => {
      const child = spawn(resolved.executable, [...resolved.args, '--help'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '', bytes = 0, settled = false;
      const finish = (success: boolean) => {
        if (settled) return; settled = true; clearTimeout(timer); child.kill();
        const ids = strip(output).match(/Currently supported: \(([^)]+)\)/)?.[1].split(',').map(value => value.trim()).filter(value => safe.test(value)) ?? [];
        if (!success || !ids.length) { reject(new CliError('RUNTIME_UNAVAILABLE', 'CodeBuddy did not expose its current model catalog. Check its native sign-in.')); return; }
        resolve([...new Set(ids)].slice(0, 200).map(id => ({ id, label: id, efforts: [] })));
      };
      const timer = setTimeout(() => finish(false), 15000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) finish(false); else output += chunk; });
      child.on('error', () => finish(false)); child.on('exit', code => finish(code === 0));
    }).then(models => {
      if (this.catalogs.size >= 32) this.catalogs.delete(this.catalogs.keys().next().value!);
      this.catalogs.set(cwd, { at: Date.now(), models }); return models;
    }).finally(() => this.pending.delete(cwd));
    this.pending.set(cwd, request); return request;
  }

  async read(observed: { model?: string | null; effort?: string | null }, cwd: string, sessionKey: string): Promise<AgentChatOptions> {
    const capability = this.efforts.get(sessionKey);
    const models = (await this.catalog(cwd)).map(model => ({ ...model, efforts: capability?.model === model.id ? capability.values.map(choice) : [] }));
    const current = { ...(observed.model && safe.test(observed.model) ? { model: observed.model } : {}), ...(observed.effort && safe.test(observed.effort) ? { effort: observed.effort } : {}) };
    return { provider: 'codebuddy', transport: 'terminal', models, current, controls: { ...controls, effort: Boolean(models.find(model => model.id === current.model)?.efforts.length), providerPicker: Boolean(current.model) && capability?.model !== current.model } };
  }

  /** Caller holds the idle owned terminal's input lock and has checked its empty composer. */
  async inspectEfforts(options: AgentChatOptions, io: ChatControlIO, sessionKey: string): Promise<AgentChatOptions> {
    if (!options.current.model) return options;
    await command('/effort', io);
    const screen = await io.waitFor(value => /(?:^|\n)\s*Effort\s*(?:\n|$)/.test(value) && /Esc to cancel/.test(value));
    if (/Could not read the current model effort capabilities/.test(screen)) {
      await io.write('\x1b'); await io.waitFor(value => !/Esc to cancel/.test(value)); return options;
    }
    const lines = screen.split('\n');
    const labels = lines.find(line => /^\s*(?:low|medium|high|xhigh|max)(?:\s+(?:low|medium|high|xhigh|max))*(?:\s+ultracode)?\s*$/.test(line));
    const values = labels?.match(/\b(?:low|medium|high|xhigh|max)\b/g) ?? [];
    await io.write('\x1b'); await io.waitFor(value => !/Esc to cancel/.test(value));
    if (this.efforts.size >= 200) this.efforts.delete(this.efforts.keys().next().value!);
    this.efforts.set(sessionKey, { model: options.current.model, values });
    return { ...options, models: options.models.map(model => model.id === options.current.model ? { ...model, efforts: values.map(choice) } : model), controls: { ...options.controls, effort: values.length > 0, providerPicker: false } };
  }

  async apply(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ChatControlIO, sessionKey: string): Promise<AgentChatOptions> {
    if (request.key === 'providerPicker' && request.value === 'open' && options.controls.providerPicker) return this.inspectEfforts(options, io, sessionKey);
    const model = options.models.find(value => value.id === options.current.model);
    if (request.key === 'model' ? !options.models.some(value => value.id === request.value) : request.key !== 'effort' || !model?.efforts.some(value => value.value === request.value)) invalid('Choose a setting advertised by the current CodeBuddy session');
    if (options.current[request.key as 'model' | 'effort'] === request.value) return options;
    let targetName: string | undefined;
    if (request.key === 'model') {
      const listStart = io.output().length;
      await command('/model list', io);
      const listed = (text: string) => /Available models:/.test(text) && /To switch model:\s*\/model/.test(text);
      await io.waitFor(() => listed(io.output().slice(listStart)));
      const listText = io.output().slice(listStart);
      const escaped = request.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lines = listText.split(/[\r\n]/);
      const row = lines.map(line => line.match(new RegExp(`^\\s*[-•]\\s+(.+?)\\s+\\(${escaped}\\)(?:\\s+← current)?\\s*$`))).find(Boolean);
      targetName = row?.[1] ?? (lines.some(line => new RegExp(`^\\s*[-•]\\s+${escaped}(?:\\s+← current)?\\s*$`).test(line)) ? request.value : undefined);
      if (!targetName) invalid('CodeBuddy did not identify this model in its current native list. Select it in Terminal.');
    }
    const start = io.output().length;
    await command(`/${request.key} ${request.value}`, io);
    await io.waitFor(() => {
      const fresh = io.output().slice(start);
      const acknowledgements = [`Switched model to ${targetName}.`, `Switched this session to ${targetName}.`, `Switched this session to ${targetName}, but the global default could not be saved.`];
      return request.key === 'model' ? fresh.split(/\r?\n/).some(line => acknowledgements.includes(line.trim()))
        : [`Model reasoning effort set to \`${request.value}\`.`, `Model reasoning effort set to ${request.value}.`].some(message => fresh.includes(message));
    });
    const result: AgentChatOptions = { ...options, current: { ...options.current, [request.key]: request.value, ...(request.key === 'model' ? { effort: undefined } : {}) } };
    if (request.key === 'model') {
      this.efforts.delete(sessionKey);
      return { ...result, models: result.models.map(value => ({ ...value, efforts: [] })), controls: { ...result.controls, effort: false, providerPicker: true } };
    }
    return result;
  }
}

async function command(value: string, io: ChatControlIO): Promise<void> {
  for (const char of value) { await io.write(char); await new Promise(resolve => setTimeout(resolve, 20)); }
  await io.write('\r');
}
