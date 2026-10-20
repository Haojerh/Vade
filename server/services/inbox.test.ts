import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentInboxItems, InboxCollector } from './inbox.js';
import { hashId } from '../integrations/orca/utils.js';
import type { CommandRunner } from '../integrations/cli.js';
import type { Project } from '../../shared/contracts.js';

const project: Project = { id: 'project', name: 'Demo', kind: 'git', sourceProjectId: 'source', repoIds: ['repo'], paths: ['/demo'], hostIds: [] };
const at = '2026-10-19T04:00:00.000Z';
test('inbox uses explicit outcomes, exact projects and real timestamps, never error text or liveness', () => {
  const items = agentInboxItems([project], [{ repoId: 'repo', agents: [
    { paneKey: 'working', state: 'working', lastAssistantMessage: 'Failed tests, error!', updatedAt: at },
    { paneKey: 'idle', state: 'idle', terminalVerdict: 'exited', updatedAt: at },
    { paneKey: 'failed', state: 'failed', stateStartedAt: at, updatedAt: '2026-10-19T05:00:00Z' },
    { paneKey: 'done', state: 'done', updatedAt: at },
    { paneKey: 'missing-time', state: 'failed' },
  ] }, { repoId: 'another', agents: [{ paneKey: 'other-project', state: 'failed', updatedAt: at }] }]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.outcome), ['failed', 'succeeded']);
  assert.equal(items[0].at, at);
  assert.equal(items[0].nodeId, hashId('node', 'failed'));
  assert.equal(items[0].runId, null);
  assert.ok(items.every(item => item.projectId === project.id));
  assert.equal(items[0].id, agentInboxItems([project], [{ repoId: 'repo', agents: [{ paneKey: 'failed', state: 'failed', stateStartedAt: at, updatedAt: '2026-10-19T06:00:00Z' }] }])[0].id);
});

test('inbox deduplicates concurrent collections and reports unavailable reads honestly', async () => {
  let calls = 0;
  const runner: CommandRunner = async () => { calls++; throw new Error('offline'); };
  const inbox = new InboxCollector(runner);
  const [a, b] = await Promise.all([inbox.get(), inbox.get()]);
  assert.equal(a, b);
  assert.equal(a.meta.availability, 'unavailable');
  assert.equal(a.data, null);
  const before = calls;
  assert.equal(await inbox.get(), a);
  assert.equal(calls, before);
});

test('task failure uses structured outcome and its worker workspace, not the coordinator project', async () => {
  const runner: CommandRunner = async (_exe, args) => {
    const command = args.join(' ');
    let result: any = {};
    if (command.startsWith('project list')) result = { projects: [
      { id: 'worker-project', displayName: 'Worker project', kind: 'git', sourceRepoIds: ['repo'] },
      { id: 'coordinator-project', displayName: 'Coordinator', kind: 'git', sourceRepoIds: ['other'] },
    ] };
    if (command.startsWith('worktree ps')) result = { worktrees: [{ worktreeId: 'workspace', repoId: 'repo', path: '/demo', agents: [{ paneKey: 'tab:leaf', state: 'working' }] }] };
    if (command.startsWith('terminal list')) result = { terminals: [{ handle: 'term_worker', tabId: 'tab', leafId: 'leaf' }] };
    if (command.includes('run-list')) result = { runs: [{ id: 'run_fixture', updated_at: at }] };
    if (command.includes('task-list')) result = { tasks: [
      { id: 'task_failed', task_title: 'Regression tests', status: 'completed', completed_at: at, result: JSON.stringify({ outcome: 'failed' }) },
      { id: 'task_unbound', task_title: 'Unknown workspace', status: 'failed', completed_at: at },
    ] };
    if (command.includes('worker-list')) result = { workers: [{ taskId: 'task_failed', agentTerminalHandle: 'term_worker', resource: { worktreeId: 'workspace' } }] };
    return { stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 };
  };
  const result = await new InboxCollector(runner).get();
  assert.equal(result.meta.availability, 'ready');
  assert.equal(result.data?.items.length, 1);
  assert.equal(result.data?.items[0].projectName, 'Worker project');
  assert.equal(result.data?.items[0].outcome, 'failed');
  assert.equal(result.data?.items[0].title, 'Regression tests');
  assert.equal(result.data?.items[0].nodeId, hashId('node', 'tab:leaf'));
  assert.equal(result.data?.items[0].runId, hashId('run', 'run_fixture'));
});
