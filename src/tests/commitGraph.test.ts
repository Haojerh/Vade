import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutCommitGraph } from '../features/github/commitGraphLayout';
import type { CommitGraphEntry } from '../../shared/contracts';
import { commitGraphNotificationKey } from '../features/github/useCommitGraph';
import { acknowledgeGitHubItem, observeGitHubItems, readUnreadHistory, saveUnreadHistory } from '../features/github/githubUnread';
import { CommitHistoryGraph } from '../features/github/CommitHistoryGraph';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markCommitRead, readCommitReads } from '../features/github/useCommitReads';

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

test('local commit notifications persist, acknowledge individually and isolate project/repository/branch scopes', () => {
  const key = commitGraphNotificationKey('project', 'node', 'main', 'repo');
  for (const other of [commitGraphNotificationKey('other', 'node', 'main', 'repo'), commitGraphNotificationKey('project', 'other', 'main', 'repo'), commitGraphNotificationKey('project', 'node', 'feature', 'repo'), commitGraphNotificationKey('project', 'node', 'main', 'other')]) assert.notEqual(key, other);
  const baseline = observeGitHubItems(undefined, ['old']);
  assert.equal(baseline.unread.size, 0);
  const arrivals = observeGitHubItems(baseline, ['new-a', 'new-b', 'old']);
  const store = new Map<string, string>();
  const storage = { setItem: (k: string, value: string) => { store.set(k, value); }, getItem: (k: string) => store.get(k) ?? null };
  saveUnreadHistory(key, arrivals, storage);
  const reloaded = readUnreadHistory(key, storage)!;
  assert.deepEqual([...reloaded.unread], ['new-a', 'new-b']);
  assert.deepEqual([...acknowledgeGitHubItem(reloaded, 'new-a').unread], ['new-b']);
});

test('graph marks unread commits without replacing branch lane colors', () => {
  const html = renderToStaticMarkup(createElement(CommitHistoryGraph, { observation: {
    key: 'scope', section: { data: { commits: [entry('new', ['old']), entry('old', [])], truncated: false }, meta: { availability: 'ready', observedAt: null, attemptedAt: '', stale: false, partial: false, issue: null } },
    loading: false, error: '', unread: new Set(['new']), readIds: new Set<string>(), acknowledge: () => {}, retry: () => {},
  } }));
  assert.equal((html.match(/title="New commit"/g) ?? []).length, 1);
  assert.ok(html.includes('github-new-indicator'));
  assert.ok(html.includes('#3899ff'));
  assert.ok(html.includes('commit-history-chevron'));
  assert.ok(!html.includes('›'));
  assert.ok(!html.includes('⌄'));
});

test('explicit commit reads synchronize graph and list histories and survive refresh/reload', () => {
  const key = commitGraphNotificationKey('project', undefined, undefined, 'repo');
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, value: string) => { values.set(k, value); } };
  const graphHistory = observeGitHubItems(observeGitHubItems(undefined, ['old']), ['graph-only', 'shared-a', 'shared-b', 'old']);
  const listHistory = observeGitHubItems(observeGitHubItems(undefined, ['old']), ['shared-a', 'shared-b', 'old']);
  const visible = (history: typeof graphHistory) => [...history.unread].filter(sha => !readCommitReads(key, storage).has(sha));
  markCommitRead(key, 'shared-a', storage); // Clicked in the graph.
  assert.deepEqual(visible(listHistory), ['shared-b']);
  markCommitRead(key, 'shared-b', storage); // Clicked in the list.
  assert.deepEqual(visible(graphHistory), ['graph-only']);
  assert.deepEqual(visible(observeGitHubItems(listHistory, ['shared-a', 'shared-b', 'old'])), []);
  assert.deepEqual([...readCommitReads(key, storage)], ['shared-a', 'shared-b']);
  assert.equal(readCommitReads(commitGraphNotificationKey('other', undefined, undefined, 'repo'), storage).size, 0);
});
