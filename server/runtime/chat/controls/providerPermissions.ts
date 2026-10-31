import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AdeProvider,
  AgentChatOptions,
  AgentPermissionMode,
  SetAgentChatOptionRequest,
} from '../../../../shared/contracts.js';
import { CliError } from '../../../integrations/cli.js';
import { isPathInsideRoots } from '../../../providers/common/transcriptUtils.js';
import { permissionArgs, readAgentPreferences } from '../../system/agentPreferences.js';
import { agyConversationSaved } from '../../../providers/antigravity/agyBinding.js';
import { validCodexThreadId } from '../../../providers/codex/codexThread.js';
import { isOpenCode, validProviderSessionId, verifyOpenCode } from '../../../providers/opencode/openCodeSessions.js';
import { freebuffResumable } from '../../../providers/freebuff/freebuff.js';
import { statusFile } from '../../sessions/statusHooks.js';
import type { AdeStore, SessionRecord } from '../../store.js';

export interface ProviderPermissionChoice {
  value: AgentPermissionMode;
  label: string;
  description: string;
}

export interface ProviderPermissionContext {
  screen?: string | null | (() => string | null);
  directory?: string;
  resumable?: boolean;
  live?: boolean;
  savedAgy?: (record: SessionRecord) => boolean;
}

export interface ProviderPermissionState {
  permissions: ProviderPermissionChoice[];
  current?: AgentPermissionMode;
  source?: 'native' | 'launch';
  permissionsRequireRestart?: boolean;
  resumable: boolean;
  nonCatalogNativeMode?: string;
}

const PERMISSION_MODES: readonly AgentPermissionMode[] = ['manual', 'auto', 'yolo'];

const MODE_LABELS: Readonly<Record<AgentPermissionMode, string>> = {
  manual: 'Ask for approval',
  auto: 'Approve for me',
  yolo: 'Full access',
};

const launchTranscriptOffsets = new Map<string, number>();

function stripAnsi(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
}

function modeDescription(provider: Exclude<AdeProvider, 'terminal'>, mode: AgentPermissionMode): string {
  if (mode === 'manual') {
    return provider === 'codex'
      ? 'Ask on request within the workspace-write sandbox.'
      : 'Keep native approval prompts enabled.';
  }
  if (mode === 'auto') {
    return 'Let the provider review approval requests.';
  }
  return provider === 'codex'
    ? 'Skip native approval prompts and disable the Codex sandbox.'
    : 'Skip native approval prompts. Provider and OS restrictions still apply.';
}

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Pure synchronous catalog of allowlisted permission modes for a provider.
 * Performs no network or subprocess I/O. Returns [] when a provider uses its own
 * live runtime channel (DSH) or offers fewer than two selectable launch modes (OpenCode 2).
 */
export function providerPermissionChoices(provider: AdeProvider): ProviderPermissionChoice[] {
  if (provider === 'terminal' || provider === 'dsh') return [];
  const mapping = permissionArgs[provider];
  if (!mapping) return [];
  const supported = PERMISSION_MODES.filter(mode => Array.isArray(mapping[mode]));
  if (supported.length < 2) return [];
  return supported.map(mode => ({
    value: mode,
    label: MODE_LABELS[mode],
    description: modeDescription(provider, mode),
  }));
}

function findSessionJsonl(root: string, id: string, depth: number): string | null {
  let remaining = 4096;
  const visit = (directory: string, level: number): string | null => {
    if (!isPathInsideRoots(directory, [root])) return null;
    let entries: fs.Dir | undefined;
    try {
      entries = fs.opendirSync(directory);
      let entry: fs.Dirent | null;
      while ((entry = entries.readSync())) {
        if (--remaining < 0) return null;
        if (entry.isFile() && (entry.name === `${id}.jsonl` || entry.name.endsWith(`-${id}.jsonl`))) {
          return path.join(directory, entry.name);
        }
        if (level > 0 && entry.isDirectory()) {
          const match = visit(path.join(directory, entry.name), level - 1);
          if (match) return match;
        }
      }
    } catch {
      return null;
    } finally {
      try { entries?.closeSync(); } catch { /* ignore */ }
    }
    return null;
  };
  return visit(root, depth);
}

