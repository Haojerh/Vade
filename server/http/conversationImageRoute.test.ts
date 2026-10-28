import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { handleLocalRoute } from './localRoutes.js';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import { conversationImageId } from '../providers/conversationImages.js';
import { CliError } from '../integrations/cli.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, 5)]);

function harness(overrides: { conversationImage?: (...args: string[]) => { mimeType: string; bytes: Buffer } } = {}) {
  const calls: { status: number | null; headers: Record<string, string>; body: Buffer | null } = { status: null, headers: {}, body: null };
  const res = {
    headersSent: false,
    statusCode: 0,
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      calls.status = status;
      for (const [name, value] of Object.entries(headers)) calls.headers[name.toLowerCase()] = String(value);
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: string | number) { calls.headers[name.toLowerCase()] = String(value); },
    end(body?: string | Buffer) { calls.body = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body); },
  };
  const runtime = {
    store: { project: () => ({ id: 'p1' }) },
    conversationImage: overrides.conversationImage ?? (() => ({ mimeType: 'image/png', bytes: PNG })),
  } as unknown as LocalRuntime;
  const run = async (method: string, path: string) => {
    const url = new URL(path, 'http://127.0.0.1');
    await handleLocalRoute(runtime, { method, headers: {} } as http.IncomingMessage, res as unknown as http.ServerResponse, 'req-1', url);
    return calls;
  };
  return { run };
}

test('the conversation-image route serves recorded bytes with bounded, non-scriptable headers', async () => {
  const id = conversationImageId('src_abc', 128, 0, 'AAAA');
  const calls = await harness().run('GET', `/api/projects/p1/nodes/n1/conversation-image?source=src_abc&id=${id}`);
  assert.equal(calls.status, 200);
  assert.equal(calls.headers['content-type'], 'image/png');
  assert.equal(calls.headers['content-length'], String(PNG.length));
  assert.equal(calls.headers['x-content-type-options'], 'nosniff');
  assert.match(calls.headers['content-security-policy']!, /sandbox/);
  assert.equal(calls.headers['cross-origin-resource-policy'], 'same-origin');
  assert.deepEqual(calls.body, PNG);
});

test('a HEAD probe returns the same headers without a body', async () => {
  const id = conversationImageId('src_abc', 128, 0, 'AAAA');
  const calls = await harness().run('HEAD', `/api/projects/p1/nodes/n1/conversation-image?source=src_abc&id=${id}`);
  assert.equal(calls.status, 200);
  assert.equal(calls.headers['content-type'], 'image/png');
  assert.equal(calls.body, null);
});

test('the route forwards only the opaque source and image tokens', async () => {
  const seen: string[][] = [];
  const id = conversationImageId('src_abc', 128, 0, 'AAAA');
  await harness({ conversationImage: (...args: string[]) => { seen.push(args); return { mimeType: 'image/png', bytes: PNG }; } })
    .run('GET', `/api/projects/p1/nodes/n1/conversation-image?source=src_abc&id=${id}`);
  assert.deepEqual(seen, [['p1', 'n1', 'src_abc', id]]);
});

test('the route rejects mutations, extra parameters and unknown endpoints', async () => {
  const id = conversationImageId('src_abc', 128, 0, 'AAAA');
  const post = await harness().run('POST', `/api/projects/p1/nodes/n1/conversation-image?source=src_abc&id=${id}`);
  assert.equal(post.status, 405);
  assert.match(post.body!.toString(), /METHOD_NOT_ALLOWED/);
  for (const query of ['source=src_abc', `id=${id}`, `source=src_abc&id=${id}&path=/etc/passwd`, `source=src_abc&id=${id}&id=${id}`]) {
    const bad = await harness().run('GET', `/api/projects/p1/nodes/n1/conversation-image?${query}`);
    assert.equal(bad.status, 400, query);
    assert.match(bad.body!.toString(), /INVALID_ARGUMENT/);
  }
  const unknown = await harness().run('GET', '/api/projects/p1/nodes/n1/conversation-imagez');
  assert.equal(unknown.status, 404);
});

test('an unavailable or re-bound recording surfaces as an error instead of bytes', async () => {
  const id = conversationImageId('src_abc', 128, 0, 'AAAA');
  for (const message of ['Conversation changed. Reload the conversation before opening its images.', 'This recorded image is no longer available.']) {
    const calls = await harness({ conversationImage: () => { throw new CliError('RUNTIME_UNAVAILABLE', message); } })
      .run('GET', `/api/projects/p1/nodes/n1/conversation-image?source=src_abc&id=${id}`);
    assert.ok(calls.status !== null && calls.status >= 400, 'a stale locator never returns image bytes');
    assert.ok(calls.body!.toString().includes(message));
  }
});
