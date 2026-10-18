import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CommandRunner, CliError } from '../cli.js';
import { hashId } from './utils.js';
import { globalSourceMaps } from './state.js';
import { collectGraph } from './graph.js';
import { readAntigravityModel } from '../../providers/antigravity.js';

describe('server/orca/graph', () => {
  test('resumed Antigravity uses latest exact-conversation generation metadata without launch settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-antigravity-model-'));
    const oldAppData = process.env.ORCA_APPDATA_DIR;
    const oldGemini = process.env.GEMINI_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = dir;
    process.env.GEMINI_APPDATA_DIR = dir;
    let db: DatabaseSync | null = null;
    const varint = (value: number) => {
      const bytes: number[] = [];
      do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
      return Buffer.from(bytes);
    };
    const field = (number: number, value: Uint8Array | string) => {
      const data = Buffer.from(value);
      return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
    };
    try {
      fs.mkdirSync(path.join(dir, 'conversations'));
      const hooks = path.join(dir, 'orca', 'agent-hooks');
      fs.mkdirSync(hooks, { recursive: true });
      db = new DatabaseSync(path.join(dir, 'conversations', 'resumed-session.db'));
      db.exec(`CREATE TABLE trajectory_meta (cascade_id TEXT); INSERT INTO trajectory_meta VALUES ('resumed-session');
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);`);
      const insert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
      insert.run(1, field(3, field(28, 'gemini-3.8-flash-low')));
      insert.run(2, Buffer.concat([
        field(3, field(28, 'gemini-4-argon-high')),
        field(9, 'Prompt mentions claude-opus-5-5-low; this is not metadata'),
      ]));
      fs.writeFileSync(path.join(hooks, 'last-status.json'), JSON.stringify({ entries: {
        'resumed-pane': { source: 'antigravity', worktreeId: 'ag-wt', payload: {},
          providerSession: { key: 'conversation_id', id: 'resumed-session' } },
      } }));
      const projectId = hashId('proj', 'antigravity-resumed');
      globalSourceMaps.projectSourceMap.set(projectId, { sourceId: 'antigravity-resumed', repoIds: ['ag-repo'], paths: [] });
      const runner: CommandRunner = async (_exe, args) => {
        const result = args[0] === 'worktree' ? { worktrees: [{
          worktreeId: 'ag-wt', repoId: 'ag-repo', agents: [{ paneKey: 'resumed-pane', agentType: 'antigravity' }],
        }] } : args[0] === 'terminal' ? { terminals: [] } : { runs: [] };
        return { stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 };
      };
      const graph = (await collectGraph(projectId, null, runner)).graph;
      const node = graph.nodes.find((n) => n.agentType === 'antigravity')!;
      assert.equal(node.model, 'gemini-4-argon');
      assert.equal(node.effort, 'high');
      assert.equal(readAntigravityModel('resumed-session', () => false), null, 'Reject disallowed paths');
      assert.equal(readAntigravityModel('../resumed-session', () => true), null, 'Reject traversal');
      db.exec("UPDATE trajectory_meta SET cascade_id = 'another-session'");
      assert.equal(readAntigravityModel('resumed-session', () => true), null, 'Reject cross-session DB');
      db.exec("UPDATE trajectory_meta SET cascade_id = 'resumed-session'");
      insert.run(3, field(1, field(19, 'backend-model')));
      assert.deepEqual(readAntigravityModel('resumed-session', () => true), { model: 'backend-model', effort: null });
      insert.run(4, Buffer.from([0x1a, 0xff]));
      assert.equal(readAntigravityModel('resumed-session', () => true), null, 'Malformed current metadata cannot reuse older settings');
      insert.run(5, Buffer.alloc(2097153));
      assert.equal(readAntigravityModel('resumed-session', () => true), null, 'Bound metadata reads');
    } finally {
      db?.close();
      if (oldAppData === undefined) delete process.env.ORCA_APPDATA_DIR;
      else process.env.ORCA_APPDATA_DIR = oldAppData;
      if (oldGemini === undefined) delete process.env.GEMINI_APPDATA_DIR;
      else process.env.GEMINI_APPDATA_DIR = oldGemini;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('standalone Codex nodes get current model and effort from exact pane hooks and recent turn context', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-standalone-model-'));
    const oldAppData = process.env.ORCA_APPDATA_DIR;
    process.env.ORCA_APPDATA_DIR = dir;
    try {
      const hooks = path.join(dir, 'orca', 'agent-hooks');
      fs.mkdirSync(hooks, { recursive: true });
      const transcript = path.join(dir, 'session.jsonl');
      const turn = (model: string, effort: string) => JSON.stringify({ type: 'turn_context', payload: { model, effort } }) + '\n';
      fs.writeFileSync(transcript, turn('old-model', 'low') + '\n' + turn('current-model', 'high') + ' '.repeat(600 * 1024) + '\n');
      const entries = {
        'standalone-pane': { paneKey: 'standalone-pane', source: 'codex', worktreeId: 'standalone-wt',
          payload: { model: 'hook-model' }, providerSession: { id: 'exact-session', transcriptPath: transcript } },
        'effort-pane': { paneKey: 'effort-pane', source: 'codex', payload: { effort: 'medium' } },
        'wrong-pane': { source: 'codex', worktreeId: 'other-wt', payload: { model: 'wrong-model', effort: 'low' } },
      };
      fs.writeFileSync(path.join(hooks, 'last-status.json'), JSON.stringify({ entries }));
      const projectId = hashId('proj', 'standalone-model');
      globalSourceMaps.projectSourceMap.set(projectId, { sourceId: 'standalone-model', repoIds: ['standalone-repo'], paths: [] });
      const runner: CommandRunner = async (_exe, args) => {
        const result = args[0] === 'worktree' ? { worktrees: [{
          worktreeId: 'standalone-wt', repoId: 'standalone-repo',
          agents: ['standalone-pane', 'effort-pane', 'wrong-pane'].map((paneKey) => ({ paneKey, agentType: 'codex' })),
        }] } : args[0] === 'terminal' ? { terminals: [] } : { runs: [] };
        return { stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 };
      };
      const first = await collectGraph(projectId, null, runner);
      const node = first.graph.nodes.find((n) => n.id === hashId('node', 'standalone-pane'))!;
      assert.equal(node.model, 'current-model');
      assert.equal(node.effort, 'high');
      const effortOnly = first.graph.nodes.find((n) => n.id === hashId('node', 'effort-pane'))!;
      assert.equal(effortOnly.model, null);
      assert.equal(effortOnly.effort, 'medium');
      assert.equal(first.graph.nodes.find((n) => n.id === hashId('node', 'wrong-pane'))?.model, null);
      fs.appendFileSync(transcript, turn('changed-model', 'xhigh'));
      const next = await collectGraph(projectId, null, runner);
      assert.equal(next.graph.nodes.find((n) => n.id === node.id)?.model, 'changed-model');
      assert.equal(next.graph.nodes.find((n) => n.id === node.id)?.effort, 'xhigh');
    } finally {
      if (oldAppData === undefined) delete process.env.ORCA_APPDATA_DIR;
      else process.env.ORCA_APPDATA_DIR = oldAppData;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collectGraph populates model and effort on standalone / resumed Kilo agent nodes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-kilo-node-'));
    const oldAppData = process.env.ORCA_APPDATA_DIR;
    const oldKilo = process.env.KILO_DB;
    process.env.ORCA_APPDATA_DIR = dir;
    const kiloDbPath = path.join(dir, 'kilo.db');
    process.env.KILO_DB = kiloDbPath;
    const kdb = new DatabaseSync(kiloDbPath);
    try {
      kdb.exec('CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT);');
      kdb.prepare('INSERT INTO session VALUES(?, ?, ?, ?)').run(
        'ses_kilo_standalone',
        'Refactor Module',
        'C:/work/kilo-wt',
        JSON.stringify({ id: 'nvidia/nemotron-3.5-super-vl:free', providerID: 'kilo' })
      );

      const projectId = hashId('proj', 'kilo-standalone-proj');
      globalSourceMaps.projectSourceMap.set(projectId, { sourceId: 'kilo-standalone-proj', repoIds: ['kilo-repo'], paths: [] });
      const runner: CommandRunner = async (_exe, args) => {
        const result = args[0] === 'worktree' ? { worktrees: [{
          worktreeId: 'kilo-wt', repoId: 'kilo-repo',
          agents: [{ paneKey: 'kilo-pane', agentType: 'kilo' }],
        }] } : args[0] === 'terminal' ? {
          terminals: [{
            handle: 'kilo-term-1',
            worktreeId: 'kilo-wt',
            title: 'Kilo CLI | Refactor Module',
            agentIdentity: 'kilo',
            paneKey: 'kilo-pane',
          }],
        } : { runs: [] };
        return { stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 };
      };

      const { graph } = await collectGraph(projectId, null, runner);
      const kiloNode = graph.nodes.find((n) => n.agentType === 'kilo')!;
      assert.ok(kiloNode, 'Kilo node must exist');
      assert.equal(kiloNode.model, 'nvidia/nemotron-3.5-super-vl:free');
    } finally {
      kdb.close();
      if (oldAppData === undefined) delete process.env.ORCA_APPDATA_DIR;
      else process.env.ORCA_APPDATA_DIR = oldAppData;
      if (oldKilo === undefined) delete process.env.KILO_DB;
      else process.env.KILO_DB = oldKilo;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collectGraph discovers terminals concurrently with at most four CLI calls in flight', async () => {
    const projectId = hashId('proj', 'parallel-terminals');
    globalSourceMaps.projectSourceMap.set(projectId, { sourceId: 'parallel-terminals', repoIds: ['parallel-repo'], paths: [] });
    let inFlight = 0;
    let peak = 0;
    let terminalCalls = 0;
    const runner: CommandRunner = async (_exe, args) => {
      let result: object = {};
      if (args[0] === 'worktree') {
        result = { worktrees: Array.from({ length: 6 }, (_, i) => ({ worktreeId: `parallel-${i}`, repoId: 'parallel-repo', agents: [] })) };
      } else if (args[0] === 'terminal') {
        terminalCalls++;
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        result = { terminals: [] };
      } else {
        result = { runs: [] };
      }
      return { stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 };
    };
    const { graph } = await collectGraph(projectId, null, runner);
    assert.equal(graph.nodes.length, 6);
    assert.equal(terminalCalls, 6);
    assert.equal(peak, 4);
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
                  id: 'run_older_shared_coordinator',
                  objective: 'Older run using the same coordinator',
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

    // Both coordinator-associated runs are included; the foreign run is excluded.
    assert.equal(graph.runs.length, 2);
    assert.equal(graph.runs[0].sourceRunId, 'run_1');
    assert.equal(graph.runs[0].association, 'coordinator-terminal');

    // Nodes: worktree, coordinator (orchestrator), worker (agent), shell (terminal)
    assert.equal(graph.nodes.length, 4);

    const coordNode = graph.nodes.find((n) => n.kind === 'orchestrator');
    assert.ok(coordNode);
    assert.equal(coordNode.state, 'working');
    assert.equal(coordNode.runId, graph.selectedRunId);
    assert.equal(coordNode.runId, hashId('run', 'run_1'));

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

    const olderRunId = hashId('run', 'run_older_shared_coordinator');
    const older = await collectGraph(projApiId, olderRunId, fakeRunner);
    assert.equal(older.graph.nodes.find((n) => n.id === coordNode.id)?.runId, olderRunId);

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

  test('collectGraph detects open agent tab with agentIdentity as agent node before chatting begins', async () => {
    const projId = hashId('proj', 'proj_unstarted_agent');
    globalSourceMaps.projectSourceMap.set(projId, {
      sourceId: 'proj_unstarted_agent',
      repoIds: ['repo_unstarted'],
      paths: ['C:/wt_unstarted'],
    });

    const runner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'repo_unstarted::C:/wt_unstarted',
                  repoId: 'repo_unstarted',
                  path: 'C:/wt_unstarted',
                  displayName: 'main',
                  status: 'idle',
                  agents: [], // No chat history or active dispatches yet!
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
                  handle: 'term_codex_idle',
                  tabId: 'tab_codex',
                  leafId: 'leaf_codex',
                  connected: true,
                  title: 'Codex Tab',
                  agentIdentity: 'codex',
                  preview: '› Ask Codex to do anything',
                },
                {
                  handle: 'term_shell_plain',
                  tabId: 'tab_shell',
                  leafId: 'leaf_shell',
                  connected: true,
                  title: 'cmd.exe',
                  agentIdentity: null,
                },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return {
        stdout: JSON.stringify({ ok: true, result: { runs: [] } }),
        stderr: '',
        exitCode: 0,
      };
    };

    const { graph } = await collectGraph(projId, null, runner);

    const agentNode = graph.nodes.find((n) => n.agentType === 'codex');
    assert.ok(agentNode, 'Agent node with agentType codex should be created');
    assert.equal(agentNode.kind, 'agent', 'Unstarted tab with agentIdentity must be kind: agent');
    assert.equal(agentNode.state, 'idle', 'Unstarted agent tab should be idle');
    assert.equal(agentNode.liveness, 'live', 'Connected agent tab should be live');
    assert.equal(agentNode.label, 'Codex Tab');

    const shellNode = graph.nodes.find((n) => n.label === 'cmd.exe');
    assert.ok(shellNode, 'Shell terminal should be created');
    assert.equal(shellNode.kind, 'terminal', 'Plain shell terminal without agentIdentity remains kind: terminal');
  });
});
