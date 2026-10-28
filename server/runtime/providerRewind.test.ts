import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_MAX_TURN_PAGES, CODEX_TURN_PAGE_LIMIT, createCodexRewindPort, executeCodexRewind, locateCodexTurn,
  planCodexRewind, preflightProviderRewind, providerRewindAvailability, providerRewindCapability, providerRewindCatalog,
  publicRewindTarget, recoverCodexRewind, resolveNativeUserAnchor, sameWorkspace, verifyCodexCut,
  type CodexRewindPort, type CodexThreadSummary, type CodexTurnPage, type NativeUserAnchor,
} from './providerRewind.js';
import { hashId } from '../providers/transcriptUtils.js';

const SOURCE = 'src_abc123';

function codexUserRow(id: string | null, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: '2026-10-27T14:57:35.861Z', ordinal: 193, type: 'response_item',
    payload: { type: 'message', ...(id === null ? {} : { id }), role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ...extra,
  });
}

function claudeUserRow(uuid: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'user', uuid, sessionId: 's', cwd: '/repo', timestamp: '2026-09-18T13:57:23.766Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, ...extra,
  });
}

/** Deterministic in-memory port; records every native call so tests can prove no extra effects. */
function fakePort(options: {
  thread?: CodexThreadSummary;
  pages?: CodexTurnPage[];
  fork?: (threadId: string, beforeTurnId: string) => Promise<{ thread: CodexThreadSummary }>;
  revert?: (threadId: string, beforeTurnId: string) => Promise<{ thread: CodexThreadSummary }>;
} = {}) {
  const calls: string[] = [];
  const thread = options.thread ?? { id: 'thread-1', forkedFromId: null, historyMode: 'paginated', status: { type: 'idle' } };
  const pages = options.pages ?? [{ data: [] }];
  let read = 0;
  const port: CodexRewindPort = {
    async readThread(threadId) { calls.push(`read:${threadId}`); read++; return { ...thread, ...(read > 1 && options.thread ? {} : {}) }; },
    async listTurns(threadId, cursor, limit) {
      calls.push(`turns:${threadId}:${cursor ?? '-'}:${limit}`);
      const index = cursor === null ? 0 : Number(cursor);
      return pages[index] ?? { data: [], nextCursor: null };
    },
    async forkBefore(threadId, beforeTurnId) {
      calls.push(`fork:${threadId}:${beforeTurnId}`);
      return options.fork ? options.fork(threadId, beforeTurnId)
        : { thread: { id: 'thread-fork', forkedFromId: threadId, historyMode: 'paginated', status: { type: 'idle' } } };
    },
    async revertBefore(threadId, beforeTurnId) {
      calls.push(`revert:${threadId}:${beforeTurnId}`);
      return options.revert ? options.revert(threadId, beforeTurnId) : { thread: { ...thread, id: threadId } };
    },
  };
  return { port, calls };
}

const CODEX_ANCHOR: NativeUserAnchor = { provider: 'codex', nativeId: 'msg_01a17d19-de3c-72d2-9d3a-d3136b988428', field: 'codex-item-id' };

test('the catalog claims rewind only where installed artifacts expose a native surface', () => {
  const catalog = providerRewindCatalog();
  const codex = providerRewindCapability('codex');
  assert.equal(codex.supported, true);
  assert.deepEqual(codex.strategies, ['fork-before', 'revert-before']);
  assert.equal(codex.preservesOriginal, true);
  assert.equal(codex.owner, 'provider-rewind');
  assert.match(codex.evidence, /thread\/fork/);
  assert.match(codex.evidence, /thread\/revert/);
  // DSH stays on the existing continuation path; root routes it there instead.
  const dsh = providerRewindCapability('dsh');
  assert.equal(dsh.supported, true);
  assert.equal(dsh.owner, 'existing-runtime');
  assert.deepEqual(dsh.strategies, ['native-continuation']);
  // Every other provider is hidden with a concrete installed-evidence limitation.
  for (const provider of ['opencode', 'opencode2', 'kilo', 'kilocode']) {
    const capability = providerRewindCapability(provider);
    assert.equal(capability.supported, false, provider);
    assert.deepEqual(capability.strategies, [], provider);
    assert.equal(capability.owner, 'none', provider);
    assert.ok((capability.limitation ?? '').length > 20, `${provider} explains why it is unavailable`);
  }
  assert.equal(providerRewindCapability('claude').preservesOriginal,true);
  assert.deepEqual(providerRewindCapability('antigravity').strategies,['native-picker']);
  assert.match(providerRewindCapability('opencode').limitation!, /list\/delete\/export\/import/);
  // Unknown providers never inherit support.
  assert.equal(providerRewindCapability('terminal').supported, false);
  // The catalog is a copy: mutating it cannot change the module's claims.
  catalog[0]!.strategies.push('revert-before');
  assert.deepEqual(providerRewindCapability('codex').strategies, ['fork-before', 'revert-before']);
});

