import {
  Id,
  RenameNodeTitleResponse,
  CreateAgentResponse,
} from '../../../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, CliError } from '../cli.js';
import { attachmentPaste, attachmentReference, usesNativeImageAttachment } from '../../services/attachments.js';
import { hashId } from './utils.js';
import { globalSourceMaps, NodeSourceEntry } from './state.js';

export const sendingTerminals = new Set<string>();
const VALID_TERMINAL_HANDLE_RE = /^term_[a-zA-Z0-9_-]+$/;

async function resolveWorktreeSource(
  nodeId: Id,
  runner: CommandRunner
): Promise<{ worktreeId?: string; worktreePath?: string }> {
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  let worktreeId = source?.worktreeId;
  let worktreePath = source?.worktreePath;

  if (!worktreeId && !worktreePath) {
    try {
      const psRes = await runOrca<any>(['worktree', 'ps', '--limit', '100', '--json'], runner);
      const allWorktrees = psRes.result?.worktrees ?? [];
      const matched = allWorktrees.find((w: any) => {
        const wtNodeId = hashId('node', w.worktreeId || w.path || w.displayName);
        return wtNodeId === nodeId || w.worktreeId === nodeId || w.path === nodeId;
      });
      if (matched) {
        worktreeId = matched.worktreeId;
        worktreePath = matched.path;
      }
    } catch {
      // Fall through
    }
  }

  return { worktreeId, worktreePath };
}

