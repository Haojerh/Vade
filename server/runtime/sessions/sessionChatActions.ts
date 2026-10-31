import crypto from 'node:crypto';
import type {
  AdeProvider,
  AgentChatOptions,
  AgentPermissionMode,
  AgentStatus,
  CompactConversationResponse,
  NativeRewindPickerResponse,
  RewindConversationResponse,
  Section,
  SetAgentChatOptionRequest,
} from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { permissionArgs } from '../system/agentPreferences.js';
import { AntigravityChatControls } from '../../providers/antigravity/antigravityChatControls.js';
import type { ChatControlIO } from '../chat/controls/chatControlTypes.js';
import { CodeBuddyChatControls } from '../../providers/codebuddy/codeBuddyChatControls.js';
import { codexRequest } from '../../providers/codex/codexThread.js';
import { claudeSettingConfirmation, codeBuddyCommandOutput } from '../chat/conversation.js';
import { applyDshOption, dshOptions, dshReady } from '../../providers/dsh/dsh.js';
import {
  applyNativePermission,
  assertNoNativePermissionDialog,
  hasNativePermissions,
  nativeFullAccessConfirmation,
  NativePermissionConfirmationRequired,
  withNativePermissions,
} from '../chat/controls/nativePermissions.js';
import { OpenCodeChatControls } from '../../providers/opencode/openCodeChatControls.js';
import { isOpenCode, validProviderSessionId } from '../../providers/opencode/openCodeSessions.js';
import { antigravityPromptReady } from './programStatus.js';
import { ProviderChatControls } from '../chat/controls/providerChatControls.js';
import { compactCommand, compactionOutcome } from '../chat/controls/providerCompaction.js';
import { validateProviderPermissionRequest, withProviderPermissions } from '../chat/controls/providerPermissions.js';
import { createCodexRewindPort, executeCodexRewind, type NativeUserAnchor, planCodexRewind, verifyCodexCut } from '../chat/controls/providerRewind.js';
import type { AdeStore, SessionRecord } from '../store.js';
import type { LiveSession } from './liveSessionTypes.js';

export interface SessionChatActionsContext {
  readonly store: AdeStore;
  readonly live: Map<string, LiveSession>;
  readonly starting: Set<string>;
  readonly sending: Set<string>;
  readonly shutdown: AbortController;
  readonly chatControls: ProviderChatControls;
  readonly openCodeControls: OpenCodeChatControls;
  readonly codeBuddyControls: CodeBuddyChatControls;
  readonly antigravityControls: AntigravityChatControls;
  readonly resolve: (provider: AdeProvider) => { executable: string; args: string[] } | null;
  readonly savedAgy: (record: SessionRecord) => boolean;
  require(projectId: string, id: string): SessionRecord;
  status(projectId: string, id: string): Section<AgentStatus>;
  nativeRewindAvailable(record: SessionRecord): boolean;
  start(record: SessionRecord, resolved: { executable: string; args: string[] }): Promise<SessionRecord>;
  closeSession(projectId: string, id: string): void;
  command(session: LiveSession, message: object): Promise<void>;
  changed(id: string): void;
  statusChanged(projectId: string, observed?: SessionRecord): void;
}

export async function readSessionChatOptions(
  ctx: SessionChatActionsContext,
  projectId: string,
  id: string,
  observed: { model?: string | null; effort?: string | null; nativeResumable?: boolean },
): Promise<AgentChatOptions> {
  const record = ctx.require(projectId, id);
  const live = ctx.live.get(id);
  if (record.provider === 'terminal') {
    throw new CliError('INVALID_ARGUMENT', 'Shell terminals do not have model settings');
  }
  const current = record.provider === 'codebuddy' ? { ...live?.chatCurrent, ...observed } : { ...observed, ...live?.chatCurrent };
  const options =
    record.provider === 'dsh'
      ? dshOptions(ctx.store.directory, record)
      : record.provider === 'codebuddy'
        ? await ctx.codeBuddyControls.read(current, record.cwd, `${record.id}:${record.statusToken}`)
        : isOpenCode(record.provider)
          ? await ctx.openCodeControls.read(record.provider, record.cwd, current, live?.screen?.text() ?? '')
          : record.provider === 'antigravity'
            ? await ctx.antigravityControls.read(current, () => live?.screen?.text() ?? '')
            : await ctx.chatControls.read(record.provider, current, () => live?.screen?.text() ?? '', record.cwd);
  if (ctx.require(projectId, id).statusToken !== record.statusToken || ctx.live.get(id) !== live) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'The agent changed while reading its settings. Reopen the picker.');
  }
  if (!live?.live) {
    options.controls = { model: false, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
    delete options.permissions;
  }
  const permissions = withProviderPermissions(options, record, {
    screen: () => live?.screen?.viewportText() ?? null,
    directory: ctx.store.directory,
    live: Boolean(live?.live),
    resumable: observed.nativeResumable === true && (record.provider !== 'antigravity' || ctx.savedAgy(record)),
  });
  // Confirmed native controls remain effective until direct Terminal input
  // invalidates chatCurrent. A fresh native footer still takes precedence.
  if (hasNativePermissions(record.provider) && live?.chatCurrent?.permission) {
    permissions.current = { ...permissions.current, permission: live.chatCurrent.permission };
    permissions.permissionCurrentSource = 'native';
  }
  return withNativePermissions(permissions, live?.screen?.viewportText() ?? '', Boolean(live?.live));
}

