import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentCatalog, getOrcaUserSettings, isCommandInstalled, KNOWN_AGENTS } from './agents.js';

describe('agents integration', () => {
  it('defines the known Orca agents catalog', () => {
    assert.ok(KNOWN_AGENTS.length >= 40);
    const codex = KNOWN_AGENTS.find((a) => a.id === 'codex');
    assert.ok(codex);
    assert.equal(codex?.detectCmd, 'codex');
    assert.equal(codex?.defaultFlags, '--dangerously-bypass-approvals-and-sandbox');
    assert.equal(codex?.isDefault, true);

    const claude = KNOWN_AGENTS.find((a) => a.id === 'claude');
    assert.ok(claude);
    assert.equal(claude?.defaultFlags, '--dangerously-skip-permissions');

    const agy = KNOWN_AGENTS.find((a) => a.id === 'antigravity');
    assert.ok(agy);
    assert.equal(agy?.detectCmd, 'agy');
  });

  it('detects commands safely without throwing', () => {
    assert.equal(isCommandInstalled(''), false);
    assert.equal(isCommandInstalled('non_existent_binary_xyz_12345'), false);
  });

  it('returns partitioned installed and available agents', () => {
    const catalog = getAgentCatalog();
    assert.ok(Array.isArray(catalog.installed));
    assert.ok(Array.isArray(catalog.available));
    assert.equal(catalog.installed.length + catalog.available.length, KNOWN_AGENTS.length);

    // Each entry has the expected structure
    for (const item of [...catalog.installed, ...catalog.available]) {
      assert.ok(item.id);
      assert.ok(item.name);
      assert.ok(item.command);
      assert.ok(item.provider);
    }
  });

  it('simulates detection with mock PATH', () => {
    const mockEnv = {
      PATH: process.platform === 'win32' ? 'C:\\dummy\\bin' : '/dummy/bin',
      PATHEXT: '.EXE;.CMD',
    };
    const catalog = getAgentCatalog(mockEnv);
    assert.equal(catalog.installed.length, 0);
    assert.equal(catalog.available.length, KNOWN_AGENTS.length);
  });

  it('reads Orca user settings safely without throwing', () => {
    const settings = getOrcaUserSettings();
    assert.ok(typeof settings === 'object');
    assert.ok(typeof settings.defaultTuiAgent === 'string' || settings.defaultTuiAgent === null);
  });
});
