import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeGitHubItem,
  observeGitHubItems,
  readUnreadHistory,
  saveUnreadHistory,
} from '../features/github/githubUnread';

test('GitHub notifications baseline existing items and retain unread arrivals until acknowledged', () => {
  const baseline = observeGitHubItems(undefined, ['old']);
  assert.equal(baseline.unread.size, 0);
  const updated = observeGitHubItems(baseline, ['new', 'old']);
  assert.deepEqual([...updated.unread], ['new']);
  assert.deepEqual([...observeGitHubItems(updated, ['new', 'old']).unread], ['new']);
  const acknowledged = { ...updated, unread: new Set<string>() };
  assert.equal(observeGitHubItems(acknowledged, ['new']).unread.size, 0);
  assert.equal(observeGitHubItems(acknowledged, ['old', 'new']).unread.size, 0);
  assert.deepEqual([...observeGitHubItems(acknowledged, ['newer', 'new']).unread], ['newer']);
  assert.equal(observeGitHubItems(undefined, ['different-branch']).unread.size, 0);
});

test('acknowledging a notification clears only that item and subsequent polls keep it read', () => {
  const baseline = observeGitHubItems(undefined, ['old']);
  const arrivals = observeGitHubItems(baseline, ['first', 'second', 'old']);
  const readFirst = acknowledgeGitHubItem(arrivals, 'first');
  assert.deepEqual([...readFirst.unread], ['second']);
  assert.deepEqual([...observeGitHubItems(readFirst, ['first', 'second', 'old']).unread], ['second']);
  assert.equal(arrivals.unread.size, 2);
});

test('notifications survive reloads, preserve reads, and isolate repository scopes', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const baseline = observeGitHubItems(undefined, ['old']);
  saveUnreadHistory('repo:commits:main', observeGitHubItems(baseline, ['first', 'second', 'old']), storage);
  const restored = readUnreadHistory('repo:commits:main', storage)!;
  assert.deepEqual([...restored.unread], ['first', 'second']);
  saveUnreadHistory('repo:commits:main', acknowledgeGitHubItem(restored, 'first'), storage);
  const reloaded = observeGitHubItems(readUnreadHistory('repo:commits:main', storage), ['first', 'second', 'third']);
  assert.deepEqual([...reloaded.unread], ['second', 'third']);
  assert.equal(readUnreadHistory('other-repo:commits:main', storage), undefined);
  assert.equal(readUnreadHistory('repo:commits:branch', storage), undefined);
});

test('invalid or unavailable notification storage falls back safely', () => {
  assert.equal(readUnreadHistory('key', { getItem: () => '{broken' }), undefined);
  assert.equal(
    readUnreadHistory('key', { getItem: () => JSON.stringify({ version: 1, seen: [5], unread: [] }) }),
    undefined
  );
  assert.doesNotThrow(() =>
    saveUnreadHistory(
      'key',
      { seen: new Set(), unread: new Set() },
      {
        setItem: () => {
          throw new Error('Storage unavailable');
        },
      }
    )
  );
});