export async function setSessionChatOption(
  ctx: SessionChatActionsContext,
  projectId: string,
  id: string,
  request: SetAgentChatOptionRequest,
  observed: { model?: string | null; effort?: string | null; nativeResumable?: boolean },
): Promise<AgentChatOptions> {
  const record = ctx.require(projectId, id);
  const live = ctx.live.get(id);
  if (!live?.live || record.provider === 'terminal') {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Open the running agent terminal before changing settings');
  }
  if (record.provider === 'dsh' && !dshReady(ctx.store.directory, record)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Wait for DSH to finish opening its session before changing settings');
  }
  if (ctx.sending.has(id)) {
    throw new CliError('RATE_LIMITED', 'Input is already being sent to this agent');
  }
  let wrote = false;
  const verify = () => {
    if (ctx.shutdown.signal.aborted || ctx.live.get(id) !== live || !live.live || ctx.require(projectId, id).statusToken !== record.statusToken) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent changed. Inspect Terminal before retrying.');
    }
    const state = ctx.status(projectId, id).data?.state;
    // CodeBuddy's prompt hook reports its own slash commands (/model list) as a working turn; this lock already owns the idle terminal.
    const fullAccessConfirmation =
      record.provider === 'codex' && request.key === 'permission' && request.value === 'yolo' && nativeFullAccessConfirmation(live.screen?.viewportText() ?? '');
    if (!fullAccessConfirmation && !(wrote && record.provider === 'codebuddy') && ['working', 'waiting', 'blocked'].includes(state ?? '')) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Wait until the agent is idle and finish any question or approval in Terminal before changing settings');
    }
  };
  verify();
  const inputRevision = live.inputRevision;
  await live.screen?.settled();
  verify();
  if (ctx.sending.has(id) || live.inputRevision !== inputRevision) {
    throw new CliError('RATE_LIMITED', 'Terminal input changed while reading its prompt. Reopen settings.');
  }
  const initial = live.screen?.text() ?? '';
  if (!(record.provider === 'codex' && request.key === 'permission' && request.value === 'yolo' && nativeFullAccessConfirmation(initial))) {
    assertNoNativePermissionDialog(record.provider, initial);
  }
  // A failed setting confirmation can leave this conservative flag set even
  // after the provider has returned to its visibly empty native prompt.
  // Reconcile observed screen state; never resend the earlier operation.
  const fullAccessConfirmation =
    record.provider === 'codex' && request.key === 'permission' && request.value === 'yolo' && nativeFullAccessConfirmation(initial);
  const composerEmpty =
    fullAccessConfirmation ||
    (record.provider === 'dsh'
      ? live.screen?.dshPromptReady()
      : record.provider === 'freebuff'
        ? live.screen?.freebuffPromptReady()
        : isOpenCode(record.provider)
          ? live.screen?.openCodePromptReady()
          : live.screen?.composerEmpty(record.provider === 'antigravity', record.provider === 'codebuddy'));
  if (live.draftInput && composerEmpty && !/(?:Select Model|Select Reasoning|Switch Model|Keyboard:.*(?:Select|Navigate))/.test(initial)) {
    live.draftInput = false;
  }
  if (live.draftInput) throw new CliError('RUNTIME_UNAVAILABLE', 'Clear the draft in Terminal before changing settings');
  if (!composerEmpty) throw new CliError('RUNTIME_UNAVAILABLE', 'Leave an empty agent prompt in Terminal before changing settings');
  // Codex and CodeBuddy can omit their optional shortcuts footer. Their
  // owned idle process and empty native composer still fence these commands.
  if (
    (!isOpenCode(record.provider) &&
      record.provider !== 'dsh' &&
      record.provider !== 'codex' &&
      record.provider !== 'codebuddy' &&
      record.provider !== 'claude' &&
      record.provider !== 'freebuff' &&
      !/(?:\? for shortcuts|context left|context remaining)/i.test(initial)) ||
    /(?:Select Model|Select Reasoning|Switch Model|Keyboard:.*(?:Select|Navigate))/.test(initial)
  ) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Open Terminal and wait for the agent prompt before changing settings');
  }
  if (record.provider === 'antigravity' && !antigravityPromptReady(initial)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Clear the Antigravity prompt before changing settings');
  }
  ctx.sending.add(id);
  const start = live.start + live.buffer.length;
  let confirmSetting: (() => boolean) | undefined;
  let expectedModelLabel: string | undefined;
  const io: ChatControlIO = {
    screen: () => live.screen?.viewportText() ?? '',
    output: () => live.buffer.slice(Math.max(0, start - live.start)).slice(-65536),
    outputCursor: () => live.start + live.buffer.length,
    promptEmpty: () => live.screen?.composerEmpty(record.provider === 'antigravity', record.provider === 'codebuddy') === true,
    settingConfirmed: () => confirmSetting?.() ?? false,
    write: async data => {
      verify();
      if (data === '\r' && !confirmSetting) confirmSetting = claudeSettingConfirmation(record, request, expectedModelLabel);
      wrote = true;
      await ctx.command(live, { type: 'input', data });
    },
    waitFor: async predicate => {
      const deadline = Date.now() + (record.provider === 'codebuddy' ? 20000 : record.provider === 'claude' ? 15000 : record.provider === 'freebuff' ? 10000 : 5000);
      while (Date.now() < deadline) {
        verify();
        const screen = live.screen?.viewportText() ?? '';
        if (predicate(screen)) return screen;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new CliError('CLI_TIMEOUT', 'The provider did not confirm this setting. Inspect Terminal before retrying.');
    },
  };
  try {
    if (request.key === 'permission' && record.provider !== 'dsh' && !hasNativePermissions(record.provider)) {
      return await restartSessionPermission(ctx, record, live, request, observed);
    }
    const options = await readSessionChatOptions(ctx, projectId, id, observed);
    verify();
    expectedModelLabel = options.models.find(model => model.id === request.value)?.label;
    const result =
      request.key === 'permission' && hasNativePermissions(record.provider)
        ? await applyNativePermission(options, request, io)
        : record.provider === 'dsh'
          ? await applyDshOption(ctx.store.directory, record, request, io)
          : record.provider === 'codebuddy'
            ? await ctx.codeBuddyControls.apply(options, request, { ...io, output: codeBuddyCommandOutput(record) }, `${record.id}:${record.statusToken}`)
            : isOpenCode(record.provider)
              ? await ctx.openCodeControls.apply(options, request, io)
              : record.provider === 'antigravity'
                ? await ctx.antigravityControls.apply(options, request, io)
                : await ctx.chatControls.apply(options, request, io);
    if (!result.unconfirmed) live.chatCurrent = result.current;
    ctx.changed(id);
    ctx.statusChanged(projectId, record);
    return result;
  } catch (error) {
    if (error instanceof NativePermissionConfirmationRequired) {
      live.draftInput = true;
      throw error;
    }
    if (wrote) {
      live.draftInput = true;
      throw new CliError(
        'CLI_FAILED',
        `The setting may be partially applied (${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}). Inspect Terminal before retrying; no input was replayed.`,
      );
    }
    throw error;
  } finally {
    ctx.sending.delete(id);
  }
}

