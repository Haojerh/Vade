import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CommandRunner, CliError } from '../cli.js';
import { hashId } from './utils.js';
import { globalSourceMaps } from './state.js';
import { collectNodeDetails, resolveCoordinatorConversation } from './nodeDetails.js';

describe('server/orca/coordinatorDetails', () => {
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

      // The same exact pane provenance works for Codex outside orchestration.
      const standaloneGraph = {
        ...mockGraph,
        runs: [],
        selectedRunId: null,
        nodes: [{ ...mockCoordNode, kind: 'agent' as const, runId: null }],
      };
      fs.appendFileSync(transcriptFile, '\n' + JSON.stringify({
        type: 'response_item', payload: { role: 'assistant', channel: 'analysis',
          content: [{ type: 'output_text', text: 'Private reasoning' }] },
      }) + '\n');
      const standalone = await collectNodeDetails(projId, coordNodeId, { preloadedGraph: standaloneGraph });
      assert.equal(standalone.conversation.meta.availability, 'ready');
      assert.equal(standalone.conversation.data?.provider, 'codex');
      assert.ok(standalone.conversation.data?.messages.some((m) => m.text === 'New user message'));
      assert.ok(!standalone.conversation.data?.messages.some((m) => m.text === 'Private reasoning'));
      const continuation = await collectNodeDetails(projId, coordNodeId, {
        preloadedGraph: standaloneGraph, cursor: standalone.conversation.data?.nextCursor,
      });
      assert.equal(continuation.conversation.data?.messages.length, 0);

      globalSourceMaps.nodeSourceMap.set(coordNodeId, { paneKey: 'different-pane' });
      const unbound = await collectNodeDetails(projId, coordNodeId, { preloadedGraph: standaloneGraph });
      assert.equal(unbound.conversation.meta.availability, 'unsupported');
    } finally {
      if (oldAppData !== undefined) {
        process.env.ORCA_APPDATA_DIR = oldAppData;
      } else {
        delete process.env.ORCA_APPDATA_DIR;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
});
