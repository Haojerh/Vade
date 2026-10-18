import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutCommitGraph } from '../features/github/commitGraphLayout';
import type { CommitGraphEntry } from '../../shared/contracts';

const entry = (sha: string, parents: string[]): CommitGraphEntry => ({ sha, parents, message: sha, author: 'Author', committedAt: '', refs: [] });
test('merge graph splits lanes, converges parents and preserves unrelated branch lanes', () => {
  const rows = layoutCommitGraph([entry('merge', ['a', 'b']), entry('a', ['root']), entry('b', ['root']), entry('root', [])]);
  assert.deepEqual(rows[0].after.map(l => l.sha), ['a', 'b']);
  assert.deepEqual(rows[1].after.map(l => l.sha), ['root', 'b']);
  assert.deepEqual(rows[2].after.map(l => l.sha), ['root']);
  assert.deepEqual(rows[3].after, []);
  assert.equal(rows[0].color, rows[1].color);
  assert.notEqual(rows[1].color, rows[2].color);
  assert.equal(rows[0].connected, false);
  assert.equal(rows[3].connected, true);
});
test('unrelated roots do not fabricate incoming edges', () => {
  const rows = layoutCommitGraph([entry('one', []), entry('two', [])]);
  assert.deepEqual(rows.map(r => r.connected), [false, false]);
});
