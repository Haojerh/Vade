import type {
  AnswerAgentRequest,
  NativeRewindPickerRequest,
  NodeStatusUpdate,
  RewindConversationRequest,
  SendMessageRequest,
  SetAgentChatOptionRequest,
} from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { conversationImageHeaders } from '../../providers/common/conversationImages.js';
import { section } from '../../runtime/localRuntime.js';
import { type RouteContext, text } from '../routeContext.js';

export async function handleNodeChatRoute(
  ctx: RouteContext,
  projectId: string,
  nodeId: string,
  action: string | undefined,
): Promise<boolean> {
  const { runtime, req, res, method, query, sendJson, requireMethod, queryKeys, body } = ctx;

  if (action === 'interaction') {
    queryKeys();
    if (method === 'POST') {
      await runtime.sessions.answer(projectId, nodeId, await body<AnswerAgentRequest>(['promptId', 'optionId', 'text']));
      sendJson(200, { ok: true });
    } else {
      requireMethod('GET');
      const prompt = runtime.sessions.interaction(projectId, nodeId);
      sendJson(200, section(prompt, prompt ? 'ready' : 'empty'));
    }
    return true;
  }

  if (action === 'subagents') {
    requireMethod('GET');
    queryKeys();
    sendJson(200, await runtime.subagents(projectId, nodeId));
    return true;
  }

  if (action === 'conversation-image') {
    requireMethod('GET');
    queryKeys('source', 'id');
    // The browser supplies only opaque tokens; the exact bytes come from this node's bound record.
    const image = runtime.conversationImage(
      projectId,
      nodeId,
      text(query.get('source'), 'conversation source', 120),
      text(query.get('id'), 'image ID', 96),
    );
    res.writeHead(200, conversationImageHeaders(image));
    res.end(method === 'HEAD' ? undefined : image.bytes);
    return true;
  }

  if (action === 'events') {
    await streamNodeConversationEvents(ctx, projectId, nodeId);
    return true;
  }

  if (action === 'rewind') {
    requireMethod('POST');
    queryKeys();
    const request = await body<RewindConversationRequest>(['messageId', 'sourceIdentity', 'revision']);
    for (const key of ['messageId', 'sourceIdentity', 'revision'] as const) {
      if (typeof request[key] !== 'string' || !/^\w[\w.-]{0,199}$/.test(request[key])) {
        throw new CliError('INVALID_ARGUMENT', 'Choose an exact recorded message to rewind.');
      }
    }
    sendJson(200, await runtime.rewind(projectId, nodeId, request));
    return true;
  }

  if (action === 'rewind-picker') {
    requireMethod('POST');
    queryKeys();
    await body<NativeRewindPickerRequest>([]);
    sendJson(200, await runtime.openNativeRewindPicker(projectId, nodeId));
    return true;
  }

  if (action === 'chat-options') {
    queryKeys('runId');
    if (req.method === 'GET') {
      sendJson(200, section(await runtime.chatOptions(projectId, nodeId)));
      return true;
    }
    requireMethod('POST');
    const request = await body<SetAgentChatOptionRequest>(['key', 'value', 'confirmRestart']);
    if (request.confirmRestart !== undefined && (typeof request.confirmRestart !== 'boolean' || request.key !== 'permission')) {
      throw new CliError('INVALID_ARGUMENT', 'Restart confirmation applies only to native permission changes.');
    }
    if (
      !['model', 'effort', 'fastMode', 'serviceTier', 'providerPicker', 'fastToggle', 'permission'].includes(request.key) ||
      typeof request.value !== 'string' ||
      !request.value.length ||
      request.value.length > 200 ||
      /[\x00-\x1f\x7f]/.test(request.value)
    ) {
      throw new CliError('INVALID_ARGUMENT', 'Select a supported native setting');
    }
    sendJson(200, await runtime.chatOptions(projectId, nodeId, request));
    return true;
  }

  if (action === 'compact') {
    requireMethod('POST');
    queryKeys();
    await body<Record<string, never>>([]);
    sendJson(200, await runtime.compact(projectId, nodeId));
    return true;
  }

  if (action === 'message') {
    queryKeys('runId');
    requireMethod('POST');
    const request = await body<SendMessageRequest>(['message', 'attachments', 'workflowConfirmed', 'requireIdle'], 29 * 1024 * 1024);
    if (request.requireIdle !== undefined && typeof request.requireIdle !== 'boolean') {
      throw new CliError('INVALID_ARGUMENT', 'Invalid idle requirement');
    }
    if (request.workflowConfirmed !== undefined && typeof request.workflowConfirmed !== 'boolean') {
      throw new CliError('INVALID_ARGUMENT', 'Invalid workflow confirmation');
    }
    sendJson(200, await runtime.organization.send(projectId, nodeId, request));
    return true;
  }

  return false;
}

