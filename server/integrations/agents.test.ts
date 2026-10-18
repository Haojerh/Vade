import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentCatalog, getOrcaUserSettings, isCommandInstalled, KNOWN_AGENTS } from './agents.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('agents integration', () => {
  it('reads the selected Orca profile default and command settings from its database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agent-settings-'));
    try {
      fs.writeFileSync(path.join(dir, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'profile-test' }));
      const profile = path.join(dir, 'profiles', 'profile-test');
      fs.mkdirSync(profile, { recursive: true });
      const db = new DatabaseSync(path.join(profile, 'profile-state.db'));
      try {
        db.exec('CREATE TABLE profile_state_documents (domain TEXT, payload BLOB)');
        db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('settings', JSON.stringify({ defaultTuiAgent: 'claude', agentDefaultArgs: { claude: '--test-flag' }, agentCmdOverrides: { claude: 'custom-claude' } }));
      } finally { db.close(); }
      assert.deepEqual(getOrcaUserSettings(dir), { defaultTuiAgent: 'claude', agentDefaultArgs: { claude: '--test-flag' }, agentCmdOverrides: { claude: 'custom-claude' } });
      assert.deepEqual(getOrcaUserSettings(path.join(dir, 'missing')), { defaultTuiAgent: null });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
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
