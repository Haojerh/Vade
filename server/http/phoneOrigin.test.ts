import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { phoneOrigin } from './phoneOrigin.js';
import { createServer } from './api.js';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import { WebSocket } from 'ws';
import { WorkflowSetup } from '../runtime/workflowSetup.js';
import { AdeStore } from '../runtime/store.js';
import { executableOnPath } from '../runtime/sessions.js';

const native = createRequire(import.meta.url)('../../desktop/phone.cjs');
test('phone setup stages a fixed Serve command in a separate owned shell without Enter', { skip: !executableOnPath('tailscale') }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-phone-setup-'));
  const store = new AdeStore(directory), setup = new WorkflowSetup(store, 'phone');
  try {
    const terminal = await setup.prepareTerminal();
    assert.match(terminal.command, /serve --bg http:\/\/127\.0\.0\.1:4317$/);
    assert.doesNotMatch(terminal.command, /[\r\n]/);
    assert.ok(setup.directory.endsWith('phone-connection'));
    assert.ok(setup.terminalSessions(terminal.projectId, terminal.nodeId));
    setup.closeTerminal(terminal.projectId, terminal.nodeId);
    assert.throws(() => setup.terminalSessions(terminal.projectId, terminal.nodeId));
  } finally { setup.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('connection discovery only accepts a unique private root proxy to Vade', () => {
  const config = { Web: { 'hj.tailbe5708.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' } } } } };
  assert.equal(native.detectedPhoneOrigin(JSON.stringify(config)), 'https://hj.tailbe5708.ts.net');
  assert.equal(native.detectedPhoneOrigin('{}'), null);
  assert.equal(native.detectedPhoneOrigin(JSON.stringify({ ...config, AllowFunnel: { 'hj.tailbe5708.ts.net:443': true } })), null);
  assert.equal(native.detectedPhoneOrigin(JSON.stringify({ Web: { 'hj.tailbe5708.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5173' } } } } })), null);
  assert.equal(native.detectedPhoneOrigin(JSON.stringify({ Web: { ...config.Web, 'other.tailbe5708.ts.net:443': config.Web['hj.tailbe5708.ts.net:443'] } })), null);
});
test('phone settings persist opt-in and fail closed for missing or invalid saved data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-phone-'));
  const file = path.join(directory, 'phone.json');
  try {
    assert.deepEqual(native.loadPhone(file), { enabled: false, origin: '' });
    const settings = { enabled: true, origin: 'https://hj.tailbe5708.ts.net' };
    native.savePhone(file, settings); assert.deepEqual(native.loadPhone(file), settings);
    assert.throws(() => native.savePhone(file, { enabled: true, origin: 'https://example.com' }));
    assert.deepEqual(native.loadPhone(file), settings);
    native.savePhone(file, { ...settings, enabled: false });
    assert.deepEqual(native.loadPhone(file), { ...settings, enabled: false });
    fs.writeFileSync(file, '{bad'); assert.equal(native.loadPhone(file).enabled, false);
    fs.writeFileSync(file, ' '.repeat(4096)); assert.equal(native.loadPhone(file).enabled, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('disabling phone access closes existing remote terminal sockets and preserves local ones', async () => {
  let origin: string | null = 'https://hj.tailbe5708.ts.net';
  const runtime = { streams: new Set(), organization: { setPort() {} }, sessions: { require() {}, subscribe() { return () => {}; }, page() { return { data: '', cursor: 0, live: true, resumable: false }; } } } as unknown as LocalRuntime;
  const server = createServer({ localRuntime: runtime, phoneOrigin: () => origin });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/api/projects/test/nodes/test/terminal-stream`;
  const remote = new WebSocket(url, { origin });
  const local = new WebSocket(url, { origin: 'http://127.0.0.1:4317' });
  try {
    await Promise.all([remote, local].map(socket => new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); })));
    const closed = new Promise<number>(resolve => remote.once('close', resolve));
    origin = null; server.emit('phone-access-changed');
    assert.equal(await closed, 1008);
    assert.equal(local.readyState, WebSocket.OPEN);
  } finally { remote.terminate(); local.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('phone addresses require an exact private Tailscale HTTPS origin in both processes', () => {
  for (const value of ['https://hj.tailbe5708.ts.net', 'https://hj.tailbe5708.ts.net/']) {
    assert.equal(phoneOrigin(value), 'https://hj.tailbe5708.ts.net');
    assert.equal(native.phoneOrigin(value), 'https://hj.tailbe5708.ts.net');
  }
  for (const value of ['', 'http://hj.tailbe5708.ts.net', 'https://example.com', 'https://a.b.ts.net.evil.com', 'https://a.b.ts.net/path', 'https://a.b.ts.net?x=1', 'https://user@a.b.ts.net', 'https://a.b.ts.net:444', 'https://a.ts.net', 'https://100.64.0.1']) {
    assert.equal(phoneOrigin(value), null, value);
    assert.throws(() => native.phoneOrigin(value), value);
  }
});

test('phone host and origin remain opt-in, exact and revocable for assets, APIs and WebSockets', async () => {
  let origin: string | null = null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-phone-http-'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Vade test</title>');
  const runtime = { streams: new Set(), organization: { setPort() {} }, sessions: { require() { throw new Error('No test session'); } } } as unknown as LocalRuntime;
  const server = createServer({ localRuntime: runtime, distDir: directory, phoneOrigin: () => origin });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const request = (host: string, requestOrigin?: string, upgrade = false) => new Promise<number>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: upgrade ? '/api/projects/test/nodes/test/terminal-stream' : '/', headers: { Host: host, ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(upgrade ? { Connection: 'Upgrade', Upgrade: 'websocket' } : {}) } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await request('127.0.0.1:' + port), 200);
    assert.equal(await request('hj.tailbe5708.ts.net'), 403);
    origin = 'https://hj.tailbe5708.ts.net';
    assert.equal(await request('hj.tailbe5708.ts.net', origin), 200);
    assert.equal(await request('hj.tailbe5708.ts.net'), 200);
    assert.equal(await request('other.tailbe5708.ts.net', origin), 403);
    assert.equal(await request('hj.tailbe5708.ts.net', 'https://evil.example'), 403);
    assert.equal(await request('hj.tailbe5708.ts.net', origin, true), 404); // Passed origin gate; no owned test session.
    origin = null; server.emit('phone-access-changed');
    assert.equal(await request('hj.tailbe5708.ts.net'), 403);
    assert.equal(await request('hj.tailbe5708.ts.net', 'https://hj.tailbe5708.ts.net', true), 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('two terminal sockets receive the same grid, including size-only updates and disconnect restoration', async () => {
  let cols = 100, rows = 28;
  const listeners = new Set<() => void>();
  const runtime = { streams: new Set(), organization: { setPort() {} }, sessions: {
    require() {}, subscribe(_id: string, listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    page() { return { data: '', cursor: 0, live: true, resumable: false, cols, rows }; },
    async resize(_project: string, _node: string, nextCols: number, nextRows: number) { cols = nextCols; rows = nextRows; for (const listener of listeners) listener(); },
  } } as unknown as LocalRuntime;
  const server = createServer({ localRuntime: runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port, latest: string[] = [];
  const clients = [0, 1].map(index => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/projects/test/nodes/test/terminal-stream`, { origin: 'http://127.0.0.1:4317' });
    client.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.type === 'output') { latest[index] = `${message.page.cols}:${message.page.rows}`; client.send(JSON.stringify({ type: 'ack', cursor: message.page.cursor })); } });
    return client;
  });
  const until = async (ready: () => boolean) => { const deadline = Date.now() + 3000; while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(ready(), latest.join(',')); };
  try {
    await Promise.all(clients.map(client => new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); })));
    await until(() => latest.every(value => value === '100:28') && latest.length === 2);
    clients[0].send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    clients[1].send(JSON.stringify({ type: 'resize', cols: 40, rows: 24 }));
    await until(() => latest[0] === '40:24' && latest[1] === '40:24');
    clients[1].close(); await until(() => latest[0] === '120:40');
  } finally { for (const client of clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