function verifyJsonlProvenance(file: string, record: SessionRecord): boolean {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(65536);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytes).toString('utf8').split('\n').slice(0, 100)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const metadata = record.provider === 'codex' && row.type === 'session_meta'
          ? row.payload
          : (record.provider === 'claude' || record.provider === 'codebuddy')
            ? (row.type === 'session-meta' && row.meta ? { sessionId: row.sessionId ?? row.id, cwd: row.cwd ?? row.meta.cwd } : row)
            : null;
        const id = record.provider === 'codex' ? (metadata?.id ?? metadata?.session_id) : metadata?.sessionId;
        if (
          id === record.providerThreadId
          && typeof metadata?.cwd === 'string'
          && [record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(metadata.cwd)) === '')
        ) {
          return true;
        }
      } catch {
        // Ignore partial or non-JSON lines while verifying session provenance.
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function findVerifiedSessionTranscript(record: SessionRecord): string | null {
  if (!validCodexThreadId(record.providerThreadId)) return null;
  if (record.provider !== 'codex' && record.provider !== 'claude' && record.provider !== 'codebuddy') return null;
  const root = record.provider === 'codex'
    ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
    : record.provider === 'codebuddy'
      ? path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects')
      : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const file = findSessionJsonl(root, record.providerThreadId, record.provider === 'codex' ? 3 : 1);
  if (!file || !isPathInsideRoots(file, [root])) return null;
  return verifyJsonlProvenance(file, record) ? file : null;
}

function boundaryKey(record: SessionRecord): string {
  return `${record.id}:${record.statusToken ?? ''}`;
}

export function recordPermissionLaunchBoundary(record: SessionRecord): void {
  const file = findVerifiedSessionTranscript(record);
  if (!file) return;
  try {
    const size = fs.statSync(file).size;
    if (launchTranscriptOffsets.size >= 256) {
      const oldest = launchTranscriptOffsets.keys().next().value;
      if (oldest) launchTranscriptOffsets.delete(oldest);
    }
    launchTranscriptOffsets.set(boundaryKey(record), size);
  } catch {
    // Transcript may not exist yet on initial launch.
  }
}

export function resolveSessionLaunchPermission(
  store: Pick<AdeStore, 'db'>,
  record: SessionRecord,
): { mode: AgentPermissionMode; args: string[]; record: SessionRecord } {
  if (record.provider === 'terminal') {
    throw new CliError('INVALID_ARGUMENT', 'Shell terminals do not use agent permission modes.');
  }
  const preference = readAgentPreferences(store as AdeStore).providers[record.provider];
  const mode = record.permissionOverride ?? preference.mode;
  if (!isAgentPermissionMode(mode)) {
    throw new CliError('INVALID_ARGUMENT', 'This permission mode is not supported by the native provider.');
  }
  const args = permissionArgs[record.provider][mode];
  if (!args) {
    throw new CliError('INVALID_ARGUMENT', 'This permission mode is not supported by the native provider.');
  }
  const updated: SessionRecord = { ...record, launchPermission: mode };
  recordPermissionLaunchBoundary(updated);
  return { mode, args: [...args], record: updated };
}

/**
 * Verifies whether a session has a durable native conversation binding that can
 * safely survive an idle-session permission restart without losing history.
 */
export function permissionRestartResumable(
  record: SessionRecord,
  context?: Pick<ProviderPermissionContext, 'resumable' | 'savedAgy'>,
): boolean {
  if (record.provider === 'terminal' || record.provider === 'dsh') return false;
  if (providerPermissionChoices(record.provider).length < 2) return false;
  if (!validProviderSessionId(record.provider, record.providerThreadId)) return false;
  if (typeof context?.resumable === 'boolean') return context.resumable;
  if (record.provider === 'antigravity') {
    return (context?.savedAgy ?? agyConversationSaved)(record);
  }
  if (isOpenCode(record.provider)) {
    try {
      verifyOpenCode(record);
      return true;
    } catch {
      return false;
    }
  }
  if (record.provider === 'claude' || record.provider === 'codebuddy') {
    return findVerifiedSessionTranscript(record) !== null;
  }
  if (record.provider === 'freebuff') {
    return freebuffResumable(record);
  }
  return record.provider === 'codex';
}

function readScreenPermissionEvidence(
  provider: AdeProvider,
  rawScreen: string | null | undefined,
): { observed: boolean; mode?: AgentPermissionMode; nonCatalogMode?: string } {
  if (!rawScreen || (provider !== 'claude' && provider !== 'codebuddy')) {
    return { observed: false };
  }
  const screen = stripAnsi(rawScreen);
  const footerLines = screen.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-10);
  for (let index = footerLines.length - 1; index >= 0; index--) {
    const line = footerLines[index]!;
    if (/\u23f5\u23f5\s*bypass permissions on\b/i.test(line)) {
      return { observed: true, mode: 'yolo' };
    }
    if (/\u23f5\u23f5\s*auto mode on\b/i.test(line)) {
      return { observed: true, mode: 'auto' };
    }
    if (/\u23f5\u23f5\s*accept edits on\b/i.test(line)) {
      return { observed: true, nonCatalogMode: 'accept-edits' };
    }
    if (/\u23f5\u23f5\s*don't ask on\b/i.test(line)) {
      return { observed: true, nonCatalogMode: 'dont-ask' };
    }
    if (/\u23f8\s*plan (?:\+\s*\w+|mode on\b)/i.test(line)) {
      return { observed: true, nonCatalogMode: 'plan' };
    }
  }
  return { observed: false };
}

