import { spawn } from 'node:child_process';
import type { AgentChatModel, AgentChatOptions, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { codexRequest } from './codexThread.js';
import { resolveAgent } from './sessions.js';
import type { ChatControlIO } from './chatControlTypes.js';
import {claudeEffortAcknowledgement} from '../providers/shared.js';

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_.\/:+@()\[\]-]{0,199}$/;
const text = (value: unknown, limit = 160): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';
const choice = (value: string) => ({ value, label: value === 'xhigh' ? 'XHigh' : value.charAt(0).toUpperCase() + value.slice(1) });
const controls = { model: false, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
const resolvedModelAliases = new WeakMap<AgentChatModel[], Map<string, string>>();
const invalid = (message: string): never => { throw new CliError('INVALID_ARGUMENT', message); };
type ProviderControlIO = ChatControlIO;
type Provider = 'claude' | 'codex';

/** Provider-native catalogs, matching Orca's model/list and list_models wire formats. */
export class ProviderChatControls {
  private cache = new Map<string, { at: number; models: AgentChatModel[] }>();
  private pending = new Map<string, Promise<AgentChatModel[]>>();
  async catalog(provider: Provider, cwd: string): Promise<AgentChatModel[]> {
    const resolved = resolveAgent(provider);
    if (!resolved) throw new CliError('CLI_MISSING', 'Install this provider before selecting its settings');
    const key = JSON.stringify([provider, cwd, resolved]);
    const cached = this.cache.get(key); if (cached && Date.now() - cached.at < 60000) return cached.models;
    const reusable = cached && Date.now() - cached.at < 300000 ? cached.models : undefined;
    const previous = this.pending.get(key); if (previous) return reusable ?? previous;
    const request = (provider === 'codex' ? codexRequest(resolved, cwd, async call => {
      const models: AgentChatModel[] = []; let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const response = await call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const row of Array.isArray(response?.data) ? response.data.slice(0, 100) : []) {
          const id = text(row.model || row.id, 200); if (!SAFE.test(id) || row.hidden === true) continue;
          const tiers = Array.isArray(row.serviceTiers) && row.serviceTiers.length ? row.serviceTiers.slice(0, 16).flatMap((tier: any) => typeof tier?.id === 'string' && SAFE.test(tier.id) ? [{ value: tier.id, label: text(tier.name) || tier.id }] : [])
            : Array.isArray(row.additionalSpeedTiers) ? row.additionalSpeedTiers.filter((tier: any) => typeof tier === 'string' && SAFE.test(tier)).slice(0, 16).map(choice) : undefined;
          models.push({ id, label: text(row.displayName) || id, description: text(row.description, 500), efforts: (Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []).slice(0, 16).flatMap((entry: any) => typeof entry?.reasoningEffort === 'string' && SAFE.test(entry.reasoningEffort) ? [choice(entry.reasoningEffort)] : []),
            ...(tiers ? { serviceTiers: tiers, supportsFastMode: tiers.some((tier: any) => /^(fast|priority)$/i.test(tier.value) || /^fast$/i.test(tier.label)) } : {}) });
        }
        cursor = typeof response?.nextCursor === 'string' && response.nextCursor.length <= 512 ? response.nextCursor : null;
        if (!cursor || models.length >= 200) break;
      }
      return models.slice(0, 200);
    }) : claudeCatalog(resolved, cwd)).then(models => {
      if (!models.length) throw new CliError('RUNTIME_UNAVAILABLE', 'The installed provider did not expose its model catalog');
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: Date.now(), models }); return models;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    // Catalogs change slowly. Keep opening the picker fast while refreshing the
    // provider listing; effective settings are still read from this session.
    if (reusable) { void request.catch(() => {}); return reusable; }
    return request;
  }
  async read(provider: Provider, observed: { model?: string | null; effort?: string | null; fastMode?: boolean; serviceTier?: string }, screenSource: string | (() => string), cwd: string): Promise<AgentChatOptions> {
    const models = await this.catalog(provider, cwd);
    const screen = typeof screenSource === 'function' ? screenSource() : screenSource;
    const visible = provider === 'codex' ? codexFooter(models, screen) : {};
    const effective = { ...observed, ...visible };
    const alias = effective.model ? resolvedModelAliases.get(models)?.get(effective.model) : undefined;
    const model = models.find(row => row.id === (alias ?? effective.model) || row.label.toLowerCase() === effective.model?.toLowerCase());
    const current: AgentChatOptions['current'] = { ...(model ? {model:model.id} : effective.model && SAFE.test(effective.model) ? {model:effective.model} : {}), ...(effective.effort && SAFE.test(effective.effort) ? { effort: effective.effort } : {}), ...(typeof observed.fastMode === 'boolean' ? { fastMode: observed.fastMode } : {}), ...(observed.serviceTier && SAFE.test(observed.serviceTier) ? { serviceTier: observed.serviceTier } : {}), ...('fastMode' in visible ? { fastMode: visible.fastMode, serviceTier: visible.serviceTier } : {}) };
    if (provider === 'codex' && !('fastMode' in visible)) {
      const tier = screen.match(/Service tier set to (priority|fast|default)\b/g)?.at(-1)?.split(' ').at(-1);
      if (tier) { current.serviceTier = tier; current.fastMode = tier !== 'default'; }
    }
    return { provider, transport: 'terminal', models, current, controls: { ...controls, model: true, effort: Boolean(model?.efforts.length), fastMode: model?.supportsFastMode === true && typeof current.fastMode === 'boolean', fastToggle: model?.supportsFastMode === true && typeof current.fastMode !== 'boolean' } };
  }
  async apply(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ProviderControlIO): Promise<AgentChatOptions> {
    const model = options.models.find(row => row.id === options.current.model);
    if (request.key === 'model' ? !options.models.some(row => row.id === request.value) : request.key === 'effort' ? !model?.efforts.some(row => row.value === request.value) : request.key === 'fastMode' ? !options.controls.fastMode || !['true', 'false'].includes(request.value) : request.key !== 'fastToggle' || request.value !== 'open' || !options.controls.fastToggle) invalid('Choose an option advertised by this provider');
    if (request.key === 'fastMode' && options.current.fastMode === (request.value === 'true')) return options;
    if ((request.key === 'model' || request.key === 'effort') && options.current[request.key] === request.value) return options;
    const fast = request.key === 'fastToggle' || request.key === 'fastMode';
    if (options.provider === 'codex' && !fast) return applyCodexPicker(options, request, io);
    const command = fast ? '/fast' : request.key === 'model' ? `/model ${request.value}` : `/effort ${request.value}`;
    const before = io.output().length;
    const beforeFooter = options.provider === 'codex' ? codexFooter(options.models, io.screen()) : {};
    await typeCommand(command, io);
    const desired = options.models.find(row => row.id === request.value);
    const desiredFast = request.key === 'fastMode' ? request.value === 'true' : typeof options.current.fastMode === 'boolean' ? !options.current.fastMode : undefined;
    const confirmed = await io.waitFor(screen => {
      if(options.provider==='claude'&&!fast&&io.settingConfirmed?.())return true;
      const fresh = io.output().slice(before).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const tier = fresh.match(/Service tier set to (priority|fast|default)\b/g)?.at(-1)?.split(' ').at(-1);
      const footer = options.provider === 'codex' ? codexFooter(options.models, screen) : {};
      const changedFooter = typeof footer.fastMode === 'boolean' && typeof beforeFooter.fastMode === 'boolean' && footer.fastMode !== beforeFooter.fastMode && (desiredFast === undefined || footer.fastMode === desiredFast);
      return fast ? changedFooter || (tier !== undefined && (desiredFast === undefined || (tier !== 'default') === desiredFast)) || (options.provider === 'claude' && /fast mode.*(?:on|off|enabled|disabled)/i.test(fresh))
      : fresh.split(/[\r\n]/).some(line => request.key === 'model' ? /(?:set|switched|changed|kept).*model|model.*(?:set|switched|changed|kept)/i.test(line) && [desired?.id, desired?.label].some(value => value && norm(line).includes(norm(value)))
        : claudeEffortAcknowledgement(line) === request.value);
    });
    const tier = io.output().slice(before).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').match(/Service tier set to (priority|fast|default)\b/g)?.at(-1)?.split(' ').at(-1);
    if (tier) return { ...options, current: { ...options.current, serviceTier: tier, fastMode: tier !== 'default' }, controls: { ...options.controls, fastMode: true, fastToggle: false } };
    if (fast) {
      const footer = options.provider === 'codex' ? codexFooter(options.models, confirmed) : {};
      if (typeof footer.fastMode === 'boolean' && footer.fastMode !== beforeFooter.fastMode && (desiredFast === undefined || footer.fastMode === desiredFast)) return updateControls({ ...options, current: { ...options.current, ...footer } });
      const fresh = io.output().slice(before).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const match = fresh.match(/fast mode[^\r\n]*?\b(on|off|enabled|disabled)\b/i);
      if (match) return { ...options, current: { ...options.current, fastMode: /^(on|enabled)$/i.test(match[1]) }, controls: { ...options.controls, fastMode: true, fastToggle: false } };
      return { ...options, unconfirmed: true };
    }
    return updateControls({ ...options, current: { ...options.current, [request.key]: request.value, ...(request.key === 'model' ? { effort: undefined, fastMode: undefined, serviceTier: undefined } : {}) } });
  }
}

