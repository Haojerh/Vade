import crypto from 'node:crypto';
import type { AgentChatModel, AgentChatOptions, Node, SetAgentChatOptionRequest } from '../../../../shared/contracts.js';
import { CliError, runOrca, type CommandRunner } from '../../cli.js';
import type { NodeSourceEntry } from '../state.js';
import { callChatRuntime, type ChatRuntimeReader } from './runtime.js';
import { sendingTerminals } from '../actions.js';
import { stripAnsi } from '../utils.js';
import { terminalChatAdapter } from './terminalAdapter.js';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.\/:+@()-]{0,199}$/;
const emptyControls = { model: false, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
export function normalizeChatModels(rows: unknown): AgentChatModel[] {
  if (!Array.isArray(rows)) return [];
  const choices = (values: any) => Array.isArray(values) ? values.slice(0, 16).filter(v => typeof v?.value === 'string' && SAFE_ID.test(v.value) && typeof v.label === 'string')
    .map(v => ({ value: v.value, label: stripAnsi(v.label).slice(0, 80) })) : [];
  return rows.slice(0, 200).filter(m => typeof m?.id === 'string' && SAFE_ID.test(m.id) && typeof m.label === 'string').map(m => ({
    id: m.id, label: stripAnsi(m.label).slice(0, 160), ...(typeof m.description === 'string' ? { description: stripAnsi(m.description).slice(0, 500) } : {}),
    efforts: choices(m.efforts), ...(typeof m.supportsFastMode === 'boolean' ? { supportsFastMode: m.supportsFastMode } : {}),
    ...(Array.isArray(m.serviceTiers) ? { serviceTiers: choices(m.serviceTiers) } : {}),
  }));
}

async function context(node: Node, source: NodeSourceEntry, runner: CommandRunner, rpc: ChatRuntimeReader) {
  if (!['agent', 'orchestrator'].includes(node.kind) || !source.worktreeId || !source.paneKey || (node.worktreeId && node.worktreeId !== source.worktreeId)) {
    throw new CliError('INVALID_ARGUMENT', 'Chat settings require an exact discovered agent');
  }
  const inventory = await rpc('session.tabs.list', { worktree: `id:${source.worktreeId}` });
  if (!Array.isArray(inventory?.tabs)) throw new CliError('INVALID_UPSTREAM', 'Invalid Orca session inventory');
  const paneTab = source.paneKey.slice(0, source.paneKey.indexOf(':'));
  const native = inventory.tabs.slice(0, 200).find((tab: any) => tab.type === 'agent-session' && tab.id === paneTab && typeof tab.sessionId === 'string');
  if (native) {
    if (typeof native.agent !== 'string' || (node.agentType && native.agent !== node.agentType)) throw new CliError('INVALID_ARGUMENT', 'The agent provider changed; refresh before editing its settings');
    return { sessionId: native.sessionId as string, provider: native.agent as string, handle: null };
  }
  const terminals = await runOrca<any>(['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '100', '--json'], runner);
  const terminal = terminals.result?.terminals?.find((t: any) => t.handle === source.handle && `${t.tabId}:${t.leafId}` === source.paneKey);
  if (!terminal?.connected || terminal.executionHostId !== 'local' || !/^term_[a-zA-Z0-9_-]+$/.test(terminal.handle) ||
    !terminal.agentIdentity || (node.agentType && terminal.agentIdentity !== node.agentType)) {
    throw new CliError('INVALID_ARGUMENT', 'Chat settings require a connected local agent');
  }
  return { sessionId: null, provider: String(node.agentType || terminal.agentIdentity || ''), handle: terminal.handle as string };
}

export async function readAgentChatOptions(node: Node, source: NodeSourceEntry, runner: CommandRunner, rpc: ChatRuntimeReader = callChatRuntime): Promise<AgentChatOptions> {
  const target = await context(node, source, runner, rpc);
  return readOptionsForTarget(node, source, target, rpc);
}

async function readOptionsForTarget(node: Node, source: NodeSourceEntry, target: Awaited<ReturnType<typeof context>>, rpc: ChatRuntimeReader): Promise<AgentChatOptions> {
  if (target.sessionId) {
    const result = await rpc('agentSession.options', { sessionId: target.sessionId });
    const models = normalizeChatModels(result?.models);
    if (!result?.current || !Array.isArray(result.models)) throw new CliError('INVALID_UPSTREAM', 'Invalid Orca chat options');
    const current = result.current;
    const model = models.find(model => model.id === current.model);
    return { provider: target.provider, transport: 'native', models, current: {
      ...(typeof current.model === 'string' && SAFE_ID.test(current.model) ? { model: current.model } : {}),
      ...(typeof current.effort === 'string' && SAFE_ID.test(current.effort) ? { effort: current.effort } : {}),
      ...(typeof current.fastMode === 'boolean' ? { fastMode: current.fastMode } : {}),
      ...(typeof current.serviceTier === 'string' && SAFE_ID.test(current.serviceTier) ? { serviceTier: current.serviceTier } : {}),
    }, controls: { ...emptyControls, model: models.length > 0, effort: Boolean(model?.efforts.length),
      fastMode: model?.supportsFastMode === true && result.fastModeSupport?.supported !== false,
      serviceTier: Boolean(model?.serviceTiers?.length) } };
  }
  const listing = await rpc('agentSession.modelCatalog', { agent: target.provider, worktree: `id:${source.worktreeId}` });
  const models = normalizeChatModels(listing?.models);
  const current = { ...(node.model && node.model !== 'unknown' ? { model: node.model } : {}), ...(node.effort && node.effort !== 'unknown' ? { effort: node.effort } : {}) };
  const model = models.find(model => model.id === current.model);
  const adapter = terminalChatAdapter(target.provider);
  return { provider: target.provider, transport: 'terminal', models, current, controls: { ...emptyControls,
    model: Boolean(adapter.modelCommand) && models.length > 0,
    effort: Boolean(adapter.effortCommand) && Boolean(model?.efforts.length),
    fastToggle: Boolean(adapter.fastToggle) && model?.supportsFastMode === true,
    providerPicker: Boolean(adapter.modelPicker),
  } };
}

export function validateChatPick(options: AgentChatOptions, request: SetAgentChatOptionRequest): void {
  const { key, value } = request;
  if (!Object.hasOwn(emptyControls, key) || !options.controls[key] || typeof value !== 'string') throw new CliError('INVALID_ARGUMENT', 'This session cannot apply that option');
  const model = options.models.find(model => model.id === options.current.model);
  const valid = key === 'model' ? options.models.some(model => model.id === value) : key === 'effort' ? model?.efforts.some(choice => choice.value === value) :
    key === 'serviceTier' ? value === 'default' || model?.serviceTiers?.some(choice => choice.value === value) :
      key === 'fastMode' ? value === 'true' || value === 'false' : value === 'open';
  if (!valid) throw new CliError('INVALID_ARGUMENT', 'Choose a value advertised by this agent');
}

export async function setAgentChatOption(node: Node, source: NodeSourceEntry, request: SetAgentChatOptionRequest, runner: CommandRunner, rpc: ChatRuntimeReader = callChatRuntime): Promise<AgentChatOptions> {
  if (node.stale || !['idle', 'completed', 'failed'].includes(node.state)) throw new CliError('INVALID_ARGUMENT', 'Wait until the agent is idle before changing its settings');
  const target = await context(node, source, runner, rpc);
  const options = await readOptionsForTarget(node, source, target, rpc);
  validateChatPick(options, request);
  if (target.sessionId) {
    const history = await rpc('agentSession.history', { sessionId: target.sessionId, direction: 'before', limit: 1 });
    const fence = history?.page?.fence;
    if (!Number.isSafeInteger(fence) || fence < 1) throw new CliError('INVALID_UPSTREAM', 'Orca did not provide a current session fence');
    const fields = { key: request.key, value: request.value };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ fields, method: 'agentSession.setOption', sessionId: target.sessionId })).digest('hex');
    await rpc('agentSession.setOption', { envelope: { sessionId: target.sessionId, clientOperationId: crypto.randomUUID(), expectedRuntimeFence: fence, payloadFingerprint: fingerprint }, ...fields });
    return readOptionsForTarget(node, source, target, rpc);
  }
  const handle = target.handle!;
  if (sendingTerminals.has(handle)) throw new CliError('RATE_LIMITED', 'The agent is already receiving input');
  sendingTerminals.add(handle);
  try {
    const adapter = terminalChatAdapter(target.provider);
    const text = request.key === 'providerPicker' ? adapter.modelPicker!.command : request.key === 'fastToggle' ? adapter.fastToggle! :
      request.key === 'model' ? adapter.modelCommand!(request.value) : adapter.effortCommand!(request.value);
    // Codex treats a multi-character write as pasted prose. Orca's own picker uses typed input.
    const chunks = request.key === 'providerPicker' && adapter.modelPicker?.typed ? [...text] : [text];
    for (const chunk of chunks) {
      const response = await runOrca<any>(['terminal', 'send', '--terminal', handle, '--text', chunk, '--json'], runner);
      if (!response.ok || response.result?.send?.accepted === false) throw new CliError('CLI_FAILED', 'The agent refused the setting');
    }
    const submitted = await runOrca<any>(['terminal', 'send', '--terminal', handle, '--enter', '--json'], runner);
    if (!submitted.ok || submitted.result?.send?.accepted === false) throw new CliError('CLI_FAILED', 'The agent did not accept the setting');
    return { ...options, current: { ...options.current, ...(request.key === 'model' || request.key === 'effort' ? { [request.key]: request.value } : {}) }, unconfirmed: true };
  } finally { sendingTerminals.delete(handle); }
}