function parseCodexTurnContextPolicy(payload: any): { observed: boolean; mode?: AgentPermissionMode; nonCatalogMode?: string } {
  if (!payload || typeof payload !== 'object') return { observed: false };
  const approval = payload.approval_policy ?? payload.approvalPolicy;
  const reviewer = payload.approvals_reviewer ?? payload.approvalsReviewer;
  const sandboxRaw = payload.sandbox_policy ?? payload.sandboxPolicy;
  const sandbox = typeof sandboxRaw === 'string' ? sandboxRaw : sandboxRaw?.type;
  if (typeof approval !== 'string' && typeof sandbox !== 'string') return { observed: false };
  if (approval === 'never' && (sandbox === 'danger-full-access' || sandbox === 'dangerFullAccess')) {
    return { observed: true, mode: 'yolo' };
  }
  if (approval === 'on-request' && (reviewer === 'auto_review' || reviewer === 'auto-review')) {
    return { observed: true, mode: 'auto' };
  }
  if (
    approval === 'on-request'
    && (!reviewer || reviewer === 'user')
    && (sandbox === 'workspace-write' || sandbox === 'workspaceWrite' || sandbox === 'read-only' || sandbox === 'readOnly')
  ) {
    return { observed: true, mode: 'manual' };
  }
  return { observed: true, nonCatalogMode: `${String(approval ?? 'unknown')}:${String(sandbox ?? 'unknown')}` };
}

function parseClaudePermissionMode(rawMode: unknown): { observed: boolean; mode?: AgentPermissionMode; nonCatalogMode?: string } {
  if (typeof rawMode !== 'string' || !rawMode.trim()) return { observed: false };
  const value = rawMode.trim();
  if (value === 'bypassPermissions' || value === 'full-access') return { observed: true, mode: 'yolo' };
  if (value === 'auto') return { observed: true, mode: 'auto' };
  if (value === 'default' || value === 'manual') return { observed: true, mode: 'manual' };
  return { observed: true, nonCatalogMode: value };
}

function readStatusLaunchAtMs(directory: string | undefined, record: SessionRecord): number | null {
  if (!directory || !record.statusToken) return null;
  try {
    const file = statusFile(directory, record.id);
    if (fs.statSync(file).size > 4096) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data?.token !== record.statusToken || data?.provider !== record.provider || data?.id !== record.providerThreadId) {
      return null;
    }
    if (data.event === 'SessionStart' && typeof data.at === 'string') {
      const parsed = Date.parse(data.at);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } catch {
    // Status file is optional when reading transcript evidence.
  }
  return null;
}

