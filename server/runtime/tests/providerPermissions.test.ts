import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentChatOptions } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { saveAgentPreferences } from '../system/agentPreferences.js';
import {
  findVerifiedSessionTranscript,
  isAgentPermissionMode,
  permissionRestartResumable,
  providerPermissionChoices,
  readProviderPermissionState,
  recordPermissionLaunchBoundary,
  resolveSessionLaunchPermission,
  validateProviderPermissionRequest,
  withProviderPermissions,
} from '../chat/controls/providerPermissions.js';
import { AdeStore, type SessionRecord } from '../store.js';

function createBaseOptions(overrides: Partial<AgentChatOptions> = {}): AgentChatOptions {
  return {
    provider: 'claude',
    transport: 'terminal',
    models: [],
    current: {},
    controls: {
      model: true,
      effort: true,
      fastMode: false,
      fastToggle: false,
      serviceTier: false,
      providerPicker: false,
    },
    ...overrides,
  };
}

function createRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: crypto.randomUUID(),
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/workspace',
    provider: 'claude',
    providerThreadId: crypto.randomUUID(),
    statusToken: 'a'.repeat(64),
    title: 'Agent',
    createdAt: new Date().toISOString(),
    closed: false,
    ...overrides,
  };
}

test('providerPermissionChoices exposes only allowlisted multi-mode launch catalogs and keeps DSH/OpenCode2 separate', () => {
  assert.deepEqual(
    providerPermissionChoices('codex').map(choice => choice.value),
    ['manual', 'auto', 'yolo'],
  );
  assert.deepEqual(
    providerPermissionChoices('claude').map(choice => choice.value),
    ['manual', 'auto', 'yolo'],
  );
  assert.deepEqual(
    providerPermissionChoices('codebuddy').map(choice => choice.value),
    ['manual', 'auto', 'yolo'],
  );
  assert.deepEqual(
    providerPermissionChoices('antigravity').map(choice => choice.value),
    ['manual', 'yolo'],
  );
  assert.deepEqual(
    providerPermissionChoices('opencode').map(choice => choice.value),
    ['manual', 'yolo'],
  );
  assert.deepEqual(
    providerPermissionChoices('kilo').map(choice => choice.value),
    ['manual', 'yolo'],
  );
  assert.deepEqual(providerPermissionChoices('opencode2'), []);
  assert.deepEqual(providerPermissionChoices('dsh'), []);
  assert.deepEqual(providerPermissionChoices('terminal'), []);

  assert.equal(isAgentPermissionMode('manual'), true);
  assert.equal(isAgentPermissionMode('auto'), true);
  assert.equal(isAgentPermissionMode('yolo'), true);
  assert.equal(isAgentPermissionMode('--dangerously-skip-permissions'), false);
  assert.equal(isAgentPermissionMode('plan'), false);
  assert.equal(isAgentPermissionMode(''), false);
  assert.equal(isAgentPermissionMode(null), false);
});