test('native anchors come from recorded identity fields, never from text or position', () => {
  const codex = resolveNativeUserAnchor('codex', codexUserRow('msg_01a17d19-de3c-72d2-9d3a-d3136b988428'));
  assert.deepEqual(codex, { provider: 'codex', nativeId: 'msg_01a17d19-de3c-72d2-9d3a-d3136b988428', field: 'codex-item-id' });
  // No recorded id means no anchor, even though the row has an ordinal that could be positional.
  assert.equal(resolveNativeUserAnchor('codex', codexUserRow(null)), null);
  assert.equal(resolveNativeUserAnchor('codex', codexUserRow('not-a-codex-item')), null);
  assert.equal(resolveNativeUserAnchor('codex', codexUserRow('x'.repeat(300))), null);
  // Tool, injected and assistant rows are not user turns.
  assert.equal(resolveNativeUserAnchor('codex', JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'msg_a', role: 'assistant', content: [] } })), null);
  assert.equal(resolveNativeUserAnchor('codex', JSON.stringify({ type: 'response_item', payload: { type: 'function_call', id: 'msg_a' } })), null);
  assert.equal(resolveNativeUserAnchor('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'message', id: 'msg_a', role: 'user' } })), null);
  assert.equal(resolveNativeUserAnchor('codex', 'not json'), null);

  const uuid = '84daefda-a420-49d5-9e7e-e61680167076';
  assert.deepEqual(resolveNativeUserAnchor('claude', claudeUserRow(uuid)), { provider: 'claude', nativeId: uuid, field: 'claude-entry-uuid' });
  for (const extra of [{ isMeta: true }, { isSidechain: true }, { isSynthetic: true }, { isCompactSummary: true }]) {
    assert.equal(resolveNativeUserAnchor('claude', claudeUserRow(uuid, extra)), null, JSON.stringify(extra));
  }
  const toolRow = JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'output' }] } });
  assert.equal(resolveNativeUserAnchor('claude', toolRow), null);
  assert.equal(resolveNativeUserAnchor('claude', claudeUserRow('not-a-uuid')), null);
  assert.deepEqual(resolveNativeUserAnchor('codebuddy', claudeUserRow(uuid)), { provider: 'codebuddy', nativeId: uuid, field: 'claude-entry-uuid' });

  const dshRow = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', nativeSeq: 41 } });
  assert.deepEqual(resolveNativeUserAnchor('dsh', dshRow), { provider: 'dsh', nativeId: '41', field: 'dsh-native-seq' });
  assert.equal(resolveNativeUserAnchor('dsh', JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', nativeSeq: -1 } })), null);

  for (const provider of ['antigravity', 'opencode', 'opencode2', 'kilo', 'terminal', 'unknown']) {
    assert.equal(resolveNativeUserAnchor(provider, codexUserRow('msg_a')), null, provider);
  }
});

test('the public rewind target matches the conversation message id derivation exactly', () => {
  const line = codexUserRow('msg_01a17d19-de3c-72d2-9d3a-d3136b988428');
  const target = publicRewindTarget('codex', line, SOURCE);
  assert.ok(target);
  assert.equal(target.messageId, hashId('msg', `${SOURCE}:msg_01a17d19-de3c-72d2-9d3a-d3136b988428`));
  assert.equal(target.anchor.nativeId, 'msg_01a17d19-de3c-72d2-9d3a-d3136b988428');
  // The id is bound to the source identity, so another transcript cannot match it.
  assert.notEqual(publicRewindTarget('codex', line, 'src_other')!.messageId, target.messageId);
  // Rows without a native identity are never targets.
  assert.equal(publicRewindTarget('codex', codexUserRow(null), SOURCE), null);
  assert.equal(publicRewindTarget('opencode', line, SOURCE), null);
  assert.equal(publicRewindTarget('codex', line, ''), null);
});

