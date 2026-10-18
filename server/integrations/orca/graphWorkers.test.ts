import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CommandRunner } from '../cli.js';
import { hashId } from './utils.js';
import { globalSourceMaps, workerLaunchCache } from './state.js';
import { collectGraph } from './graph.js';
import { collectOrchestrationMessages } from './liveActivity.js';
import type { Node, Edge, Run } from '../../../shared/contracts.js';

test('packets come only from exact-run toolkit messages and preserve reply direction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-mail-events-'));
  const previous = process.env.ORCA_APPDATA_DIR;
  fs.mkdirSync(path.join(dir, 'orca'));
  const db = new DatabaseSync(path.join(dir, 'orca', 'orchestration.db'));
  try {
    process.env.ORCA_APPDATA_DIR = dir;
    db.exec('CREATE TABLE messages(id TEXT, run_id TEXT, from_handle TEXT, to_handle TEXT, created_at TEXT)');
    const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)');
    insert.run('send', 'run1', 'coord', 'worker', '2026-10-18 01:00:00');
    insert.run('reply', 'run1', 'worker', 'coord', '2026-10-18 01:01:00');
    insert.run('wrong-run', 'run2', 'worker', 'coord', '2026-10-18 01:01:00');
    insert.run('unknown-pane', 'run1', 'stranger', 'coord', '2026-10-18 01:01:00');
    globalSourceMaps.nodeSourceMap.set('mail-coord', { handle: 'coord' });
    globalSourceMaps.nodeSourceMap.set('mail-worker', { handle: 'worker' });
    const nodes = [{ id: 'mail-coord' }, { id: 'mail-worker' }] as Node[];
    const edge = { id: 'mail-edge', source: 'mail-coord', target: 'mail-worker', kind: 'delegates', active: true } as Edge;
    collectOrchestrationMessages({ id: 'r1', sourceRunId: 'run1' } as Run, nodes, [edge]);
    assert.equal(edge.messages?.length, 2);
    assert.equal(edge.messages?.[0].source, 'mail-coord');
    assert.equal(edge.messages?.[1].source, 'mail-worker');
    assert.equal(edge.messages?.[0].at, '2026-10-18T01:00:00.000Z');
    const idleEdge = { ...edge, messages: undefined };
    collectOrchestrationMessages(null, nodes, [idleEdge]);
    assert.equal(idleEdge.messages, undefined);
  } finally {
    db.close();
    globalSourceMaps.nodeSourceMap.delete('mail-coord');
    globalSourceMaps.nodeSourceMap.delete('mail-worker');
    if (previous === undefined) delete process.env.ORCA_APPDATA_DIR; else process.env.ORCA_APPDATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('server/orca/graphWorkers', () => {
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
