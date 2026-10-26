import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgeGitHubItem,
  observeGitHubItems,
  readUnreadHistory,
} from '../features/github/githubUnread';
import { emptyNotificationState, mergeNotificationState } from '../../shared/notificationState';
import { notificationWasHandled } from '../features/inbox/agentNotifications';

test('shared notifications baseline first observations, preserve arrivals and acknowledge additively', () => {
  let state = mergeNotificationState(emptyNotificationState(), { scope: 'github:repo', action: 'observe', ids: ['old'] });
  assert.deepEqual(state.seenIds, ['old']);
  assert.deepEqual(state.unreadIds, []);
  state = mergeNotificationState(state, { scope: 'github:repo', action: 'observe', ids: ['new', 'old'] });
  assert.deepEqual(state.unreadIds, ['new']);
  state = mergeNotificationState(state, { scope: 'github:repo', action: 'observe', ids: ['newer', 'new'], baseline: true });
  assert.deepEqual(state.unreadIds, ['new'], 'Pagination must add seen items without creating unread arrivals');
  state = mergeNotificationState(state, { scope: 'github:repo', action: 'acknowledge', ids: ['new'] });
  assert.deepEqual(state.readIds, ['new']);
  assert.deepEqual(state.unreadIds, []);
  state = mergeNotificationState(state, { scope: 'github:repo', action: 'observe', ids: ['new', 'newer'] });
  assert.deepEqual(state.unreadIds, [], 'Acknowledged IDs stay read across refreshes');
});

test('shared notification legacy imports are additive, bounded and clear handled items', () => {
  const legacy = Array.from({ length: 5100 }, (_, index) => `id-${index}`);
  let state = mergeNotificationState(emptyNotificationState(), {
    scope: 'inbox', action: 'import',
    legacy: { seenIds: legacy, unreadIds: ['id-5099', 'id-5098'], readIds: ['id-5099'] },
  });
  assert.equal(state.seenIds.length, 5000);
  assert.equal(state.seenIds[0], 'id-100');
  assert.deepEqual(state.unreadIds, ['id-5098']);
  assert.equal(state.initialized, true);
  state = mergeNotificationState(state, { scope: 'inbox', action: 'clear', ids: ['id-5098'] });
  assert.deepEqual(state.clearedIds, ['id-5098']);
  assert.deepEqual(state.unreadIds, []);
  assert.ok(state.readIds.includes('id-5098'));
});

test('notification scopes keep Inbox, GitHub and local commits isolated', () => {
  const observe = (scope: string) => mergeNotificationState(emptyNotificationState(), { scope, action: 'observe', ids: ['old'] });
  const inbox = observe('inbox'), github = observe('github:repo::prs'), commit = observe('commit:repo');
  assert.notEqual(inbox.seenIds, github.seenIds);
  assert.notEqual(github.seenIds, commit.seenIds);
  const arrived = mergeNotificationState(github, { scope: 'github:repo::prs', action: 'observe', ids: ['new', 'old'] });
  assert.deepEqual(arrived.unreadIds, ['new']);
  assert.deepEqual(inbox.unreadIds, []);
  assert.deepEqual(commit.unreadIds, []);
});

test('a first shared load preserves legacy unread items without turning the initial baseline into arrivals', () => {
  const legacy = observeGitHubItems(undefined, ['old']);
  const current = observeGitHubItems(legacy, ['old', 'arrived-while-offline']);
  let state = mergeNotificationState(emptyNotificationState(), {
    scope: 'github:repo', action: 'import',
    legacy: { seenIds: [...current.seen], unreadIds: [...current.unread] },
  });
  assert.deepEqual(state.unreadIds, ['arrived-while-offline']);
  state = mergeNotificationState(state, { scope: 'github:repo', action: 'observe', ids: ['old', 'arrived-while-offline'] });
  assert.deepEqual(state.unreadIds, ['arrived-while-offline']);
  state = mergeNotificationState(state, { scope: 'github:repo', action: 'observe', ids: ['next', 'old'], baseline: true });
  assert.deepEqual(state.unreadIds, ['arrived-while-offline']);
});

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

test('legacy GitHub reads preserve history and isolate repository scopes', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
  };
  const baseline = observeGitHubItems(undefined, ['old']);
  values.set('orca-visualization:github-notifications:v1:repo:commits:main', JSON.stringify({
    version: 1, seen: [...baseline.seen, 'first', 'second'], unread: ['first', 'second'],
  }));
  const restored = readUnreadHistory('repo:commits:main', storage)!;
  assert.deepEqual([...restored.unread], ['first', 'second']);
  assert.deepEqual([...acknowledgeGitHubItem(restored, 'first').unread], ['second']);
  assert.equal(readUnreadHistory('other-repo:commits:main', storage), undefined);
  assert.equal(readUnreadHistory('repo:commits:branch', storage), undefined);
});

test('invalid or unavailable notification storage falls back safely', () => {
  assert.equal(readUnreadHistory('key', { getItem: () => '{broken' }), undefined);
  assert.equal(
    readUnreadHistory('key', { getItem: () => JSON.stringify({ version: 1, seen: [5], unread: [] }) }),
    undefined
  );
  assert.equal(readUnreadHistory('key', { getItem: () => null }), undefined);
});

test('agent delivery suppresses items already handled in shared Inbox state', () => {
  assert.equal(notificationWasHandled(null, 'item'), false);
  assert.equal(notificationWasHandled(emptyNotificationState(), 'item'), false);
  assert.equal(notificationWasHandled({ ...emptyNotificationState(), readIds: ['item'] }, 'item'), true);
  assert.equal(notificationWasHandled({ ...emptyNotificationState(), clearedIds: ['item'] }, 'item'), true);
  assert.equal(notificationWasHandled({ ...emptyNotificationState(), readIds: ['other'] }, 'item'), false);
});
