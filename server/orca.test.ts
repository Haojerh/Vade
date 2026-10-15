import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapToState,
  normalizeLiveness,
  stripAnsi,
  toIsoOrNull,
  collectInventory,
  collectGraph,
  collectNodeDetails,
  hashId,
  globalSourceMaps,
  cursorStore,
  resolveCoordinatorConversation,
  resolveAntigravityConversation,
  readBoundedTranscriptLines,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
  workerLaunchCache,
  isAntigravityChatRecord,
} from './orca.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CommandRunner, CliError } from './cli.js';

describe('server/orca', () => {
  test('Antigravity recent window counts public chat turns before limiting and skips tool/thinking records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-chat-window-'));
    const file = path.join(dir, 'transcript.jsonl');
    try {
      const records: string[] = [];
      for (let step = 0; step < 30; step++) {
        records.push(JSON.stringify({ type: step % 2 ? 'PLANNER_RESPONSE' : 'USER_INPUT', content: `Public turn ${step}` }));
        for (let tool = 0; tool < 250; tool++) {
          records.push(JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'Internal reasoning', tool_calls: [{}] }));
        }
      }
      fs.writeFileSync(file, records.join('\n') + '\n');
      const recent = await readBoundedTranscriptLines(file, null, 20, 1024 * 1024, false, isAntigravityChatRecord);
      assert.equal(recent.lines.length, 20);
      assert.equal(JSON.parse(recent.lines[0]).content, 'Public turn 10');
      assert.equal(JSON.parse(recent.lines[19]).content, 'Public turn 29');
      assert.ok(recent.lines.every((line) => !JSON.parse(line).thinking));

      fs.appendFileSync(file, JSON.stringify({ type: 'GENERIC', content: 'Tool output' }) + '\n' +
        JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'New public reply' }) + '\n');
      const newer = await readBoundedTranscriptLines(file, recent.nextByteOffset, 20, 1024 * 1024, false, isAntigravityChatRecord);
      assert.equal(newer.lines.length, 1);
      assert.equal(JSON.parse(newer.lines[0]).content, 'New public reply');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mapToState maps known states and preserves unknowns', () => {
    assert.equal(mapToState('working'), 'working');
    assert.equal(mapToState('running'), 'working');
    assert.equal(mapToState('waiting'), 'waiting');
    assert.equal(mapToState('awaiting input'), 'waiting');
    assert.equal(mapToState('blocked'), 'blocked');
    assert.equal(mapToState('completed'), 'completed');
    assert.equal(mapToState('done'), 'completed');
    assert.equal(mapToState('succeeded'), 'completed');
    assert.equal(mapToState('failed'), 'failed');
    assert.equal(mapToState('error'), 'failed');
    assert.equal(mapToState('idle'), 'idle');
    assert.equal(mapToState('custom_unexpected_status'), 'unknown');
    assert.equal(mapToState(null), 'unknown');
    assert.equal(mapToState(undefined), 'unknown');
  });

  test('stripAnsi removes escape codes and control chars', () => {
    const raw = '\x1B[32mSuccess\x1B[0m\x1B[1m Bold\x1B[0m';
    assert.equal(stripAnsi(raw), 'Success Bold');
  });

  test('toIsoOrNull enforces strict timestamp parsing and rejects ambiguous SQL timestamps', () => {
    // Valid ISO timestamps with explicit timezone
    assert.equal(toIsoOrNull('2026-10-15T09:38:45Z'), '2026-10-15T09:38:45.000Z');
    assert.equal(toIsoOrNull('2026-10-15 09:38:45+00:00'), '2026-10-15T09:38:45.000Z');
    assert.equal(toIsoOrNull('2026-10-15T09:38:45.123Z'), '2026-10-15T09:38:45.123Z');

    // Ambiguous SQL timestamps lacking timezone must return null
    assert.equal(toIsoOrNull('2026-10-15 09:38:45'), null);
    assert.equal(toIsoOrNull('2026-10-15'), null);
    assert.equal(toIsoOrNull('not-a-date'), null);

    // Number timestamp handling
    assert.equal(toIsoOrNull(1792056970487), new Date(1792056970487).toISOString());
    assert.equal(toIsoOrNull(NaN), null);
    assert.equal(toIsoOrNull(Infinity), null);
    assert.equal(toIsoOrNull(-100), null);
    assert.equal(toIsoOrNull(1e25), null);
    assert.equal(toIsoOrNull(null), null);
    assert.equal(toIsoOrNull(undefined), null);
  });

  test('collectInventory normalizes git and folder projects and captures version', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('project list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              projects: [
                {
                  id: 'github:haojerh/orca-visualization',
                  displayName: 'orca-visualization',
                  kind: 'git',
                  sourceRepoIds: ['repo-1'],
                },
              ],
            },
            _meta: { runtimeId: 'rt-1' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('project setups')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: [
              {
                projectId: 'github:haojerh/orca-visualization',
                repoId: 'repo-1',
                path: 'C:\\Users\\inter\\orca\\orca-visualization',
                hostId: 'local',
              },
              {
                projectId: 'folder:local-folder-project',
                repoId: 'repo-2',
                path: 'C:\\Users\\inter\\local-folder',
                hostId: 'local',
                displayName: 'Local Folder Project',
                kind: 'folder',
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('repo list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              repos: [
                { id: 'repo-1', path: 'C:/Users/inter/orca/orca-visualization', kind: 'git' },
                { id: 'repo-2', path: 'C:/Users/inter/local-folder', kind: 'folder' },
                { id: 'repo-3', path: 'C:/Users/inter/unregistered-repo', kind: 'git', displayName: 'Unregistered' },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('status --json')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              runtime: { appVersion: '1.4.224', runtimeId: 'rt-1' },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const { inventory, meta, runtimeId, appVersion } = await collectInventory(fakeRunner);
    assert.equal(meta.availability, 'ready');
    assert.equal(runtimeId, 'rt-1');
    assert.equal(appVersion, '1.4.224');
    assert.equal(inventory.projects.length, 3);

    const gitProj = inventory.projects.find((p) => p.name === 'orca-visualization');
    assert.ok(gitProj);
    assert.equal(gitProj.kind, 'git');
    assert.ok(gitProj.paths.length > 0);

    const folderProj = inventory.projects.find((p) => p.name === 'Local Folder Project');
    assert.ok(folderProj);
    assert.equal(folderProj.kind, 'folder');

    const unregProj = inventory.projects.find((p) => p.name === 'Unregistered');
    assert.ok(unregProj);
  });

  test('R1: collectInventory returns unavailable when all inventory sources fail', async () => {
    const failingRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('project list') || cmd.includes('project setups') || cmd.includes('repo list')) {
        throw new CliError('CLI_FAILED', 'Connection refused');
      }
      if (cmd.includes('status')) {
        return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const res = await collectInventory(failingRunner);
    assert.equal(res.meta.availability, 'unavailable');
    assert.equal(res.meta.observedAt, null);
    assert.equal(res.meta.partial, true);
    assert.equal(res.inventory.projects.length, 0);
    assert.equal(res.meta.issue?.code, 'RUNTIME_UNAVAILABLE');
  });

  test('collectGraph joins agents, terminals, runs, tasks, and preserves worker evidence', async () => {
    // Setup project in globalSourceMaps
    const projApiId = hashId('proj', 'test-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'test-proj',
      repoIds: ['repo-1'],
      paths: ['C:\\test-proj'],
    });

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');

      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-main',
                  repoId: 'repo-1',
                  path: 'C:\\test-proj',
                  branch: 'main',
                  workspaceStatus: 'in-progress',
                  status: 'active',
                  terminalVerdict: 'live',
                  agents: [
                    {
                      paneKey: 'tab-1:leaf-1',
                      parentPaneKey: null,
                      state: 'working',
                      agentType: 'codex',
                      taskTitle: 'Coordinator Agent',
                    },
                    {
                      paneKey: 'tab-2:leaf-2',
                      parentPaneKey: 'tab-1:leaf-1',
                      state: 'working',
                      agentType: 'antigravity',
                      taskTitle: 'Backend Worker',
                    },
                  ],
                },
              ],
            },
            _meta: { runtimeId: 'rt-1' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [
                {
                  handle: 'term_coord',
                  tabId: 'tab-1',
                  leafId: 'leaf-1',
                  connected: true,
                  agentIdentity: 'codex',
                  preview: 'Coordinator preview',
                },
                {
                  handle: 'term_worker',
                  tabId: 'tab-2',
                  leafId: 'leaf-2',
                  connected: true,
                  agentIdentity: 'antigravity',
                  preview: 'Worker preview',
                },
                {
                  handle: 'term_shell',
                  tabId: 'tab-3',
                  leafId: 'leaf-3',
                  connected: true,
                  agentIdentity: null,
                  title: 'C:\\Windows\\system32\\cmd.exe',
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              runs: [
                {
                  id: 'run_1',
                  objective: 'Associated run',
                  coordinator_handle: 'term_coord',
                },
                {
                  id: 'run_foreign',
                  objective: 'Foreign run',
                  coordinator_handle: 'term_other',
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (cmd.includes('worker-list --run run_foreign')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              workers: [{ resource: { worktreeId: 'wt-other' } }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (cmd.includes('worker-list --run run_1')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              workers: [
                {
                  dispatchId: 'ctx_worker',
                  taskId: 'task_1',
                  agentTerminalHandle: 'term_worker',
                  workerState: 'succeeded',
                  projection: {
                    stage: { activity: 'working' },
                    outcome: 'succeeded',
                    liveness: { verdict: 'live', observedAt: 1792057752992 },
                    tool: { name: 'code_search', input: 'test' },
                  },
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      if (cmd.includes('orchestration task-list --run run_1')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              tasks: [
                {
                  id: 'task_1',
                  task_title: 'Implement backend',
                  status: 'completed',
                  assignee_handle: 'term_worker',
                  deps: '["task_0"]',
                  result: 'Success',
                },
                {
                  id: 'task_2',
                  task_title: 'Review',
                  status: 'working',
                  assignee_handle: 'term_coord',
                  deps: 'malformed json deps',
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }

      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const { graph, meta } = await collectGraph(projApiId, null, fakeRunner);
    assert.equal(meta.availability, 'ready');

    // Only associated run_1 is included, run_foreign is excluded
    assert.equal(graph.runs.length, 1);
    assert.equal(graph.runs[0].sourceRunId, 'run_1');
    assert.equal(graph.runs[0].association, 'coordinator-terminal');

    // Nodes: worktree, coordinator (orchestrator), worker (agent), shell (terminal)
    assert.equal(graph.nodes.length, 4);

    const coordNode = graph.nodes.find((n) => n.kind === 'orchestrator');
    assert.ok(coordNode);
    assert.equal(coordNode.state, 'working');

    const workerNode = graph.nodes.find((n) => n.label === 'Backend Worker');
    assert.ok(workerNode);
    assert.equal(workerNode.kind, 'agent');
    // R4: worker projection outcome and run-dispatch delegation evidence preserved
    assert.equal(workerNode.taskOutcome, 'succeeded');
    assert.ok(
      graph.edges.some(
        (e) =>
          e.kind === 'delegates' &&
          e.evidence === 'run-dispatch' &&
          e.source === coordNode.id &&
          e.target === workerNode.id
      )
    );

    const shellNode = graph.nodes.find((n) => n.kind === 'terminal');
    assert.ok(shellNode);

    // Edges: contains (wt -> coord, wt -> worker, wt -> shell), delegates (coord -> worker)
    assert.ok(graph.edges.some((e) => e.kind === 'contains' && e.target === coordNode.id));

    // Tasks: 2 tasks, 1 completed, 1 working
    assert.equal(graph.tasks.length, 2);
    assert.equal(graph.progress.total, 2);
    assert.equal(graph.progress.completed, 1);
    assert.equal(graph.progress.working, 1);
    assert.equal(graph.progress.percent, 50);

    // R4: requesting an unknown run ID must reject with RUN_NOT_FOUND
    await assert.rejects(
      () => collectGraph(projApiId, 'run_unknown_id', fakeRunner),
      (err: any) => err instanceof CliError && err.issue.code === 'RUN_NOT_FOUND'
    );
  });

  test('two-pass graph construction connects out-of-order parent worktrees and parent panes', async () => {
    const projApiId = hashId('proj', 'out-of-order-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'out-of-order-proj',
      repoIds: ['repo-ooo'],
      paths: ['C:\\ooo'],
    });

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        // Child worktree appears BEFORE parent worktree
        // Child agent appears BEFORE parent agent
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-child',
                  parentWorktreeId: 'wt-parent',
                  repoId: 'repo-ooo',
                  path: 'C:\\ooo\\child',
                  agents: [
                    {
                      paneKey: 'pane-child',
                      parentPaneKey: 'pane-parent',
                      state: 'working',
                      agentType: 'antigravity',
                      taskTitle: 'Child Agent',
                    },
                  ],
                },
                {
                  worktreeId: 'wt-parent',
                  parentWorktreeId: null,
                  repoId: 'repo-ooo',
                  path: 'C:\\ooo\\parent',
                  agents: [
                    {
                      paneKey: 'pane-parent',
                      parentPaneKey: null,
                      state: 'working',
                      agentType: 'codex',
                      taskTitle: 'Parent Agent',
                    },
                  ],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('run-list')) {
        return { stdout: JSON.stringify({ ok: true, result: { runs: [] } }), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const { graph } = await collectGraph(projApiId, null, fakeRunner);

    // Parent-worktree lineage edge must be present even though child appeared first in discovery
    const lineageEdge = graph.edges.find((e) => e.evidence === 'parent-worktree');
    assert.ok(lineageEdge, 'Lineage edge between out-of-order parent-child worktrees must exist');
    assert.equal(lineageEdge.kind, 'lineage');

    // Parent-pane delegates edge must be present even though child pane appeared first in discovery
    const parentPaneEdge = graph.edges.find((e) => e.evidence === 'parent-pane');
    assert.ok(parentPaneEdge, 'Delegates edge between out-of-order parent-child panes must exist');
    assert.equal(parentPaneEdge.kind, 'delegates');
  });

  test('R3: Run association discovery is cached and bounded', async () => {
    const projApiId = hashId('proj', 'cache-test-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'cache-test-proj',
      repoIds: ['repo-cache'],
      paths: ['C:\\cache-test'],
    });

    let workerListCalls = 0;
    const runner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-cache',
                  repoId: 'repo-cache',
                  path: 'C:\\cache-test',
                  agents: [],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              runs: [
                { id: 'run_unassoc_1', objective: 'Run 1' },
                { id: 'run_unassoc_2', objective: 'Run 2' },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        workerListCalls++;
        return {
          stdout: JSON.stringify({ ok: true, result: { workers: [] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    // First call: inspects workers and caches associations
    await collectGraph(projApiId, null, runner);
    const callsAfterFirst = workerListCalls;
    assert.ok(callsAfterFirst <= 5);

    // Second call: uses cached associations, worker-list calls should NOT increase
    await collectGraph(projApiId, null, runner);
    assert.equal(workerListCalls, callsAfterFirst);
  });

  test('collectNodeDetails collects truthful transcript conversation and handles bound cursors', async () => {
    const projApiId = hashId('proj', 'test-proj');
    const workerNodeId = hashId('node', 'tab-2:leaf-2');

    let receivedWorkerReadArgs: string[] = [];
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-main',
                  repoId: 'repo-1',
                  path: 'C:\\test-proj',
                  agents: [
                    {
                      paneKey: 'tab-2:leaf-2',
                      state: 'working',
                      agentType: 'antigravity',
                    },
                  ],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [
                {
                  handle: 'term_worker',
                  tabId: 'tab-2',
                  leafId: 'leaf-2',
                  connected: true,
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              runs: [
                {
                  id: 'run_1',
                  objective: 'Run 1',
                  coordinator_handle: 'term_worker',
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list --run run_1')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              workers: [
                {
                  dispatchId: 'ctx_worker_1',
                  agentTerminalHandle: 'term_worker',
                  projection: {
                    tool: { name: 'run_command', input: 'npm test' },
                  },
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-read')) {
        receivedWorkerReadArgs = args;
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              dispatchId: 'ctx_worker_1',
              source: 'transcript',
              sourceExact: true,
              contentComplete: true,
              sourceIdentity: 'transcript-sha-abc',
              provider: 'antigravity',
              transcript: {
                messages: [
                  {
                    id: 'm1',
                    role: 'assistant',
                    blocks: [
                      { type: 'text', text: 'I am starting the task.' },
                      { type: 'tool-call', name: 'search' },
                    ],
                    timestamp: 1792056970487,
                  },
                  {
                    id: 'm2',
                    role: 'tool',
                    blocks: [{ type: 'tool-result', content: 'results' }],
                  },
                  {
                    id: 'm3',
                    role: 'user',
                    blocks: [{ type: 'text', text: 'Great, please proceed.' }],
                    timestamp: 1792056980000,
                  },
                ],
                nextCursor: 'upstream_next_cur_123',
                limited: false,
                returnedMessageCount: 3,
              },
              warnings: [],
              clipping: [],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const details = await collectNodeDetails(projApiId, workerNodeId, { limit: 50 }, fakeRunner);
    assert.equal(details.node.id, workerNodeId);
    assert.equal(details.currentTool?.name, 'run_command');
    assert.equal(details.conversation.meta.availability, 'ready');

    // Messages normalized: assistant mapped to agent, tool message omitted
    const msgs = details.conversation.data?.messages;
    assert.ok(msgs);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'agent');
    assert.equal(msgs[0].text, 'I am starting the task.');
    assert.equal(msgs[1].role, 'user');
    assert.equal(msgs[1].text, 'Great, please proceed.');

    // Partial is true because tool-call and tool role blocks were omitted
    assert.equal(details.conversation.meta.partial, true);

    // Opaque public cursor issued
    const publicCursor = details.conversation.data?.nextCursor;
    assert.ok(publicCursor?.startsWith('cur_'));

    // Second call with public cursor translates to upstream cursor
    await collectNodeDetails(projApiId, workerNodeId, { cursor: publicCursor }, fakeRunner);
    assert.ok(receivedWorkerReadArgs.includes('--cursor'));
    assert.ok(receivedWorkerReadArgs.includes('upstream_next_cur_123'));

    // Cross-bound / invalid cursor is rejected with 400 INVALID_ARGUMENT
    await assert.rejects(
      () => collectNodeDetails(projApiId, workerNodeId, { cursor: 'fake_cursor' }, fakeRunner),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT'
    );
  });

  test('collectNodeDetails rejects non-exact source as CONVERSATION_UNSUPPORTED', async () => {
    const projApiId = hashId('proj', 'non-exact-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'non-exact-proj',
      repoIds: ['repo-x'],
      paths: ['C:\\test-x'],
    });
    const workerNodeId = hashId('node', 'leaf-x');

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-x',
                  repoId: 'repo-x',
                  path: 'C:\\test-x',
                  agents: [{ paneKey: 'leaf-x', state: 'working' }],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [{ handle: 'term_x', tabId: 'tab-x', leafId: 'leaf-x', connected: true }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { runs: [{ id: 'run_x', coordinator_handle: 'term_x' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              workers: [{ dispatchId: 'ctx_x', agentTerminalHandle: 'term_x' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-read')) {
        // Upstream returned sourceExact: false fallback
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              dispatchId: 'ctx_x',
              source: 'transcript',
              sourceExact: false,
              transcript: { messages: [] },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const details = await collectNodeDetails(projApiId, workerNodeId, undefined, fakeRunner);
    assert.equal(details.conversation.meta.availability, 'unsupported');
    assert.equal(details.conversation.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
    assert.equal(details.conversation.data, null);
  });

  test('normalizeLiveness preserves unverifiable and unknown verdicts (B5)', () => {
    assert.equal(normalizeLiveness('live'), 'live');
    assert.equal(normalizeLiveness('running'), 'live');
    assert.equal(normalizeLiveness('exited'), 'exited');
    assert.equal(normalizeLiveness('dead'), 'exited');
    assert.equal(normalizeLiveness('unverifiable'), 'unverifiable');
    assert.equal(normalizeLiveness('UNVERIFIABLE'), 'unverifiable');
    assert.equal(normalizeLiveness('unknown'), 'unknown');
    assert.equal(normalizeLiveness('UNKNOWN'), 'unknown');
    assert.equal(normalizeLiveness('something-else'), 'unknown');
    assert.equal(normalizeLiveness(null), 'unknown');
  });

  test('enforces exact cursor ownership even without a current binding (B3)', async () => {
    const projId = hashId('proj', 'proj-cursor-nobind');
    const unboundNodeId = hashId('node', 'unbound-node');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-cursor-nobind',
      repoIds: ['repo-nobind'],
      paths: ['C:\\nobind'],
    });

    // Node without a binding in graph
    const mockGraph: any = {
      runs: [],
      selectedRunId: null,
      nodes: [
        {
          id: unboundNodeId,
          kind: 'agent',
          label: 'Unbound Agent',
          worktreeId: 'wt-nobind',
          runId: null,
          agentType: null,
          branch: null,
          path: 'C:\\nobind',
          state: 'idle',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: false,
        },
      ],
      edges: [],
      tasks: [],
      progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
      activity: [],
    };

    // Passing an unknown or cross-bound cursor token must throw INVALID_ARGUMENT upfront
    await assert.rejects(
      () => collectNodeDetails(projId, unboundNodeId, { cursor: 'cur_nonexistent', preloadedGraph: mockGraph }),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT'
    );
  });

  test('invalidates stale dispatch bindings for active run on discovery (B3)', async () => {
    const projId = hashId('proj', 'proj-inval-bind');
    const runApiId = hashId('run', 'run-inval');
    const staleNodeId = hashId('node', 'stale-node');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-inval-bind',
      repoIds: ['repo-inval'],
      paths: ['C:\\inval'],
    });

    // Populate a stale dispatch binding for this run and project
    const staleKey = `${projId}::${runApiId}::${staleNodeId}`;
    globalSourceMaps.dispatchMap.set(staleKey, { dispatchId: 'ctx_stale' });
    assert.ok(globalSourceMaps.dispatchMap.has(staleKey));

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-inval',
                  displayName: 'Worktree',
                  repoId: 'repo-inval',
                  path: 'C:\\inval',
                  agents: [],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { terminals: [{ handle: 'term_coord', tabId: 'tab-coord', leafId: 'leaf-coord', connected: true }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { runs: [{ id: 'run-inval', coordinator_handle: 'term_coord' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        // Discovered workers do NOT include stale-node
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { workers: [] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    await collectGraph(projId, runApiId, fakeRunner);
    // The stale dispatch binding must have been invalidated
    assert.equal(globalSourceMaps.dispatchMap.has(staleKey), false);
  });

  test('validates transcript payload schema and message identities without fabricating (B4)', async () => {
    const projId = hashId('proj', 'proj-b4');
    const workerNodeId = hashId('node', 'worker-b4');
    const runApiId = hashId('run', 'run-b4');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-b4',
      repoIds: ['repo-b4'],
      paths: ['C:\\test-b4'],
    });

    const bindingKey = `${projId}::${runApiId}::${workerNodeId}`;
    globalSourceMaps.dispatchMap.set(bindingKey, { dispatchId: 'ctx_b4' });

    const mockGraph: any = {
      runs: [],
      selectedRunId: runApiId,
      nodes: [
        {
          id: workerNodeId,
          kind: 'agent',
          label: 'Worker B4',
          worktreeId: 'wt-b4',
          runId: runApiId,
          agentType: null,
          branch: null,
          path: 'C:\\test-b4',
          state: 'working',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
      activity: [],
    };

    // Case 1: Missing sourceIdentity
    const runnerNoSourceId: CommandRunner = async () => ({
      stdout: JSON.stringify({
        ok: true,
        result: {
          dispatchId: 'ctx_b4',
          source: 'transcript',
          sourceExact: true,
          // sourceIdentity missing!
          transcript: { messages: [] },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const res1 = await collectNodeDetails(projId, workerNodeId, { runId: runApiId, preloadedGraph: mockGraph }, runnerNoSourceId);
    assert.equal(res1.conversation.meta.availability, 'unavailable');
    assert.equal(res1.conversation.meta.issue?.code, 'INVALID_UPSTREAM');

    // Case 2: Message missing id
    const runnerMalformedMsg: CommandRunner = async () => ({
      stdout: JSON.stringify({
        ok: true,
        result: {
          dispatchId: 'ctx_b4',
          sourceIdentity: 'src_b4_actual',
          source: 'transcript',
          sourceExact: true,
          transcript: {
            messages: [
              { role: 'assistant', blocks: [{ type: 'text', text: 'Hello' }] }, // id missing!
            ],
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    });

    const res2 = await collectNodeDetails(projId, workerNodeId, { runId: runApiId, preloadedGraph: mockGraph }, runnerMalformedMsg);
    assert.equal(res2.conversation.meta.availability, 'unavailable');
    assert.equal(res2.conversation.meta.issue?.code, 'INVALID_UPSTREAM');
  });

  test('cursor validation enforces exact null-aware runId matching and rejects cross-run cursors', async () => {
    const projId = hashId('proj', 'proj-cross-run');
    const nodeId = hashId('node', 'worker-cross-run');
    const runA = hashId('run', 'run-A');
    const runB = hashId('run', 'run-B');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-cross-run',
      repoIds: ['repo-cross'],
      paths: ['C:\\test-cross'],
    });

    const bindingKeyA = `${projId}::${runA}::${nodeId}`;
    globalSourceMaps.dispatchMap.set(bindingKeyA, { dispatchId: 'ctx_cross_a' });

    const mockGraphA: any = {
      runs: [],
      selectedRunId: runA,
      nodes: [
        {
          id: nodeId,
          kind: 'agent',
          label: 'Worker Cross Run',
          worktreeId: 'wt-cross',
          runId: runA,
          agentType: null,
          branch: null,
          path: 'C:\\test-cross',
          state: 'working',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
      activity: [],
    };

    // Store a cursor bound to runA
    const cursorTokenA = 'cur_bound_to_run_a';
    cursorStore.set(cursorTokenA, {
      upstreamCursor: 'up_cur_a',
      projectId: projId,
      nodeId: nodeId,
      runId: runA,
      dispatchId: 'ctx_cross_a',
      sourceIdentity: 'src_cross',
      sourceMode: 'worker-read-transcript',
      expiresAt: Date.now() + 600000,
    });

    // 1. Cross-run request: requesting under runB must throw INVALID_ARGUMENT
    await assert.rejects(
      () => collectNodeDetails(projId, nodeId, { runId: runB, cursor: cursorTokenA, preloadedGraph: mockGraphA }),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT'
    );

    // 2. Null-run bypass attempt: requesting under null/undefined run must throw INVALID_ARGUMENT
    const mockGraphNoRun: any = { ...mockGraphA, selectedRunId: null };
    await assert.rejects(
      () => collectNodeDetails(projId, nodeId, { runId: null, cursor: cursorTokenA, preloadedGraph: mockGraphNoRun }),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT'
    );

    // Store a cursor bound to null run
    const cursorTokenNull = 'cur_bound_to_null_run';
    cursorStore.set(cursorTokenNull, {
      upstreamCursor: 'up_cur_null',
      projectId: projId,
      nodeId: nodeId,
      runId: null,
      dispatchId: 'ctx_cross_a',
      sourceIdentity: 'src_cross',
      sourceMode: 'worker-read-transcript',
      expiresAt: Date.now() + 600000,
    });

    // 3. Requesting null-bound cursor under runA must throw INVALID_ARGUMENT
    await assert.rejects(
      () => collectNodeDetails(projId, nodeId, { runId: runA, cursor: cursorTokenNull, preloadedGraph: mockGraphA }),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT'
    );
  });

  test('disambiguates reused worker dispatches using proven materialization and endpointIncarnation', async () => {
    const projId = hashId('proj', 'proj-reused');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-reused',
      repoIds: ['repo-reused'],
      paths: ['C:\\reused'],
    });

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-reused',
                  repoId: 'repo-reused',
                  path: 'C:\\reused',
                  agents: [{ paneKey: 'tab-r:leaf-r', state: 'working' }],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [
                {
                  handle: 'term_reused',
                  tabId: 'tab-r',
                  leafId: 'leaf-r',
                  ptyId: 'pty-1',
                  incarnationId: 'inc-1',
                  connected: true,
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              runs: [{ id: 'run_reused', coordinator_handle: 'term_reused' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              workers: [
                {
                  dispatchId: 'ctx_failed_readiness',
                  agentTerminalHandle: 'term_reused',
                  workerState: 'failed',
                  resource: null,
                  projection: { stage: { detail: 'agent_readiness' } },
                },
                {
                  dispatchId: 'ctx_materialized_owner',
                  agentTerminalHandle: 'term_reused',
                  workerState: 'succeeded',
                  resource: {
                    endpointIncarnation: 'pty-1:inc-1',
                    ownerDispatchId: 'ctx_materialized_owner',
                  },
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const res = await collectGraph(projId, null, fakeRunner);
    const agentNode = res.graph.nodes.find((n) => n.kind === 'orchestrator' || n.kind === 'agent');
    assert.ok(agentNode);

    const activeRunId = res.graph.selectedRunId;
    const bindingKey = `${projId}::${activeRunId}::${agentNode.id}`;
    const binding = globalSourceMaps.dispatchMap.get(bindingKey);

    assert.ok(binding, 'Binding should exist');
    assert.equal(binding.ambiguous, false, 'Binding must not be marked ambiguous');
    assert.equal(binding.dispatchId, 'ctx_materialized_owner', 'Binding must resolve to proven materialized owner dispatch');
  });

  test('pages worker-list with --cursor when worker list exceeds single page limit', async () => {
    const projId = hashId('proj', 'proj-paged');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-paged',
      repoIds: ['repo-paged'],
      paths: ['C:\\paged'],
    });

    const receivedWorkerListArgs: string[][] = [];

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-paged',
                  repoId: 'repo-paged',
                  path: 'C:\\paged',
                  agents: [
                    { paneKey: 'tab-p1:leaf-p1', state: 'working' },
                    { paneKey: 'tab-p2:leaf-p2', state: 'working' },
                  ],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [
                { handle: 'term_p1', tabId: 'tab-p1', leafId: 'leaf-p1', connected: true },
                { handle: 'term_p2', tabId: 'tab-p2', leafId: 'leaf-p2', connected: true },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              runs: [{ id: 'run_paged', coordinator_handle: 'term_p1' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        receivedWorkerListArgs.push(args);
        if (!args.includes('--cursor')) {
          // Page 1 returns worker 1 and nextCursor
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                workers: [{ dispatchId: 'ctx_p1', agentTerminalHandle: 'term_p1' }],
                page: { nextCursor: 'cur_page_2', hasMore: true },
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        } else {
          // Page 2 returns worker 2 and no nextCursor
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                workers: [{ dispatchId: 'ctx_p2', agentTerminalHandle: 'term_p2' }],
                page: { nextCursor: null, hasMore: false },
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    await collectGraph(projId, null, fakeRunner);
    assert.equal(receivedWorkerListArgs.length, 2, 'worker-list should be queried twice via cursor');
    assert.ok(receivedWorkerListArgs[1].includes('--cursor'));
    assert.ok(receivedWorkerListArgs[1].includes('cur_page_2'));
  });

  test('collectNodeDetails resolves coordinator conversation using exact proven transcript adapter and supports pagination', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-coord-test-'));
    const orcaDir = path.join(tempDir, 'orca');
    const hooksDir = path.join(orcaDir, 'agent-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const orchDbPath = path.join(orcaDir, 'orchestration.db');
    const db = new DatabaseSync(orchDbPath);
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        coordinator_handle TEXT,
        coordinator_pane_key TEXT,
        coordinator_orca_session_id TEXT
      );
      INSERT INTO runs VALUES ('run_coord_test', 'term_coord', 'pane_coord', NULL);
    `);
    db.close();

    const transcriptFile = path.join(tempDir, 'coord_session.jsonl');
    const transcriptLines = [
      JSON.stringify({
        timestamp: '2026-10-15T12:00:00Z',
        ordinal: 0,
        type: 'response_item',
        payload: {
          id: 'msg-u1',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello from user' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-10-15T12:01:00Z',
        ordinal: 1,
        type: 'response_item',
        payload: {
          id: 'msg-a1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello back from agent' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-10-15T12:02:00Z',
        ordinal: 2,
        type: 'response_item',
        payload: {
          id: 'msg-u2',
          role: 'user',
          content: [{ type: 'input_text', text: 'Second user message' }],
        },
      }),
    ];
    fs.writeFileSync(transcriptFile, transcriptLines.join('\n'));

    const lastStatus = {
      version: 2,
      entries: {
        pane_coord: {
          paneKey: 'pane_coord',
          source: 'codex',
          providerSession: {
            id: 'sess_coord_123',
            transcriptPath: transcriptFile,
          },
        },
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'last-status.json'), JSON.stringify(lastStatus));

    const oldAppData = process.env.ORCA_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;

    try {
      const projId = hashId('proj', 'proj-coord');
      const coordNodeId = hashId('node', 'pane_coord');
      globalSourceMaps.nodeSourceMap.set(coordNodeId, {
        handle: 'term_coord',
        paneKey: 'pane_coord',
      });

      const mockCoordNode = {
        id: coordNodeId,
        kind: 'orchestrator' as const,
        label: 'Coordinator',
        worktreeId: 'wt-coord',
        runId: hashId('run', 'run_coord_test'),
        agentType: 'codex',
        branch: null,
        path: 'C:\\coord',
        state: 'working' as const,
        rawState: 'working',
        workspaceStatus: null,
        taskOutcome: null,
        liveness: 'live' as const,
        observedAt: null,
        lastActivityAt: null,
        stale: false,
        taskIds: [],
        preview: null,
        outputAvailable: true,
      };

      const mockGraph: any = {
        runs: [
          {
            id: hashId('run', 'run_coord_test'),
            sourceRunId: 'run_coord_test',
            objective: 'Coord Test',
            coordinatorNodeId: coordNodeId,
            association: 'coordinator-terminal',
          },
        ],
        selectedRunId: hashId('run', 'run_coord_test'),
        nodes: [mockCoordNode],
        edges: [],
        tasks: [],
        progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
        activity: [],
      };

      // Page 1: limit 2
      const detailsPage1 = await collectNodeDetails(
        projId,
        coordNodeId,
        { limit: 2, preloadedGraph: mockGraph }
      );

      assert.equal(detailsPage1.conversation.meta.availability, 'ready');
      assert.equal(detailsPage1.conversation.data?.messages.length, 2);
      assert.equal(detailsPage1.conversation.data?.messages[0].role, 'agent');
      assert.equal(detailsPage1.conversation.data?.messages[0].text, 'Hello back from agent');
      assert.equal(detailsPage1.conversation.data?.messages[1].role, 'user');
      assert.equal(detailsPage1.conversation.data?.messages[1].text, 'Second user message');
      assert.ok(detailsPage1.conversation.data?.nextCursor?.startsWith('cur_'));

      // Page 2: with cursor
      fs.appendFileSync(transcriptFile, '\n' + JSON.stringify({
        type: 'response_item', timestamp: '2026-10-15T12:03:00Z',
        payload: { id: 'msg-u3', role: 'user', content: [{ type: 'input_text', text: 'New user message' }] },
      }));
      const detailsPage2 = await collectNodeDetails(
        projId,
        coordNodeId,
        { cursor: detailsPage1.conversation.data?.nextCursor, preloadedGraph: mockGraph }
      );

      assert.equal(detailsPage2.conversation.data?.messages.length, 1);
      assert.equal(detailsPage2.conversation.data?.messages[0].role, 'user');
      assert.equal(detailsPage2.conversation.data?.messages[0].text, 'New user message');
      assert.ok(detailsPage2.conversation.data?.nextCursor?.startsWith('cur_'), 'Must issue next-byte cursor even at EOF to preserve repeated newer fetch');

      // Page 3: an exhausted check hides the newer-messages action.
      const detailsPage3 = await collectNodeDetails(
        projId,
        coordNodeId,
        { cursor: detailsPage2.conversation.data?.nextCursor, preloadedGraph: mockGraph }
      );
      assert.equal(detailsPage3.conversation.data?.messages.length, 0);
      assert.equal(detailsPage3.conversation.data?.nextCursor, null);
    } finally {
      if (oldAppData !== undefined) {
        process.env.ORCA_APPDATA_DIR = oldAppData;
      } else {
        delete process.env.ORCA_APPDATA_DIR;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('collectNodeDetails cleans duplicated CLI error prefixes and reports actionable messages', async () => {
    const projId = hashId('proj', 'proj-err-clean');
    const workerNodeId = hashId('node', 'worker-err-node');
    const runApiId = hashId('run', 'run-err-clean');

    const bindingKey = `${projId}::${runApiId}::${workerNodeId}`;
    globalSourceMaps.dispatchMap.set(bindingKey, {
      dispatchId: 'ctx_err_test',
      ambiguous: false,
    });

    const mockWorkerNode = {
      id: workerNodeId,
      kind: 'agent' as const,
      label: 'Worker',
      worktreeId: 'wt-err',
      runId: runApiId,
      agentType: 'antigravity',
      branch: null,
      path: 'C:\\err',
      state: 'failed' as const,
      rawState: 'failed',
      workspaceStatus: null,
      taskOutcome: null,
      liveness: 'live' as const,
      observedAt: null,
      lastActivityAt: null,
      stale: false,
      taskIds: [],
      preview: null,
      outputAvailable: true,
    };

    const mockGraph: any = {
      runs: [{ id: runApiId, sourceRunId: 'run-err-clean', objective: 'Err Run', coordinatorNodeId: null, association: 'worker-workspace' }],
      selectedRunId: runApiId,
      nodes: [mockWorkerNode],
      edges: [],
      tasks: [],
      progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
      activity: [],
    };

    const fakeFailRunner: CommandRunner = async (_exe, args) => {
      if (args.includes('worker-read')) {
        return {
          stdout: JSON.stringify({
            ok: false,
            error: {
              code: 'transcript_required',
              message: 'Structured output is unavailable for Dispatch ctx_err_test: provider_unsupported.',
              data: { reason: 'provider_unsupported' },
            },
          }),
          stderr: '',
          exitCode: 1,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const details = await collectNodeDetails(projId, workerNodeId, { preloadedGraph: mockGraph }, fakeFailRunner);
    assert.equal(details.conversation.meta.availability, 'unsupported');
    assert.equal(details.conversation.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
    assert.equal(
      details.conversation.meta.issue?.message,
      'Structured output is unavailable for Dispatch ctx_err_test: provider_unsupported.'
    );
    assert.equal(details.conversation.meta.issue?.message.includes('[CLI_FAILED]'), false);
    assert.equal(details.conversation.meta.issue?.message.includes('CLI_FAILED:'), false);
  });

  test('resolveCoordinatorConversation enforces cross-node and cross-run isolation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-coord-iso-test-'));
    const orcaDir = path.join(tempDir, 'orca');
    fs.mkdirSync(orcaDir, { recursive: true });

    const orchDbPath = path.join(orcaDir, 'orchestration.db');
    const db = new DatabaseSync(orchDbPath);
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        coordinator_handle TEXT,
        coordinator_pane_key TEXT,
        coordinator_orca_session_id TEXT
      );
    `);
    db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(
      'run_iso_1',
      'term_real_coord',
      'pane_real_coord',
      null
    );
    db.close();

    const oldAppData = process.env.ORCA_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;

    try {
      const projId = hashId('proj', 'proj-iso');
      const realCoordNodeId = hashId('node', 'pane_real_coord');
      const fakeCoordNodeId = hashId('node', 'pane_fake_coord');

      globalSourceMaps.nodeSourceMap.set(realCoordNodeId, {
        handle: 'term_real_coord',
        paneKey: 'pane_real_coord',
      });
      globalSourceMaps.nodeSourceMap.set(fakeCoordNodeId, {
        handle: 'term_fake_coord',
        paneKey: 'pane_fake_coord',
      });

      const activeRun: any = {
        id: hashId('run', 'run_iso_1'),
        sourceRunId: 'run_iso_1',
        coordinatorNodeId: realCoordNodeId,
      };

      const fakeNode: any = {
        id: fakeCoordNodeId,
        kind: 'orchestrator',
        runId: hashId('run', 'run_iso_1'),
      };

      // 1. Non-coordinator node clicked -> rejects
      const fakeDetails = await resolveCoordinatorConversation(projId, fakeNode, activeRun);
      assert.equal(fakeDetails.meta.availability, 'unsupported');
      assert.equal(fakeDetails.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
      assert.ok(fakeDetails.meta.issue?.message.includes('not the coordinator for run'));

      // 2. Mismatched runId -> rejects
      const mismatchedRunNode: any = {
        id: realCoordNodeId,
        kind: 'orchestrator',
        runId: hashId('run', 'other_run'),
      };
      const mismatchDetails = await resolveCoordinatorConversation(projId, mismatchedRunNode, activeRun);
      assert.equal(mismatchDetails.meta.availability, 'unsupported');
      assert.equal(mismatchDetails.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
      assert.ok(mismatchDetails.meta.issue?.message.includes('does not match active run'));
    } finally {
      if (oldAppData !== undefined) {
        process.env.ORCA_APPDATA_DIR = oldAppData;
      } else {
        delete process.env.ORCA_APPDATA_DIR;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines streams and bounds file reads with limit and maxWindow', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bounded-read-'));
    const testFile = path.join(tempDir, 'test_lines.jsonl');
    const lines = Array.from({ length: 15 }, (_, i) => JSON.stringify({ index: i, msg: `Message ${i}` }));
    fs.writeFileSync(testFile, lines.join('\n'));

    try {
      // 1. First page: start 0, limit 5
      const page1 = await readBoundedTranscriptLines(testFile, 0, 5);
      assert.equal(page1.lines.length, 5);
      assert.equal(page1.hasMore, true);
      assert.equal(page1.limited, false);
      assert.equal(JSON.parse(page1.lines[0]).index, 0);
      assert.equal(JSON.parse(page1.lines[4]).index, 4);
      assert.ok(page1.nextByteOffset > 0);

      // 2. Second page: advance with nextByteOffset, limit 5
      const page2 = await readBoundedTranscriptLines(testFile, page1.nextByteOffset, 5);
      assert.equal(page2.lines.length, 5);
      assert.equal(page2.hasMore, true);
      assert.equal(page2.limited, false);
      assert.equal(JSON.parse(page2.lines[0]).index, 5);
      assert.equal(JSON.parse(page2.lines[4]).index, 9);

      // 3. Third page: advance with nextByteOffset, limit 5
      const page3 = await readBoundedTranscriptLines(testFile, page2.nextByteOffset, 5);
      assert.equal(page3.lines.length, 5);
      assert.equal(page3.hasMore, false);
      assert.equal(page3.limited, false);
      assert.equal(JSON.parse(page3.lines[0]).index, 10);
      assert.equal(JSON.parse(page3.lines[4]).index, 14);

      // 4. Max byte window exceeded: maxBytesWindow 100 bytes
      const bounded = await readBoundedTranscriptLines(testFile, 0, 10, 100);
      assert.equal(bounded.limited, true);
      assert.equal(bounded.hasMore, true);
      assert.ok(bounded.lines.length < 10 && bounded.lines.length > 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines handles huge single line (>2MB) without unbounded IO or OOM', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-huge-line-'));
    const testFile = path.join(tempDir, 'huge.jsonl');
    const hugeLine = JSON.stringify({ huge: 'x'.repeat(2 * 1024 * 1024) }) + '\n';
    const normalLine = JSON.stringify({ step: 1, text: 'hello after huge' }) + '\n';
    fs.writeFileSync(testFile, hugeLine + normalLine);

    try {
      // 1. Read with standard 512KiB window: giant line exceeds window, advances boundedly with seekingNewline: true
      let offset = 0;
      let seeking = false;
      let iterations = 0;
      let res: any;
      while (iterations < 10) {
        iterations++;
        res = await readBoundedTranscriptLines(testFile, offset, 10, 512 * 1024, seeking);
        assert.equal(res.lines.length, 0, 'Giant line exceeding maxBytesWindow must not be truncated into partial records');
        assert.equal(res.limited, true);
        assert.equal(res.hasMore, true);
        offset = res.nextByteOffset;
        seeking = Boolean(res.seekingNewline);
        if (!seeking) break;
      }
      assert.ok(res.nextByteOffset > 2 * 1024 * 1024, 'nextByteOffset must advance past giant line');

      // 2. Next continuation read from nextByteOffset must read normal records
      const res2 = await readBoundedTranscriptLines(testFile, res.nextByteOffset, 10, 512 * 1024);
      assert.equal(res2.lines.length, 1);
      assert.equal(JSON.parse(res2.lines[0]).step, 1);
      assert.equal(JSON.parse(res2.lines[0]).text, 'hello after huge');
      assert.equal(res2.hasMore, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines handles >10,000 records with recent initial tail and continuation advances', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-10k-records-'));
    const testFile = path.join(tempDir, '10k.jsonl');
    const lines10k = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ step: i, msg: `Record ${i}` }) + '\n');
    fs.writeFileSync(testFile, lines10k.join(''));

    try {
      // 1. Initial read without cursor (null/undefined): must read recent TAIL, not oldest records at byte 0
      const initTail = await readBoundedTranscriptLines(testFile, null, 100);
      assert.equal(initTail.lines.length, 100);
      assert.equal(initTail.hasMore, false);
      assert.equal(initTail.limited, true);
      const lastRecord = JSON.parse(initTail.lines[initTail.lines.length - 1]);
      assert.equal(lastRecord.step, 11999, 'Initial read must capture recent tail records');
      const firstTailRecord = JSON.parse(initTail.lines[0]);
      assert.ok(firstTailRecord.step > 5000, 'Initial read must never start from oldest records at byte 0');

      // 2. Continuation advances starting from byte 0: page 1
      const cont1 = await readBoundedTranscriptLines(testFile, 0, 100);
      assert.equal(cont1.lines.length, 100);
      assert.equal(cont1.hasMore, true);
      assert.equal(JSON.parse(cont1.lines[0]).step, 0);
      assert.equal(JSON.parse(cont1.lines[99]).step, 99);
      assert.ok(cont1.nextByteOffset > 0);

      // 3. Continuation advances to page 2 using nextByteOffset
      const cont2 = await readBoundedTranscriptLines(testFile, cont1.nextByteOffset, 100);
      assert.equal(cont2.lines.length, 100);
      assert.equal(cont2.hasMore, true);
      assert.equal(JSON.parse(cont2.lines[0]).step, 100);
      assert.equal(JSON.parse(cont2.lines[99]).step, 199);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines handles append and newline split without truncating incomplete records', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-append-split-'));
    const testFile = path.join(tempDir, 'append.jsonl');
    fs.writeFileSync(testFile, '{"step":0}\n{"step":1}\n{"step":2,"partia');

    try {
      // 1. Incomplete record at EOF is discarded from lines; nextByteOffset points before it
      const res1 = await readBoundedTranscriptLines(testFile, 0, 10);
      assert.equal(res1.lines.length, 2);
      assert.equal(JSON.parse(res1.lines[0]).step, 0);
      assert.equal(JSON.parse(res1.lines[1]).step, 1);

      // 2. Complete the write by appending the remainder and newline
      fs.appendFileSync(testFile, 'l":false}\n');

      // 3. Reading from nextByteOffset seamlessly recovers step 2
      const res2 = await readBoundedTranscriptLines(testFile, res1.nextByteOffset, 10);
      assert.equal(res2.lines.length, 1);
      assert.equal(JSON.parse(res2.lines[0]).step, 2);
      assert.equal(JSON.parse(res2.lines[0]).partial, false);
      assert.equal(res2.hasMore, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('isPathInsideRoots enforces canonical realpath and prevents symlink traversal escapes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-symlink-test-'));
    const allowedRoot = path.join(tempDir, 'allowed');
    const secretDir = path.join(tempDir, 'secret');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });

    const secretFile = path.join(secretDir, 'secret.jsonl');
    fs.writeFileSync(secretFile, '{"secret":true}\n');

    const linkPath = path.join(allowedRoot, 'escaped-link.jsonl');
    try {
      try {
        fs.symlinkSync(secretFile, linkPath);
      } catch {
        // Fallback for Windows environments without symlink privilege: junction or skip
      }

      // 1. Normal file inside allowed root: allowed
      const normalFile = path.join(allowedRoot, 'normal.jsonl');
      fs.writeFileSync(normalFile, '{"normal":true}\n');
      assert.equal(isPathInsideRoots(normalFile, [allowedRoot]), true);

      // 2. Secret file outside allowed root: rejected
      assert.equal(isPathInsideRoots(secretFile, [allowedRoot]), false);

      // 3. Symlink pointing outside allowed root: canonical realpath points to secretDir, must be rejected
      if (fs.existsSync(linkPath)) {
        assert.equal(isPathInsideRoots(linkPath, [allowedRoot]), false);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('collectGraph updates agent state only from authoritative selectedWorker and ignores stale dispatches', async () => {
    const projId = hashId('proj', 'proj-worker-iso');
    const workerNodeId = hashId('node', 'pane_iso_reused');
    const runApiId = hashId('run', 'run_worker_iso');
    const terminalHandle = 'term_iso_reused';

    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj-worker-iso',
      repoIds: ['repo-iso'],
      paths: ['C:\\iso'],
    });

    globalSourceMaps.nodeSourceMap.set(workerNodeId, {
      handle: terminalHandle,
      paneKey: 'pane_iso_reused',
      endpointIncarnation: 'inc_authoritative',
    });

    const staleWorker = {
      id: 'ctx_stale',
      dispatchId: 'ctx_stale',
      agentTerminalHandle: terminalHandle,
      workerState: 'failed',
      outcome: 'failed',
      resource: null,
      projection: { stage: { detail: 'agent_readiness', activity: 'failed' }, outcome: 'failed' },
    };

    const authoritativeWorker = {
      id: 'ctx_auth',
      dispatchId: 'ctx_auth',
      agentTerminalHandle: terminalHandle,
      workerState: 'working',
      outcome: 'in_progress',
      resource: {
        state: 'ready',
        endpointIncarnation: 'inc_authoritative',
        ownerDispatchId: 'ctx_auth',
      },
      projection: { stage: { activity: 'working' }, outcome: 'in_progress', liveness: { verdict: 'live', observedAt: '2026-10-15T15:00:00Z' } },
    };

    const runner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-iso',
                  repoId: 'repo-iso',
                  path: 'C:\\iso',
                  agents: [{ paneKey: 'pane_iso_reused', agentType: 'antigravity' }],
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [
                {
                  handle: 'term_coord_iso',
                  tabId: 'tab-coord',
                  leafId: 'leaf-coord',
                  connected: true,
                },
                {
                  handle: terminalHandle,
                  paneKey: 'pane_iso_reused',
                  tabId: 'tab-iso',
                  leafId: 'leaf-iso',
                  endpointIncarnation: 'inc_authoritative',
                  connected: true,
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { runs: [{ id: 'run_worker_iso', objective: 'Iso Run', coordinator_handle: 'term_coord_iso' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { workers: [staleWorker, authoritativeWorker] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const res = await collectGraph(projId, runApiId, runner);
    const node = res.graph.nodes.find((n) => n.id === workerNodeId);
    assert.ok(node);
    assert.equal(node.state, 'working');
    assert.equal(node.taskOutcome, 'in_progress');
    assert.equal(node.liveness, 'live');
  });

  test('collectNodeDetails resolves Antigravity conversation via exact-session hook fallback', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-ag-test-'));
    const orcaDir = path.join(tempDir, 'orca');
    const hooksDir = path.join(orcaDir, 'agent-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const geminiDir = path.join(tempDir, 'gemini');
    const convDir = path.join(geminiDir, 'conversations');
    const brainLogDir = path.join(geminiDir, 'brain', 'conv-ag-123', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainLogDir, { recursive: true });

    // Mock SQLite conversation DB
    const cdbPath = path.join(convDir, 'conv-ag-123.db');
    const cdb = new DatabaseSync(cdbPath);
    cdb.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);`);
    cdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('traj-1', 'conv-ag-123');
    cdb.close();

    // Mock transcript.jsonl
    const transcriptFile = path.join(brainLogDir, 'transcript.jsonl');
    const transcriptLines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-10-15T14:00:00Z',
        content: '<USER_REQUEST>\nImplement backend feature\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-15T14:01:00Z',
        content: 'I have started implementing the feature.',
      }),
    ];
    fs.writeFileSync(transcriptFile, transcriptLines.join('\n'));

    // Mock last-status.json
    const lastStatus = {
      version: 2,
      entries: {
        pane_ag_node: {
          paneKey: 'pane_ag_node',
          source: 'antigravity',
          worktreeId: 'wt-ag',
          providerSession: {
            key: 'conversation_id',
            id: 'conv-ag-123',
          },
        },
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'last-status.json'), JSON.stringify(lastStatus));

    const oldOrcaAppData = process.env.ORCA_APPDATA_DIR;
    const oldGeminiAppData = process.env.GEMINI_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;
    process.env.GEMINI_APPDATA_DIR = geminiDir;

    try {
      const projId = hashId('proj', 'proj-ag');
      const agNodeId = hashId('node', 'pane_ag_node');
      const runApiId = hashId('run', 'run-ag');

      globalSourceMaps.nodeSourceMap.set(agNodeId, {
        handle: 'term_ag',
        paneKey: 'pane_ag_node',
      });

      const mockAgNode: any = {
        id: agNodeId,
        kind: 'agent',
        label: 'Antigravity Worker',
        worktreeId: 'wt-ag',
        runId: runApiId,
        agentType: 'antigravity',
        branch: null,
        path: 'C:\\ag',
        state: 'working',
        rawState: 'working',
        workspaceStatus: null,
        taskOutcome: null,
        liveness: 'live',
        observedAt: null,
        lastActivityAt: null,
        stale: false,
        taskIds: [],
        preview: null,
        outputAvailable: true,
      };

      const mockGraph: any = {
        runs: [{ id: runApiId, sourceRunId: 'run-ag', objective: 'AG Run', coordinatorNodeId: null, association: 'worker-workspace' }],
        selectedRunId: runApiId,
        nodes: [mockAgNode],
        edges: [],
        tasks: [],
        progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
        activity: [],
      };

      // Simulated runner: worker-read fails with provider_unsupported
      const runner: CommandRunner = async (_exe, args) => {
        if (args.includes('worker-read')) {
          return {
            stdout: JSON.stringify({
              ok: false,
              error: {
                code: 'transcript_required',
                message: 'Structured output is unavailable for Dispatch ctx_ag: provider_unsupported.',
                data: { reason: 'provider_unsupported' },
              },
            }),
            stderr: '',
            exitCode: 1,
          };
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      };

      const details = await collectNodeDetails(projId, agNodeId, { preloadedGraph: mockGraph }, runner);
      assert.equal(details.conversation.meta.availability, 'ready');
      assert.equal(details.conversation.data?.provider, 'antigravity');
      assert.equal(details.conversation.data?.messages.length, 2);
      assert.equal(details.conversation.data?.messages[0].role, 'user');
      assert.equal(details.conversation.data?.messages[0].text, 'Implement backend feature');
      assert.equal(details.conversation.data?.messages[1].role, 'agent');
      assert.equal(details.conversation.data?.messages[1].text, 'I have started implementing the feature.');

      // Test missing transcript.jsonl returns honest capability blocker
      fs.unlinkSync(transcriptFile);
      const detailsMissing = await collectNodeDetails(projId, agNodeId, { preloadedGraph: mockGraph }, runner);
      assert.equal(detailsMissing.conversation.meta.availability, 'unsupported');
      assert.equal(detailsMissing.conversation.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
      assert.ok(
        detailsMissing.conversation.meta.issue?.message.includes(
          'Antigravity binary protobuf trajectory decoder unavailable without schema definition; vendor transcript log not found.'
        )
      );
    } finally {
      if (oldOrcaAppData !== undefined) process.env.ORCA_APPDATA_DIR = oldOrcaAppData;
      else delete process.env.ORCA_APPDATA_DIR;
      if (oldGeminiAppData !== undefined) process.env.GEMINI_APPDATA_DIR = oldGeminiAppData;
      else delete process.env.GEMINI_APPDATA_DIR;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('collectNodeDetails returns honest unsupported conversation for worktree and terminal nodes', async () => {
    const projId = hashId('proj', 'proj-non-agent');
    const wtNodeId = hashId('node', 'wt-node-test');

    const mockWtNode: any = {
      id: wtNodeId,
      kind: 'worktree',
      label: 'Main Worktree',
      worktreeId: 'wt-main',
      runId: null,
      agentType: null,
      branch: 'main',
      path: 'C:\\main',
      state: 'idle',
      rawState: 'idle',
      workspaceStatus: 'clean',
      taskOutcome: null,
      liveness: 'unknown',
      observedAt: null,
      lastActivityAt: null,
      stale: false,
      taskIds: [],
      preview: null,
      outputAvailable: false,
    };

    const mockGraph: any = {
      runs: [],
      selectedRunId: null,
      nodes: [mockWtNode],
      edges: [],
      tasks: [],
      progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
      activity: [],
    };

    let runnerCalled = false;
    const runner: CommandRunner = async () => {
      runnerCalled = true;
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const details = await collectNodeDetails(projId, wtNodeId, { preloadedGraph: mockGraph }, runner);
    assert.equal(runnerCalled, false, 'Must not attempt CLI commands for worktree nodes');
    assert.equal(details.conversation.meta.availability, 'unsupported');
    assert.equal(details.conversation.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
    assert.equal(
      details.conversation.meta.issue?.message,
      'Conversation history is only supported for agent and orchestrator nodes'
    );
  });

  test('getAllowedTranscriptRoots excludes os.tmpdir from production roots', () => {
    const roots = getAllowedTranscriptRoots();
    assert.equal(roots.includes(os.tmpdir()), false);
  });

  test('collectNodeDetails supports Antigravity fallback page continuation without calling worker-read on local cursor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-ag-cont-'));
    const orcaDir = path.join(tempDir, 'orca');
    const hooksDir = path.join(orcaDir, 'agent-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    const geminiDir = path.join(tempDir, 'gemini');
    const convDir = path.join(geminiDir, 'conversations');
    const brainLogDir = path.join(geminiDir, 'brain', 'conv-ag-cont', '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(brainLogDir, { recursive: true });

    const cdbPath = path.join(convDir, 'conv-ag-cont.db');
    const cdb = new DatabaseSync(cdbPath);
    cdb.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);`);
    cdb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('traj-1', 'conv-ag-cont');
    cdb.close();

    const transcriptFile = path.join(brainLogDir, 'transcript.jsonl');
    const transcriptLines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-10-15T14:00:00Z', content: '<USER_REQUEST>\nTurn 1\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-10-15T14:01:00Z', content: 'Turn 2' }),
      JSON.stringify({ step_index: 2, type: 'USER_INPUT', created_at: '2026-10-15T14:02:00Z', content: '<USER_REQUEST>\nTurn 3\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-10-15T14:03:00Z', content: 'Turn 4' }),
    ];
    fs.writeFileSync(transcriptFile, transcriptLines.join('\n'));

    const lastStatus = {
      version: 2,
      entries: {
        pane_ag_cont: {
          paneKey: 'pane_ag_cont',
          source: 'antigravity',
          worktreeId: 'wt-ag-cont',
          providerSession: {
            key: 'conversation_id',
            id: 'conv-ag-cont',
          },
        },
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'last-status.json'), JSON.stringify(lastStatus));

    const oldOrca = process.env.ORCA_APPDATA_DIR;
    const oldGemini = process.env.GEMINI_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;
    process.env.GEMINI_APPDATA_DIR = geminiDir;

    try {
      const projId = hashId('proj', 'proj-ag-cont');
      const agNodeId = hashId('node', 'pane_ag_cont');
      const runApiId = hashId('run', 'run-ag-cont');

      globalSourceMaps.nodeSourceMap.set(agNodeId, {
        handle: 'term_ag_cont',
        paneKey: 'pane_ag_cont',
      });

      const mockAgNode: any = {
        id: agNodeId,
        kind: 'agent',
        label: 'Antigravity Worker',
        worktreeId: 'wt-ag-cont',
        runId: runApiId,
        agentType: 'antigravity',
        branch: null,
        path: 'C:\\ag',
        state: 'working',
        rawState: 'working',
        workspaceStatus: null,
        taskOutcome: null,
        liveness: 'live',
        observedAt: null,
        lastActivityAt: null,
        stale: false,
        taskIds: [],
        preview: null,
        outputAvailable: true,
      };

      const mockGraph: any = {
        runs: [{ id: runApiId, sourceRunId: 'run-ag-cont', objective: 'AG Run', coordinatorNodeId: null, association: 'worker-workspace' }],
        selectedRunId: runApiId,
        nodes: [mockAgNode],
        edges: [],
        tasks: [],
        progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
        activity: [],
      };

      // Set active worker dispatch binding
      const bindingKey = `${projId}::${runApiId}::${agNodeId}`;
      globalSourceMaps.dispatchMap.set(bindingKey, { dispatchId: 'ctx_ag_dispatch', ambiguous: false });

      // Page 1: Initial call. worker-read throws provider_unsupported. Fallback activates.
      let workerReadCalledCount = 0;
      const runner: CommandRunner = async (_exe, args) => {
        if (args.includes('worker-read')) {
          workerReadCalledCount++;
          throw new CliError('CLI_FAILED', 'Structured output is unavailable for Dispatch ctx_ag_dispatch: provider_unsupported.');
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      };

      const page1 = await collectNodeDetails(projId, agNodeId, { limit: 2, preloadedGraph: mockGraph }, runner);
      assert.equal(page1.conversation.meta.availability, 'ready');
      assert.equal(page1.conversation.data?.messages.length, 2);
      assert.equal(page1.conversation.data?.messages[0].text, 'Turn 3');
      assert.equal(page1.conversation.data?.messages[1].text, 'Turn 4');
      assert.ok(page1.conversation.data?.nextCursor, 'Must produce nextCursor for continuation');

      const nextCursor = page1.conversation.data!.nextCursor!;
      fs.appendFileSync(transcriptFile, '\n' + [
        JSON.stringify({ step_index: 4, type: 'USER_INPUT', content: 'Turn 5' }),
        JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', content: 'Turn 6' }),
      ].join('\n'));

      // Page 2: Continuation call with local cursor.
      // Must NOT call worker-read because stored cursor has sourceMode: 'antigravity-transcript'!
      const continuationRunner: CommandRunner = async (_exe, args) => {
        if (args.includes('worker-read')) {
          assert.fail('worker-read must NOT be called when continuation cursor belongs to local Antigravity transcript fallback');
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      };

      const page2 = await collectNodeDetails(projId, agNodeId, { cursor: nextCursor, limit: 2, preloadedGraph: mockGraph }, continuationRunner);
      assert.equal(page2.conversation.meta.availability, 'ready');
      assert.equal(page2.conversation.data?.messages.length, 2);
      assert.equal(page2.conversation.data?.messages[0].text, 'Turn 5');
      assert.equal(page2.conversation.data?.messages[1].text, 'Turn 6');
      const exhausted = await collectNodeDetails(projId, agNodeId,
        { cursor: page2.conversation.data!.nextCursor, limit: 2, preloadedGraph: mockGraph }, continuationRunner);
      assert.equal(exhausted.conversation.data?.messages.length, 0);
      assert.equal(exhausted.conversation.data?.nextCursor, null);
    } finally {
      if (oldOrca !== undefined) process.env.ORCA_APPDATA_DIR = oldOrca;
      else delete process.env.ORCA_APPDATA_DIR;
      if (oldGemini !== undefined) process.env.GEMINI_APPDATA_DIR = oldGemini;
      else delete process.env.GEMINI_APPDATA_DIR;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('collectNodeDetails resets cursor on "The worker-read cursor is pinned to terminal output" error and recovers', async () => {
    const projId = hashId('proj', 'proj-pinned-reset');
    const workerNodeId = hashId('node', 'node-pinned-worker');
    const runApiId = hashId('run', 'run-pinned');

    const mockNode: any = {
      id: workerNodeId,
      kind: 'agent',
      label: 'Codex Worker',
      worktreeId: 'wt-pinned',
      runId: runApiId,
      agentType: 'codex',
      branch: null,
      path: 'C:\\pinned',
      state: 'working',
      rawState: 'working',
      workspaceStatus: null,
      taskOutcome: null,
      liveness: 'live',
      observedAt: null,
      lastActivityAt: null,
      stale: false,
      taskIds: [],
      preview: null,
      outputAvailable: true,
    };

    const mockGraph: any = {
      runs: [{ id: runApiId, sourceRunId: 'run-pinned', objective: 'Pinned Run', coordinatorNodeId: null, association: 'worker-workspace' }],
      selectedRunId: runApiId,
      nodes: [mockNode],
      edges: [],
      tasks: [],
      progress: { total: 0, completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0, percent: null, coverage: 'unavailable', basis: 'completed-tasks' },
      activity: [],
    };

    const bindingKey = `${projId}::${runApiId}::${workerNodeId}`;
    globalSourceMaps.dispatchMap.set(bindingKey, { dispatchId: 'ctx_pinned_dispatch', ambiguous: false });

    // Store a cursor
    const testCursor = 'cur_pinned_test_123';
    cursorStore.set(testCursor, {
      upstreamCursor: 'raw_pinned_cursor_abc',
      projectId: projId,
      nodeId: workerNodeId,
      runId: runApiId,
      dispatchId: 'ctx_pinned_dispatch',
      sourceIdentity: 'src_identity_1',
      sourceMode: 'worker-read-transcript',
      expiresAt: Date.now() + 60000,
    });

    let callsCount = 0;
    const runner: CommandRunner = async (_exe, args) => {
      if (args.includes('worker-read')) {
        callsCount++;
        if (args.includes('--cursor')) {
          throw new CliError('CLI_FAILED', 'The worker-read cursor is pinned to terminal output.');
        }
        // Recovered fresh call without --cursor
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              source: 'transcript',
              sourceExact: true,
              sourceIdentity: 'src_identity_1',
              provider: 'codex',
              contentComplete: true,
              transcript: {
                messages: [
                  {
                    id: 'msg_recovered',
                    role: 'assistant',
                    timestamp: '2026-10-15T15:00:00Z',
                    blocks: [{ type: 'text', text: 'Fresh message after reset' }],
                  },
                ],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const details = await collectNodeDetails(projId, workerNodeId, { cursor: testCursor, preloadedGraph: mockGraph }, runner);
    assert.equal(callsCount, 2, 'Must fail once with cursor and retry once without cursor');
    assert.equal(details.conversation.meta.availability, 'ready');
    assert.equal(details.conversation.meta.partial, true, 'Reset must mark partial truthfully');
    assert.ok(
      details.conversation.data?.warnings.some((w) =>
        w.includes('The worker-read cursor was pinned to terminal output and was reset to recent transcript window.')
      ),
      'Must contain reset warning'
    );
    assert.equal(details.conversation.data?.messages.length, 1);
    assert.equal(details.conversation.data?.messages[0].text, 'Fresh message after reset');
    assert.equal(cursorStore.has(testCursor), false, 'Pinned cursor must be pruned from cursorStore');
  });

  test('collectGraph populates model and effort on nodes from workers, terminals, and coordinator hooks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-model-test-'));
    const orcaDir = path.join(tempDir, 'orca');
    const hooksDir = path.join(orcaDir, 'agent-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    // Mock coordinator in last-status.json
    const lastStatus = {
      version: 2,
      entries: {
        'term_coord_handle': {
          handle: 'term_coord_handle',
          payload: {
            agentType: 'codex',
            model: 'gpt-6.1-sol',
            effort: 'medium',
          },
        },
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'last-status.json'), JSON.stringify(lastStatus));

    const oldOrca = process.env.ORCA_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;

    try {
      const runner: CommandRunner = async (_exe, args) => {
        if (args.includes('project') && args.includes('list')) {
          return { stdout: JSON.stringify({ ok: true, result: { projects: [{ id: 'p1', name: 'proj-model', root: 'C:\\proj' }] } }), stderr: '', exitCode: 0 };
        }
        if (args.includes('project') && args.includes('setups')) {
          return { stdout: JSON.stringify({ ok: true, result: { setups: [] } }), stderr: '', exitCode: 0 };
        }
        if (args.includes('repo') && args.includes('list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                repos: [
                  {
                    id: 'r1',
                    displayName: 'repo-1',
                    worktrees: [
                      {
                        worktreeId: 'wt1',
                        path: 'C:\\proj',
                        agents: [
                          {
                            paneKey: 'pane_w1',
                            agentType: 'antigravity',
                            model: 'gemini-3.8-flash',
                            effort: 'high',
                            state: 'working',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('terminal') && args.includes('list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                terminals: [
                  {
                    handle: 'term_coord_handle',
                    title: 'Coordinator Terminal',
                    connected: true,
                  },
                  {
                    handle: 'term_worker_handle',
                    paneKey: 'pane_w1',
                    connected: true,
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('run-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                runs: [
                  {
                    id: 'run_model_1',
                    coordinator_handle: 'term_coord_handle',
                    objective: 'Model test run',
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worker-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                workers: [
                  {
                    id: 'ctx_worker_1',
                    agentTerminalHandle: 'term_worker_handle',
                    workerState: 'working',
                    projection: {
                      provider: {
                        model: 'gemini-3.8-pro',
                        effort: 'low',
                      },
                      stage: {
                        activity: 'working',
                      },
                    },
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worktree') && args.includes('ps')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                worktrees: [
                  {
                    worktreeId: 'wt1',
                    repoId: 'r1',
                    path: 'C:\\proj',
                    agents: [
                      {
                        paneKey: 'pane_w1',
                        agentType: 'antigravity',
                        model: 'gemini-3.8-flash',
                        effort: 'high',
                        state: 'working',
                      },
                    ],
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      };

      const projId = hashId('proj', 'p1');
      globalSourceMaps.projectSourceMap.set(projId, {
        sourceId: 'p1',
        repoIds: ['r1'],
        paths: ['C:\\proj'],
      });

      const { graph } = await collectGraph(projId, null, runner);

      // 1. Coordinator node should have model and effort from last-status.json
      const coordNode = graph.nodes.find((n) => n.kind === 'orchestrator');
      assert.ok(coordNode, 'Orchestrator node must exist');
      assert.equal(coordNode.model, 'gpt-6.1-sol');
      assert.equal(coordNode.effort, 'medium');

      // 2. Worker node should have model and effort updated from authoritative selectedWorker
      const workerNode = graph.nodes.find((n) => n.kind === 'agent');
      assert.ok(workerNode, 'Agent node must exist');
      assert.equal(workerNode.model, 'gemini-3.8-pro');
      assert.equal(workerNode.effort, 'low');
    } finally {
      if (oldOrca !== undefined) process.env.ORCA_APPDATA_DIR = oldOrca;
      else delete process.env.ORCA_APPDATA_DIR;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('collectGraph populates model and effort from actual worker-show effective launch and caches by dispatch', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-worker-show-test-'));
    const orcaDir = path.join(tempDir, 'orca');
    const hooksDir = path.join(orcaDir, 'agent-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    // Coordinator entry with turn_context model/effort instead of top-level payload.model
    const lastStatus = {
      version: 2,
      entries: {
        'term_coord_show': {
          handle: 'term_coord_show',
          turn_context: {
            model: 'gpt-5.3-codex',
            effort: 'high',
          },
        },
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'last-status.json'), JSON.stringify(lastStatus));

    const oldOrca = process.env.ORCA_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;

    let workerShowCallCount = 0;
    try {
      const runner: CommandRunner = async (_exe, args) => {
        if (args.includes('project') && args.includes('list')) {
          return { stdout: JSON.stringify({ ok: true, result: { projects: [{ id: 'p_show', name: 'proj-show', root: 'C:\\proj_show' }] } }), stderr: '', exitCode: 0 };
        }
        if (args.includes('project') && args.includes('setups')) {
          return { stdout: JSON.stringify({ ok: true, result: { setups: [] } }), stderr: '', exitCode: 0 };
        }
        if (args.includes('repo') && args.includes('list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                repos: [
                  {
                    id: 'r_show',
                    displayName: 'repo-show',
                    worktrees: [
                      {
                        worktreeId: 'wt_show',
                        path: 'C:\\proj_show',
                        agents: [{ paneKey: 'pane_show_1', agentType: 'antigravity', state: 'working' }],
                      },
                    ],
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('terminal') && args.includes('list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                terminals: [
                  { handle: 'term_coord_show', title: 'Coordinator', connected: true },
                  { handle: 'term_worker_show', paneKey: 'pane_show_1', connected: true },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('run-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                runs: [{ id: 'run_show_1', coordinator_handle: 'term_coord_show', objective: 'Show run' }],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worker-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                workers: [
                  {
                    id: 'ctx_show_1',
                    agentTerminalHandle: 'term_worker_show',
                    workerState: 'working',
                    // Actual worker-list projection.provider.model is null and no startOptions:
                    projection: {
                      provider: { id: 'antigravity', model: null },
                      stage: { activity: 'working' },
                    },
                    resource: {
                      endpointIncarnation: 'inc_show_1',
                      ownerDispatchId: 'ctx_show_1',
                    },
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worker-show')) {
          workerShowCallCount++;
          // Returns actual worker-show envelope with startOptions.launch.effective
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                worker: {
                  dispatchId: 'ctx_show_1',
                  startOptions: {
                    launch: {
                      requested: { agent: 'antigravity', model: 'gemini-3.8-flash', effort: 'high' },
                      effective: { agent: 'antigravity', model: 'gemini-3.8-flash', effort: 'high' },
                    },
                  },
                },
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worktree') && args.includes('ps')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                worktrees: [
                  {
                    worktreeId: 'wt_show',
                    repoId: 'r_show',
                    path: 'C:\\proj_show',
                    agents: [{ paneKey: 'pane_show_1', agentType: 'antigravity', state: 'working' }],
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      };

      const projId = hashId('proj', 'p_show');
      globalSourceMaps.projectSourceMap.set(projId, {
        sourceId: 'p_show',
        repoIds: ['r_show'],
        paths: ['C:\\proj_show'],
      });

      // 1. First collection: calls worker-show and populates model/effort
      const { graph: graph1 } = await collectGraph(projId, null, runner);
      assert.equal(workerShowCallCount, 1, 'Must invoke worker-show for exact authoritative dispatch');
      const workerNode1 = graph1.nodes.find((n) => n.kind === 'agent');
      assert.ok(workerNode1);
      assert.equal(workerNode1.model, 'gemini-3.8-flash');
      assert.equal(workerNode1.effort, 'high');

      const coordNode1 = graph1.nodes.find((n) => n.kind === 'orchestrator');
      assert.ok(coordNode1);
      assert.equal(coordNode1.model, 'gpt-5.3-codex');
      assert.equal(coordNode1.effort, 'high');

      // 2. Second collection: uses workerLaunchCache, does not re-invoke worker-show (avoids poll explosion)
      const { graph: graph2 } = await collectGraph(projId, null, runner);
      assert.equal(workerShowCallCount, 1, 'Must use workerLaunchCache on subsequent ticks');
      const workerNode2 = graph2.nodes.find((n) => n.kind === 'agent');
      assert.equal(workerNode2?.model, 'gemini-3.8-flash');
      assert.equal(workerNode2?.effort, 'high');
    } finally {
      if (oldOrca !== undefined) process.env.ORCA_APPDATA_DIR = oldOrca;
      else delete process.env.ORCA_APPDATA_DIR;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines strictly caps total bytes read per call to maxBytesWindow + 64KiB and handles huge no-newline tail', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bounded-read-cap-'));
    const testFile = path.join(tempDir, 'cap.jsonl');
    const hugeLine = JSON.stringify({ huge: 'y'.repeat(2 * 1024 * 1024) }) + '\n';
    const normalLine = JSON.stringify({ step: 99, text: 'normal record' }) + '\n';
    fs.writeFileSync(testFile, hugeLine + normalLine);

    const origReadSync = fs.readSync;
    let bytesReadInCurrentCall = 0;
    fs.readSync = function (this: any, ...args: any[]) {
      const length = args[3];
      bytesReadInCurrentCall += length;
      return (origReadSync as any).apply(this, args);
    } as any;

    try {
      const windowSize = 512 * 1024;
      const cap = windowSize + 64 * 1024;

      // 1. Initial read on giant line: bytes read must not exceed cap
      bytesReadInCurrentCall = 0;
      const res1 = await readBoundedTranscriptLines(testFile, 0, 10, windowSize, false);
      assert.ok(
        bytesReadInCurrentCall <= cap,
        `Read per call (${bytesReadInCurrentCall}) must not exceed maxBytesWindow + 64KiB (${cap})`
      );
      assert.equal(res1.lines.length, 0);
      assert.equal(res1.limited, true);
      assert.equal(res1.hasMore, true);
      assert.equal(res1.seekingNewline, true);
      assert.ok(res1.nextByteOffset > 0 && res1.nextByteOffset <= cap);

      // 2. Subsequent continuation reads with seekingNewline: each call must respect cap
      let offset = res1.nextByteOffset;
      let seeking = Boolean(res1.seekingNewline);
      let res = res1;
      while (seeking) {
        bytesReadInCurrentCall = 0;
        res = await readBoundedTranscriptLines(testFile, offset, 10, windowSize, seeking);
        assert.ok(
          bytesReadInCurrentCall <= cap,
          `Continuation read per call (${bytesReadInCurrentCall}) must not exceed cap (${cap})`
        );
        offset = res.nextByteOffset;
        seeking = Boolean(res.seekingNewline);
      }
      assert.equal(seeking, false);
      assert.ok(res.nextByteOffset > 2 * 1024 * 1024);

      // 3. Resumes at newline: reading from offset yields normal line cleanly
      bytesReadInCurrentCall = 0;
      const normalRes = await readBoundedTranscriptLines(testFile, res.nextByteOffset, 10, windowSize, false);
      assert.equal(normalRes.lines.length, 1);
      assert.equal(JSON.parse(normalRes.lines[0]).step, 99);

      // 4. Initial read with huge no-newline tail: yields limited: true, progressing offset, seekingNewline: true
      const hugeTailFile = path.join(tempDir, 'huge-tail.jsonl');
      fs.writeFileSync(hugeTailFile, 'x'.repeat(2 * 1024 * 1024));
      bytesReadInCurrentCall = 0;
      const tailRes = await readBoundedTranscriptLines(hugeTailFile, null, 10, windowSize);
      assert.ok(bytesReadInCurrentCall <= cap);
      assert.equal(tailRes.lines.length, 0, 'No malformed line on huge no-newline tail');
      assert.equal(tailRes.limited, true);
      assert.equal(tailRes.seekingNewline, true);
      assert.ok(tailRes.nextByteOffset > 0, 'Progressing offset on huge tail');
    } finally {
      fs.readSync = origReadSync;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('collectGraph confirms requested-only launch remains null and recovers effective launch from matching origin dispatch', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-origin-reuse-test-'));
    const orcaDir = path.join(tempDir, 'orca');
    fs.mkdirSync(orcaDir, { recursive: true });

    const orchDbPath = path.join(orcaDir, 'orchestration.db');
    const db = new DatabaseSync(orchDbPath);
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        coordinator_handle TEXT,
        coordinator_pane_key TEXT,
        coordinator_orca_session_id TEXT
      );
      CREATE TABLE worker_terminal_resources (
        terminal_handle TEXT PRIMARY KEY,
        endpoint_incarnation TEXT,
        owner_dispatch_id TEXT,
        origin_dispatch_id TEXT
      );
    `);
    db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(
      'run_reuse_test',
      'term_coord_reuse',
      'pane_coord_reuse',
      null
    );
    db.prepare('INSERT INTO worker_terminal_resources VALUES (?, ?, ?, ?)').run(
      'term_worker_reuse',
      'inc_reuse_matched',
      'ctx_reused_disp',
      'ctx_origin_disp'
    );
    db.prepare('INSERT INTO worker_terminal_resources VALUES (?, ?, ?, ?)').run(
      'term_worker_req_only',
      'inc_req_only',
      'ctx_req_only_disp',
      null
    );
    db.close();

    const oldOrca = process.env.ORCA_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = tempDir;

    workerLaunchCache.clear();

    try {
      const runner: CommandRunner = async (_exe, args) => {
        if (args.includes('terminal') && args.includes('list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                terminals: [
                  { handle: 'term_coord_reuse', title: 'Coordinator', connected: true },
                  { handle: 'term_worker_reuse', paneKey: 'pane_worker_reuse', connected: true },
                  { handle: 'term_worker_req_only', paneKey: 'pane_worker_req_only', connected: true },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('run-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                runs: [{ id: 'run_reuse_test', coordinator_handle: 'term_coord_reuse', objective: 'Reuse Test' }],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worker-list')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                workers: [
                  {
                    id: 'ctx_reused_disp',
                    agentTerminalHandle: 'term_worker_reuse',
                    workerState: 'working',
                    projection: {
                      provider: { id: 'antigravity', model: null },
                      stage: { activity: 'working' },
                    },
                    resource: {
                      endpointIncarnation: 'inc_reuse_matched',
                      ownerDispatchId: 'ctx_reused_disp',
                      originDispatchId: 'ctx_origin_disp',
                    },
                  },
                  {
                    id: 'ctx_req_only_disp',
                    agentTerminalHandle: 'term_worker_req_only',
                    workerState: 'working',
                    projection: {
                      provider: { id: 'antigravity', model: null },
                      stage: { activity: 'working' },
                    },
                    resource: {
                      endpointIncarnation: 'inc_req_only',
                      ownerDispatchId: 'ctx_req_only_disp',
                    },
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (args.includes('worker-show')) {
          const dispIdx = args.indexOf('--dispatch');
          const dispatchArg = dispIdx !== -1 ? args[dispIdx + 1] : null;

          if (dispatchArg === 'ctx_req_only_disp') {
            // Requested launch only, effective is null: MUST REMAIN NULL
            return {
              stdout: JSON.stringify({
                ok: true,
                result: {
                  worker: {
                    dispatchId: 'ctx_req_only_disp',
                    startOptions: {
                      launch: {
                        requested: { agent: 'antigravity', model: 'gemini-3.8-flash', effort: 'high' },
                        effective: null,
                      },
                    },
                  },
                },
              }),
              stderr: '',
              exitCode: 0,
            };
          }

          if (dispatchArg === 'ctx_reused_disp') {
            // Reused worker has null effective launch
            return {
              stdout: JSON.stringify({
                ok: true,
                result: {
                  worker: {
                    dispatchId: 'ctx_reused_disp',
                    startOptions: {
                      launch: {
                        requested: { agent: 'antigravity', model: 'unobserved-request', effort: 'low' },
                        effective: null,
                      },
                    },
                  },
                },
              }),
              stderr: '',
              exitCode: 0,
            };
          }

          if (dispatchArg === 'ctx_origin_disp') {
            // Origin dispatch provides authoritative effective launch for matching incarnation/terminal
            return {
              stdout: JSON.stringify({
                ok: true,
                result: {
                  worker: {
                    dispatchId: 'ctx_origin_disp',
                    agentTerminalHandle: 'term_worker_reuse',
                    resource: {
                      endpointIncarnation: 'inc_reuse_matched',
                    },
                    startOptions: {
                      launch: {
                        requested: { agent: 'antigravity', model: 'origin-req', effort: 'high' },
                        effective: { agent: 'antigravity', model: 'claude-3-5-sonnet', effort: 'low' },
                      },
                    },
                  },
                },
              }),
              stderr: '',
              exitCode: 0,
            };
          }
        }
        if (args.includes('worktree') && args.includes('ps')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              result: {
                worktrees: [
                  {
                    worktreeId: 'wt_reuse',
                    repoId: 'r_reuse',
                    path: 'C:\\proj_reuse',
                    agents: [
                      { paneKey: 'pane_worker_reuse', agentType: 'antigravity', state: 'working' },
                      { paneKey: 'pane_worker_req_only', agentType: 'antigravity', state: 'working' },
                    ],
                  },
                ],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      };

      const projId = hashId('proj', 'p_reuse');
      globalSourceMaps.projectSourceMap.set(projId, {
        sourceId: 'p_reuse',
        repoIds: ['r_reuse'],
        paths: ['C:\\proj_reuse'],
      });

      const { graph } = await collectGraph(projId, null, runner);

      // 1. Requested-only worker node: must remain honest null (no fallback to requested)
      const reqOnlyNode = graph.nodes.find(
        (n) => n.label?.includes('pane_worker_req_only') || globalSourceMaps.nodeSourceMap.get(n.id)?.paneKey === 'pane_worker_req_only'
      );
      assert.ok(reqOnlyNode, 'Worker node with requested-only launch must exist');
      assert.equal(reqOnlyNode.model, null, 'Requested-only launch must not set model');
      assert.equal(reqOnlyNode.effort, null, 'Requested-only launch must not set effort');

      // 2. Reused worker with null effective: recovers effective from origin dispatch
      const reusedNode = graph.nodes.find(
        (n) => n.label?.includes('pane_worker_reuse') || globalSourceMaps.nodeSourceMap.get(n.id)?.paneKey === 'pane_worker_reuse'
      );
      assert.ok(reusedNode, 'Reused worker node must exist');
      assert.equal(reusedNode.model, 'claude-3-5-sonnet', 'Must recover effective model from matching origin dispatch');
      assert.equal(reusedNode.effort, 'low', 'Must recover effective effort from matching origin dispatch');
    } finally {
      if (oldOrca !== undefined) process.env.ORCA_APPDATA_DIR = oldOrca;
      else delete process.env.ORCA_APPDATA_DIR;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