test('readProviderPermissionState and withProviderPermissions do not fabricate current mode from global preferences when launch and native evidence are absent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-perm-pref-'));
  const store = new AdeStore(tmpDir);
  try {
    saveAgentPreferences(store, {
      defaultAgent: 'codex',
      providers: {
        codex: { enabled: true, mode: 'yolo' },
        claude: { enabled: true, mode: 'auto' },
        antigravity: { enabled: true, mode: 'yolo' },
        codebuddy: { enabled: true, mode: 'yolo' },
        opencode: { enabled: true, mode: 'yolo' },
        opencode2: { enabled: true, mode: 'manual' },
        kilo: { enabled: true, mode: 'yolo' },
        dsh: { enabled: true, mode: 'manual' },
        freebuff: { enabled: true, mode: 'manual' },
      },
    });

    const record = createRecord({
      provider: 'codex',
      cwd: tmpDir,
      launchPermission: undefined,
      permissionOverride: undefined,
    });

    const state = readProviderPermissionState(record, { resumable: true, live: true });
    assert.equal(state.current, undefined);
    assert.equal(state.source, undefined);
    assert.equal(state.permissionsRequireRestart, true);
    assert.equal(state.resumable, true);
    assert.equal(state.permissions.length, 3);

    const options = withProviderPermissions(createBaseOptions({ provider: 'codex' }), record, {
      resumable: true,
      live: true,
    });
    assert.equal(options.current.permission, undefined);
    assert.equal(options.permissionCurrentSource, undefined);
    assert.equal(options.permissionsRequireRestart, true);
    assert.equal(options.permissions?.length, 3);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveSessionLaunchPermission records configured launch mode and returns allowlisted CLI flags', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-perm-launch-'));
  const store = new AdeStore(tmpDir);
  try {
    saveAgentPreferences(store, {
      defaultAgent: 'claude',
      providers: {
        codex: { enabled: true, mode: 'manual' },
        claude: { enabled: true, mode: 'auto' },
        antigravity: { enabled: true, mode: 'manual' },
        codebuddy: { enabled: true, mode: 'manual' },
        opencode: { enabled: true, mode: 'manual' },
        opencode2: { enabled: true, mode: 'manual' },
        kilo: { enabled: true, mode: 'manual' },
        dsh: { enabled: true, mode: 'manual' },
        freebuff: { enabled: true, mode: 'manual' },
      },
    });

    const baseRecord = createRecord({ provider: 'claude', cwd: tmpDir });
    const fromDefault = resolveSessionLaunchPermission(store, baseRecord);
    assert.equal(fromDefault.mode, 'auto');
    assert.deepEqual(fromDefault.args, ['--permission-mode', 'auto']);
    assert.equal(fromDefault.record.launchPermission, 'auto');

    const withOverride = resolveSessionLaunchPermission(store, {
      ...baseRecord,
      permissionOverride: 'yolo',
    });
    assert.equal(withOverride.mode, 'yolo');
    assert.deepEqual(withOverride.args, ['--dangerously-skip-permissions']);
    assert.equal(withOverride.record.launchPermission, 'yolo');

    const state = readProviderPermissionState(withOverride.record, { resumable: true, live: true });
    assert.equal(state.current, 'yolo');
    assert.equal(state.source, 'launch');

    const options = withProviderPermissions(createBaseOptions({ provider: 'claude' }), withOverride.record, {
      resumable: true,
      live: true,
    });
    assert.equal(options.current.permission, 'yolo');
    assert.equal(options.permissionCurrentSource, 'launch');
    assert.equal(options.permissionsRequireRestart, true);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readProviderPermissionState observes Claude and CodeBuddy live TUI footer badges and suppresses stale launch mode on non-catalog native modes', () => {
  const record = createRecord({
    provider: 'claude',
    launchPermission: 'manual',
    permissionOverride: 'manual',
  });

  const yoloState = readProviderPermissionState(record, {
    resumable: true,
    live: true,
    screen: '❯ \n  \x1b[31m⏵⏵ bypass permissions on (shift+tab to cycle)\x1b[0m',
  });
  assert.equal(yoloState.current, 'yolo');
  assert.equal(yoloState.source, 'native');

  const autoState = readProviderPermissionState(
    { ...record, provider: 'codebuddy' },
    {
      resumable: true,
      live: true,
      screen: () => '❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)',
    },
  );
  assert.equal(autoState.current, 'auto');
  assert.equal(autoState.source, 'native');

  // '? for shortcuts' alone is a readiness hint, not permission evidence; it preserves launchPermission
  const shortcutsOnlyState = readProviderPermissionState(
    { ...record, launchPermission: 'yolo', permissionOverride: 'yolo' },
    {
      resumable: true,
      live: true,
      screen: '❯ \n  ? for shortcuts',
    },
  );
  assert.equal(shortcutsOnlyState.current, 'yolo');
  assert.equal(shortcutsOnlyState.source, 'launch');

  for (const banner of [
    '⏵⏵ accept edits on (shift+tab to cycle)',
    "⏵⏵ don't ask on (shift+tab to cycle)",
    '⏸ plan mode on (shift+tab to cycle)',
    '⏸ plan + bypass permissions',
  ]) {
    const nonCatalog = readProviderPermissionState(record, {
      resumable: true,
      live: true,
      screen: `❯ \n  ${banner}`,
    });
    assert.equal(nonCatalog.current, undefined);
    assert.equal(nonCatalog.source, 'native');
    assert.ok(nonCatalog.nonCatalogNativeMode);

    const options = withProviderPermissions(
      createBaseOptions({ provider: 'claude', current: { permission: 'manual' } }),
      record,
      { resumable: true, live: true, screen: `❯ \n  ${banner}` },
    );
    assert.equal(options.current.permission, undefined);
    assert.equal(options.permissionCurrentSource, undefined);
    assert.equal(options.permissions?.length, 3);
  }
});

