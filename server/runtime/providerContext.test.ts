import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readDatabaseContext, readAntigravityContext, nativeModelContextWindow } from './providerContext.js';
import type { SessionRecord } from './store.js';

test('native catalog capacities accept positive integer provider limits only', () => {
  assert.equal(nativeModelContextWindow({ limit: { context: 128000 } }), 128000);
  for (const context of [undefined, null, 0, -1, NaN, Infinity, 1.5, '128000']) assert.equal(nativeModelContextWindow({ limit: { context } }), undefined);
  assert.equal(nativeModelContextWindow({ contextWindow: 128000 }), undefined);
});

test('database context reads latest exact-session request input with both caches, never cumulative spend', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-context-db-')), file = path.join(directory, 'native.db');
  const db = new DatabaseSync(file);
  const record = { provider: 'kilo', providerThreadId: 'ses_exact', cwd: directory } as SessionRecord;
  try {
    db.exec('CREATE TABLE session(id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
    db.prepare('INSERT INTO session VALUES (?,?,NULL)').run('ses_exact', directory);
    const insert = (session: string, message: unknown) => db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(crypto.randomUUID(), session, 1000, JSON.stringify(message));
    insert('ses_exact', { role: 'assistant', tokens: { input: 999999, output: 5 } });
    insert('ses_exact', { role: 'assistant', tokens: { input: 100, output: 20, cache: { read: 30, write: 10 } } });
    insert('ses_other', { role: 'assistant', tokens: { input: 5000, output: 5 } });
    const usage = readDatabaseContext(record, file);
    assert.equal(usage.usedTokens, 140); assert.equal(usage.windowTokens, null);
    assert.equal(usage.outputTokens, 20); assert.equal(usage.cacheReadTokens, 30); assert.equal(usage.cacheWriteTokens, 10);
    assert.equal(readDatabaseContext({ ...record, cwd: path.dirname(directory) }, file).usedTokens, null);
    // An aborted or token-less request is not a measurement: fall back to the newest
    // request that reported usage, and say so rather than showing nothing.
    insert('ses_exact', { role: 'assistant', tokens: { input: 0, output: 0 } });
    assert.equal(readDatabaseContext(record, file).usedTokens, 140);
    assert.match(readDatabaseContext(record, file).reason!, /reported no token usage/);
    insert('ses_exact', { role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } });
    assert.equal(readDatabaseContext(record, file).usedTokens, 140);
    // A compaction summary still stops the scan: pre-compaction usage is not current.
    insert('ses_exact', { role: 'assistant', summary: true, tokens: { input: 90, output: 6 } });
    assert.equal(readDatabaseContext(record, file).usedTokens, null);
    insert('ses_exact', { role: 'assistant', modelID: 'nvidia/model:free', providerID: 'kilo', tokens: { input: 70, output: 4 } });
    assert.equal(readDatabaseContext(record,file).model,'kilo/nvidia/model:free');
    insert('ses_exact', { role: 'assistant', modelID: 'old', providerID: 'route', tokens: { input: 70, output: 4 } });
    insert('ses_exact', { role: 'user', model: { modelID: 'new', providerID: 'route' } });
    assert.match(readDatabaseContext(record, file).reason!, /model changed/);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('OpenCode 2 context uses session_message only and refuses summary, foreign and malformed counts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-context-v2-')), file = path.join(directory, 'native.db');
  const db = new DatabaseSync(file);
  const record = { provider: 'opencode2', providerThreadId: 'ses_exact', cwd: directory } as SessionRecord;
  try {
    db.exec('CREATE TABLE session_v2(id TEXT,directory TEXT,parent_id TEXT); CREATE TABLE session_message(id TEXT,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT); CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT)');
    db.prepare('INSERT INTO session_v2 VALUES (?,?,NULL)').run('ses_exact', directory);
    db.prepare('INSERT INTO message VALUES (?,?,?)').run('ses_exact', 1000, JSON.stringify({ role: 'assistant', tokens: { input: 100000, output: 20 } }));
    assert.equal(readDatabaseContext(record, file).usedTokens, null);
    const insert = (seq: number, message: unknown) => db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('msg' + seq, 'ses_exact', 'assistant', seq, 1000, JSON.stringify(message));
    insert(1, { tokens: { input: 40, output: 6, cache: { read: 10 } } });
    assert.equal(readDatabaseContext(record, file).usedTokens, 50);
    insert(2, { summary: true, tokens: { input: 90, output: 6 } });
    assert.equal(readDatabaseContext(record, file).usedTokens, null);
    insert(3, { tokens: { input: 40, output: 6, cache: { read: -1 } } });
    assert.equal(readDatabaseContext(record, file).usedTokens, null);
    insert(4, { providerID: 'route', modelID: 'old', tokens: { input: 40, output: 6 } });
    assert.equal(readDatabaseContext(record, file).model, 'route/old');
    db.exec('ALTER TABLE session_v2 ADD COLUMN model TEXT');
    db.prepare('UPDATE session_v2 SET model = ? WHERE id = ?').run(JSON.stringify({ providerID: 'route', modelID: 'new' }), 'ses_exact');
    assert.match(readDatabaseContext(record, file).reason!, /model changed/);
    db.prepare('UPDATE session_v2 SET parent_id = ? WHERE id = ?').run('ses_parent', 'ses_exact');
    assert.equal(readDatabaseContext(record, file).usedTokens, null);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity reads only exact latest request numeric context metadata and invalidates missing or zero readings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-context-agy-')), file = path.join(directory, 'exact.db');
  const db = new DatabaseSync(file), record = { provider: 'antigravity', providerThreadId: 'exact' } as SessionRecord;
  const integer = (value: number) => {
    const result: number[] = [];
    do { const byte = value % 128; value = Math.floor(value / 128); result.push(byte + (value ? 128 : 0)); } while (value);
    return Buffer.from(result);
  };
  const scalar = (field: number, value: number) => Buffer.concat([integer(field * 8), integer(value)]);
  const bytes = (field: number, value: Uint8Array) => Buffer.concat([integer(field * 8 + 2), integer(value.length), value]);
  const context = (used: number, window: number) => bytes(10, Buffer.concat([scalar(1, used), scalar(4, window)]));
  const packet = (used: number, window: number) => bytes(1, Buffer.concat([
    bytes(9, Buffer.concat([
      // Native ChatStartMetadata includes an int64 -1 sentinel before context.
      Buffer.from([16,255,255,255,255,255,255,255,255,255,1]),
      context(used, window), bytes(4, scalar(1, 1700000000)),
    ])),
    bytes(4, Buffer.concat([scalar(2, 100), scalar(3, 20), scalar(4, 50), scalar(5, 250)])),
    bytes(19, Buffer.from('claude-model')),
  ]));
  try {
    db.exec('CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE gen_metadata(idx INTEGER,data BLOB)');
    db.prepare('INSERT INTO trajectory_meta VALUES (?)').run('exact');
    const insert = (idx: number, data: Uint8Array) => db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(idx, data);
    insert(1, packet(400, 200000));
    const usage = readAntigravityContext(record, file);
    assert.equal(usage.usedTokens, 400); assert.equal(usage.windowTokens, 200000); assert.equal(usage.estimated, true);
    assert.equal(usage.inputTokens, 100); assert.equal(usage.outputTokens, 20); assert.equal(usage.cacheReadTokens, 250); assert.equal(usage.cacheWriteTokens, 50);
    assert.equal(usage.model, 'claude-model'); assert.equal(usage.observedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(readAntigravityContext({ ...record, providerThreadId: 'foreign' }, file).usedTokens, null);
    insert(2, bytes(1, bytes(1, packet(9999, 999999)))); // Prompt bytes are not context metadata.
    assert.equal(readAntigravityContext(record, file).usedTokens, null);
    insert(3, packet(0, 200000)); assert.equal(readAntigravityContext(record, file).usedTokens, null);
    insert(4, packet(500, 0)); assert.equal(readAntigravityContext(record, file).usedTokens, 500); assert.equal(readAntigravityContext(record, file).windowTokens, null);
    insert(5, Buffer.from([10, 255])); assert.equal(readAntigravityContext(record, file).usedTokens, null);
    insert(6, bytes(1, bytes(9, Buffer.concat([Buffer.from([16,255,255,255,255,255,255,255,255,255,2]), context(500,200000)]))));
    assert.equal(readAntigravityContext(record, file).usedTokens, null); // Invalid uint64 overflow.
    insert(7, bytes(1, bytes(9, Buffer.from([16,255,255,255,255,255,255,255,255,255,129]))));
    assert.equal(readAntigravityContext(record, file).usedTokens, null); // Unterminated ten-byte varint.
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