test('UI availability hides unsupported, legacy, routed and busy providers without planning', () => {
  assert.deepEqual(providerRewindAvailability('codex'), { available: true, reason: null, message: null, strategy: 'fork-before' });
  assert.equal(providerRewindAvailability('codex', { historyMode: 'legacy' }).reason, 'history-not-paginated');
  assert.equal(providerRewindAvailability('codex', { activeTurns: 2 }).reason, 'busy');
  assert.equal(providerRewindAvailability('dsh').reason, 'routed-elsewhere');
  for (const provider of ['opencode', 'opencode2', 'kilo', 'kilocode', 'terminal']) {
    const availability = providerRewindAvailability(provider);
    assert.equal(availability.available, false, provider);
    assert.equal(availability.reason, 'unsupported-provider', provider);
    assert.equal(availability.strategy, null, provider);
    assert.ok((availability.message ?? '').length > 20, provider);
  }
  // Legacy history never becomes available just because the provider is supported.
  assert.equal(providerRewindAvailability('claude', { historyMode: 'paginated' }).available, false);
});

test('preflight refuses unsupported providers, stale sources, foreign anchors, busy and legacy sessions', () => {
  const base = { provider: 'codex', sourceIdentity: SOURCE, expectedSourceIdentity: SOURCE, anchor: CODEX_ANCHOR, idle: true };
  const admitted = preflightProviderRewind(base);
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(admitted.strategy, 'fork-before');
  assert.equal(admitted.preservesOriginal, true);

  const refusals: [Parameters<typeof preflightProviderRewind>[0], string][] = [
    [{ ...base, provider: 'claude' }, 'routed-elsewhere'],
    [{ ...base, provider: 'codebuddy' }, 'routed-elsewhere'],
    [{ ...base, provider: 'antigravity' }, 'routed-elsewhere'],
    [{ ...base, provider: 'opencode2' }, 'unsupported-provider'],
    [{ ...base, provider: 'dsh' }, 'routed-elsewhere'],
    [{ ...base, sourceIdentity: 'src_old' }, 'stale-source'],
    [{ ...base, sourceIdentity: '' }, 'stale-source'],
    [{ ...base, anchor: null }, 'foreign-target'],
    [{ ...base, anchor: { provider: 'claude', nativeId: 'u', field: 'claude-entry-uuid' } }, 'foreign-target'],
    [{ ...base, historyMode: 'legacy' }, 'history-not-paginated'],
    [{ ...base, idle: false }, 'busy'],
    [{ ...base, activeTurns: 1 }, 'busy'],
    [{ ...base, strategy: 'revert-before' }, 'destructive-not-allowed'],
    [{ ...base, strategy: 'native-continuation' }, 'unsupported-provider'],
  ];
  for (const [input, reason] of refusals) {
    const result = preflightProviderRewind(input);
    assert.equal(result.ok, false, reason);
    if (result.ok) continue;
    assert.equal(result.reason, reason);
    assert.ok(result.message.length > 0);
  }

  // A revert is reachable only with explicit consent, and it never claims to preserve the original.
  const destructive = preflightProviderRewind({ ...base, strategy: 'revert-before', allowDestructive: true });
  assert.equal(destructive.ok, true);
  if (destructive.ok) assert.equal(destructive.preservesOriginal, false);
});

test('a persisted thread is not busy merely because the separate app-server reader has not loaded it',async()=>{
  const {port}=fakePort({thread:{id:'thread-1',historyMode:'paginated',status:{type:'notLoaded'}},pages:[{data:[{id:'turn',items:[{id:CODEX_ANCHOR.nativeId,type:'userMessage'}]}],nextCursor:null}]});
  assert.equal((await planCodexRewind(port,{threadId:'thread-1',anchor:CODEX_ANCHOR})).ok,true);
});

