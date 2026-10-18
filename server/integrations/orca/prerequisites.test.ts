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

describe('server/orca/prerequisites', () => {
  test('checkPrerequisites reports ready when Orca app, CLI, and orchestration skill are present', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: true },
              runtime: {
                state: 'ready',
                appVersion: '1.4.224',
                capabilities: ['orchestration.contract.v1', 'orchestration.federation.v1'],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const result = await checkPrerequisites(fakeRunner, { checkAppInstallation: () => true, checkCliSkillInstallation: () => true });
    assert.equal(result.orcaApp, true);
    assert.equal(result.orcaCli, true);
    assert.equal(result.orchestrationSkill, true);
    assert.equal(result.orcaCliSkill, true);
    assert.equal(result.ready, true);
    assert.equal(result.version, '1.4.224');
    assert.equal(result.issues, undefined);
  });

  test('checkPrerequisites reports not ready and missing app when Orca desktop app is not installed', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              // App is not running/present
              runtime: {
                state: 'ready',
                capabilities: ['orchestration.contract.v1'],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const result = await checkPrerequisites(fakeRunner, { checkAppInstallation: () => false, checkCliSkillInstallation: () => true });
    assert.equal(result.orcaApp, false);
    assert.equal(result.ready, false);
    assert.ok(result.issues?.some((i) => i.includes('desktop application is not installed')));
  });

  test('checkPrerequisites reports not ready when CLI is missing', async () => {
    const fakeRunner: CommandRunner = async () => {
      throw new CliError('CLI_MISSING', 'orca command not found');
    };

    const result = await checkPrerequisites(fakeRunner, { checkAppInstallation: () => true, checkCliSkillInstallation: () => true });
    assert.equal(result.orcaCli, false);
    assert.equal(result.orchestrationSkill, false);
    assert.equal(result.ready, false);
    assert.ok(result.issues?.some((i) => i.includes('Orca CLI is not installed')));
  });

  test('checkPrerequisites reports not ready when orchestration skill is missing', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: true },
              runtime: {
                state: 'ready',
                capabilities: ['session.tabs.v1'], // No orchestration capability
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('orchestration run-list')) {
        throw new CliError('CLI_FAILED', 'unknown command orchestration');
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const result = await checkPrerequisites(fakeRunner, { checkAppInstallation: () => true, checkCliSkillInstallation: () => true });
    assert.equal(result.orcaApp, true);
    assert.equal(result.orcaCli, true);
    assert.equal(result.orchestrationSkill, false);
    assert.equal(result.ready, false);
    assert.ok(result.issues?.some((i) => i.includes('Orchestration skill is not installed')));
  });

  test('checkPrerequisites reports not ready when orca-cli skill is missing', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: true },
              runtime: {
                state: 'ready',
                capabilities: ['orchestration.contract.v1'],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const result = await checkPrerequisites(fakeRunner, { checkAppInstallation: () => true, checkCliSkillInstallation: () => false });
    assert.equal(result.orcaApp, true);
    assert.equal(result.orcaCli, true);
    assert.equal(result.orchestrationSkill, true);
    assert.equal(result.orcaCliSkill, false);
    assert.equal(result.ready, false);
    assert.ok(result.issues?.some((i) => i.includes('Orca CLI skill (orca-cli) is not installed')));
  });

  test('checkPrerequisites reports not ready when Orca desktop app is closed / not running', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: false },
              runtime: {
                state: 'ready',
                capabilities: ['orchestration.contract.v1'],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const result = await checkPrerequisites(fakeRunner, {
      checkAppInstallation: () => true,
      checkCliSkillInstallation: () => true,
      checkOrchestrationSkillInstallation: () => true,
    });
    assert.equal(result.orcaApp, true);
    assert.equal(result.orcaAppOpen, false);
    assert.equal(result.ready, false);
    assert.ok(result.issues?.some((i) => i.includes('closed / not running')));
  });

  test('checkPrerequisites queries orca skills installed --json authoritatively for home skills', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: true, desktopWindowStatus: 'available' },
              runtime: {
                state: 'ready',
                capabilities: ['orchestration.contract.v1'],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('skills installed')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              skills: [
                { name: 'orchestration', sourceKind: 'home' },
                { name: 'orca-cli', sourceKind: 'home' },
                { name: 'custom-skill', sourceKind: 'home' },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const res = await checkPrerequisites(fakeRunner, {
      checkAppInstallation: () => true,
      checkCliInstallation: () => true,
    });
    assert.equal(res.orcaCli, true);
    assert.equal(res.orchestrationSkill, true);
    assert.equal(res.orcaCliSkill, true);
    assert.equal(res.orcaAppOpen, true);
    assert.equal(res.ready, true);
  });

  test('checkPrerequisites rejects skills with repo sourceKind from authoritative listing', async () => {
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: true, desktopWindowStatus: 'available' },
              runtime: {
                state: 'ready',
                capabilities: ['orchestration.contract.v1'],
              },
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('skills installed')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              skills: [
                // In a repo worktree, NOT home installed
                { name: 'orchestration', sourceKind: 'repo' },
                { name: 'orca-cli', sourceKind: 'repo' },
              ],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const res = await checkPrerequisites(fakeRunner, {
      checkAppInstallation: () => true,
      checkCliInstallation: () => true,
    });
    assert.equal(res.orchestrationSkill, false);
    assert.equal(res.orcaCliSkill, false);
    assert.equal(res.ready, false);
  });
});
