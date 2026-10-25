import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from './api.js';
import { LocalSpeech } from '../runtime/speech.js';
import { speechModels } from '../runtime/speechCatalog.js';
import type { LocalRuntime } from '../runtime/localRuntime.js';

test('every fixed speech model ID reaches download/cancel routes, including decimal Parakeet IDs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-speech-routes-'));
  const speech = new LocalSpeech(directory), downloaded: string[] = [], cancelled: string[] = [];
  const download = t.mock.method(speech, 'download', (id: string) => { assert.ok(speechModels.some(model => model.id === id)); downloaded.push(id); });
  const cancel = speech.cancelDownload.bind(speech);
  t.mock.method(speech, 'cancelDownload', (id: string) => { cancel(id); cancelled.push(id); });
  const runtime = { speech, streams: new Set(), organization: { setPort() {} } } as unknown as LocalRuntime;
  const server = createServer({ localRuntime: runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/speech/models`;
  const post = (suffix: string, body: object = {}) => fetch(`${base}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const model of speechModels) for (const action of ['download', 'cancel']) {
      const response = await post(`${encodeURIComponent(model.id)}/${action}`);
      assert.equal(response.status, 200, `${model.id}/${action}: ${await response.text()}`);
    }
    assert.deepEqual(downloaded, speechModels.map(model => model.id));
    assert.deepEqual(cancelled, speechModels.map(model => model.id));
    assert.equal((await fetch(`${base}/${speechModels[0].id}/download`)).status, 405);
    assert.equal((await post(`${speechModels[0].id}/download`, { url: 'https://example.com/arbitrary-model' })).status, 400);
    download.mock.restore();
    assert.equal((await post('unknown-0.6b/download')).status, 400);
    assert.equal((await post('unknown-0.6b/cancel')).status, 400);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { speech.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(directory, { recursive: true, force: true }); }
});
