import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Node } from '../../../../shared/contracts.js';
import type { CommandRunner } from '../../cli.js';
import { normalizeChatModels, readAgentChatOptions, setAgentChatOption, validateChatPick } from './options.js';
import type { ChatRuntimeReader } from './runtime.js';
import { terminalChatAdapter } from './terminalAdapter.js';

const source = { handle: 'term_test', worktreeId: 'repo::/workspace', paneKey: 'tab:leaf' };
const node = { id: 'node', kind: 'agent', worktreeId: source.worktreeId, agentType: 'claude', state: 'idle', stale: false, model: 'model-one', effort: 'low' } as Node;
const models = [{ id: 'model-one', label: 'Model One', efforts: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }], supportsFastMode: true },
  { id: 'model-two', label: 'Model Two', efforts: [], supportsFastMode: false }];
function terminalFixture(provider = 'claude', remote = false) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_exe, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ ok: true, result: args[1] === 'list' ? { terminals: [{ handle: 'term_test', tabId: 'tab', leafId: 'leaf', connected: true, executionHostId: remote ? 'remote' : 'local', agentIdentity: provider }] } : { send: { accepted: true } } }), stderr: '', exitCode: 0 };
  };
  const rpc: ChatRuntimeReader = async (method, params) => {
    if (method === 'session.tabs.list') { assert.equal(params.worktree, 'id:repo::/workspace'); return { tabs: [{ type: 'terminal', id: 'tab::leaf' }] }; }
    if (method === 'agentSession.modelCatalog') { assert.equal(params.agent, provider); return { origin: 'probe', models }; }
    throw new Error(`Unexpected method ${method}`);
  };
  return { calls, runner, rpc };
}

test('catalog normalization bounds data and rejects command-injection model/effort ids', () => {
  const normalized = normalizeChatModels([...models, { id: 'bad\n/model other', label: 'Bad' }, { id: '--flags', label: 'Bad' }]);
  assert.equal(normalized.length, 2);
  assert.equal(normalizeChatModels(Array.from({ length: 300 }, () => models[0])).length, 200);
  assert.equal(normalizeChatModels([{ ...models[0], efforts: [{ value: 'x\nanything', label: 'Bad' }] }])[0].efforts.length, 0);
});

test('terminal provider adapters apply Claude commands but reject unverified Codex inline settings', async () => {
  const claude = terminalFixture();
  const options = await readAgentChatOptions(node, source, claude.runner, claude.rpc);
  assert.equal(options.controls.model, true);
  assert.equal(options.controls.effort, true);
  assert.equal(options.controls.fastMode, false);
  assert.equal(options.controls.fastToggle, true);
  const next = await setAgentChatOption(node, source, { key: 'effort', value: 'high' }, claude.runner, claude.rpc);
  assert.equal(next.unconfirmed, true);
  assert.equal(next.current.effort, 'high');
  assert.deepEqual(claude.calls.filter(args => args[1] === 'send'), [
    ['terminal', 'send', '--terminal', 'term_test', '--text', '/effort high', '--json'],
    ['terminal', 'send', '--terminal', 'term_test', '--enter', '--json'],
  ]);
  const codex = terminalFixture('codex');
  const codexNode = { ...node, agentType: 'codex' };
  const codexOptions = await readAgentChatOptions(codexNode, source, codex.runner, codex.rpc);
  assert.equal(codexOptions.controls.model, false);
  assert.equal(codexOptions.controls.effort, false);
  assert.equal(codexOptions.controls.providerPicker, true);
  await setAgentChatOption(codexNode, source, { key: 'providerPicker', value: 'open' }, codex.runner, codex.rpc);
  assert.deepEqual(codex.calls.filter(args => args[4] === '--text').map(args => args[5]), [...'/model']);
  codex.calls.length = 0;
  await assert.rejects(setAgentChatOption(codexNode, source, { key: 'effort', value: 'high' }, codex.runner, codex.rpc));
  await assert.rejects(setAgentChatOption(codexNode, source, { key: 'model', value: 'model-two' }, codex.runner, codex.rpc));
  assert.equal(codex.calls.some(args => args[1] === 'send'), false);
});

