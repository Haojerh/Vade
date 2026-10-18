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

describe('server/orca/inventory', () => {
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
});