function readTranscriptPermissionEvidence(
  record: SessionRecord,
  directory?: string,
): { observed: boolean; mode?: AgentPermissionMode; nonCatalogMode?: string } {
  if (record.provider !== 'codex' && record.provider !== 'claude') return { observed: false };
  const file = findVerifiedSessionTranscript(record);
  if (!file) return { observed: false };
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    const minOffset = launchTranscriptOffsets.get(boundaryKey(record)) ?? 0;
    if (stat.size <= minOffset && minOffset > 0) return { observed: false };
    const maxRead = 262144;
    const start = Math.max(minOffset, stat.size - maxRead);
    const length = stat.size - start;
    if (length <= 0) return { observed: false };
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytes).toString('utf8');
    const lines = text.split('\n');
    if (start > minOffset && lines.length > 1) lines.shift();
    const sessionStartMs = readStatusLaunchAtMs(directory, record);
    let latest: { observed: boolean; mode?: AgentPermissionMode; nonCatalogMode?: string } = { observed: false };
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.isSidechain || row._fromSubAgent) continue;
        if (typeof row.timestamp === 'string' && sessionStartMs !== null) {
          const rowMs = Date.parse(row.timestamp);
          if (Number.isFinite(rowMs) && rowMs + 50 < sessionStartMs) continue;
        }
        if (record.provider === 'codex') {
          if (row.type === 'turn_context' && row.payload) {
            if (
              typeof row.payload.cwd === 'string'
              && ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.payload.cwd)) === '')
            ) {
              continue;
            }
            const parsed = parseCodexTurnContextPolicy(row.payload);
            if (parsed.observed) latest = parsed;
          }
        } else if (record.provider === 'claude') {
          if (row.sessionId && row.sessionId !== record.providerThreadId) continue;
          if (
            typeof row.cwd === 'string'
            && ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')
          ) {
            continue;
          }
          if (row.type === 'permission-mode' || (row.type === 'user' && typeof row.permissionMode === 'string')) {
            const parsed = parseClaudePermissionMode(row.permissionMode);
            if (parsed.observed) latest = parsed;
          }
        }
      } catch {
        // Ignore truncated or malformed lines.
      }
    }
    if (
      latest.observed
      && record.permissionOverride
      && record.launchPermission === record.permissionOverride
      && !launchTranscriptOffsets.has(boundaryKey(record))
      && sessionStartMs === null
      && latest.mode !== undefined
      && latest.mode !== record.launchPermission
    ) {
      // Without a launch byte boundary or SessionStart timestamp, an override that differs
      // from an older transcript turn remains 'launch' until a matching turn confirms it.
      return { observed: false };
    }
    return latest;
  } catch {
    return { observed: false };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Resolves the effective permission catalog and current state for a session without
 * performing network I/O or fabricating state from global preferences.
 */
export function readProviderPermissionState(
  record: SessionRecord,
  context: ProviderPermissionContext = {},
): ProviderPermissionState {
  const choices = providerPermissionChoices(record.provider);
  const resumable = permissionRestartResumable(record, context);
  if (context.live === false || choices.length < 2) {
    return { permissions: [], resumable: false };
  }
  const rawScreen = typeof context.screen === 'function' ? context.screen() : context.screen;
  const screenEvidence = readScreenPermissionEvidence(record.provider, rawScreen);
  if (screenEvidence.observed) {
    const supported = screenEvidence.mode && choices.some(choice => choice.value === screenEvidence.mode)
      ? screenEvidence.mode
      : undefined;
    return {
      permissions: choices,
      ...(supported ? { current: supported, source: 'native' as const } : {}),
      ...(screenEvidence.nonCatalogMode ? { nonCatalogNativeMode: screenEvidence.nonCatalogMode, source: 'native' as const } : {}),
      permissionsRequireRestart: true,
      resumable,
    };
  }

  const transcriptEvidence = readTranscriptPermissionEvidence(record, context.directory);
  if (transcriptEvidence.observed) {
    const supported = transcriptEvidence.mode && choices.some(choice => choice.value === transcriptEvidence.mode)
      ? transcriptEvidence.mode
      : undefined;
    return {
      permissions: choices,
      ...(supported ? { current: supported, source: 'native' as const } : {}),
      ...(transcriptEvidence.nonCatalogMode ? { nonCatalogNativeMode: transcriptEvidence.nonCatalogMode, source: 'native' as const } : {}),
      permissionsRequireRestart: true,
      resumable,
    };
  }

  const configured = record.launchPermission ?? record.permissionOverride;
  const supportedLaunch = isAgentPermissionMode(configured) && choices.some(choice => choice.value === configured)
    ? configured
    : undefined;
  return {
    permissions: choices,
    ...(supportedLaunch ? { current: supportedLaunch, source: 'launch' as const } : {}),
    permissionsRequireRestart: true,
    resumable,
  };
}

/**
 * Attaches bounded permission choices, current mode, source ('native' | 'launch'),
 * and restart metadata to AgentChatOptions. Hides permissions when unsupported or not resumable.
 */
export function withProviderPermissions(
  options: AgentChatOptions,
  record: SessionRecord,
  context: ProviderPermissionContext = {},
): AgentChatOptions {
  if (context.live === false) {
    const nextCurrent = { ...options.current };
    delete nextCurrent.permission;
    const next: AgentChatOptions = { ...options, current: nextCurrent };
    delete next.permissions;
    delete next.permissionsRequireRestart;
    delete next.permissionCurrentSource;
    return next;
  }
  if (record.provider === 'terminal') return options;
  if (record.provider === 'dsh') {
    if (!options.permissions?.length) return options;
    return {
      ...options,
      permissionsRequireRestart: false,
      ...(options.current.permission ? { permissionCurrentSource: 'native' as const } : {}),
    };
  }
  const state = readProviderPermissionState(record, context);
  const nextCurrent = { ...options.current };
  if (!state.resumable || state.permissions.length < 2) {
    delete nextCurrent.permission;
    const next: AgentChatOptions = { ...options, current: nextCurrent };
    delete next.permissions;
    delete next.permissionsRequireRestart;
    delete next.permissionCurrentSource;
    return next;
  }
  if (state.current) nextCurrent.permission = state.current;
  else delete nextCurrent.permission;
  const next: AgentChatOptions = {
    ...options,
    current: nextCurrent,
    permissions: state.permissions,
    permissionsRequireRestart: true,
  };
  if (state.current && state.source) next.permissionCurrentSource = state.source;
  else delete next.permissionCurrentSource;
  return next;
}

/**
 * Validates a permission change request for non-DSH providers before stopping or restarting a session.
 */
export function validateProviderPermissionRequest(
  record: SessionRecord,
  request: SetAgentChatOptionRequest,
  context: ProviderPermissionContext = {},
): { mode: AgentPermissionMode; args: string[]; noop: boolean; state: ProviderPermissionState } {
  if (request.key !== 'permission') {
    throw new CliError('INVALID_ARGUMENT', 'Expected a permission option request.');
  }
  if (record.provider === 'terminal' || record.provider === 'dsh') {
    throw new CliError('INVALID_ARGUMENT', 'Choose a supported native access mode.');
  }
  if (typeof request.value !== 'string' || !isAgentPermissionMode(request.value)) {
    throw new CliError('INVALID_ARGUMENT', 'Choose a supported native access mode.');
  }
  const mode = request.value;
  const choices = providerPermissionChoices(record.provider);
  const args = permissionArgs[record.provider][mode];
  if (choices.length < 2 || !args) {
    throw new CliError('INVALID_ARGUMENT', 'This permission mode is not supported by the native provider.');
  }
  if (context.live === false) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Open the running agent terminal before changing settings');
  }
  const state = readProviderPermissionState(record, context);
  if (!state.resumable) {
    throw new CliError(
      'RUNTIME_UNAVAILABLE',
      'This session has not saved a resumable conversation yet. Finish a turn in Chat or use Terminal before changing access.',
    );
  }
  const noop = state.current === mode
    && !state.nonCatalogNativeMode
    && (
      state.source === 'native'
      || (record.launchPermission === mode && (!record.permissionOverride || record.permissionOverride === mode))
    );
  if (!noop && request.confirmRestart !== true) {
    throw new CliError('INVALID_ARGUMENT', 'Confirm restarting this idle session before changing its access.');
  }
  return { mode, args: [...args], noop, state };
}
