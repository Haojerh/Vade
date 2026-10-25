import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalViewports } from './terminalViewports.js';

test('focus can move sizing control between phone and desktop and restore it on disconnect', async () => {
  const applied: string[] = [], group = new TerminalViewports<string>(async (cols, rows) => { applied.push(`${cols}:${rows}`); });
  await group.update('desktop', 120, 40);
  await group.update('phone', 40, 24);
  await group.update('desktop', 130, 44);
  await group.update('phone', 40, 24);
  assert.deepEqual(applied, ['120:40', '40:24', '130:44', '40:24']);
  await group.remove('phone');
  assert.deepEqual(applied, ['120:40', '40:24', '130:44', '40:24', '130:44']);
  await group.remove('desktop');
  assert.equal(applied.length, 5);
});

test('concurrent viewport changes coalesce and serialize native resizing', async () => {
  const applied: string[] = [];
  let release!: () => void, started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const group = new TerminalViewports<string>(async (cols, rows) => { applied.push(`${cols}:${rows}`); if (applied.length === 1) { started(); await gate; } });
  const desktop = group.update('desktop', 120, 40); await beginning;
  const portrait = group.update('phone', 40, 24), landscape = group.update('phone', 70, 18);
  release(); await Promise.all([desktop, portrait, landscape]);
  assert.deepEqual(applied, ['120:40', '70:18']);
});

test('viewport validation cannot introduce an invalid geometry', async () => {
  const applied: string[] = [], group = new TerminalViewports<string>(async (cols, rows) => { applied.push(`${cols}:${rows}`); });
  await assert.rejects(group.update('phone', 10, 24));
  await assert.rejects(group.update('phone', 40, 201));
  await assert.rejects(group.update('phone', 40.5, 24));
  assert.equal(group.owners.size, 0); assert.deepEqual(applied, []);
  await group.update('phone', 40, 24); assert.deepEqual(applied, ['40:24']);
});

test('a failed resize does not poison later explicit viewport changes', async () => {
  let fail = true; const applied: string[] = [];
  const group = new TerminalViewports<string>(async (cols, rows) => { if (fail) throw new Error('Unavailable'); applied.push(`${cols}:${rows}`); });
  await assert.rejects(group.update('phone', 40, 24));
  fail = false; await group.update('phone', 44, 24);
  assert.deepEqual(applied, ['44:24']);
});