test('Codex and Claude bound transcripts provide verified native evidence, reject foreign provenance, and respect restart launch boundaries', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-perm-transcript-'));
  const prevCodexHome = process.env.CODEX_HOME;
  const prevClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = path.join(tmpDir, 'codex-home');
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'claude-home');

  try {
    const workspace = path.join(tmpDir, 'workspace');
    const foreignWorkspace = path.join(tmpDir, 'foreign-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(foreignWorkspace, { recursive: true });

    // 1. Codex verified transcript
    const codexThreadId = crypto.randomUUID();
    const codexSessionsDir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '28');
    fs.mkdirSync(codexSessionsDir, { recursive: true });
    const codexFile = path.join(codexSessionsDir, `rollout-2026-10-28-${codexThreadId}.jsonl`);
    fs.writeFileSync(
      codexFile,
      [
        JSON.stringify({
          timestamp: '2026-10-28T08:00:00.000Z',
          type: 'session_meta',
          payload: { id: codexThreadId, cwd: workspace },
        }),
        JSON.stringify({
          timestamp: '2026-10-28T08:00:01.000Z',
          type: 'turn_context',
          payload: {
            cwd: workspace,
            approval_policy: 'never',
            sandbox_policy: { type: 'danger-full-access' },
          },
        }),
      ].join('\n') + '\n',
    );

    const codexRecord = createRecord({
      provider: 'codex',
      cwd: workspace,
      providerThreadId: codexThreadId,
      launchPermission: 'manual',
    });
    assert.equal(findVerifiedSessionTranscript(codexRecord), codexFile);

    const codexYolo = readProviderPermissionState(codexRecord, { resumable: true, live: true });
    assert.equal(codexYolo.current, 'yolo');
    assert.equal(codexYolo.source, 'native');

    // Foreign cwd record must not bind to the transcript
    const foreignRecord = createRecord({
      provider: 'codex',
      cwd: foreignWorkspace,
      providerThreadId: codexThreadId,
      launchPermission: 'manual',
    });
    assert.equal(findVerifiedSessionTranscript(foreignRecord), null);
    const foreignState = readProviderPermissionState(foreignRecord, { resumable: true, live: true });
    assert.equal(foreignState.current, 'manual');
    assert.equal(foreignState.source, 'launch');

    // Restart boundary on Codex transcript: pre-restart yolo turn is fenced out until a new turn is written
    const restartedCodex: SessionRecord = {
      ...codexRecord,
      statusToken: 'b'.repeat(64),
      permissionOverride: 'auto',
      launchPermission: 'auto',
    };
    recordPermissionLaunchBoundary(restartedCodex);
    const afterRestartBeforeTurn = readProviderPermissionState(restartedCodex, {
      resumable: true,
      live: true,
    });
    assert.equal(afterRestartBeforeTurn.current, 'auto');
    assert.equal(afterRestartBeforeTurn.source, 'launch');

    fs.appendFileSync(
      codexFile,
      JSON.stringify({
        timestamp: '2026-10-28T08:05:00.000Z',
        type: 'turn_context',
        payload: {
          cwd: workspace,
          approval_policy: 'on-request',
          approvals_reviewer: 'auto_review',
          sandbox_policy: { type: 'workspace-write' },
        },
      }) + '\n',
    );
    const afterPostRestartTurn = readProviderPermissionState(restartedCodex, {
      resumable: true,
      live: true,
    });
    assert.equal(afterPostRestartTurn.current, 'auto');
    assert.equal(afterPostRestartTurn.source, 'native');

    // 2. Claude verified transcript
    const claudeThreadId = crypto.randomUUID();
    const claudeProjectDir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'proj-slug');
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    const claudeFile = path.join(claudeProjectDir, `${claudeThreadId}.jsonl`);
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({
          type: 'permission-mode',
          permissionMode: 'default',
          sessionId: claudeThreadId,
          cwd: workspace,
        }),
        JSON.stringify({
          type: 'user',
          permissionMode: 'bypassPermissions',
          sessionId: claudeThreadId,
          cwd: workspace,
        }),
      ].join('\n') + '\n',
    );

    const claudeRecord = createRecord({
      provider: 'claude',
      cwd: workspace,
      providerThreadId: claudeThreadId,
    });
    assert.equal(findVerifiedSessionTranscript(claudeRecord), claudeFile);
    assert.equal(permissionRestartResumable(claudeRecord), true);

    const claudeState = readProviderPermissionState(claudeRecord, { live: true });
    assert.equal(claudeState.current, 'yolo');
    assert.equal(claudeState.source, 'native');
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('withProviderPermissions and validateProviderPermissionRequest enforce resumability, confirmation, allowlists, and DSH isolation', () => {
  // DSH live options remain untouched with permissionsRequireRestart: false
  const dshRecord = createRecord({ provider: 'dsh' });
  const dshInput = createBaseOptions({
    provider: 'dsh',
    current: { permission: 'workspace-write' },
    permissions: [{ value: 'workspace-write', label: 'Workspace write' }],
  });
  const dshResult = withProviderPermissions(dshInput, dshRecord, { live: true });
  assert.equal(dshResult.permissionsRequireRestart, false);
  assert.equal(dshResult.permissionCurrentSource, 'native');
  assert.deepEqual(dshResult.permissions, dshInput.permissions);

  // Unsaved Claude session (no verified transcript on disk) is not restart-resumable and hides permissions
  const unsavedClaude = createRecord({
    provider: 'claude',
    launchPermission: 'manual',
  });
  assert.equal(permissionRestartResumable(unsavedClaude), false);
  const hiddenClaude = withProviderPermissions(createBaseOptions({ provider: 'claude' }), unsavedClaude, {
    live: true,
  });
  assert.equal(hiddenClaude.permissions, undefined);
  assert.equal(hiddenClaude.current.permission, undefined);

  assert.throws(
    () =>
      validateProviderPermissionRequest(
        unsavedClaude,
        { key: 'permission', value: 'yolo', confirmRestart: true },
        { live: true },
      ),
    (err: unknown) => err instanceof CliError && err.issue.code === 'RUNTIME_UNAVAILABLE',
  );

  // Unsaved Antigravity conversation is refused
  const agyRecord = createRecord({
    provider: 'antigravity',
    launchPermission: 'manual',
  });
  assert.equal(permissionRestartResumable(agyRecord, { savedAgy: () => false }), false);
  assert.equal(permissionRestartResumable(agyRecord, { savedAgy: () => true }), true);

  // Unsupported mode for Antigravity ('auto') is rejected
  assert.throws(
    () =>
      validateProviderPermissionRequest(
        agyRecord,
        { key: 'permission', value: 'auto', confirmRestart: true },
        { live: true, savedAgy: () => true },
      ),
    (err: unknown) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT',
  );

  // Arbitrary CLI flags or unknown strings are rejected
  for (const invalidValue of ['--dangerously-skip-permissions', 'yolo; rm -rf /', 'acceptEdits', '']) {
    assert.throws(
      () =>
        validateProviderPermissionRequest(
          agyRecord,
          { key: 'permission', value: invalidValue, confirmRestart: true },
          { live: true, savedAgy: () => true },
        ),
      (err: unknown) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT',
    );
  }

  // Missing confirmRestart is rejected when changing mode
  assert.throws(
    () =>
      validateProviderPermissionRequest(
        agyRecord,
        { key: 'permission', value: 'yolo' },
        { live: true, savedAgy: () => true },
      ),
    (err: unknown) => err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT',
  );

  // Confirmed valid change returns allowlisted args and noop: false
  const validChange = validateProviderPermissionRequest(
    agyRecord,
    { key: 'permission', value: 'yolo', confirmRestart: true },
    { live: true, savedAgy: () => true },
  );
  assert.equal(validChange.mode, 'yolo');
  assert.deepEqual(validChange.args, ['--dangerously-skip-permissions']);
  assert.equal(validChange.noop, false);

  // Selecting the already-active launch mode is a noop even without confirmRestart
  const noopResult = validateProviderPermissionRequest(
    agyRecord,
    { key: 'permission', value: 'manual' },
    { live: true, savedAgy: () => true },
  );
  assert.equal(noopResult.mode, 'manual');
  assert.equal(noopResult.noop, true);
});
