import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachmentPaste, decodeAttachments, storeAttachments } from './attachments.js';
import { globalSourceMaps } from '../integrations/orca/state.js';
import { sendAgentMessage } from '../integrations/orca/actions.js';
import { validateOrcaArgs } from '../integrations/cliValidators.js';

const image = { name: 'test.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=' };

test('attachment validation rejects malformed, oversized, and mismatched images', () => {
  assert.equal(decodeAttachments([image])[0].bytes.length, 68);
  for (const input of [null, [null], [{ ...image, dataBase64: 'invalid!' }], [{ ...image, mimeType: 'image/jpeg' }],
    Array(9).fill(image), [{ ...image, dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }]]) {
    assert.throws(() => decodeAttachments(input));
  }
  assert.throws(() => decodeAttachments(Array(5).fill({ name: 'file.bin', mimeType: '', dataBase64: Buffer.alloc(5 * 1024 * 1024).toString('base64') })));
});

test('attachment store generates contained paths, preserves bytes, and expires old files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-attachments-test-'));
  try {
    const files = await storeAttachments(decodeAttachments([{ ...image, name: '../../evil.png' }]), root);
    assert.equal(path.dirname(files[0].path), root);
    assert.equal(files[0].image, true);
    assert.equal((await fs.readFile(files[0].path)).toString('base64'), image.dataBase64);
    await fs.utimes(files[0].path, new Date(0), new Date(0));
    await storeAttachments([], root);
    assert.equal((await fs.readdir(root)).length, 0);
  } finally {
    for (const name of await fs.readdir(root)) await fs.unlink(path.join(root, name));
    await fs.rmdir(root);
  }
});

test('image delivery mirrors provider paste rules and submits after staging', async () => {
  const file = { name: 'test.png', path: 'C:\\Temp\\test.png', image: true };
  assert.equal(attachmentPaste('codex', file), '\x1b[200~C:\\Temp\\test.png\x1b[201~\x1b[200~\n\x1b[201~');
  assert.equal(attachmentPaste('claude', file), attachmentPaste('codex', file));
  for (const provider of ['antigravity', 'opencode', 'kilocode', 'pi', 'omp', 'unknown']) {
    assert.equal(attachmentPaste(provider, file), '\x1b[200~@C:\\Temp\\test.png\x1b[201~\x1b[200~\n\x1b[201~');
  }
  assert.match(attachmentPaste('codex', { ...file, image: false }), /@C:/);
  assert.match(attachmentPaste('pi', { ...file, path: 'C:\\User Files\\test.png' }), /@"C:/);
  const calls: string[][] = [];
  globalSourceMaps.nodeSourceMap.set('attachment-test', { handle: 'term_attachment_test' });
  try {
    await sendAgentMessage('project', 'attachment-test', 'Describe this', async (_exe, args) => {
      validateOrcaArgs(args);
      calls.push(args);
      return { stdout: JSON.stringify({ ok: true, result: { send: { accepted: true } } }), stderr: '', exitCode: 0 };
    }, { provider: 'codex', files: [file] });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].includes('--enter'), false);
    assert.equal(calls[1][5], '\x1b[200~\nDescribe this\x1b[201~');
    assert.equal(calls[1].includes('--enter'), false);
    assert.deepEqual(calls[2], ['terminal', 'send', '--terminal', 'term_attachment_test', '--enter', '--json']);
  } finally { globalSourceMaps.nodeSourceMap.delete('attachment-test'); }
});

test('attachment staging failure prevents final submission', async () => {
  globalSourceMaps.nodeSourceMap.set('attachment-failed', { handle: 'term_attachment_failed' });
  const calls: string[][] = [];
  try {
    await assert.rejects(() => sendAgentMessage('project', 'attachment-failed', 'Describe', async (_exe, args) => {
      calls.push(args);
      throw new Error('Not accepted');
    }, { provider: 'codex', files: [{ name: 'test.png', path: 'C:\\Temp\\test.png', image: true }] }));
    assert.equal(calls.length, 1);
  } finally { globalSourceMaps.nodeSourceMap.delete('attachment-failed'); }
});

test('file reference and prompt share a multiline paste so the line break is retained', async () => {
  globalSourceMaps.nodeSourceMap.set('reference-test', { handle: 'term_reference_test' });
  const calls: string[][] = [];
  try {
    await sendAgentMessage('project', 'reference-test', '- Update the header', async (_exe, args) => {
      validateOrcaArgs(args);
      calls.push(args);
      return { stdout: JSON.stringify({ ok: true, result: { send: { accepted: true } } }), stderr: '', exitCode: 0 };
    }, { provider: 'antigravity', files: [{ name: 'test.png', path: 'C:\\Temp\\test.png', image: true }] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0][5], '\x1b[200~@C:\\Temp\\test.png\n- Update the header\x1b[201~');
    assert.equal(calls[0].includes('--enter'), false);
    assert.equal(calls[1].includes('--enter'), true);
  } finally { globalSourceMaps.nodeSourceMap.delete('reference-test'); }
});
