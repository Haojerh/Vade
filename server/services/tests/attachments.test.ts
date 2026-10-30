import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachmentPaste, decodeAttachments, storeAttachments } from '../attachments.js';

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