async function restartSessionPermission(
  ctx: SessionChatActionsContext,
  record: SessionRecord,
  live: LiveSession,
  request: SetAgentChatOptionRequest,
  observed: { model?: string | null; effort?: string | null; nativeResumable?: boolean },
): Promise<AgentChatOptions> {
  if (record.provider === 'terminal' || record.provider === 'dsh' || !['manual', 'auto', 'yolo'].includes(request.value)) {
    throw new CliError('INVALID_ARGUMENT', 'Choose a supported native access mode.');
  }
  const mode = request.value as AgentPermissionMode;
  if (permissionArgs[record.provider][mode] === null || !validProviderSessionId(record.provider, record.providerThreadId)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'This saved native session cannot change access through a confirmed restart.');
  }
  if (request.confirmRestart !== true) {
    throw new CliError('INVALID_ARGUMENT', 'Confirm restarting this idle session before changing its access.');
  }
  if (observed.nativeResumable !== true || (record.provider === 'antigravity' && !ctx.savedAgy(record))) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Wait until this native session is saved before changing access.');
  }
  const selection = validateProviderPermissionRequest(record, request, {
    screen: () => live.screen?.viewportText() ?? null,
    directory: ctx.store.directory,
    live: live.live,
    resumable: observed.nativeResumable,
  });
  if (selection.noop) return readSessionChatOptions(ctx, record.projectId, record.id, observed);
  const resolved = ctx.resolve(record.provider);
  if (!resolved) throw new CliError('CLI_MISSING', 'Install this native provider before changing access.');
  const stopped = new Promise<boolean>(resolve => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { live.process.removeListener('exit', done); resolve(false); }, 5000);
    live.process.once('exit', done);
  });
  ctx.closeSession(record.projectId, record.id);
  if (!(await stopped)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Native shutdown is unconfirmed. No replacement session was launched. Inspect Terminal before resuming.');
  }
  // Native resume restores the exact conversation. Do not reapply old model
  // launch choices or replay any user input while changing access.
  const started = await ctx.start({ ...record, closed: false, permissionOverride: mode, workflowLaunch: undefined }, resolved);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = ctx.require(record.projectId, record.id);
    const session = ctx.live.get(record.id);
    if (current.statusToken !== started.statusToken || !session?.live) break;
    await session.screen?.settled();
    const ready = isOpenCode(current.provider)
      ? session.screen?.openCodePromptReady()
      : current.provider === 'freebuff'
        ? session.screen?.freebuffPromptReady()
        : session.screen?.composerEmpty(current.provider === 'antigravity', current.provider === 'codebuddy');
    if (ready) return readSessionChatOptions(ctx, record.projectId, record.id, observed);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new CliError('RUNTIME_UNAVAILABLE', 'The session restarted but its prompt is not ready. Finish native setup in Terminal; no message or setting was replayed.');
}

