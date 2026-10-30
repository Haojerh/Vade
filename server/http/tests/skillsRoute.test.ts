import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleLocalRoute } from '../localRoutes.js';
import type { LocalRuntime } from '../../runtime/localRuntime.js';

function harness() {
  const calls: { status: number | null; body: any } = { status: null, body: null };
  const res = {
    headersSent: false,
    statusCode: 0,
    writeHead(status: number) { calls.status = status; res.headersSent = true; return res; },
    setHeader() {},
    end(body?: string) { calls.body = body ? JSON.parse(body) : null; },
  };
  const runtime = { store: { directory: os.tmpdir() } } as unknown as LocalRuntime;
  const run = async (method: string, path: string) => {
    await handleLocalRoute(runtime, { method, headers: {} } as http.IncomingMessage, res as unknown as http.ServerResponse, 'req-1', new URL(path, 'http://127.0.0.1'));
    return calls;
  };
  return { run };
}

test('the skills route serves bounded personal skill metadata and rejects mutations', async () => {
  const home = process.env.HOME, profile = process.env.USERPROFILE;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-skills-route-'));
  try {
    // The route reads the personal skills directory under the current home.
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'animate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'skills', 'animate', 'SKILL.md'), '---\nname: animate\ndescription: Build an animation\n---\n');
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    const { run } = harness();
    const get = await run('GET', '/api/skills');
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.data, [{ name: 'animate', description: 'Build an animation', scope: 'personal' }]);
    assert.equal(get.body.meta.availability, 'ready');
    // A fresh response per request: the harness marks headersSent after the first reply.
    assert.equal((await harness().run('POST', '/api/skills')).status, 405);
    assert.equal((await harness().run('GET', '/api/skills?path=C:/anything')).status, 400);
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = profile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