test('the plan locates the exact turn holding the recorded item and keeps the OLDER boundary', async () => {
  // Newest-first history is t3, t2 (target), t1: the cut discards t2 and t3, so t1 is kept.
  const pages: CodexTurnPage[] = [
    { data: [{ id: 'turn-3', items: [{ id: 'msg_c', type: 'userMessage' }] }, { id: 'turn-2', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] }], nextCursor: '1' },
    { data: [{ id: 'turn-1', items: [{ id: 'msg_a', type: 'userMessage' }] }], nextCursor: null },
  ];
  const { port, calls } = fakePort({ pages });
  const result = await planCodexRewind(port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.plan, { strategy: 'fork-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-2', keepTurnId: 'turn-1' });
  assert.deepEqual(calls, [
    'read:thread-1',
    `turns:thread-1:-:${CODEX_TURN_PAGE_LIMIT}`,
    `turns:thread-1:1:${CODEX_TURN_PAGE_LIMIT}`,
    'read:thread-1',
  ]);
  assert.ok(!calls.some(call => call.startsWith('fork:') || call.startsWith('revert:')), 'planning never mutates');
});

test('the kept boundary is the next older turn on the same page', async () => {
  const pages: CodexTurnPage[] = [{ data: [
    { id: 'turn-3', items: [{ id: 'msg_c', type: 'userMessage' }] },
    { id: 'turn-2', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] },
    { id: 'turn-1', items: [{ id: 'msg_a', type: 'userMessage' }] },
  ], nextCursor: null }];
  const result = await planCodexRewind(fakePort({ pages }).port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plan.keepTurnId, 'turn-1');
});

test('the plan keeps a null boundary only when the target is the oldest recorded turn', async () => {
  const { port } = fakePort({ pages: [{ data: [{ id: 'turn-2', items: [{ id: 'msg_b', type: 'userMessage' }] }, { id: 'turn-1', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] }], nextCursor: null }] });
  const result = await planCodexRewind(port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(result.ok, true);
  if (result.ok) { assert.equal(result.plan.beforeTurnId, 'turn-1'); assert.equal(result.plan.keepTurnId, null); }
});

test('a colliding non-user item id is not a rewind anchor', async () => {
  const pages: CodexTurnPage[] = [{ data: [{ id: 'turn-1', items: [{ id: CODEX_ANCHOR.nativeId, type: 'agentMessage' }] }], nextCursor: null }];
  const result = await planCodexRewind(fakePort({ pages }).port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'target-not-found');
});

