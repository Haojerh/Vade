import { spawn } from 'node:child_process';
import type { AgentChatModel, AgentChatOptions, SetAgentChatOptionRequest } from '../../../../shared/contracts.js';
import { CliError } from '../../../integrations/cli.js';
import { codexRequest } from '../../../providers/codex/codexThread.js';
import { resolveAgent } from '../../sessions/sessions.js';
import type { ChatControlIO } from './chatControlTypes.js';
import {claudeEffortAcknowledgement} from '../../../providers/common/shared.js';
import { freebuffModelByLabel, freebuffModelInRow, freebuffResolveStored } from '../../../providers/freebuff/freebuffCatalog.js';
import { freebuffFooterModel, readFreebuffCatalog, readFreebuffModel } from '../../../providers/freebuff/freebuff.js';

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_.\/:+@()\[\]-]{0,199}$/;
const text = (value: unknown, limit = 160): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';
const choice = (value: string) => ({ value, label: value === 'xhigh' ? 'XHigh' : value.charAt(0).toUpperCase() + value.slice(1) });
const controls = { model: false, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
const resolvedModelAliases = new WeakMap<AgentChatModel[], Map<string, string>>();
const invalid = (message: string): never => { throw new CliError('INVALID_ARGUMENT', message); };
type ProviderControlIO = ChatControlIO;
type Provider = 'claude' | 'codex' | 'freebuff';

/** Provider-native catalogs, matching Orca's model/list and list_models wire formats. */
export class ProviderChatControls {
  private cache = new Map<string, { at: number; models: AgentChatModel[] }>();
  private pending = new Map<string, Promise<AgentChatModel[]>>();
  async catalog(provider: Provider, cwd: string): Promise<AgentChatModel[]> {
    // Freebuff's catalog is per-account and served by the provider, so it is read on
    // demand and cached there; it must never be replaced by a bundled snapshot.
    if (provider === 'freebuff') return (await readFreebuffCatalog({ waitMs: 4000 })).models;
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
    if (provider === 'freebuff') {
      // The running session's own status line wins over any stored preference: it is
      // what the next message will actually use. Settings remain a fallback for a
      // session whose screen is not readable yet, and neither source invents a default.
      const screen = typeof screenSource === 'function' ? screenSource() : screenSource;
      const footer = freebuffFooterModel(screen);
      const stored = readFreebuffModel('', '');
      const { models } = await readFreebuffCatalog({ waitMs: 2500 });
      const footerModel = footer.label ? freebuffModelByLabel(footer.label, models) : undefined;
      const storedModel = stored.model ? freebuffResolveStored(stored.model, models) : undefined;
      const modelObj = footerModel ?? storedModel;
      // A model the account can no longer select (plan change, retired row) still has to
      // be shown as the current value; it is appended rather than silently replaced.
      const listed = modelObj && models.some(model => model.id === modelObj.id) ? models : modelObj ? [...models, modelObj] : models;
      const currentEffort = footer.effort ?? stored.effort;
      return {
        provider: 'freebuff',
        transport: 'terminal',
        models: listed,
        current: {
          ...(modelObj ? { model: modelObj.id } : {}),
          ...(currentEffort ? { effort: currentEffort } : {}),
        },
        controls: { ...controls, model: true, effort: Boolean(modelObj?.efforts.length) },
      };
    }
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
    if (options.provider === 'freebuff') {
      return request.key === 'model'
        ? applyFreebuffModel(options, request, io)
        : applyFreebuffReasoning(options, request, io);
    }
    if (options.provider === 'codex' && !fast) return applyCodexPicker(options, request, io);
    const command = fast ? '/fast' : request.key === 'model' ? `/model ${request.value}` : `/effort ${request.value}`;
    const before = io.output().length;
    const beforeFooter = options.provider === 'codex' ? codexFooter(options.models, io.screen()) : {};
    await typeCommand(command, io);
    const desired = options.models.find(row => row.id === request.value);
    const desiredFast = request.key === 'fastMode' ? request.value === 'true' : typeof options.current.fastMode === 'boolean' ? !options.current.fastMode : undefined;
    const strip = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const confirmed = await io.waitFor(screen => {
      if(options.provider==='claude'&&!fast&&io.settingConfirmed?.())return true;
      // Claude's Ink renderer can emit one acknowledgement in several positioned writes,
      // so the raw byte stream may not contain the sentence contiguously. Read the
      // rendered screen too, but only below this command's own echo so an older
      // acknowledgement still visible in the transcript cannot confirm a new request.
      const fresh = strip(io.output().slice(before));
      const echo = screen.lastIndexOf(command);
      const screenTail = echo >= 0 ? screen.slice(echo + command.length) : '';
      const lines = [...fresh.split(/[\r\n]/), ...screenTail.split('\n')];
      const tier = fresh.match(/Service tier set to (priority|fast|default)\b/g)?.at(-1)?.split(' ').at(-1);
      const footer = options.provider === 'codex' ? codexFooter(options.models, screen) : {};
      const changedFooter = typeof footer.fastMode === 'boolean' && typeof beforeFooter.fastMode === 'boolean' && footer.fastMode !== beforeFooter.fastMode && (desiredFast === undefined || footer.fastMode === desiredFast);
      return fast ? changedFooter || (tier !== undefined && (desiredFast === undefined || (tier !== 'default') === desiredFast)) || (options.provider === 'claude' && /fast mode.*(?:on|off|enabled|disabled)/i.test(fresh))
      : lines.some(line => request.key === 'model' ? /(?:set|switched|changed|kept).*model|model.*(?:set|switched|changed|kept)/i.test(line) && [desired?.id, desired?.label].some(value => value && norm(line).includes(norm(value)))
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

const FREEBUFF_MODEL_PICKER = /choose model · Tab reasoning · Enter select · Esc cancel/;
const FREEBUFF_REASONING_PICKER = /choose · Enter save · Esc back/;

/** One rendered Freebuff model row. Only rows that resolve to the account's own
 *  catalog are accepted, so section headers and taglines are never navigation targets. */
function freebuffPickerRows(screen: string, models: AgentChatModel[]): { selected: boolean; model: AgentChatModel }[] {
  const rows: { selected: boolean; model: AgentChatModel }[] = [];
  for (const line of screen.split('\n')) {
    if (!/^\s*│/.test(line)) continue;
    const content = line.replace(/^\s*│\s*/, '').replace(/\s*│\s*$/, '');
    const selected = content.startsWith('›');
    const body = content.replace(/^›\s*/, '').trim();
    if (!body) continue;
    const model = freebuffModelInRow(body, models);
    if (model) rows.push({ selected, model });
  }
  return rows;
}

function freebuffReasoningRows(screen: string): { selected: boolean; value: string }[] {
  const marker = screen.lastIndexOf('↑↓ choose · Enter save · Esc back');
  const tail = marker >= 0 ? screen.slice(marker) : screen;
  return tail.split('\n').flatMap(line => {
    const match = /^\s*(›)?\s*(low|medium|high|xhigh|max)(?: \(default\))?\s*$/.exec(line);
    return match ? [{ selected: Boolean(match[1]), value: match[2] }] : [];
  });
}

async function pressKeys(io: ProviderControlIO, delta: number): Promise<void> {
  const key = delta > 0 ? '\x1b[B' : '\x1b[A';
  for (let step = 0; step < Math.abs(delta); step++) {
    await io.write(key);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

/** The native picker scrolls its rows. Walk it in both directions until the target is
 *  rendered, then let the caller navigate the visible window by index. */
async function revealFreebuffModel(io: ProviderControlIO, target: string, models: AgentChatModel[]): Promise<boolean> {
  const selectedId = () => freebuffPickerRows(io.screen(), models).find(row => row.selected)?.model.id;
  for (const key of ['\x1b[B', '\x1b[A'] as const) {
    let previous = selectedId();
    for (let step = 0; step < 48; step++) {
      await io.write(key);
      await new Promise(resolve => setTimeout(resolve, 60));
      const rows = freebuffPickerRows(io.screen(), models);
      if (rows.some(row => row.model.id === target)) return true;
      const current = rows.find(row => row.selected)?.model.id;
      if (current === previous) break;
      previous = current;
    }
  }
  return false;
}

/** Model and reasoning are chosen in Freebuff's own pickers. The running CLI owns
 *  the write, so its status line is the confirmation instead of a guessed success. */
async function applyFreebuffModel(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ProviderControlIO): Promise<AgentChatOptions> {
  const target = options.models.find(row => row.id === request.value);
  if (!target) invalid('Choose a model advertised by Freebuff');
  const models = options.models;
  try {
    await typeCommand('/model', io);
    let screen = await io.waitFor(value => FREEBUFF_MODEL_PICKER.test(value));
    if (!freebuffPickerRows(screen, models).some(row => row.model.id === target!.id)) {
      if (!(await revealFreebuffModel(io, target!.id, models))) {
        await io.write('\x1b');
        invalid('Freebuff does not list this model on the current connection. Choose another model or open Terminal.');
      }
      screen = io.screen();
    }
    const rows = freebuffPickerRows(screen, models);
    const selectedIndex = rows.findIndex(row => row.selected);
    const targetIndex = rows.findIndex(row => row.model.id === target!.id);
    if (selectedIndex < 0 || targetIndex < 0) invalid('The Freebuff model picker changed. Open Terminal to select this model.');
    await pressKeys(io, targetIndex - selectedIndex);
    await io.waitFor(value => freebuffPickerRows(value, models).find(row => row.selected)?.model.id === target!.id);
    await io.write('\r');
    const confirmed = await io.waitFor(value => {
      const footer = freebuffFooterModel(value);
      return Boolean(footer.label) && freebuffModelByLabel(footer.label!, models)?.id === target!.id;
    });
    const footer = freebuffFooterModel(confirmed);
    return {
      ...options,
      current: { model: target!.id, ...(footer.effort ? { effort: footer.effort } : {}) },
      controls: { ...options.controls, effort: target!.efforts.length > 0 },
    };
  } catch (error) {
    await io.write('\x1b').catch(() => {});
    throw error;
  }
}

async function applyFreebuffReasoning(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ProviderControlIO): Promise<AgentChatOptions> {
  const target = options.models.find(row => row.id === options.current.model);
  if (!target?.efforts.some(row => row.value === request.value)) invalid('Choose a reasoning level advertised for this model');
  try {
    await typeCommand('/reasoning', io);
    const screen = await io.waitFor(value => FREEBUFF_REASONING_PICKER.test(value) || /does not offer adjustable reasoning/.test(value));
    if (!FREEBUFF_REASONING_PICKER.test(screen)) invalid(`${target!.label} does not offer adjustable reasoning.`);
    const rows = freebuffReasoningRows(screen);
    const selectedIndex = rows.findIndex(row => row.selected);
    const targetIndex = rows.findIndex(row => row.value === request.value);
    if (selectedIndex < 0 || targetIndex < 0) invalid('The Freebuff reasoning picker changed. Open Terminal to select this level.');
    await pressKeys(io, targetIndex - selectedIndex);
    await io.waitFor(value => freebuffReasoningRows(value).find(row => row.selected)?.value === request.value);
    await io.write('\r');
    const confirmed = await io.waitFor(value => freebuffFooterModel(value).effort === request.value);
    return { ...options, current: { ...options.current, effort: freebuffFooterModel(confirmed).effort ?? request.value } };
  } catch (error) {
    await io.write('\x1b').catch(() => {});
    throw error;
  }
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