export async function openSessionNativeRewindPicker(
  ctx: SessionChatActionsContext,
  projectId: string,
  id: string,
): Promise<NativeRewindPickerResponse> {
  const record = ctx.require(projectId, id);
  const live = ctx.live.get(id);
  if (!['antigravity', 'codebuddy'].includes(record.provider) || !live?.live) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'This provider has no running native rewind picker.');
  }
  if (ctx.sending.has(id)) throw new CliError('RATE_LIMITED', 'Terminal input is busy.');
  const revision = live.inputRevision;
  await live.screen?.settled();
  if (
    live.inputRevision !== revision ||
    !live.screen?.composerEmpty(record.provider === 'antigravity', record.provider === 'codebuddy') ||
    ['working', 'waiting', 'blocked'].includes(ctx.status(projectId, id).data?.state ?? '')
  ) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Leave the idle native prompt empty before opening Rewind.');
  }
  ctx.sending.add(id);
  let wrote = false;
  try {
    for (const data of [...'/rewind', '\r']) {
      if (ctx.live.get(id) !== live || !live.live || ctx.require(projectId, id).statusToken !== record.statusToken) {
        throw Error('Native session changed');
      }
      wrote = true;
      await ctx.command(live, { type: 'input', data });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    live.chatCurrent = undefined;
    return { ok: true };
  } catch (error) {
    throw new CliError(
      'RUNTIME_UNAVAILABLE',
      wrote ? 'Opening native Rewind is unconfirmed. Inspect its terminal; the command will not be replayed.' : String(error),
    );
  } finally {
    ctx.sending.delete(id);
  }
}