async function claudeCatalog(resolved: { executable: string; args: string[] }, cwd: string): Promise<AgentChatModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, [...resolved.args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}'], { cwd, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', bytes = 0, done = false;
    const finish = (models?: AgentChatModel[]) => { if (done) return; done = true; clearTimeout(timer); child.kill(); models ? resolve(models) : reject(new CliError('CLI_FAILED', 'Claude model discovery failed. Check its installation and sign-in.')); };
    const timer = setTimeout(() => finish(), 15000);
    child.on('error', () => finish()); child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) finish(); else output += chunk.toString(); });
    child.on('exit', code => {
      if (code !== 0) { finish(); return; }
      for (const line of output.split(/\r?\n/)) {
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        const response = message?.response;
        if (message?.type !== 'control_response' || response?.request_id !== 'ade-model-discovery' || response?.subtype !== 'success' || !Array.isArray(response.response?.models)) continue;
        const rows = response.response.models.slice(0, 200);
        const models: AgentChatModel[] = rows.flatMap((row: any): AgentChatModel[] => {
          const id = text(row.value, 200); if (!SAFE.test(id) || row.disabled === true) return [];
          return [{ id, label: text(row.displayName) || id, description: text(row.description, 500), efforts: row.supportsEffort === true && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((level: any) => typeof level === 'string' && SAFE.test(level)).slice(0, 16).map(choice) : [], ...(typeof row.supportsFastMode === 'boolean' ? { supportsFastMode: row.supportsFastMode } : {}) }];
        });
        const aliases = new Map<string, string>();
        for (const row of rows) if (typeof row.resolvedModel === 'string' && SAFE.test(row.resolvedModel) && models.some(model => model.id === row.value) && (!aliases.has(row.resolvedModel) || row.value !== 'default')) aliases.set(row.resolvedModel, row.value);
        resolvedModelAliases.set(models, aliases);
        finish(models); return;
      }
      finish();
    });
    child.stdin.end(JSON.stringify({ type: 'control_request', request_id: 'ade-model-discovery', request: { subtype: 'list_models' } }) + '\n');
  });
}