test('a mid-turn message is never a rewind target, only the turn opener is', async () => {
  const midTurn: CodexTurnPage[] = [{
    data: [{ id: 'turn-1', items: [{ id: 'msg_opener', type: 'userMessage' }, { id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] }],
    nextCursor: null,
  }];
  const refused = await planCodexRewind(fakePort({ pages: midTurn }).port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(refused.ok, false);
  if (!refused.ok) { assert.equal(refused.reason, 'not-turn-opener'); assert.match(refused.message, /started a turn/); }
  const opened = await planCodexRewind(fakePort({ pages: midTurn }).port,
    { threadId: 'thread-1', anchor: { provider: 'codex', nativeId: 'msg_opener', field: 'codex-item-id' } });
  assert.equal(opened.ok, true);
});

test('the plan refuses missing turns, foreign threads, legacy history, busy threads and bad anchors', async () => {
  const missing = await planCodexRewind(fakePort({ pages: [{ data: [{ id: 'turn-1', items: [{ id: 'msg_other', type: 'userMessage' }] }], nextCursor: null }] }).port,
    { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'target-not-found');

  const foreign = await planCodexRewind(fakePort({ thread: { id: 'thread-other', status: { type: 'idle' } } }).port,
    { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.reason, 'foreign-target');

  const legacy = await planCodexRewind(fakePort({ thread: { id: 'thread-1', historyMode: 'legacy', status: { type: 'idle' } } }).port,
    { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.equal(legacy.reason, 'history-not-paginated');

  const busy = await planCodexRewind(fakePort({ thread: { id: 'thread-1', historyMode: 'paginated', status: { type: 'active' } } }).port,
    { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.reason, 'busy');

  const wrongAnchor = await planCodexRewind(fakePort().port, { threadId: 'thread-1', anchor: { provider: 'dsh', nativeId: '1', field: 'dsh-native-seq' } });
  assert.equal(wrongAnchor.ok, false);
  if (!wrongAnchor.ok) assert.equal(wrongAnchor.reason, 'foreign-target');
});

test('the plan re-reads the thread after scanning so a turn started mid-scan is refused', async () => {
  const calls: string[] = [];
  let reads = 0;
  const port: CodexRewindPort = {
    async readThread(threadId) {
      calls.push(`read:${threadId}`); reads++;
      return { id: threadId, historyMode: 'paginated', status: { type: reads === 1 ? 'idle' : 'active' } };
    },
    async listTurns() { return { data: [{ id: 'turn-1', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] }], nextCursor: null }; },
    async forkBefore() { throw new Error('must not fork'); },
    async revertBefore() { throw new Error('must not revert'); },
  };
  const result = await planCodexRewind(port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'busy');
  assert.deepEqual(calls, ['read:thread-1', 'read:thread-1']);
});

test('turn scanning is bounded and refuses a repeated cursor instead of looping', async () => {
  const page: CodexTurnPage = { data: [{ id: 'turn-1', items: [{ id: 'msg_other', type: 'userMessage' }] }], nextCursor: 'same' };
  let calls = 0;
  const port: CodexRewindPort = {
    async readThread(threadId) { return { id: threadId, historyMode: 'paginated', status: { type: 'idle' } }; },
    async listTurns() { calls++; return page; },
    async forkBefore() { throw new Error('must not fork'); },
    async revertBefore() { throw new Error('must not revert'); },
  };
  await assert.rejects(() => locateCodexTurn(port, 'thread-1', CODEX_ANCHOR.nativeId), /repeated a turn cursor/);
  assert.equal(calls, 2, 'the loop stops on the first repeated cursor');

  // A thread longer than the page budget is reported as a limit, never as absence.
  let pages = 0;
  const endless: CodexRewindPort = {
    async readThread(threadId) { return { id: threadId, historyMode: 'paginated', status: { type: 'idle' } }; },
    async listTurns() { pages++; return { data: [{ id: `turn-${pages}`, items: [{ id: 'msg_other', type: 'userMessage' }] }], nextCursor: String(pages) }; },
    async forkBefore() { throw new Error('must not fork'); },
    async revertBefore() { throw new Error('must not revert'); },
  };
  assert.deepEqual(await locateCodexTurn(endless, 'thread-1', CODEX_ANCHOR.nativeId), { found: false, reason: 'history-limit' });
  assert.equal(pages, CODEX_MAX_TURN_PAGES);

  // An exhausted history without the item is a genuine not-found.
  const short = fakePort({ pages: [{ data: [{ id: 'turn-1', items: [{ id: 'msg_other', type: 'userMessage' }] }], nextCursor: null }] });
  assert.deepEqual(await locateCodexTurn(short.port, 'thread-1', CODEX_ANCHOR.nativeId), { found: false, reason: 'not-found' });
});

test('an over-long thread refuses with a history limit instead of claiming the turn is gone', async () => {
  let pages = 0;
  const port: CodexRewindPort = {
    async readThread(threadId) { return { id: threadId, historyMode: 'paginated', status: { type: 'idle' } }; },
    async listTurns() { pages++; return { data: [{ id: `turn-${pages}`, items: [{ id: 'msg_other', type: 'userMessage' }] }], nextCursor: String(pages) }; },
    async forkBefore() { throw new Error('must not fork'); },
    async revertBefore() { throw new Error('must not revert'); },
  };
  const result = await planCodexRewind(port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.reason, 'history-limit'); assert.match(result.message, /bounded rewind scan/); }
});

test('a fork preserves the original thread and confirms the new fork provenance', async () => {
  const { port, calls } = fakePort();
  const outcome = await executeCodexRewind(port, { strategy: 'fork-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.threadId, 'thread-fork');
  assert.equal(outcome.sourceThreadId, 'thread-1');
  assert.deepEqual(calls, ['fork:thread-1:turn-1'], 'a fork never reverts the original');
});

test('a revert keeps the original thread id and is only used when the plan says so', async () => {
  const { port, calls } = fakePort();
  const outcome = await executeCodexRewind(port, { strategy: 'revert-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.threadId, 'thread-1');
  assert.deepEqual(calls, ['revert:thread-1:turn-1']);
});

test('a lost reply is reported as uncertain and never retried', async () => {
  let forks = 0, reverts = 0;
  const port: CodexRewindPort = {
    async readThread(threadId) { return { id: threadId, historyMode: 'paginated', status: { type: 'idle' } }; },
    async listTurns() { return { data: [], nextCursor: null }; },
    async forkBefore() { forks++; throw new Error('connection closed'); },
    async revertBefore() { reverts++; throw new Error('connection closed'); },
  };
  const fork = await executeCodexRewind(port, { strategy: 'fork-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(fork.ok, false);
  if (!fork.ok) { assert.equal(fork.reason, 'outcome-unknown'); assert.equal(fork.uncertain, true); }
  assert.equal(forks, 1, 'the uncertain fork is not retried');

  const revert = await executeCodexRewind(port, { strategy: 'revert-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(revert.ok, false);
  if (!revert.ok) assert.equal(revert.reason, 'outcome-unknown');
  assert.equal(reverts, 1, 'the uncertain revert is not retried');
});

test('a fork that returns the original thread or a foreign parent is never accepted', async () => {
  const sameThread = fakePort({ fork: async () => ({ thread: { id: 'thread-1', forkedFromId: 'thread-1' } }) });
  const same = await executeCodexRewind(sameThread.port, { strategy: 'fork-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.reason, 'outcome-unknown');

  const foreign = fakePort({ fork: async () => ({ thread: { id: 'thread-fork', forkedFromId: 'thread-unrelated' } }) });
  const result = await executeCodexRewind(foreign.port, { strategy: 'fork-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.reason, 'foreign-target'); assert.equal(result.uncertain, false); }

  const noThread = fakePort({ fork: async () => ({ thread: undefined as unknown as CodexThreadSummary }) });
  const missing = await executeCodexRewind(noThread.port, { strategy: 'fork-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'outcome-unknown');

  const revertForeign = fakePort({ revert: async () => ({ thread: { id: 'thread-other' } }) });
  const reverted = await executeCodexRewind(revertForeign.port, { strategy: 'revert-before', sourceThreadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: 'turn-2' });
  assert.equal(reverted.ok, false);
  if (!reverted.ok) assert.equal(reverted.reason, 'foreign-target');
});

test('the cut is verified against the recorded history, including the first-turn case', async () => {
  const kept = fakePort({ pages: [{ data: [{ id: 'turn-2', items: [] }, { id: 'turn-1', items: [] }], nextCursor: null }] });
  assert.deepEqual(await verifyCodexCut(kept.port, { threadId: 'thread-1', beforeTurnId: 'turn-3', keepTurnId: 'turn-2' }), { ok: true, empty: false });

  // History ending at the kept turn is proven from the newest turn alone.
  const newestOnly = fakePort({ pages: [{ data: [{ id: 'turn-2' }], nextCursor: 'more' }] });
  assert.deepEqual(await verifyCodexCut(newestOnly.port, { threadId: 'thread-1', beforeTurnId: 'turn-3', keepTurnId: 'turn-2' }), { ok: true, empty: false });
  assert.deepEqual(newestOnly.calls, [`turns:thread-1:-:${CODEX_TURN_PAGE_LIMIT}`], 'the cut is proven without walking the whole thread');

  const empty = fakePort({ pages: [{ data: [], nextCursor: null }] });
  assert.deepEqual(await verifyCodexCut(empty.port, { threadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: null }), { ok: true, empty: true });

  const stillThere = fakePort({ pages: [{ data: [{ id: 'turn-3' }, { id: 'turn-2' }], nextCursor: null }] });
  const notApplied = await verifyCodexCut(stillThere.port, { threadId: 'thread-1', beforeTurnId: 'turn-3', keepTurnId: 'turn-2' });
  assert.equal(notApplied.ok, false);
  if (!notApplied.ok) assert.equal(notApplied.reason, 'provider-refused');

  const wrongBoundary = fakePort({ pages: [{ data: [{ id: 'turn-2' }, { id: 'turn-1' }], nextCursor: null }] });
  const unknown = await verifyCodexCut(wrongBoundary.port, { threadId: 'thread-1', beforeTurnId: 'turn-9', keepTurnId: 'turn-5' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, 'outcome-unknown');

  // Rewinding the first turn while turns remain is a refusal, not a success.
  const leftovers = fakePort({ pages: [{ data: [{ id: 'turn-2' }], nextCursor: null }] });
  const leftover = await verifyCodexCut(leftovers.port, { threadId: 'thread-1', beforeTurnId: 'turn-9', keepTurnId: null });
  assert.equal(leftover.ok, false);
  if (!leftover.ok) assert.equal(leftover.reason, 'provider-refused');
});

test('a bounded verification scan that runs out with a cursor pending proves nothing', async () => {
  let pages = 0;
  const port: CodexRewindPort = {
    async readThread(threadId) { return { id: threadId, historyMode: 'paginated', status: { type: 'idle' } }; },
    async listTurns() { pages++; return { data: [{ id: `turn-${pages}` }], nextCursor: String(pages) }; },
    async forkBefore() { throw new Error('must not fork'); },
    async revertBefore() { throw new Error('must not revert'); },
  };
  const result = await verifyCodexCut(port, { threadId: 'thread-1', beforeTurnId: 'turn-x', keepTurnId: 'turn-y' });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.reason, 'outcome-unknown'); assert.match(result.message, /bounded verification scan/); }
  assert.equal(pages, CODEX_MAX_TURN_PAGES);

  // An empty first page with a pending cursor also cannot prove the history is empty.
  const partialEmpty = fakePort({ pages: [{ data: [], nextCursor: 'still-more' }] });
  const emptyUnknown = await verifyCodexCut(partialEmpty.port, { threadId: 'thread-1', beforeTurnId: 'turn-1', keepTurnId: null });
  assert.equal(emptyUnknown.ok, false);
  if (!emptyUnknown.ok) assert.equal(emptyUnknown.reason, 'outcome-unknown');
});

test('a native thread from another workspace is refused before any cut', async () => {
  const pages: CodexTurnPage[] = [{ data: [{ id: 'turn-1', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] }], nextCursor: null }];
  const foreignCwd = fakePort({ pages, thread: { id: 'thread-1', cwd: 'C:\\Users\\User\\other-repo', historyMode: 'paginated', status: { type: 'idle' } } });
  const refused = await planCodexRewind(foreignCwd.port, { threadId: 'thread-1', anchor: CODEX_ANCHOR, allowedCwds: ['C:\\Users\\User\\orca\\ADE'] });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'foreign-target');
  assert.ok(!foreignCwd.calls.some(call => call.startsWith('fork:')));

  const bound = fakePort({ pages, thread: { id: 'thread-1', cwd: 'C:\\Users\\User\\orca\\ADE', historyMode: 'paginated', status: { type: 'idle' } } });
  assert.equal((await planCodexRewind(bound.port, { threadId: 'thread-1', anchor: CODEX_ANCHOR, allowedCwds: ['C:\\Users\\User\\orca\\ADE'] })).ok, true);
  assert.equal(sameWorkspace('C:\\Users\\User\\orca\\ADE\\', ['C:\\Users\\User\\orca\\ADE']), true);
  assert.equal(sameWorkspace('C:\\Users\\User\\orca\\ADE', ['C:\\Users\\User\\orca\\OTHER']), false);
  // A thread with no recorded cwd is not refused on cwd alone; the id binding still applies.
  const noCwd = fakePort({ pages, thread: { id: 'thread-1', historyMode: 'paginated', status: { type: 'idle' } } });
  assert.equal((await planCodexRewind(noCwd.port, { threadId: 'thread-1', anchor: CODEX_ANCHOR, allowedCwds: ['C:\\x'] })).ok, true);
});

test('recovery distinguishes an applied cut from an unapplied one without mutating anything', async () => {
  const applied = fakePort({ pages: [{ data: [{ id: 'turn-2' }], nextCursor: null }] });
  assert.deepEqual(await recoverCodexRewind(applied.port, { threadId: 'thread-1', beforeTurnId: 'turn-3', keepTurnId: 'turn-2' }), { ok: true });
  assert.ok(!applied.calls.some(call => call.startsWith('fork:') || call.startsWith('revert:')));

  const unapplied = fakePort({ pages: [{ data: [{ id: 'turn-3' }, { id: 'turn-2' }], nextCursor: null }] });
  const refused = await recoverCodexRewind(unapplied.port, { threadId: 'thread-1', beforeTurnId: 'turn-3', keepTurnId: 'turn-2' });
  assert.equal(refused.ok, false);
  if (!refused.ok) { assert.equal(refused.reason, 'target-not-found'); assert.match(refused.message, /original session is unchanged/); }
});

test('the default port sends only fixed methods and shapes native replies', async () => {
  const seen: { method: string; params: any }[] = [];
  const request = async (method: string, params: any) => {
    seen.push({ method, params });
    switch (method) {
      case 'thread/read': return { thread: { id: params.threadId, historyMode: 'paginated', status: { type: 'idle' }, forkedFromId: null } };
      case 'thread/turns/list': return { data: [{ id: 'turn-1', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] }], nextCursor: null };
      case 'thread/fork': return { thread: { id: 'thread-fork', forkedFromId: params.threadId, historyMode: 'paginated', status: { type: 'idle' } } };
      case 'thread/revert': return { thread: { id: params.threadId, historyMode: 'paginated', status: { type: 'idle' } } };
      default: throw new Error(`unexpected method ${method}`);
    }
  };
  const port = createCodexRewindPort(request);
  assert.deepEqual(await port.readThread('thread-1'), { id: 'thread-1', cwd: null, forkedFromId: null, historyMode: 'paginated', status: { type: 'idle' } });
  const page = await port.listTurns('thread-1', null, CODEX_TURN_PAGE_LIMIT);
  assert.deepEqual(page.data[0]!.items, [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }]);
  await port.forkBefore('thread-1', 'turn-1');
  await port.revertBefore('thread-1', 'turn-1');
  assert.deepEqual(seen.map(entry => entry.method), ['thread/read', 'thread/turns/list', 'thread/fork', 'thread/revert']);
  assert.deepEqual(seen[0]!.params, { threadId: 'thread-1', includeTurns: false });
  assert.deepEqual(seen[1]!.params, { threadId: 'thread-1', cursor: null, limit: CODEX_TURN_PAGE_LIMIT, sortDirection: 'desc', itemsView: 'full' });
  assert.deepEqual(seen[2]!.params, { threadId: 'thread-1', beforeTurnId: 'turn-1', excludeTurns: true });
  assert.deepEqual(seen[3]!.params, { threadId: 'thread-1', beforeTurnId: 'turn-1' });
});

test('the default port rejects malformed native replies instead of inventing state', async () => {
  const noThread = createCodexRewindPort(async () => ({}));
  await assert.rejects(() => noThread.readThread('thread-1'), /no thread/);
  const noPage = createCodexRewindPort(async () => ({ data: 'nope' }));
  await assert.rejects(() => noPage.listTurns('thread-1', null, 10), /no turn page/);
  const emptyId = createCodexRewindPort(async () => ({ thread: { id: '' } }));
  await assert.rejects(() => emptyId.readThread('thread-1'), /no thread/);
});

test('a full plan-and-execute cycle never touches the original thread when forking', async () => {
  const pages: CodexTurnPage[] = [{ data: [
    { id: 'turn-3', items: [{ id: 'msg_c', type: 'userMessage' }] },
    { id: 'turn-2', items: [{ id: CODEX_ANCHOR.nativeId, type: 'userMessage' }] },
    { id: 'turn-1', items: [{ id: 'msg_a', type: 'userMessage' }] },
  ], nextCursor: null }];
  const { port, calls } = fakePort({ pages });
  const planned = await planCodexRewind(port, { threadId: 'thread-1', anchor: CODEX_ANCHOR });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const outcome = await executeCodexRewind(port, planned.plan);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.keepTurnId, 'turn-1');
  assert.equal(outcome.beforeTurnId, 'turn-2');
  assert.equal(outcome.threadId, 'thread-fork');
  assert.ok(!calls.some(call => call.startsWith('revert:')), 'the original thread is never rewritten by a fork');
});
