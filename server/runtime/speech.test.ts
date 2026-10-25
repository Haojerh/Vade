import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalSpeech, speechModulePath, validateSpeechAudio } from './speech.js';
import { speechModels } from './speechCatalog.js';

test('installed speech resolves the unpacked addon independently of resources cwd and refuses outside fallbacks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-packaged-speech-'));
  const resources = path.join(directory, 'resources'), application = path.join(resources, 'app.asar');
  const name = process.platform === 'win32' ? `sherpa-onnx-win-${process.arch}` : `sherpa-onnx-${process.platform}-${process.arch}`;
  const install = (base: string) => {
    const target = path.join(base, 'node_modules', name); fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = {};'); return path.join(target, 'index.js');
  };
  try {
    install(resources); // A stray adjacent package must not mask an incomplete app.
    const entry = install(path.join(resources, 'app.asar.unpacked'));
    assert.equal(speechModulePath(application), entry);
    assert.ok(!speechModulePath(application)!.includes(`${path.sep}app.asar${path.sep}`));
    const incomplete = path.join(directory, 'incomplete', 'resources'); install(incomplete);
    assert.equal(speechModulePath(path.join(incomplete, 'app.asar')), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('local speech accepts only bounded ordered float32 PCM payloads', () => {
  const pcm = Buffer.from(new Float32Array([0, -1, 1, 0.5]).buffer).toString('base64');
  assert.equal(validateSpeechAudio({ sequence: 0, pcm }).length, 16);
  for (const value of [NaN, Infinity, 1.1]) assert.throws(() => validateSpeechAudio({ sequence: 0, pcm: Buffer.from(new Float32Array([value]).buffer).toString('base64') }), /sample/);
  for (const sequence of [-1, 0.5, NaN]) assert.throws(() => validateSpeechAudio({ sequence, pcm }), /chunk/);
  for (const value of ['', 'a', 'not audio', Buffer.alloc(64004).toString('base64')]) assert.throws(() => validateSpeechAudio({ sequence: 0, pcm: value }));
});

test('local speech catalog paths and downloads derive only from fixed manifests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-speech-test-'));
  const service = new LocalSpeech(directory);
  try {
    const catalog = service.catalog();
    assert.equal(catalog.models.length, 10);
    assert.ok(catalog.models.every(model => model.status === 'missing'));
    for (const id of ['../escape', 'unknown', 'https://example.com/model']) assert.throws(() => service.download(id), /listed local/);
    for (const model of speechModels) {
      assert.equal(model.sizeBytes, model.downloadFiles.reduce((sum, file) => sum + file.sizeBytes, 0));
      for (const file of model.downloadFiles) { assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(file.url.startsWith('https://huggingface.co/')); assert.equal(path.basename(file.name), file.name); }
    }
    assert.throws(() => service.cancelDownload('../escape'), /listed local/);
  } finally { service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('model downloads verify content before becoming ready and surface failed checksums', { skip: !speechModulePath() }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-speech-download-'));
  const original = speechModels[0], data = Buffer.from('verified model');
  const service = new LocalSpeech(directory, async () => Readable.from([data]));
  const testModel = { ...original, files: ['tokens.txt'], downloadFiles: [{ name: 'tokens.txt', url: 'https://huggingface.co/test', sizeBytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }], sizeBytes: data.length };
  t.mock.method(service as any, 'model', () => testModel);
  const wait = async () => { for (let i = 0; i < 200; i++) { if (!service.catalog().models.some(model => model.status === 'downloading')) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Download did not settle'); };
  try {
    service.download(original.id); await wait();
    assert.equal(service.catalog().models[0].status, 'ready');
    assert.equal(fs.readFileSync(path.join(directory, 'speech-models', original.id, 'tokens.txt'), 'utf8'), data.toString());
    fs.unlinkSync(path.join(directory, 'speech-models', original.id, 'tokens.txt'));
    testModel.downloadFiles[0].sha256 = '0'.repeat(64);
    service.download(original.id); await wait();
    assert.equal(service.catalog().models[0].status, 'error');
    assert.equal(fs.existsSync(path.join(directory, 'speech-models', original.id, 'tokens.txt.part')), false);
  } finally { service.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