async function typeCommand(command: string, io: ProviderControlIO) {
  // Codex interprets a coalesced multi-character write as pasted prose. Keep slash
  // commands as native typed input; the owned-session lock remains held throughout.
  for (const char of command) { await io.write(char); await new Promise(resolve => setTimeout(resolve, 20)); }
  await io.write('\r');
}
function updateControls(options: AgentChatOptions): AgentChatOptions {
  const model = options.models.find(row => row.id === options.current.model);
  return { ...options, controls: { ...options.controls, effort: Boolean(model?.efforts.length), fastMode: model?.supportsFastMode === true && typeof options.current.fastMode === 'boolean', fastToggle: model?.supportsFastMode === true && typeof options.current.fastMode !== 'boolean' } };
}
const norm = (value: string) => value.toLowerCase().replace(/\((?:current|default)\)/g, '').replace(/[^a-z0-9]/g, '');
function codexFooter(models: AgentChatModel[], screen: string): AgentChatOptions['current'] {
  for (const line of screen.split('\n').reverse()) {
    for (const model of models) {
      const label = model.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = line.trim().match(new RegExp(`^${label}\\s+(\\w+)(\\s+fast)?\\s+·`));
      if (match && model.efforts.some(effort => effort.value === match[1])) return { model: model.id, effort: match[1], fastMode: Boolean(match[2]), serviceTier: match[2] ? model.serviceTiers?.find(tier => /^fast$/i.test(tier.label))?.value : 'default' };
    }
  }
  return {};
}
function menu(screen: string) {
  return screen.split('\n').flatMap(line => {
    const match = line.match(/^\s*([›>])?\s*(\d+)\.\s+(.+?)(?:\s{2,}|$)/);
    return match ? [{ index: Number(match[2]), selected: Boolean(match[1]), label: match[3].trim() }] : [];
  });
}
async function select(screen: string, label: string, io: ProviderControlIO, session = false): Promise<void> {
  const rows = menu(screen), selected = rows.find(row => row.selected), target = rows.find(row => norm(row.label) === norm(label));
  if (!selected || !target || Math.abs(target.index - selected.index) > 100) invalid('The provider picker changed. Open Terminal to select this setting.');
  const delta = target!.index - selected!.index;
  for (let step = 0; step < Math.abs(delta); step++) await io.write(delta > 0 ? '\x1b[B' : '\x1b[A');
  await io.waitFor(value => menu(value).some(row => row.selected && norm(row.label) === norm(label)));
  await io.write(session && /s session/.test(screen) ? 's' : '\r');
}
async function applyCodexPicker(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ProviderControlIO): Promise<AgentChatOptions> {
  const target = options.models.find(row => row.id === (request.key === 'model' ? request.value : options.current.model));
  if (!target) invalid('The current Codex model is unknown. Select a model first.');
  await typeCommand('/model', io);
  let screen = await io.waitFor(value => /Select Model and Effort/.test(value));
  await select(screen, target!.label, io);
  screen = await io.waitFor(value => /Select Reasoning Level/.test(value) || !/Select Model and Effort/.test(value));
  if (/Select Reasoning Level/.test(screen)) {
    const effort = request.key === 'effort' ? request.value : target!.efforts.some(row => row.value === options.current.effort) ? options.current.effort : undefined;
    if (effort) {
      const label = effort === 'xhigh' ? 'Extra high' : choice(effort).label;
      if (!menu(screen).some(row => norm(row.label) === norm(label))) {
        const more = menu(screen).find(row => /more reasoning/i.test(row.label));
        if (!more) invalid('The provider picker does not expose this effort. Open Terminal to continue.');
        await select(screen, more!.label, io);
        screen = await io.waitFor(value => menu(value).some(row => norm(row.label) === norm(label)));
      }
      await select(screen, label, io, true);
    } else {
      // A model-only selection keeps the native picker selected effort without inventing one.
      const selected = menu(screen).find(row => row.selected);
      if (!selected) invalid('The provider did not expose a selected reasoning level');
      await select(screen, selected!.label, io, true);
    }
  }
  screen = await io.waitFor(value => !/Select (?:Model and Effort|Reasoning Level)/.test(value) && codexFooter(options.models, value).model === target!.id && (request.key !== 'effort' || codexFooter(options.models, value).effort === request.value));
  return updateControls({ ...options, current: { ...options.current, ...codexFooter(options.models, screen) } });
}
