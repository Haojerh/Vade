import path from 'node:path';
import type { AgentStatus, Section, SendMessageRequest, TerminalAttachmentsRequest } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { attachmentPaste, attachmentReference, decodeAttachments, storeAttachments, usesNativeFileAttachment } from '../../services/attachments.js';
import { dshReady } from '../../providers/dsh/dsh.js';
import { assertNoNativePermissionDialog } from '../chat/controls/nativePermissions.js';
import { isOpenCode } from '../../providers/opencode/openCodeSessions.js';
import { antigravityPromptReady } from './programStatus.js';
import type { AdeStore, SessionRecord } from '../store.js';
import { type LiveSession, UncertainMessageDelivery } from './liveSessionTypes.js';

export interface SessionSendContext {
  readonly store: AdeStore;
  readonly live: Map<string, LiveSession>;
  readonly sending: Set<string>;
  require(projectId: string, id: string): SessionRecord;
  status(projectId: string, id: string): Section<AgentStatus>;
  handoffPromptReady(projectId: string, id: string): boolean;
  command(session: LiveSession, message: object): Promise<void>;
}

export async function pasteSessionTerminalAttachments(
  ctx: SessionSendContext,
  projectId: string,
  id: string,
  request: TerminalAttachmentsRequest,
): Promise<{ ok: true }> {
  const record = ctx.require(projectId, id);
  const session = ctx.live.get(id);
  if (!['codex', 'claude'].includes(record.provider)) {
    throw new CliError('INVALID_ARGUMENT', 'Image paste is supported in Codex and Claude terminals.');
  }
  const files = decodeAttachments(request.attachments);
  if (!files.length || files.some(file => !file.mimeType.startsWith('image/'))) {
    throw new CliError('INVALID_ARGUMENT', 'Paste valid image attachments.');
  }
  if (ctx.sending.has(id)) {
    throw new CliError('RATE_LIMITED', 'Terminal input is busy. Wait before pasting an image.');
  }
  const revision = session?.inputRevision;
  await session?.screen?.settled();
  const verify = () => {
    if (!session?.live || ctx.live.get(id) !== session || ctx.require(projectId, id).statusToken !== record.statusToken || session.inputRevision !== revision) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The terminal changed. Inspect it before pasting again.');
    }
    assertNoNativePermissionDialog(record.provider, session.screen?.viewportText() ?? '');
    if (['working', 'waiting', 'blocked'].includes(ctx.status(projectId, id).data?.state ?? '') || !session.screen?.composerPresent()) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Wait for the native input prompt and finish any setup or approval before pasting an image.');
    }
  };
  verify();
  ctx.sending.add(id);
  let wrote = false;
  try {
    const stored = await storeAttachments(files, path.join(ctx.store.directory, 'attachments'));
    for (const file of stored) {
      verify();
      wrote = true;
      await ctx.command(session!, { type: 'input', data: attachmentPaste(record.provider, { ...file, path: file.path.replaceAll('\\', '/') }) });
    }
    session!.inputRevision = (session!.inputRevision ?? 0) + 1;
    session!.draftInput = true;
    session!.chatCurrent = undefined;
    return { ok: true };
  } catch (error) {
    if (wrote) {
      throw new CliError('CLI_FAILED', 'Image paste may be partially applied. Inspect Terminal before repeating it; no Enter or retry was sent.');
    }
    throw error;
  } finally {
    ctx.sending.delete(id);
  }
}

