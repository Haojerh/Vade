import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRunner, CliError } from '../cli.js';
import { hashId } from './utils.js';
import { globalSourceMaps, cursorStore } from './state.js';
import { collectNodeDetails } from './nodeDetails.js';

describe('server/orca/nodeDetails', () => {
  test('collectNodeDetails collects truthful transcript conversation and handles bound cursors', async () => {
    const projApiId = hashId('proj', 'test-proj');
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'test-proj',
      repoIds: ['repo-1'],
      paths: ['C:\\test-proj'],
    });
    globalSourceMaps.runAssociationCache.set(`${projApiId}::run_1`, {
      associated: true,
      association: 'coordinator-terminal',
      coordinatorNodeId: hashId('node', 'tab-1:leaf-1'),
    });
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
                { handle: 'term_coord', tabId: 'tab-1', leafId: 'leaf-1', connected: true, agentIdentity: 'codex' },
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
                  coordinator_handle: 'term_coord',
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
});
