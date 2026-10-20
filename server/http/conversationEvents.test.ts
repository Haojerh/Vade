import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleConversationEvents } from './conversationEvents.js';
import type { ReadRouteContext } from './readRoutes.js';

test('conversation SSE advances only forward cursors, serializes reads and stops after disconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const response = new EventEmitter() as EventEmitter & { writeHead: Function; write: Function; writableNeedDrain: boolean };
  const writes: string[] = [];
  response.writeHead = (status: number, headers: Record<string, string>) => { assert.equal(status, 200); assert.equal(headers['Content-Type'], 'text/event-stream'); };
  response.write = (value: string) => writes.push(value);
  response.writableNeedDrain = false;
  const reads: any[] = [];
  const context = { pathname: '/api/projects/project/nodes/node/events', query: { runId: 'run' }, res: response,
    snapshotManager: { async getNodeDetails(project: string, node: string, options: any) {
      assert.equal(project, 'project'); assert.equal(node, 'node'); reads.push(options);
      return { conversation: { data: { messages: reads.length === 1 ? [] : [{ id: 'message', role: 'agent', text: 'Public reply' }], nextCursor: `forward-${reads.length}` }, meta: {} } };
    } },
  } as unknown as ReadRouteContext;
  await handleConversationEvents(context);
  assert.match(writes[0], /event: conversation/);
  assert.equal(reads[0].limit, 20);
  assert.equal(reads[0].direction, undefined);
  t.mock.timers.tick(2000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reads[1].cursor, 'forward-1');
  assert.match(writes[1], /Public reply/);
  response.emit('close');
  t.mock.timers.tick(10000);
  assert.equal(reads.length, 2);
});

test('conversation SSE rejects arbitrary scope and never reads the source', async () => {
  let status = 0;
  const ctx = { pathname: '/api/projects/project/nodes/node/events', query: { direction: 'older' },
    sendError: (code: number) => { status = code; }, snapshotManager: { getNodeDetails() { throw new Error('must not read'); } },
  } as unknown as ReadRouteContext;
  assert.equal(await handleConversationEvents(ctx), true);
  assert.equal(status, 400);
});