export async function compactSessionConversation(
  ctx: SessionChatActionsContext,
  projectId: string,
  id: string,
): Promise<CompactConversationResponse> {
  const record = ctx.require(projectId, id);
  const live = ctx.live.get(id);
  const command = compactCommand(record.provider);
  if (!command) throw new CliError('RUNTIME_UNAVAILABLE', 'This provider does not expose a verified native compaction command.');
  if (!live?.live) throw new CliError('RUNTIME_UNAVAILABLE', 'Open the running agent terminal before compacting its conversation.');
  if (record.provider === 'dsh' && !dshReady(ctx.store.directory, record)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Wait for DSH to finish opening its session before compacting.');
  }
  if (ctx.sending.has(id)) throw new CliError('RATE_LIMITED', 'Input is already being sent to this agent.');
  const verify = () => {
    if (ctx.shutdown.signal.aborted || ctx.live.get(id) !== live || !live.live || ctx.require(projectId, id).statusToken !== record.statusToken) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent changed. Inspect Terminal before retrying.');
    }
    if (['working', 'waiting', 'blocked'].includes(ctx.status(projectId, id).data?.state ?? '')) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Wait until the agent is idle and finish any question or approval in Terminal before compacting.');
    }
  };
  verify();
  const inputRevision = live.inputRevision;
  await live.screen?.settled();
  verify();
  if (ctx.sending.has(id) || live.inputRevision !== inputRevision) {
    throw new CliError('RATE_LIMITED', 'Terminal input changed while reading its prompt. Try again.');
  }
  const before = live.screen?.viewportText() ?? '';
  assertNoNativePermissionDialog(record.provider, before);
  const composerEmpty =
    record.provider === 'dsh'
      ? live.screen?.dshPromptReady()
      : isOpenCode(record.provider)
        ? live.screen?.openCodePromptReady()
        : live.screen?.composerEmpty(record.provider === 'antigravity', record.provider === 'codebuddy');
  if (live.draftInput && composerEmpty) live.draftInput = false;
  if (live.draftInput) throw new CliError('RUNTIME_UNAVAILABLE', 'Clear the draft in Terminal before compacting.');
  if (!composerEmpty) throw new CliError('RUNTIME_UNAVAILABLE', 'Leave an empty agent prompt in Terminal before compacting.');
  if (record.provider === 'antigravity' && !antigravityPromptReady(before)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Clear the Antigravity prompt before compacting.');
  }
  ctx.sending.add(id);
  const start = live.start + live.buffer.length;
  const fresh = () => live.buffer.slice(Math.max(0, start - live.start)).slice(-65536).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  try {
    for (const data of [command, '\r']) {
      verify();
      await ctx.command(live, { type: 'input', data });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      verify();
      const after = live.screen?.viewportText() ?? '';
      const outcome = compactionOutcome({ fresh: fresh(), before, after });
      if (outcome === 'confirmed') {
        ctx.changed(id);
        ctx.statusChanged(projectId, record);
        return { ok: true, message: 'Compaction started. Chat shows a divider once the provider records its native boundary.' };
      }
      if (outcome === 'rejected') {
        return { ok: false, message: 'The provider rejected its compaction command. Inspect Terminal.' };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return {
      ok: false,
      message: 'Compaction was submitted but not confirmed by the provider yet. Inspect Terminal; the command will not be replayed.',
    };
  } finally {
    ctx.sending.delete(id);
  }
}

export async function rewindSessionConversation(
  ctx: SessionChatActionsContext,
  projectId: string,
  id: string,
  target: {
    beforeSeq?: number;
    beforeMessageId?: string;
    anchor?: NativeUserAnchor;
    materialize?: () => Promise<string | undefined>;
    message: string;
    current: () => boolean;
    receipt?: SessionRecord['rewindPending'];
  },
  token: string | undefined,
): Promise<RewindConversationResponse> {
  const record = ctx.require(projectId, id);
  const live = ctx.live.get(id);
  if (!['dsh', 'codex', 'claude'].includes(record.provider) || !record.providerThreadId || !live?.live || record.statusToken !== token) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'The native session changed. Refresh before rewinding.');
  }
  if (ctx.sending.has(id) || ctx.starting.has(id)) {
    throw new CliError('RATE_LIMITED', 'Agent input is busy. No rewind was started.');
  }
  ctx.sending.add(id);
  try {
    const revision = live.inputRevision;
    await live.screen?.settled();
    const state = ctx.status(projectId, id).data?.state;
    const nativeReady =
      record.provider === 'dsh'
        ? dshReady(ctx.store.directory, record) && live.screen?.dshPromptReady()
        : record.provider === 'claude'
          ? Boolean(target.materialize) && live.screen?.composerEmpty()
          : ctx.nativeRewindAvailable(record) && live.screen?.composerEmpty();
    if (!target.current() || ctx.live.get(id) !== live || live.inputRevision !== revision || !nativeReady || ['working', 'waiting', 'blocked'].includes(state ?? '')) {
      throw new CliError('INVALID_ARGUMENT', 'Leave the idle native prompt empty and refresh before rewinding.');
    }
    const resolved = ctx.resolve(record.provider);
    if (!resolved) throw new CliError('CLI_MISSING', 'Install the native provider before rewinding.');
    if (record.provider === 'dsh' && (target.beforeSeq === undefined || !target.beforeMessageId)) {
      throw new CliError('INVALID_ARGUMENT', 'The native rewind boundary is unavailable.');
    }
    if (record.provider === 'codex' && !target.anchor) {
      throw new CliError('INVALID_ARGUMENT', 'The native rewind anchor is unavailable.');
    }
    let codexFork: string | undefined;
    if (record.provider === 'codex') {
      codexFork = await codexRequest(
        resolved,
        record.cwd,
        async call => {
          const port = createCodexRewindPort(call);
          const plan = await planCodexRewind(port, {
            threadId: record.providerThreadId!,
            anchor: target.anchor!,
            strategy: 'fork-before',
            allowedCwds: [record.cwd, ...(record.sourceCwd ? [record.sourceCwd] : [])],
          });
          if (!plan.ok) throw new CliError('RUNTIME_UNAVAILABLE', plan.message);
          if (!target.current() || ctx.live.get(id) !== live || !live.live || live.inputRevision !== revision) {
            throw new CliError('RUNTIME_UNAVAILABLE', 'The native session changed before rewind.');
          }
          if (target.receipt) ctx.store.saveSession({ ...record, rewindPending: target.receipt });
          const outcome = await executeCodexRewind(port, plan.plan);
          if (!outcome.ok) throw new CliError('RUNTIME_UNAVAILABLE', outcome.message);
          const verified = await verifyCodexCut(port, outcome);
          if (!verified.ok) throw new CliError('RUNTIME_UNAVAILABLE', verified.message);
          return outcome.threadId;
        },
        ctx.shutdown.signal,
        { experimentalApi: true, maxBytes: 8 * 1024 * 1024 },
      );
    }
    if (!target.current() || ctx.live.get(id) !== live || !live.live || live.inputRevision !== revision) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The native session changed. The original terminal was kept open.');
    }
    if (target.receipt) ctx.store.saveSession({ ...record, rewindPending: target.receipt });
    // A verified Codex fork is ready before closing the original. Storage continuations
    // still require native writer shutdown before taking the source lease.
    const exited = new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { live.process.removeListener('exit', done); resolve(false); }, 5000);
      const done = () => { clearTimeout(timer); resolve(true); };
      live.process.once('exit', done);
    });
    ctx.closeSession(projectId, id);
    if (!(await exited)) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Native shutdown is unconfirmed. No rewind was launched. Inspect Terminal before resuming.');
    }
    let next: SessionRecord;
    if (record.provider === 'codex') {
      next = { ...record, closed: false, providerThreadId: codexFork!, workflowLaunch: undefined, rewindPending: target.receipt };
    } else if (record.provider === 'claude') {
      next = { ...record, closed: false, providerThreadId: await target.materialize!(), workflowLaunch: undefined, rewindPending: target.receipt };
    } else {
      next = {
        ...record,
        closed: false,
        providerThreadId: crypto.randomUUID(),
        sourceCwd: record.cwd,
        rewindPending: target.receipt,
        dshContinuation: {
          threadId: record.providerThreadId,
          cwd: record.cwd,
          beforeSeq: target.beforeSeq,
          beforeMessageId: target.beforeMessageId,
        },
      };
    }
    const started = await ctx.start(next, resolved);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const current = ctx.require(projectId, id);
      if (current.statusToken !== started.statusToken || !ctx.live.get(id)?.live) break;
      if (current.provider === 'dsh' ? dshReady(ctx.store.directory, current) : ctx.live.get(id)?.screen?.composerEmpty()) {
        if (current.rewindPending) ctx.store.saveSession({ ...current, rewindPending: undefined });
        return { message: target.message };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new CliError('RUNTIME_UNAVAILABLE', 'Native rewind has not confirmed its new session. Inspect Terminal; the operation will not be replayed.');
  } finally {
    ctx.sending.delete(id);
  }
}
