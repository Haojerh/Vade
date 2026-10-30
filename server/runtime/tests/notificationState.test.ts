import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdeStore } from '../store.js';
import { notificationState, updateNotificationState } from '../system/notificationState.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-notification-state-'));
  return { directory, store: new AdeStore(directory), close() { this.store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('notification state persists scoped observations and additive acknowledgements', () => {
  const f = fixture();
  try {
    let state = updateNotificationState(f.store, { scope: 'github:repo::prs', action: 'observe', ids: ['old'] });
    assert.equal(state.initialized, true);
    assert.deepEqual(state.unreadIds, []);
    state = updateNotificationState(f.store, { scope: 'github:repo::prs', action: 'observe', ids: ['new', 'old'] });
    assert.deepEqual(state.unreadIds, ['new']);
    state = updateNotificationState(f.store, { scope: 'github:repo::prs', action: 'acknowledge', ids: ['new'] });
    assert.deepEqual(state.readIds, ['new']);
    assert.deepEqual(notificationState(f.store, 'github:repo::prs').unreadIds, []);
    assert.deepEqual(notificationState(f.store, 'inbox'), { initialized: false, revision: 0, seenIds: [], unreadIds: [], readIds: [], clearedIds: [] });
  } finally { f.close(); }
});

test('notification state imports legacy values once and clear wins over unread', () => {
  const f = fixture();
  try {
    updateNotificationState(f.store, {
      scope: 'inbox', action: 'import',
      legacy: { seenIds: ['one', 'two'], unreadIds: ['one', 'two'], readIds: ['one'], clearedIds: ['two'] },
    });
    const imported = notificationState(f.store, 'inbox');
    assert.deepEqual(imported.seenIds, ['one', 'two']);
    assert.deepEqual(imported.readIds, ['one']);
    assert.deepEqual(imported.clearedIds, ['two']);
    assert.deepEqual(imported.unreadIds, []);
    const cleared = updateNotificationState(f.store, { scope: 'inbox', action: 'clear', ids: ['one'] });
    assert.deepEqual(cleared.clearedIds, ['two', 'one']);
    assert.deepEqual(cleared.unreadIds, []);
  } finally { f.close(); }
});

test('notification state rejects arbitrary scopes, malformed IDs and unknown legacy fields', () => {
  const f = fixture();
  try {
    assert.throws(() => updateNotificationState(f.store, { scope: 'preferences', action: 'observe', ids: [] }), /Invalid notification state/);
    assert.throws(() => updateNotificationState(f.store, { scope: 'github:repo', action: 'observe', ids: ['bad\nid'] }), /Invalid notification state/);
    assert.throws(() => updateNotificationState(f.store, {
      scope: 'github:repo', action: 'import', legacy: { seenIds: ['one'], path: ['escape'] } as any,
    }), /Invalid notification state/);
    assert.throws(() => updateNotificationState(f.store, { scope: 'github:repo', action: 'acknowledge', ids: undefined }), /Invalid notification state/);
  } finally { f.close(); }
});
