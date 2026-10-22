import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agyQuota, claudeQuota, codexQuota, LocalConnections, quotaWindow } from './connections.js';
import type { CommandRunner } from '../integrations/cli.js';

test('integrations returns immediately while GitHub auth is pending and avoids provider credential reads', async () => {
  let finish!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
  const service = new LocalConnections(async (_exe, args) => args[0] === '--version' ? { exitCode: 0, stdout: 'gh', stderr: '' } : new Promise(resolve => { finish = resolve; }), {
    credentials: async () => { throw new Error('Unrelated provider credentials must not delay integrations'); }, resolve: () => null,
  });
  const initial = await service.connections('integrations');
  assert.equal(initial.meta.partial, true);
  assert.equal(initial.data?.connections.length, 1);
  assert.equal(initial.data?.connections[0].connected, null);
  const during = await service.connections('integrations'); assert.equal(during, initial);
  finish({ exitCode: 0, stderr: '', stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success' }] } }) });
  await new Promise(resolve => setImmediate(resolve));
  const confirmed = await service.connections('integrations');
  assert.equal(confirmed.meta.partial, false);
  assert.equal(confirmed.data?.connections[0].connected, true);
});

test('provider account detection skips GitHub probes and shares concurrent reads', async () => {
  let credentials = 0, probes = 0;
  const service = new LocalConnections(async () => { probes++; throw new Error('Accounts must not wait for GitHub'); }, {
    credentials: async () => { credentials++; return [null, null]; }, resolve: () => null,
  });
  const [first, second] = await Promise.all([service.connections('accounts'), service.connections('accounts')]);
  assert.equal(credentials, 1);
  assert.equal(probes, 0);
  assert.equal(first, second);
  assert.equal(first.data?.connections.some(connection => connection.id === 'github'), false);
  assert.equal(first.data?.connections.length, 3);
});

test('quota parsers preserve zero, distinguish unknown from zero, and use structured disabled pool evidence', () => {
  assert.equal(quotaWindow('unknown', null, null), null);
  assert.equal(quotaWindow('invalid', 101, null), null);
  assert.equal(quotaWindow('invalid', NaN, null), null);
  assert.equal(quotaWindow('zero', 0, null)?.usedPercent, 0);
  assert.deepEqual(codexQuota({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1900000000 } } }), [
    { label: '5h', usedPercent: 12, resetsAt: new Date(1900000000000).toISOString() },
  ]);
  assert.equal(claudeQuota({ five_hour: { utilization: 0 }, seven_day: { utilization: 40 } })[0].usedPercent, 0);
  assert.deepEqual(agyQuota({ response: '100% remaining' }), []);
  const data = { command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
    { remaining_fraction: 1, window: '5h' }, { remaining_fraction: 0, disabled: true }, { remaining_fraction: 2 },
  ] }] } } };
  assert.deepEqual(agyQuota(data), [{ label: 'Gemini 5h', usedPercent: 0, resetsAt: null }]);
});

test('native quota reads deduplicate, preserve last good observations on errors, and never serialize credentials', async () => {
  let now = 1900000000000, calls = 0, fail = false;
  const service = new LocalConnections(async () => { throw new Error('not installed'); }, {
    credentials: async () => [{ tokens: { access_token: 'private-token', account_id: 'private-account' } }, null], resolve: () => null, now: () => now,
    request: async (url, headers) => {
      calls++; assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage'); assert.equal(headers.Authorization, 'Bearer private-token');
      if (fail) throw new Error('private-token must never reach browser');
      return { rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000 } } };
    },
  });
  const [a, b] = await Promise.all([service.usage(), service.usage()]);
  assert.equal(a, b); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(a).includes('private-'));
  assert.equal(await service.usage(), a); assert.equal(calls, 1, 'background reads use the unexpired cache');
  const [fresh, concurrent] = await Promise.all([service.usage(true), service.usage(true)]);
  assert.equal(fresh, concurrent); assert.equal(calls, 2, 'manual refresh bypasses the cache and shares in-flight reads');
  now += 61000; fail = true;
  const stale = await service.usage();
  assert.equal(stale.meta.availability, 'unavailable');
  assert.equal(stale.meta.stale, true);
  assert.equal(stale.data?.providers[0].windows[0].usedPercent, 23);
  assert.equal(stale.data?.providers[0].meta.observedAt, a.data?.providers[0].meta.observedAt);
  assert.ok(!JSON.stringify(stale).includes('private-'));
});

test('Antigravity usage probe gates old CLI versions and disables the background updater', async () => {
  const calls: string[][] = [];
  let version = '1.1.10', now = 1900000000000;
  const runner: CommandRunner = async (_executable, args, options) => {
    calls.push(args);
    assert.equal(options?.env?.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    return { exitCode: 0, stderr: '', stdout: args[0] === '--version' ? version : JSON.stringify({ command: { name: 'usage', data: { groups: [{ name: 'Pool', buckets: [{ remaining_fraction: .5 }] }] } } }) };
  };
  const service = new LocalConnections(runner, { credentials: async () => [null, null], resolve: p => p === 'antigravity' ? { executable: 'agy', args: [] } : null, now: () => now });
  await service.usage(); assert.deepEqual(calls, [['--version']]);
  version = '1.2.11'; now += 11000;
  const reading = await service.usage();
  assert.deepEqual(calls.at(-1), ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s']);
  assert.equal(reading.data?.providers[2].windows[0].usedPercent, 50);
});

test('GitHub detection uses fixed auth metadata and excludes private account fields', async () => {
  const calls: string[][] = [];
  const service = new LocalConnections(async (_exe, args) => {
    calls.push(args); return { exitCode: 0, stderr: '', stdout: args[0] === '--version' ? 'gh version' : JSON.stringify({ hosts: { 'github.com': [{ state: 'success', login: 'private-login', token: 'private-token' }] } }) };
  }, { credentials: async () => [null, null], resolve: () => null });
  const result = await service.connections();
  assert.equal(result.data?.connections[0].connected, true);
  assert.deepEqual(calls[1], ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']);
  assert.ok(!JSON.stringify(result).includes('private-'));
});
