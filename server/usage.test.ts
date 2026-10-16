import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeUsageSnapshot, readOrcaUsageSnapshot, UsageCollector } from './usage.js';

const now = Date.now();
const snapshot = { accounts: [{ email: 'private@example.test', token: 'secret' }], rateLimits: {
  codex: { status: 'ok', updatedAt: now, session: { usedPercent: 0, resetsAt: now + 3600000 },
    weekly: { usedPercent: 100, resetsAt: now + 86400000 } },
  antigravity: { status: 'ok', updatedAt: now, buckets: [
    { name: 'Gemini Models · Weekly Limit Remaining', usedPercent: 51.4, resetsAt: now + 86400000 },
  ] },
} };

test('usage normalizes used percentages and named pools without leaking account data', () => {
  const result = normalizeUsageSnapshot(snapshot, now);
  assert.equal(result.data?.providers[0].provider, 'antigravity');
  assert.equal(result.data?.providers[0].buckets[0].label, 'Gemini Models · Weekly Limit');
  assert.equal(result.data?.providers[0].buckets[0].usedPercent, 51);
  assert.deepEqual(result.data?.providers[1].windows.map((w) => w.usedPercent), [0, 100]);
  assert.equal(result.meta.stale, false);
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('invalid usage is unavailable rather than zero and expired observations stay stale', () => {
  const bad = normalizeUsageSnapshot({ rateLimits: { codex: { status: 'error', updatedAt: now,
    session: { usedPercent: null }, weekly: { usedPercent: 101 } } } }, now);
  assert.deepEqual(bad.data?.providers[0].windows, []);
  assert.equal(bad.meta.availability, 'unavailable');
  assert.equal(bad.meta.partial, true);
  assert.equal(normalizeUsageSnapshot(snapshot, now + 16 * 60000).meta.stale, true);
  assert.equal(normalizeUsageSnapshot({ rateLimits: {} }, now).meta.availability, 'empty');
  assert.throws(() => normalizeUsageSnapshot({}), /no usage snapshot/);
});

test('usage collector deduplicates reads, caches, and preserves stale evidence after failure', async (t) => {
  let calls = 0;
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const collector = new UsageCollector(async () => {
    calls++;
    if (calls > 1) throw new Error('sensitive runtime detail');
    return snapshot;
  });
  const [first, second] = await Promise.all([collector.get(), collector.get()]);
  assert.equal(first, second);
  await collector.get();
  assert.equal(calls, 1);
  clock += 11000;
  const failed = await collector.get();
  assert.equal(calls, 2);
  assert.equal(failed.meta.availability, 'unavailable');
  assert.equal(failed.meta.stale, true);
  assert.equal(failed.meta.observedAt, first.meta.observedAt);
  assert.deepEqual(failed.data, first.data);
  assert.ok(!JSON.stringify(failed).includes('sensitive runtime detail'));
});

test('local usage transport only sends cached accounts.list and checks runtime provenance', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-usage-'));
  const oldPath = process.env.ORCA_USER_DATA_PATH;
  process.env.ORCA_USER_DATA_PATH = dir;
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\orca-usage-test-${crypto.randomUUID()}` : path.join(dir, 'runtime.sock');
  let wrongRuntime = false;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.trim());
      assert.equal(request.method, 'accounts.list');
      assert.deepEqual(request.params, { refreshUsage: false });
      assert.equal(request.authToken, 'test-token');
      socket.write('{"_keepalive":true}\n');
      socket.end(JSON.stringify({ id: request.id, ok: true, result: snapshot,
        _meta: { runtimeId: wrongRuntime ? 'different-runtime' : 'runtime-test' } }) + '\n');
    });
    socket.on('error', () => {});
  });
  try {
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    await fs.writeFile(path.join(dir, 'orca-runtime.json'), JSON.stringify({
      authToken: 'test-token', runtimeId: 'runtime-test',
      transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }],
    }));
    assert.deepEqual(await readOrcaUsageSnapshot(), snapshot);
    wrongRuntime = true;
    await assert.rejects(readOrcaUsageSnapshot(), /Invalid Orca usage response/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldPath === undefined) delete process.env.ORCA_USER_DATA_PATH;
    else process.env.ORCA_USER_DATA_PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
