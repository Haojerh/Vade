import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Node } from '../../shared/contracts';
import { assignmentProblem, automaticAssignmentProblem, buildCardPrompt, claimQueuedLaunch, createCardId, observeCard, observeCardResults, queuedCards, queuePosition, type KanbanCard } from '../features/kanban/kanban';
import { KanbanBoard } from '../features/kanban/KanbanBoard';
import { KanbanTaskDetails } from '../features/kanban/KanbanTaskDetails';

const node = { id: 'agent', kind: 'agent', label: 'Codex', state: 'idle', stale: false, liveness: 'live' } as Node;
const todo: KanbanCard = { id: 'card', projectId: 'project', title: 'Implement feature', prompt: 'Do the work', files: [], status: 'todo', createdAt: '2026-10-20T00:00:00Z' };
const pending: KanbanCard = { ...todo, status: 'pending', assignment: { nodeId: node.id, label: node.label, runId: null, sentAt: todo.createdAt, sawWorking: false } };

test('automatic queue orders tasks per target and excludes uncertain deliveries and finished work', () => {
  const target = { kind: 'existing', nodeId: node.id, label: node.label } as const;
  const first = { ...todo, id: 'first', target };
  const second = { ...todo, id: 'second', target, createdAt: '2026-10-21T00:00:00Z' };
  const other = { ...todo, id: 'other', target: { ...target, nodeId: 'other' } };
  const rows = [second, { ...first, id: 'uncertain', error: 'Check delivery' }, pending, other, first];
  assert.deepEqual(queuedCards(rows).map(card => card.id), ['first', 'other', 'second']);
  assert.equal(queuePosition(second, rows), 2);
  assert.equal(queuePosition(other, rows), 1);
});

test('new-session launch claims survive restoration and cannot be claimed twice or after unqueue', () => {
  const queued: KanbanCard = { ...todo, target: { kind: 'new', worktreeNodeId: 'tree', worktreeLabel: 'Main', agentId: 'codex', agentLabel: 'Codex', command: 'codex' } };
  const claimed = claimQueuedLaunch(queued, '2026-10-25T00:00:00Z');
  assert.notEqual(claimed, queued);
  const restored: KanbanCard = JSON.parse(JSON.stringify(claimed));
  assert.equal(claimQueuedLaunch(restored, '2026-10-25T00:01:00Z'), restored);
  for (const card of [{ ...queued, target: undefined }, { ...queued, error: 'Launch uncertain' }, { ...queued, status: 'pending' as const }])
    assert.equal(claimQueuedLaunch(card, '2026-10-25T00:01:00Z'), card);
});

test('automatic dispatch requires an empty observed prompt and respects agent and checkout occupancy', () => {
  const ready = { ...node, worktreeId: 'tree', chatReady: true };
  assert.equal(automaticAssignmentProblem(todo, ready, [], [ready]), null);
  assert.ok(automaticAssignmentProblem(todo, { ...ready, chatReady: false }, [], [ready]));
  assert.ok(automaticAssignmentProblem(todo, { ...ready, state: 'working' }, [], [ready]));
  assert.ok(automaticAssignmentProblem(todo, { ...ready, stale: true }, [], [ready]));
  assert.ok(automaticAssignmentProblem(todo, ready, [pending], [ready]));
  const other = { ...ready, id: 'other', state: 'working' as const };
  assert.ok(automaticAssignmentProblem(todo, ready, [], [ready, other]));
  assert.equal(automaticAssignmentProblem(todo, ready, [], [ready, { ...other, worktreeId: 'different' }]), null);
  assert.ok(automaticAssignmentProblem(todo, ready, [{ ...pending, id: 'other-task', assignment: { ...pending.assignment!, nodeId: 'other' } }], [ready, { ...other, state: 'idle' }]));
  assert.equal(automaticAssignmentProblem(todo, { ...ready, state: 'unknown' }, [], [ready]), null);
});

test('preparing a composer draft keeps task status unchanged and distinguishes failed-task fixes', () => {
  assert.equal(buildCardPrompt(todo), 'Please implement this task: Implement feature\n\nDo the work');
  const failed: KanbanCard = { ...pending, status: 'failed' };
  assert.equal(buildCardPrompt(failed), 'Please fix this failed task: Implement feature\n\nDo the work');
  assert.equal(todo.status, 'todo');
  assert.equal(todo.assignment, undefined);
  assert.equal(failed.status, 'failed');
});

test('task IDs work on HTTP origins without crypto.randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => { bytes.fill(42); return bytes; } } });
  try { assert.equal(createCardId(), '2a'.repeat(16)); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else Reflect.deleteProperty(globalThis, 'crypto'); }
});