async function streamNodeConversationEvents(ctx: RouteContext, projectId: string, nodeId: string): Promise<void> {
  const { runtime, res, query, requireMethod, queryKeys } = ctx;
  requireMethod('GET');
  queryKeys('runId', 'cursor');
  if (query.has('cursor') && query.get('cursor')!.length > 512) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid conversation cursor');
  }
  runtime.sessions.require(projectId, nodeId);
  if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
  let cursor = query.get('cursor'), closed = false, busy = false;
  const read = () => runtime.conversations.read(runtime.sessions.require(projectId, nodeId), { cursor, limit: 20 });
  const initial = await read();
  if (res.destroyed) return;
  if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
  runtime.connections++;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let publishedRevision = initial.data?.revision;
  let publishedRounds = JSON.stringify(initial.data?.rounds);
  let publishedStatus = '';
  const publishStatus = () => {
    if (closed || res.writableNeedDrain) return;
    try {
      const agentStatus = runtime.sessions.status(projectId, nodeId);
      const liveness = runtime.sessions.liveness(projectId, nodeId);
      const { attemptedAt, ...meta } = agentStatus.meta;
      const key = JSON.stringify({ data: agentStatus.data, meta, liveness });
      if (key === publishedStatus) return;
      const update: NodeStatusUpdate = { nodeId, observedAt: new Date().toISOString(), agentStatus, liveness };
      res.write(`event: node-status\ndata: ${JSON.stringify(update)}\n\n`);
      publishedStatus = key;
    } catch { /* Closing a node never invents a terminal outcome. */ }
  };
  const publish = (conversation: typeof initial, first = false) => {
    if (closed) return;
    if (conversation.data?.nextCursor) cursor = conversation.data.nextCursor;
    const revisionChanged = conversation.data?.revision !== undefined && conversation.data.revision !== publishedRevision;
    const roundSignature = JSON.stringify(conversation.data?.rounds);
    if (first || conversation.data?.messages.length || conversation.meta.issue || revisionChanged || roundSignature !== publishedRounds) {
      res.write(`event: conversation\ndata: ${JSON.stringify(conversation)}\n\n`);
    }
    publishedRounds = roundSignature;
    if (conversation.data?.revision !== undefined) publishedRevision = conversation.data.revision;
  };
  const update = async () => {
    if (closed || busy || res.writableNeedDrain) return;
    busy = true;
    try {
      publishStatus();
      publish(await read());
    } catch {
      if (!closed) res.write('event: stream-reset\ndata: {}\n\n');
      close();
    } finally {
      busy = false;
    }
  };
  const stopWatching = runtime.conversations.watch(runtime.sessions.require(projectId, nodeId), () => { void update(); });
  const stopStatus = runtime.sessions.subscribeStatus(projectId, publishStatus);
  const timer = setInterval(update, 2000);
  const heartbeat = setInterval(() => { if (!closed && !res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    stopWatching();
    stopStatus();
    runtime.connections--;
    runtime.streams.delete(close);
    res.end();
  };
  runtime.streams.add(close);
  res.once('close', close);
  publishStatus();
  publish(initial, true);
}
