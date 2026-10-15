import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapToState,
  stripAnsi,
  toIsoOrNull,
  collectInventory,
  collectGraph,
  collectNodeDetails,
  hashId,
  globalSourceMaps,
} from './orca.js';
import { CommandRunner, CliError } from './cli.js';

describe('server/orca', () => {
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
        (e) => e.kind === 'delegates' && e.evidence === 'run-dispatch' && e.source === coordNode.id && e.target === workerNode.id
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

  test('collectNodeDetails fetches output and strips ANSI', async () => {
    const projApiId = hashId('proj', 'test-proj');
    const workerNodeId = hashId('node', 'tab-2:leaf-2');

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
          stdout: JSON.stringify({ ok: true, result: { runs: [] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal read --terminal term_worker')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminal: {
                handle: 'term_worker',
                status: 'running',
                tail: ['\x1B[32mLine 1\x1B[0m', 'Line 2'],
                limited: true,
                truncated: false,
                latestCursor: 'cur-99',
                source: 'stream',
              },
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
    assert.equal(details.output.data?.lines.length, 2);
    assert.equal(details.output.data?.lines[0], 'Line 1');
    assert.equal(details.output.data?.nextCursor, 'cur-99');
    assert.equal(details.output.data?.source, 'terminal');
  });
});