test('fast task results must be explicit, newer than dispatch and match project and agent', () => {
  const result = { source: 'agent', projectId: 'project', nodeId: 'agent', at: '2026-10-20T00:01:00Z', outcome: 'succeeded' } as const;
  assert.equal(observeCardResults(pending, [result as any]).status, 'completed');
  assert.equal(observeCardResults(pending, [{ ...result, outcome: 'failed' } as any]).status, 'failed');
  for (const item of [{ ...result, source: 'task' }, { ...result, projectId: 'other' }, { ...result, nodeId: 'other' }, { ...result, at: todo.createdAt }]) {
    assert.equal(observeCardResults(pending, [item as any]), pending);
  }
});

test('board ignores old results, missing agents, stale snapshots and text; observes working then terminal outcome', () => {
  assert.equal(observeCard(pending, [{ ...node, state: 'completed' }]), pending);
  assert.equal(observeCard(pending, [{ ...node, state: 'failed' }]), pending);
  assert.equal(observeCard(pending, [{ ...node, state: 'working', stale: true }]), pending);
  assert.equal(observeCard(pending, []), pending);
  const working = observeCard(pending, [{ ...node, state: 'working' }]);
  assert.equal(working.assignment?.sawWorking, true);
  assert.equal(observeCard(working, [{ ...node, state: 'idle', preview: 'Failed test' }]), working);
  assert.equal(observeCard(working, [{ ...node, state: 'completed' }]).status, 'completed');
  assert.equal(observeCard(working, [{ ...node, state: 'failed' }]).status, 'failed');
  assert.equal(observeCard(working, [{ ...node, id: 'other', state: 'failed' }]), working);
});

test('workflow assignments wait for explicit final results rather than an orchestrator turn ending', () => {
  const working = observeCard(pending, [{ ...node, state: 'working' }]);
  const orchestrator: Node = { ...node, state: 'completed', workflow: { runId: 'workflow', role: 'orchestrator' } };
  assert.equal(observeCard(working, [orchestrator]), working);
  assert.ok(assignmentProblem(todo, orchestrator, []));
  const result = { source: 'agent', projectId: 'project', nodeId: 'agent', at: '2026-10-20T00:01:00Z', outcome: 'completed' } as const;
  assert.equal(observeCardResults(working, [result as any]).status, 'completed');
  assert.equal(observeCardResults(working, [{ ...result, outcome: 'interrupted' } as any]).status, 'failed');
});

test('assignment guards reject busy/disconnected agents, duplicate pending work and terminal cards; allow failed retry', () => {
  assert.equal(assignmentProblem(todo, node, [todo]), null);
  assert.equal(assignmentProblem({ ...todo, status: 'failed' }, node, []), null);
  assert.ok(assignmentProblem(todo, { ...node, state: 'working' }, []));
  assert.ok(assignmentProblem(todo, { ...node, liveness: 'exited' }, []));
  assert.ok(assignmentProblem(todo, { ...node, kind: 'worktree' }, []));
  assert.ok(assignmentProblem(todo, node, [pending]));
  assert.ok(assignmentProblem({ ...todo, status: 'completed' }, node, []));
  assert.ok(assignmentProblem(todo, node, [{ ...pending, projectId: 'other' }]));
});

test('board uses drag-only assignment and opens details for every task status', () => {
  const board = { cards: [todo, pending, { ...pending, id: 'done', status: 'completed' }, { ...pending, id: 'failed', status: 'failed' }, { ...todo, id: 'hidden', projectId: 'other', title: 'Hidden task' }], ready: true, error: null,
    add: async () => {}, assign: async () => {}, remove: async () => {}, clear: async () => {}, dismissError: () => {} };
  const html = renderToStaticMarkup(React.createElement(KanbanBoard, { board: board as any, projectId: 'project', onClose: () => {}, onOpenAgent: () => {} }));
  for (const title of ['To-do', 'Pending', 'Completed', 'Failed', 'Add task', 'Delete all']) assert.ok(html.includes(title));
  assert.ok(!html.includes('<select'));
  assert.equal((html.match(/aria-label="View task Implement feature"/g) || []).length, 4);
  assert.ok(!html.includes('Hidden task'));
  assert.equal((html.match(/draggable="true"/g) || []).length, 2);
  assert.equal((html.match(/draggable="false"/g) || []).length, 2);
});

test('task details show full prompt, attachments, status and explicit assigned agent action', () => {
  const file = new File(['mock'], 'notes.txt', { type: 'text/plain' });
  const card = { ...pending, files: [file], prompt: 'Full task **instructions**', error: 'Observed issue' };
  const html = renderToStaticMarkup(React.createElement(KanbanTaskDetails, { card, isOpen: true, isClosing: false, onClose: () => {}, onOpenAgent: () => {} }));
  for (const text of ['Implement feature', 'Pending', 'Full task', '<strong>instructions</strong>', 'notes.txt', 'Codex', 'Created', 'Sent', 'Observed issue', 'Open agent', 'Close task details']) assert.ok(html.includes(text), text);
  const unassigned = renderToStaticMarkup(React.createElement(KanbanTaskDetails, { card: todo, isOpen: true, isClosing: false, onClose: () => {}, onOpenAgent: () => {} }));
  assert.ok(unassigned.includes('Not assigned'));
  assert.ok(!unassigned.includes('Open agent'));
});