test('invalid values, unsupported switches, busy/stale agents and remote terminals never receive commands', async () => {
  const fixture = terminalFixture();
  const options = await readAgentChatOptions(node, source, fixture.runner, fixture.rpc);
  for (const pick of [{ key: 'model', value: 'made-up' }, { key: 'effort', value: 'ultra' }, { key: 'fastMode', value: 'true' }, { key: 'command', value: 'shell' }]) {
    assert.throws(() => validateChatPick(options, pick as any));
  }
  await assert.rejects(setAgentChatOption({ ...node, state: 'working' }, source, { key: 'model', value: 'model-one' }, fixture.runner, fixture.rpc));
  await assert.rejects(setAgentChatOption({ ...node, stale: true }, source, { key: 'model', value: 'model-one' }, fixture.runner, fixture.rpc));
  const remote = terminalFixture('claude', true);
  await assert.rejects(readAgentChatOptions(node, source, remote.runner, remote.rpc));
  assert.equal(fixture.calls.some(args => args[1] === 'send'), false);
  assert.equal(remote.calls.some(args => args[1] === 'send'), false);
  assert.deepEqual(terminalChatAdapter('unsupported-provider'), {});
});

test('native options bind the exact tab/session and use a fresh fence and canonical operation fingerprint', async () => {
  let current = { model: 'model-one', effort: 'low', fastMode: false };
  let writes = 0;
  const rpc: ChatRuntimeReader = async (method, params) => {
    if (method === 'session.tabs.list') return { tabs: [{ type: 'agent-session', id: 'other', sessionId: 'wrong', agent: 'codex' }, { type: 'agent-session', id: 'tab', sessionId: 'session-exact', agent: 'codex' }] };
    assert.equal(params.sessionId ?? (params.envelope as any)?.sessionId, 'session-exact');
    if (method === 'agentSession.options') return { models, current, fastModeSupport: { supported: true } };
    if (method === 'agentSession.history') { assert.equal(params.limit, 1); return { ok: true, page: { fence: 7 } }; }
    if (method === 'agentSession.setOption') {
      writes++;
      const envelope = params.envelope as any;
      assert.equal(envelope.expectedRuntimeFence, 7);
      assert.equal(envelope.payloadFingerprint, crypto.createHash('sha256').update(JSON.stringify({ fields: { key: 'effort', value: 'high' }, method, sessionId: 'session-exact' })).digest('hex'));
      current = { ...current, effort: 'high' };
      return { key: 'effort', value: 'high' };
    }
    throw new Error('Unexpected method');
  };
  const runner: CommandRunner = async () => { throw new Error('Native session must not receive terminal input'); };
  const nativeNode = { ...node, agentType: 'codex' };
  const before = await readAgentChatOptions(nativeNode, source, runner, rpc);
  assert.equal(before.controls.fastMode, true);
  assert.equal(before.transport, 'native');
  const after = await setAgentChatOption(nativeNode, source, { key: 'effort', value: 'high' }, runner, rpc);
  assert.equal(after.current.effort, 'high');
  assert.equal(writes, 1);
});

test('native mutation refuses a missing session fence instead of guessing an owner', async () => {
  const rpc: ChatRuntimeReader = async method => {
    if (method === 'session.tabs.list') return { tabs: [{ type: 'agent-session', id: 'tab', sessionId: 'session', agent: 'claude' }] };
    if (method === 'agentSession.options') return { models, current: { model: 'model-one' } };
    if (method === 'agentSession.history') return { ok: true, page: {} };
    throw new Error('Must not mutate');
  };
  await assert.rejects(setAgentChatOption(node, source, { key: 'model', value: 'model-two' }, terminalFixture().runner, rpc), /fence/);
});
