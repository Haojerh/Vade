import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotManager } from './snapshot.js';
import { CommandRunner, CliError } from './cli.js';
import { hashId, globalSourceMaps } from './orca.js';

describe('server/snapshot', () => {
  test('SnapshotManager deduplicates in-flight calls and creates stable revisions', async () => {
    const projApiId = hashId('proj', 'snap-test-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'snap-test-proj',
      repoIds: ['repo-snap'],
      paths: ['C:\\snap-test'],
    });

    let cliCalls = 0;
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        cliCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-1',
                  repoId: 'repo-snap',
                  path: 'C:\\snap-test',
                  workspaceStatus: 'in-progress',
                  status: 'working',
                  terminalVerdict: 'live',
                  agents: [],
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
          stdout: JSON.stringify({ ok: true, result: { terminals: [] } }),
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
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const manager = new SnapshotManager(fakeRunner);

    // Call getSnapshot twice concurrently
    const [s1, s2] = await Promise.all([
      manager.getSnapshot(projApiId, null, fakeRunner),
      manager.getSnapshot(projApiId, null, fakeRunner),
    ]);

    assert.equal(cliCalls, 1);
    assert.equal(s1.revision, s2.revision);
    assert.ok(s1.revision.startsWith('rev_'));
    assert.equal(s1.projectId, projApiId);
    assert.equal(s1.graph.data?.nodes.length, 1);
  });

  test('R2: Preserves last successful graph as stale on failure and does not hardcode version', async () => {
    const projApiId = hashId('proj', 'stale-test-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'stale-test-proj',
      repoIds: ['repo-stale'],
      paths: ['C:\\stale-test'],
    });

    const successRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-stale-1',
                  repoId: 'repo-stale',
                  path: 'C:\\stale-test',
                  workspaceStatus: 'in-progress',
                  status: 'working',
                  terminalVerdict: 'live',
                  agents: [],
                },
              ],
            },
            _meta: { runtimeId: 'rt-stale' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return { stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('orchestration run-list')) {
        return { stdout: JSON.stringify({ ok: true, result: { runs: [] } }), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const manager = new SnapshotManager(successRunner);

    // 1. Initial successful snapshot
    const initial = await manager.getSnapshot(projApiId, null, successRunner);
    assert.equal(initial.graph.meta.availability, 'ready');
    assert.equal(initial.graph.data?.nodes.length, 1);
    assert.equal(initial.graph.meta.stale, false);
    // Version is observed or null, not hardcoded
    assert.equal(initial.runtime.data?.version, globalSourceMaps.observedAppVersion ?? null);

    // 2. Subsequent failed poll
    const failRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('worktree ps')) {
        throw new CliError('CLI_FAILED', 'Runtime disconnected');
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const failed = await manager.getSnapshot(projApiId, null, failRunner);
    // Graph data is preserved, NOT overwritten with empty failure
    assert.ok(failed.graph.data);
    assert.equal(failed.graph.data.nodes.length, 1);
    assert.equal(failed.graph.meta.availability, 'unavailable');
    assert.equal(failed.graph.meta.stale, true);
    assert.equal(failed.graph.data.nodes[0].stale, true);
    assert.equal(failed.graph.data.nodes[0].liveness, 'unverifiable');
    assert.ok(failed.graph.meta.issue);
  });

  test('SnapshotManager enforces max 10 concurrent subscribers', () => {
    const manager = new SnapshotManager();
    const projApiId = hashId('proj', 'subscriber-test');
    const unsubs: (() => void)[] = [];

    // Register 10 subscribers
    for (let i = 0; i < 10; i++) {
      unsubs.push(manager.subscribe(projApiId, null, () => {}));
    }

    // 11th should throw RATE_LIMITED
    assert.throws(
      () => manager.subscribe(projApiId, null, () => {}),
      (err: any) => err.issue?.code === 'RATE_LIMITED'
    );

    // Cleanup
    for (const u of unsubs) u();
  });

  test('SnapshotManager.getNodeDetails resolves run-aware graph and caches details', async () => {
    const projApiId = hashId('proj', 'details-test-proj');
    const nodeId = hashId('node', 'wt-node-1');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'details-test-proj',
      repoIds: ['repo-snap'],
      paths: ['C:\\snap-test'],
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
                  worktreeId: 'wt-node-1',
                  repoId: 'repo-snap',
                  path: 'C:\\snap-test',
                  workspaceStatus: 'in-progress',
                  status: 'working',
                  terminalVerdict: 'live',
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
      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { runs: [{ id: 'run_test_1', objective: 'Test 1' }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('worker-list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: { workers: [{ resource: { worktreeId: 'wt-node-1' } }] },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const manager = new SnapshotManager(fakeRunner);
    const runApiId = hashId('run', 'run_test_1');
    const details = await manager.getNodeDetails(projApiId, nodeId, { runId: runApiId, limit: 100 }, fakeRunner);

    assert.ok(details.node);
    assert.equal(details.node.id, nodeId);
    assert.ok(details.conversation);
  });
});