async function resolveAgentTerminalHandle(
  nodeId: Id,
  runner: CommandRunner
): Promise<{ handle: string; source: NodeSourceEntry | undefined }> {
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  let handle = source?.handle;

  if ((!handle || !VALID_TERMINAL_HANDLE_RE.test(handle)) && source?.worktreeId) {
    try {
      const termRes = await runOrca<any>(
        ['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '100', '--json'],
        runner
      );
      const terminals = termRes.result?.terminals ?? [];
      if (source.paneKey) {
        const matched = terminals.find(
          (t: any) => `${t.tabId}:${t.leafId}` === source.paneKey || t.paneKey === source.paneKey
        );
        if (matched?.handle) {
          handle = matched.handle;
        }
      }
      if (!handle && terminals.length > 0) {
        const activeTerm = terminals.find((t: any) => t.connected && t.handle);
        if (activeTerm?.handle) {
          handle = activeTerm.handle;
        }
      }
    } catch {
      // Fall through
    }
  }

  if (!handle || !VALID_TERMINAL_HANDLE_RE.test(handle)) {
    throw new CliError('NODE_NOT_FOUND', `No active terminal found for agent node ${nodeId}`);
  }

  return { handle, source };
}

export async function sendAgentMessage(
  projectId: Id,
  nodeId: Id,
  message: string,
  runner: CommandRunner = defaultCommandRunner,
  attachments?: { provider: string | null; files: { path: string; name: string; image: boolean }[] }
): Promise<{ ok: boolean; message: string }> {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'Message cannot be empty');
  }
  const cleanMessage = message.trim();
  if (cleanMessage.length > 10000) {
    throw new CliError('INVALID_ARGUMENT', 'Message length exceeds maximum of 10000 characters');
  }

  // 1. Direct handle from nodeSourceMap
  const source = globalSourceMaps.nodeSourceMap.get(nodeId);
  const handle = source?.handle;

  if (handle && VALID_TERMINAL_HANDLE_RE.test(handle)) {
    if (sendingTerminals.has(handle)) {
      throw new CliError('RATE_LIMITED', 'A message is already being sent to this terminal');
    }
    sendingTerminals.add(handle);
    try {
      if (attachments?.files.length) {
        for (const file of attachments.files) {
          if (!usesNativeImageAttachment(attachments.provider, file)) continue;
          const staged = await runOrca<any>(
            ['terminal', 'send', '--terminal', handle, '--text', attachmentPaste(attachments.provider, file), '--json'],
            runner
          );
          if (staged.result?.send?.accepted === false) {
            throw new CliError('CLI_FAILED', 'The agent refused an attachment; the message was not submitted');
          }
        }
        // Allow TUIs to register attachment chips before the text-plus-Enter submission.
        await new Promise((resolve) => setTimeout(resolve, 300));

        // The text-plus-Enter CLI route trims leading whitespace. Stage a raw
        // multiline paste instead, then submit separately to preserve the break.
        const references = attachments.files
          .filter((file) => !usesNativeImageAttachment(attachments.provider, file))
          .map(attachmentReference);
        const text = `${references.join('\n')}\n${cleanMessage}`;
        const prompt = `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`;
        const staged = await runOrca<any>(['terminal', 'send', '--terminal', handle, '--text', prompt, '--json'], runner);
        if (staged.result?.send?.accepted === false) {
          throw new CliError('CLI_FAILED', 'The agent refused the message text');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const args = attachments?.files.length
        ? ['terminal', 'send', '--terminal', handle, '--enter', '--json']
        : ['terminal', 'send', '--terminal', handle, '--text', cleanMessage, '--enter', '--json'];
      const res = await runOrca<any>(args, runner);
      if (!res.ok || res.result?.send?.accepted === false) {
        throw new CliError('CLI_FAILED', 'Failed to send message to agent terminal');
      }
      return { ok: true, message: 'Message sent to agent terminal' };
    } finally {
      sendingTerminals.delete(handle);
    }
  }

  if (attachments?.files.length) {
    throw new CliError('INVALID_ARGUMENT', 'Attachments require an exact local agent terminal');
  }

  // 2. Dispatch map lookup
  const dispatchKey = `${projectId}::${nodeId}`;
  const dispatchEntry = globalSourceMaps.dispatchMap.get(dispatchKey);
  if (dispatchEntry?.dispatchId) {
    const res = await runOrca<any>(
      [
        'orchestration',
        'send',
        '--subject',
        cleanMessage.slice(0, 50),
        '--body',
        cleanMessage,
        '--to',
        `dispatch:${dispatchEntry.dispatchId}`,
        '--json',
      ],
      runner
    );
    if (!res.ok) {
      throw new CliError('CLI_FAILED', 'Failed to send message to worker dispatch');
    }
    return { ok: true, message: 'Message sent to worker dispatch' };
  }

  // 3. Fallback: search worktree terminals if worktree is known
  if (source?.worktreeId) {
    try {
      const termRes = await runOrca<any>(
        ['terminal', 'list', '--worktree', `id:${source.worktreeId}`, '--limit', '10', '--json'],
        runner
      );
      const terminals = termRes.result?.terminals ?? [];
      const activeTerm = terminals.find((t: any) => t.connected && t.handle);
      if (activeTerm?.handle && VALID_TERMINAL_HANDLE_RE.test(activeTerm.handle)) {
        const res = await runOrca<any>(
          ['terminal', 'send', '--terminal', activeTerm.handle, '--text', cleanMessage, '--enter', '--json'],
          runner
        );
        if (res.ok) {
          return { ok: true, message: 'Message sent to active worktree terminal' };
        }
      }
    } catch {
      // Fall through
    }
  }

  throw new CliError('NODE_NOT_FOUND', `No active terminal or dispatch found for node ${nodeId}`);
}

export async function deleteWorktree(
  projectId: Id,
  nodeId: Id,
  runner: CommandRunner = defaultCommandRunner
): Promise<{ ok: boolean; message: string }> {
  const { worktreeId } = await resolveWorktreeSource(nodeId, runner);
  if (!worktreeId) {
    throw new CliError('NODE_NOT_FOUND', `Worktree node ${nodeId} not found`);
  }

  const selector =
    worktreeId.startsWith('id:') || worktreeId.startsWith('path:') ? worktreeId : `id:${worktreeId}`;

  await runOrca<any>(['worktree', 'rm', '--worktree', selector, '--force', '--json'], runner);
  globalSourceMaps.nodeSourceMap.delete(nodeId);
  return { ok: true, message: 'Worktree deleted successfully' };
}

export async function closeAgentTab(
  projectId: Id,
  nodeId: Id,
  runner: CommandRunner = defaultCommandRunner
): Promise<{ ok: boolean; message: string }> {
  const { handle, source } = await resolveAgentTerminalHandle(nodeId, runner);
  await runOrca<any>(['terminal', 'close', '--terminal', handle, '--tab', '--json'], runner);
  if (source) {
    source.handle = undefined;
  }
  return { ok: true, message: 'Agent tab closed successfully' };
}

export async function renameNodeTitle(
  projectId: Id,
  nodeId: Id,
  title: string,
  runner: CommandRunner = defaultCommandRunner
): Promise<RenameNodeTitleResponse> {
  const { handle } = await resolveAgentTerminalHandle(nodeId, runner);
  const cleanTitle = (title || '').trim();
  const args = cleanTitle
    ? ['terminal', 'rename', '--terminal', handle, '--title', cleanTitle, '--json']
    : ['terminal', 'rename', '--terminal', handle, '--json'];

  await runOrca<any>(args, runner);
  return { ok: true, title: cleanTitle, message: 'Agent tab renamed successfully' };
}

export async function createWorktreeAgent(
  projectId: Id,
  nodeId: Id,
  command: string,
  title?: string,
  runner: CommandRunner = defaultCommandRunner
): Promise<CreateAgentResponse> {
  const { worktreeId, worktreePath } = await resolveWorktreeSource(nodeId, runner);
  if (!worktreeId && !worktreePath) {
    throw new CliError('NODE_NOT_FOUND', `Worktree node ${nodeId} not found`);
  }

  const selector = worktreePath
    ? `path:${worktreePath}`
    : worktreeId!.startsWith('id:') || worktreeId!.startsWith('path:')
      ? worktreeId!
      : `id:${worktreeId}`;

  const cleanCmd = (command || '').trim();
  if (!cleanCmd) {
    throw new CliError('INVALID_ARGUMENT', 'Command is required');
  }

  const cleanTitle = (title || '').trim();
  const args = ['terminal', 'create', '--worktree', selector, '--command', cleanCmd];
  if (cleanTitle) {
    args.push('--title', cleanTitle);
  }
  args.push('--json');

  const res = await runOrca<any>(args, runner);
  const handle = res.result?.terminal?.handle || res.result?.handle;
  return {
    ok: true,
    handle,
    title: cleanTitle || undefined,
    message: 'Agent created successfully',
  };
}
