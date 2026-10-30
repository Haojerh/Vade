import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAutoCompactWindow, claudeAutoCompactWindows, claudeSettingsFile } from '../claude/claudeSettings.js';

test('Claude settings supply the configured auto-compact window without running /context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-claude-settings-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      modelSettings: {
        'workbuddy-ai/glm-5.3-flash': { effortLevel: 'low' },
        'opencode-zen/deepseek-v4.1-flash-free': { effortLevel: 'low', autoCompactWindow: 500000 },
        'bad-window': { autoCompactWindow: '500k' },
        'negative-window': { autoCompactWindow: -1 },
      },
      autoCompactWindow: 272000,
    }));
    const windows = claudeAutoCompactWindows(file);
    assert.equal(windows.defaultWindow, 272000);
    assert.equal(claudeAutoCompactWindow('opencode-zen/deepseek-v4.1-flash-free', windows), 500000);
    // A model without its own entry follows the CLI default; a model with no
    // configuration at all stays unknown rather than borrowing another model's window.
    assert.equal(claudeAutoCompactWindow('workbuddy-ai/glm-5.3-flash', windows), 272000);
    assert.equal(claudeAutoCompactWindow(undefined, windows), 272000);
    assert.equal(claudeAutoCompactWindow('bad-window', windows), 272000);
    assert.equal(claudeAutoCompactWindow('negative-window', windows), 272000);
    assert.equal(claudeAutoCompactWindow('opencode-zen/deepseek-v4.1-flash-free'), null, 'no observation-scoped settings means unknown');

    fs.writeFileSync(file, JSON.stringify({ modelSettings: { 'a/b': { autoCompactWindow: 160000 } } }));
    const updated = claudeAutoCompactWindows(file);
    assert.equal(updated.defaultWindow, null, 'an updated settings file replaces the cached reading');
    assert.equal(claudeAutoCompactWindow('a/b', updated), 160000);
    assert.equal(claudeAutoCompactWindow('c/d', updated), null);

    fs.writeFileSync(file, '{');
    assert.deepEqual(claudeAutoCompactWindows(file), { byModel: new Map(), defaultWindow: null });
    fs.rmSync(file);
    assert.deepEqual(claudeAutoCompactWindows(file), { byModel: new Map(), defaultWindow: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Claude settings path follows the CLI configuration directory', () => {
  const prior = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'ade-claude-config');
    assert.equal(claudeSettingsFile(), path.join(os.tmpdir(), 'ade-claude-config', 'settings.json'));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.match(claudeSettingsFile(), /\.claude[\\/]settings\.json$/);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior;
  }
});
