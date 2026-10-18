import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CommandRunner, CliError } from '../cli.js';
import {
  hashId,
  mapToState,
  normalizeLiveness,
  stripAnsi,
  toIsoOrNull,
  readBoundedTranscriptLines,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
} from './utils.js';
import { globalSourceMaps, cursorStore, workerLaunchCache } from './state.js';
import { collectInventory } from './inventory.js';
import { collectGraph } from './graph.js';
import { collectNodeDetails, resolveCoordinatorConversation } from './nodeDetails.js';
import {
  deleteWorktree,
  closeAgentTab,
  renameNodeTitle,
  createWorktreeAgent,
} from './actions.js';
import { checkPrerequisites } from './prerequisites.js';
import {
  readAntigravityModel,
  isAntigravityChatRecord,
  resolveAntigravityConversation,
} from '../../providers/antigravity.js';
import { findCodexTranscript } from '../../providers/codex.js';

describe('server/orca/actions', () => {
  test('deleteWorktree executes orca worktree rm with selector and --force', async () => {
    const executed: string[][] = [];
    const fakeRunner: CommandRunner = async (_exe, args) => {
      executed.push(args);
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', exitCode: 0 };
    };

    globalSourceMaps.nodeSourceMap.set('node_wt1', { worktreeId: 'repo-1::C:/wt1' });
    const res = await deleteWorktree('proj_1', 'node_wt1', fakeRunner);
    assert.equal(res.ok, true);
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], ['worktree', 'rm', '--worktree', 'id:repo-1::C:/wt1', '--force', '--json']);
    assert.equal(globalSourceMaps.nodeSourceMap.has('node_wt1'), false);
  });

  test('deleteWorktree throws NODE_NOT_FOUND when worktree cannot be resolved', async () => {
    const fakeRunner: CommandRunner = async () => ({
      stdout: JSON.stringify({ ok: true, result: { worktrees: [] } }),
      stderr: '',
      exitCode: 0,
    });
    await assert.rejects(
      () => deleteWorktree('proj_1', 'node_unknown_wt', fakeRunner),
      (err: any) => err.issue.code === 'NODE_NOT_FOUND'
    );
  });

  test('closeAgentTab executes orca terminal close with handle and --tab', async () => {
    const executed: string[][] = [];
    const fakeRunner: CommandRunner = async (_exe, args) => {
      executed.push(args);
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', exitCode: 0 };
    };

    globalSourceMaps.nodeSourceMap.set('node_agent1', { handle: 'term_123', worktreeId: 'repo-1::C:/wt1' });
    const res = await closeAgentTab('proj_1', 'node_agent1', fakeRunner);
    assert.equal(res.ok, true);
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], ['terminal', 'close', '--terminal', 'term_123', '--tab', '--json']);
  });

  test('closeAgentTab recovers handle from worktree terminals when handle is missing', async () => {
    const executed: string[][] = [];
    const fakeRunner: CommandRunner = async (_exe, args) => {
      executed.push(args);
      if (args[0] === 'terminal' && args[1] === 'list') {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              terminals: [
                { handle: 'term_discovered', tabId: 'tab1', leafId: 'leaf1', connected: true },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', exitCode: 0 };
    };

    globalSourceMaps.nodeSourceMap.set('node_agent2', { worktreeId: 'repo-1::C:/wt1', paneKey: 'tab1:leaf1' });
    const res = await closeAgentTab('proj_1', 'node_agent2', fakeRunner);
    assert.equal(res.ok, true);
    assert.deepEqual(executed[1], ['terminal', 'close', '--terminal', 'term_discovered', '--tab', '--json']);
  });

  test('renameNodeTitle executes orca terminal rename with handle and title', async () => {
    const executed: string[][] = [];
    const fakeRunner: CommandRunner = async (_exe, args) => {
      executed.push(args);
      return { stdout: JSON.stringify({ ok: true, result: {} }), stderr: '', exitCode: 0 };
    };

    globalSourceMaps.nodeSourceMap.set('node_agent_rename', { handle: 'term_456', worktreeId: 'repo-1::C:/wt1' });
    const res = await renameNodeTitle('proj_1', 'node_agent_rename', 'New Title', fakeRunner);
    assert.equal(res.ok, true);
    assert.equal(res.title, 'New Title');
    assert.deepEqual(executed[0], ['terminal', 'rename', '--terminal', 'term_456', '--title', 'New Title', '--json']);

    // Empty title resets title
    executed.length = 0;
    const resReset = await renameNodeTitle('proj_1', 'node_agent_rename', '', fakeRunner);
    assert.equal(resReset.ok, true);
    assert.equal(resReset.title, '');
    assert.deepEqual(executed[0], ['terminal', 'rename', '--terminal', 'term_456', '--json']);
  });

  test('createWorktreeAgent executes orca terminal create with worktree selector and command', async () => {
    const executed: string[][] = [];
    const fakeRunner: CommandRunner = async (_exe, args) => {
      executed.push(args);
      return {
        stdout: JSON.stringify({
          ok: true,
          result: { terminal: { handle: 'term_created_123' } },
        }),
        stderr: '',
        exitCode: 0,
      };
    };

    globalSourceMaps.nodeSourceMap.set('node_wt_create', { worktreeId: 'repo-1::C:/wt1', worktreePath: 'C:/wt1' });
    const res = await createWorktreeAgent('proj_1', 'node_wt_create', 'codex', 'My Codex', fakeRunner);
    assert.equal(res.ok, true);
    assert.equal(res.handle, 'term_created_123');
    assert.equal(res.title, 'My Codex');
    assert.deepEqual(executed[0], [
      'terminal',
      'create',
      '--worktree',
      'path:C:/wt1',
      '--command',
      'codex',
      '--title',
      'My Codex',
      '--json',
    ]);
  });
});