export async function sendSessionMessage(
  ctx: SessionSendContext,
  projectId: string,
  id: string,
  request: SendMessageRequest,
  internalWorkflow = false,
  submit = true,
  requireEmpty = false,
): Promise<{ ok: true; message: string }> {
  const record = ctx.require(projectId, id);
  const session = ctx.live.get(id);
  const inputRevision = session?.inputRevision;
  await session?.screen?.settled();
  if (session?.inputRevision !== inputRevision) {
    throw new CliError('RATE_LIMITED', 'Terminal input changed while reading its prompt. Review it before sending.');
  }
  if ((requireEmpty || request.requireIdle) && !ctx.handoffPromptReady(projectId, id)) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Leave an empty, idle agent prompt before sending this task');
  }
  // Antigravity hides shortcuts in a nonempty composer. Preserve initial readiness
  // only within this locked send, while every write still checks fresh status/liveness.
  const initialNativeReady = record.provider === 'antigravity' && antigravityPromptReady(session?.screen?.text() ?? session?.buffer ?? '');
  const initialCodeBuddyReady = record.provider === 'codebuddy' && session?.screen?.codeBuddyPromptReady() === true;
  const initialCodexReady = record.provider === 'codex' && session?.screen?.composerEmpty() === true;
  const initialDshReady = record.provider === 'dsh' && dshReady(ctx.store.directory, record) && session?.screen?.dshPromptReady() === true;
  const openCodeReady = !isOpenCode(record.provider) || session?.screen?.openCodePromptReady() === true;
  if (typeof request.message !== 'string' || request.message.length > (internalWorkflow ? 48000 : 10000) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(request.message)) {
    throw new CliError('INVALID_ARGUMENT', 'Message exceeds the allowed length or contains terminal control codes');
  }
  const uploads = decodeAttachments(request.attachments);
  if (!request.message.trim() && !uploads.length) {
    throw new CliError('INVALID_ARGUMENT', 'Enter a message or attach a file');
  }
  if (ctx.sending.has(id)) {
    throw new CliError('RATE_LIMITED', 'A message is already being sent to this agent');
  }
  const writable = () => {
    if (!session?.live || ctx.live.get(id) !== session) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This session is stopped. Open Terminal to resume it before sending.');
    }
    if (!openCodeReady) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Leave an empty agent prompt in Terminal and finish native setup before sending.');
    }
    if (record.provider === 'dsh' && !initialDshReady) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Wait for the DSH session and leave an empty prompt. Finish native setup in Terminal before sending.');
    }
    if (record.provider === 'codex' && !initialCodexReady) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Leave an empty Codex prompt and finish native trust/sign-in setup in Terminal before sending.');
    }
    const status = ctx.status(projectId, id);
    if (request.requireIdle && status.data?.state === 'working') {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent started working. This queued task was not submitted.');
    }
    if (
      request.requireIdle &&
      ctx.store.sessions(projectId).some(
        other =>
          other.id !== id &&
          !other.closed &&
          other.worktreeId === record.worktreeId &&
          ctx.live.get(other.id)?.live &&
          (ctx.sending.has(other.id) || ['working', 'waiting', 'blocked'].includes(ctx.status(projectId, other.id).data?.state ?? '')),
      )
    ) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Another agent is using this worktree. This queued task was not submitted.');
    }
    if (['waiting', 'blocked'].includes(status.data?.state ?? '')) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent needs input. Answer its question or approval controls in Chat, or use Terminal for native setup.');
    }
    const nativeReady = (!status.data || status.data.state === 'unknown') && (initialNativeReady || initialCodeBuddyReady || (isOpenCode(record.provider) && openCodeReady));
    if (!nativeReady && (status.meta.availability !== 'ready' || !['idle', 'working', 'completed', 'failed', 'interrupted'].includes(status.data?.state ?? ''))) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent input prompt is not ready yet. Open Terminal to finish setup, then try again.');
    }
  };
  writable();
  ctx.sending.add(id);
  let staged = false;
  try {
    const files = (await storeAttachments(uploads, path.join(ctx.store.directory, 'attachments'))).map(file => ({
      ...file,
      path: file.path.replaceAll('\\', '/'),
    }));
    const write = async (data: string) => {
      writable();
      staged = true;
      for (let offset = 0; offset < data.length; offset += 8192) {
        await ctx.command(session!, { type: 'input', data: data.slice(offset, offset + 8192) });
      }
    };
    // Same provider-specific staging rules as Orca's agent-image-paste: native image chips
    // for Codex/Claude, file mentions for Antigravity and non-image attachments.
    let imageChips = 0;
    for (const file of files) {
      if (usesNativeFileAttachment(record.provider, file)) {
        await write(attachmentPaste(record.provider, file));
        // Codex converts a pasted image path asynchronously; a prompt pasted into that
        // window can cancel the conversion and leave the raw path as text. Wait for the
        // rendered chip (bounded), then continue either way: the recorded path stays a
        // readable reference and never becomes a retried or replayed write.
        if (record.provider === 'codex') {
          imageChips++;
          const chipDeadline = Date.now() + 1500;
          for (;;) {
            await session!.screen?.settled();
            writable();
            if ((session!.screen?.codexComposerImageCount() ?? 0) >= imageChips) break;
            if (Date.now() >= chipDeadline) break;
            await new Promise(resolve => setTimeout(resolve, 40));
          }
        }
      }
    }
    const references = files.filter(file => !usesNativeFileAttachment(record.provider, file)).map(attachmentReference);
    const prompt = [...references, request.message.trim() || 'Please review the attached files.'].join('\n');
    await write(`\x1b[200~${prompt.replace(/\r\n?/g, '\n')}\x1b[201~`);
    if (record.provider === 'codebuddy' || record.provider === 'codex') {
      const deadline = Date.now() + 5000;
      for (;;) {
        await session!.screen?.settled();
        writable();
        if (record.provider === 'codex' ? session!.screen?.codexComposerHasText(prompt) : session!.screen?.codeBuddyComposerHasText(prompt)) break;
        if (Date.now() >= deadline) {
          throw new CliError('CLI_TIMEOUT', 'The agent has not rendered the pasted message. Inspect Terminal before submitting; no Enter was sent.');
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } else if (record.provider === 'dsh') {
      const deadline = Date.now() + 5000;
      for (;;) {
        await session!.screen?.settled();
        writable();
        if (session!.screen?.dshComposerHasText(prompt)) break;
        if (Date.now() >= deadline) {
          throw new CliError('CLI_TIMEOUT', 'DSH has not rendered the pasted draft. Inspect Terminal; no Enter was sent.');
        }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    writable();
    if (submit) {
      const beforeSubmit = ctx.status(projectId, id).meta.observedAt;
      let beforeOutput = session!.start + session!.buffer.length;
      if (session!.resumeTurnObserved === false) session!.resumePromptSubmitted = true;
      await ctx.command(session!, { type: 'input', data: '\r' });
      if (record.provider === 'codebuddy' || record.provider === 'codex' || record.provider === 'dsh') {
        const started = Date.now();
        const deadline = started + 5000;
        let retried = false;
        let lastOutput = beforeOutput;
        let stableSince = started;
        for (;;) {
          await session!.screen?.settled();
          if (!session!.live || ctx.live.get(id) !== session) {
            throw new CliError('RUNTIME_UNAVAILABLE', 'The agent stopped before confirming submission.');
          }
          const observed = ctx.status(projectId, id);
          const freshActivity =
            observed.meta.availability === 'ready' &&
            !observed.meta.stale &&
            observed.meta.observedAt &&
            observed.meta.observedAt !== beforeSubmit &&
            ['working', 'waiting', 'blocked', 'completed', 'failed', 'interrupted'].includes(observed.data?.state ?? '');
          const output = session!.start + session!.buffer.length;
          const now = Date.now();
          if (freshActivity || (record.provider !== 'dsh' && output !== beforeOutput && session!.screen?.composerEmpty(false, record.provider === 'codebuddy'))) {
            break;
          }
          if (output !== lastOutput) {
            lastOutput = output;
            stableSince = now;
          }
          // One user-authorized recovery Enter, only after a fresh, stable
          // redraw still proves this exact draft is unsubmitted and idle.
          // Missing evidence, busy states and write failures remain uncertain.
          if (
            record.provider === 'codex' &&
            !retried &&
            output !== beforeOutput &&
            now - started >= 1000 &&
            now - stableSince >= 600 &&
            observed.meta.availability === 'ready' &&
            !observed.meta.stale &&
            observed.data?.state === 'idle' &&
            !/esc(?:ape)? to interrupt|queued message/i.test(session!.screen?.viewportText() ?? '') &&
            session!.screen?.codexComposerHasText(prompt)
          ) {
            writable();
            retried = true;
            beforeOutput = output;
            await ctx.command(session!, { type: 'input', data: '\r' });
          }
          if (now >= deadline) {
            throw new CliError('CLI_TIMEOUT', 'The agent has not confirmed submission. Inspect Terminal before sending again.');
          }
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      }
    }
    session!.draftInput = !submit;
    return { ok: true, message: submit ? 'Submitted to the agent terminal' : 'Staged in the agent terminal. Press Enter to submit.' };
  } catch (error) {
    if (staged) throw new UncertainMessageDelivery();
    throw error;
  } finally {
    ctx.sending.delete(id);
  }
}
