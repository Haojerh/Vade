import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NotificationState, UpdateNotificationStateRequest } from '../../shared/contracts';
import { emptyNotificationState, mergeNotificationState } from '../../shared/notificationState';
import { NotificationClient } from '../features/notifications/notificationClient';

function server(initial: NotificationState = emptyNotificationState()) {
  const states = new Map<string, NotificationState>([['inbox', initial]]);
  return {
    states,
    adapter: {
      async read(scopes: string[]) {
        return { states: Object.fromEntries(scopes.map(scope => [scope, states.get(scope) ?? emptyNotificationState()])) };
      },
      async write(request: UpdateNotificationStateRequest) {
        const next = mergeNotificationState(states.get(request.scope) ?? emptyNotificationState(), request);
        states.set(request.scope, next);
        return next;
      },
    },
  };
}

test('notification client serializes writes and exposes optimistic acknowledgements', async () => {
  const fixture = server();
  const client = new NotificationClient(fixture.adapter);
  const states: Array<NotificationState | null> = [];
  client.subscribe('inbox', () => states.push(client.snapshot('inbox').state));
  await client.refresh();
  await client.update({ scope: 'inbox', action: 'observe', ids: ['one'] });
  await client.update({ scope: 'inbox', action: 'observe', ids: ['two'] });
  const acknowledged = client.update({ scope: 'inbox', action: 'acknowledge', ids: ['two'] });
  assert.ok(client.snapshot('inbox').state?.readIds.includes('two'), 'The click is visible before the request finishes');
  await acknowledged;
  assert.deepEqual(client.snapshot('inbox').state?.unreadIds, []);
  assert.deepEqual(client.snapshot('inbox').state?.readIds, ['two']);
  assert.ok(states.length >= 3);
});

test('notification client retains a failed additive action for explicit retry instead of silently dropping it', async () => {
  const fixture = server();
  let writes = 0;
  const client = new NotificationClient({
    read: fixture.adapter.read,
    async write(request) {
      if (++writes === 1) throw new Error('offline');
      return fixture.adapter.write(request);
    },
  });
  await client.refresh();
  await assert.rejects(client.update({ scope: 'inbox', action: 'acknowledge', ids: ['one'] }));
  assert.ok(client.snapshot('inbox').state?.readIds.includes('one'));
  assert.match(client.snapshot('inbox').error ?? '', /Try again/);
});
