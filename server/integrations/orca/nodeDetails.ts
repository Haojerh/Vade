import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Id,
  Run,
  Node,
  Section,
  NodeDetails,
  ConversationMessage,
  ConversationPage,
  ErrorCode,
  Graph,
} from '../../../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, CliError, cleanErrorMessage } from '../cli.js';
import { localTranscriptProviders, publicTranscriptRecord } from '../../providers/shared.js';
import { openCodeDatabase, readOpenCodePage, readOpenCodeModel, findOpenCodeSession } from '../../providers/opencode.js';
import { findClaudeTranscript } from '../../providers/claude.js';
import { findCodexTranscript, isCodexChatRecord } from '../../providers/codex.js';
import { resolveAntigravityConversation } from '../../providers/antigravity.js';
import {
  hashId,
  isSystemInjectedUserText,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
  readBoundedTranscriptLines,
  BoundedTranscriptReadResult,
  toIsoOrNull,
} from './utils.js';
import {
  globalSourceMaps,
  cursorStore,
  StoredCursor,
  issueStoredCursor,
  validateStoredCursor,
} from './state.js';
import { collectGraph } from './graph.js';

function unsupportedConversationSection(message: string): Section<ConversationPage> {
  return {
    data: null,
    meta: {
      availability: 'unsupported',
      observedAt: null,
      attemptedAt: new Date().toISOString(),
      stale: false,
      partial: false,
      issue: {
        code: 'CONVERSATION_UNSUPPORTED',
        message,
        retryable: false,
      },
    },
  };
}

function unavailableConversationSection(
  code: ErrorCode,
  message: string,
  retryable: boolean
): Section<ConversationPage> {
  return {
    data: null,
    meta: {
      availability: 'unavailable',
      observedAt: null,
      attemptedAt: new Date().toISOString(),
      stale: false,
      partial: false,
      issue: {
        code,
        message,
        retryable,
      },
    },
  };
}

function lookupCoordinatorRunRow(
  orchDbPath: string,
  sourceRunId: string
): { coordHandle: string | null; coordPaneKey: string | null; coordSessionId: string | null } {
  if (!fs.existsSync(orchDbPath) || !sourceRunId) {
    return { coordHandle: null, coordPaneKey: null, coordSessionId: null };
  }
  let odb: DatabaseSync | null = null;
  try {
    odb = new DatabaseSync(orchDbPath, { readOnly: true });
    const runRow = odb
      .prepare('SELECT coordinator_handle, coordinator_pane_key, coordinator_orca_session_id FROM runs WHERE id = ?')
      .get(sourceRunId) as any;
    return {
      coordHandle: runRow?.coordinator_handle || null,
      coordPaneKey: runRow?.coordinator_pane_key || null,
      coordSessionId: runRow?.coordinator_orca_session_id || null,
    };
  } catch {
    return { coordHandle: null, coordPaneKey: null, coordSessionId: null };
  } finally {
    try { odb?.close(); } catch {}
  }
}

function lookupResumedCodexJournalSession(
  journalDbPath: string,
  cleanLabel: string
): { transcriptPath: string; providerSessionId: string } | null {
  const isGeneric = ['codex', 'terminal'].some((g) => cleanLabel.toLowerCase().startsWith(g));
  if (isGeneric || !fs.existsSync(journalDbPath)) return null;

  let jdb: DatabaseSync | null = null;
  try {
    jdb = new DatabaseSync(journalDbPath, { readOnly: true });
    const rows = jdb
      .prepare(
        "SELECT record_json FROM agent_session_records WHERE json_extract(record_json, '$.provider') = 'codex' ORDER BY createdAt DESC LIMIT 20"
      )
      .all() as any[];
    for (const row of rows) {
      if (!row.record_json) continue;
      const parsed = JSON.parse(row.record_json);
      const threadId = parsed.providerHandleChain?.[0]?.handle?.threadId;
      const matchesSpecific =
        parsed.sessionId === cleanLabel ||
        threadId === cleanLabel ||
        (parsed.title &&
          (parsed.title.toLowerCase() === cleanLabel.toLowerCase() ||
            cleanLabel.toLowerCase().includes(parsed.title.toLowerCase())));
      if (matchesSpecific && threadId) {
        const found = findCodexTranscript(threadId);
        if (found) {
          return { transcriptPath: found, providerSessionId: threadId };
        }
      }
    }
  } catch {} finally {
    try { jdb?.close(); } catch {}
  }
  return null;
}

function lookupJournalSessionById(
  journalDbPath: string,
  coordSessionId: string
): { transcriptPath: string; provider?: string; providerSessionId?: string } | null {
  if (!fs.existsSync(journalDbPath)) return null;
  let jdb: DatabaseSync | null = null;
  try {
    jdb = new DatabaseSync(journalDbPath, { readOnly: true });
    const rec = jdb
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
      .get(coordSessionId) as any;
    if (!rec?.record_json) return null;
    const parsedRec = JSON.parse(rec.record_json);
    if (parsedRec.transcriptPath && typeof parsedRec.transcriptPath === 'string') {
      return {
        transcriptPath: parsedRec.transcriptPath,
        provider: parsedRec.provider || undefined,
        providerSessionId: parsedRec.sessionId || undefined,
      };
    }
  } catch {} finally {
    try { jdb?.close(); } catch {}
  }
  return null;
}

function parseCoordinatorTranscriptLine(
  line: string,
  provider: string,
  opaqueSourceIdentity: string
): { message: ConversationMessage | null; omitted: boolean } {
  try {
    const obj = publicTranscriptRecord(line, provider);
    if (!obj) return { message: null, omitted: false };
    if (obj.payload?.role === 'assistant' && obj.payload?.channel === 'analysis') {
      return { message: null, omitted: false };
    }
    if (obj.type !== 'response_item' || (obj.payload?.type !== 'message' && !obj.payload?.role)) {
      return { message: null, omitted: false };
    }

    const payloadRole = obj.payload.role;
    if (payloadRole !== 'assistant' && payloadRole !== 'user') {
      return { message: null, omitted: true };
    }

    const role: 'agent' | 'user' = payloadRole === 'assistant' ? 'agent' : 'user';
    const contentBlocks = Array.isArray(obj.payload.content) ? obj.payload.content : [];
    const textBlocks: string[] = [];
    let omitted = false;

    for (const b of contentBlocks) {
      if ((b.type === 'output_text' || b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string') {
        const trimmed = b.text.trim();
        if (role === 'user' && isSystemInjectedUserText(trimmed, false)) {
          omitted = true;
          continue;
        }
        if (trimmed) textBlocks.push(b.text);
      } else {
        omitted = true;
      }
    }

    if (textBlocks.length === 0) {
      return { message: null, omitted: true };
    }

    const rawMsgId = obj.payload.id || (typeof obj.ordinal === 'number' ? String(obj.ordinal) : hashId('record', line));
    return {
      message: {
        id: hashId('msg', `${opaqueSourceIdentity}:${rawMsgId}`),
        role,
        text: textBlocks.join('\n'),
        at: toIsoOrNull(obj.timestamp),
      },
      omitted,
    };
  } catch {
    return { message: null, omitted: true };
  }
}

// Resolve Codex/Claude/OpenCode transcripts from exact coordinator or standalone pane metadata.
export async function resolveCoordinatorConversation(
  projectId: Id,
  node: Node,
  activeRun: Run | null,
  options?: { cursor?: string | null; limit?: number },
  standaloneAgent = false
): Promise<Section<ConversationPage>> {
  if (!activeRun && !standaloneAgent) {
    return unsupportedConversationSection('No active run for coordinator conversation');
  }

  if (node.runId && activeRun?.id && node.runId !== activeRun.id) {
    return unsupportedConversationSection(`Node runId ${node.runId} does not match active run ${activeRun.id}`);
  }

  const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
  const orcaDir = path.join(appData, 'orca');
  const orchDbPath = path.join(orcaDir, 'orchestration.db');
  const lastStatusPath = path.join(orcaDir, 'agent-hooks', 'last-status.json');
  const journalDbPath = path.join(orcaDir, 'agent-session-journal.db');

  let { coordHandle, coordPaneKey, coordSessionId } =
    !standaloneAgent && activeRun
      ? lookupCoordinatorRunRow(orchDbPath, activeRun.sourceRunId)
      : { coordHandle: null, coordPaneKey: null, coordSessionId: null };

  const nodeSource = globalSourceMaps.nodeSourceMap.get(node.id);
  const isMatchingCoord =
    standaloneAgent ||
    activeRun?.coordinatorNodeId === node.id ||
    Boolean(coordHandle && nodeSource?.handle === coordHandle) ||
    Boolean(coordPaneKey && nodeSource?.paneKey === coordPaneKey);

  if (!isMatchingCoord) {
    return unsupportedConversationSection(`Node ${node.id} is not the coordinator for run ${activeRun?.sourceRunId}`);
  }

  if (!coordPaneKey && nodeSource?.paneKey) coordPaneKey = nodeSource.paneKey;
  if (!coordHandle && nodeSource?.handle) coordHandle = nodeSource.handle;

  let transcriptPath: string | null = null;
  let provider: string | null = null;
  let providerSessionId: string | null = null;
  let isSourceMismatch = false;

  if (coordPaneKey && fs.existsSync(lastStatusPath)) {
    try {
      const statusData = JSON.parse(fs.readFileSync(lastStatusPath, 'utf-8'));
      const entry = statusData.entries?.[coordPaneKey];
      if (entry) {
        if (standaloneAgent && entry.source && entry.source !== node.agentType) {
          isSourceMismatch = true;
        } else if (
          entry.providerSession &&
          (!standaloneAgent ||
            (entry.source === node.agentType &&
              localTranscriptProviders.includes(entry.source) &&
              (!entry.worktreeId || entry.worktreeId === node.worktreeId) &&
              typeof entry.providerSession.id === 'string' &&
              entry.providerSession.id.trim()))
        ) {
          if (typeof entry.providerSession.transcriptPath === 'string') {
            transcriptPath = entry.providerSession.transcriptPath;
          }
          providerSessionId = entry.providerSession.id || null;
          provider = entry.source || entry.agentPresence?.agent || entry.payload?.agentType || null;
        }
      }
    } catch {}
  }

  const allowedRoots = getAllowedTranscriptRoots();
  const isAllowedPath = (file: string) => isPathInsideRoots(file, allowedRoots);

  // Fallback for resumed or standalone Codex sessions
  if (!transcriptPath && node.agentType === 'codex' && !isSourceMismatch && node.label) {
    transcriptPath = findCodexTranscript(node.label);
    if (!transcriptPath) {
      const journalMatch = lookupResumedCodexJournalSession(journalDbPath, node.label.trim());
      if (journalMatch) {
        transcriptPath = journalMatch.transcriptPath;
        providerSessionId = journalMatch.providerSessionId;
      }
    }
    if (transcriptPath) provider = 'codex';
  }

  // Fallback for resumed OpenCode / Kilo sessions
  if (!transcriptPath && ['opencode', 'kilo', 'kilocode'].includes(node.agentType || '') && !isSourceMismatch && node.label) {
    const rawPtyId =
      nodeSource?.ptyId ||
      (nodeSource?.endpointIncarnation
        ? nodeSource.endpointIncarnation.slice(0, nodeSource.endpointIncarnation.lastIndexOf(':'))
        : null);
    const worktreePath = node.worktreeId
      ? node.worktreeId.includes('::')
        ? node.worktreeId.split('::')[1]
        : node.worktreeId
      : null;
    const ocMatch = findOpenCodeSession(node.agentType!, node.label, isAllowedPath, {
      worktreePath,
      ptyId: rawPtyId,
    });
    if (ocMatch) {
      transcriptPath = ocMatch.dbPath;
      provider = node.agentType;
      providerSessionId = ocMatch.sessionId;
    }
  }

  // Fallback for resumed Claude sessions
  if (!transcriptPath && node.agentType === 'claude' && !isSourceMismatch && node.label) {
    const claudeMatch = findClaudeTranscript(node.label, isAllowedPath);
    if (claudeMatch) {
      transcriptPath = claudeMatch.transcriptPath;
      provider = 'claude';
      providerSessionId = claudeMatch.sessionId;
    }
  }

  if (!transcriptPath && coordSessionId) {
    const journalSession = lookupJournalSessionById(journalDbPath, coordSessionId);
    if (journalSession) {
      transcriptPath = journalSession.transcriptPath;
      provider = journalSession.provider || provider;
      providerSessionId = journalSession.providerSessionId || providerSessionId;
    }
  }

  const databaseProvider = Boolean(provider && ['opencode', 'kilo', 'kilocode'].includes(provider));
  if (!transcriptPath && databaseProvider && providerSessionId) {
    try {
      transcriptPath = openCodeDatabase(provider!, providerSessionId, isAllowedPath);
    } catch {}
  }

  if (databaseProvider && transcriptPath && providerSessionId && !node.model) {
    try {
      const observed = readOpenCodeModel(transcriptPath, providerSessionId);
      if (observed?.model) node.model = observed.model;
      if (observed?.effort) node.effort = observed.effort;
    } catch {}
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return unsupportedConversationSection(
      standaloneAgent
        ? 'Agent transcript provenance not found or unsupported'
        : 'Coordinator transcript provenance not found or unsupported'
    );
  }

  try {
    if (!fs.statSync(transcriptPath).isFile()) {
      throw new Error('Not a regular file');
    }
  } catch {
    return unsupportedConversationSection('Coordinator transcript is not a regular file');
  }

  if (!isAllowedPath(transcriptPath)) {
    return unsupportedConversationSection('Coordinator transcript path is outside allowed provider directories');
  }

  const opaqueSourceIdentity = hashId('src', `${provider}:${providerSessionId}:${transcriptPath}`);

  let startOffset: number | null = null;
  let seekingNewline = false;
  if (options?.cursor) {
    const stored = validateStoredCursor(options.cursor, {
      projectId,
      nodeId: node.id,
      runId: activeRun?.id ?? null,
      sourceIdentity: opaqueSourceIdentity,
    });
    startOffset = parseInt(stored.upstreamCursor, 10) || 0;
    seekingNewline = Boolean(stored.seekingNewline);
  }

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const normalizedMessages: ConversationMessage[] = [];
  let omittedContent = false;
  let currentOffset = startOffset;
  let currentSeeking = seekingNewline;
  let lastReadResult: BoundedTranscriptReadResult | null = null;
  let loopCount = 0;
  const MAX_PAGE_ITERATIONS = 5;

  while (loopCount < MAX_PAGE_ITERATIONS) {
    loopCount++;
    let readResult: BoundedTranscriptReadResult;
    try {
      readResult = databaseProvider
        ? readOpenCodePage(transcriptPath, providerSessionId!, currentOffset, limit)
        : await readBoundedTranscriptLines(
            transcriptPath,
            currentOffset,
            limit,
            8 * 1024 * 1024,
            currentSeeking,
            (line) => {
              try {
                const record = publicTranscriptRecord(line, provider || 'codex');
                return record && isCodexChatRecord(JSON.stringify(record));
              } catch {
                return false;
              }
            }
          );
    } catch (err: any) {
      if (loopCount === 1) {
        return unavailableConversationSection(
          'CLI_FAILED',
          cleanErrorMessage(err.message || 'Failed to read coordinator transcript file'),
          true
        );
      }
      break;
    }

    lastReadResult = readResult;
    currentOffset = readResult.nextByteOffset;
    currentSeeking = Boolean(readResult.seekingNewline);

    for (const line of readResult.lines) {
      const { message, omitted } = parseCoordinatorTranscriptLine(line, provider || 'codex', opaqueSourceIdentity);
      if (omitted) omittedContent = true;
      if (message) {
        normalizedMessages.push(message);
        if (normalizedMessages.length >= limit) break;
      }
    }

    if (normalizedMessages.length >= limit || !readResult.hasMore) {
      break;
    }
  }

  const finalReadResult = lastReadResult!;
  const hasMore = Boolean(finalReadResult?.hasMore);
  const limited = Boolean(finalReadResult?.limited) || (loopCount >= MAX_PAGE_ITERATIONS && normalizedMessages.length < limit);

  let publicNextCursor: string | null = null;
  if (finalReadResult && !(options?.cursor && normalizedMessages.length === 0 && !hasMore)) {
    publicNextCursor = issueStoredCursor({
      upstreamCursor: String(finalReadResult.nextByteOffset),
      projectId,
      nodeId: node.id,
      runId: activeRun?.id ?? null,
      dispatchId: '',
      sourceIdentity: opaqueSourceIdentity,
      sourceMode: 'coordinator-transcript',
      seekingNewline: Boolean(finalReadResult.seekingNewline),
    });
  }

  const page: ConversationPage = {
    messages: normalizedMessages,
    source: 'transcript',
    sourceIdentity: opaqueSourceIdentity,
    provider: provider || 'codex',
    cursor: options?.cursor ?? null,
    nextCursor: publicNextCursor,
    limited: hasMore || limited,
    truncated: false,
    warnings: [],
  };

  return {
    data: page,
    meta: {
      availability: normalizedMessages.length > 0 ? 'ready' : 'empty',
      observedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      stale: false,
      partial: omittedContent || hasMore || limited,
      issue: null,
    },
  };
}

function appendWorkerReadMessages(
  rawMessages: any[],
  opaqueSourceIdentity: string,
  normalizedMessages: ConversationMessage[],
  limit: number
): boolean {
  let omittedContent = false;
  for (const m of rawMessages) {
    if (m.role !== 'assistant' && m.role !== 'user') {
      omittedContent = true;
      continue;
    }
    const role: 'agent' | 'user' = m.role === 'assistant' ? 'agent' : 'user';
    const blocks = Array.isArray(m.blocks) ? m.blocks : [];
    const textBlocks: string[] = [];
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        textBlocks.push(b.text);
      } else {
        omittedContent = true;
      }
    }
    if (textBlocks.length === 0) {
      omittedContent = true;
      continue;
    }
    normalizedMessages.push({
      id: hashId('msg', `${opaqueSourceIdentity}:${m.id}`),
      role,
      text: textBlocks.join('\n'),
      at: toIsoOrNull(m.timestamp),
    });
    if (normalizedMessages.length >= limit) {
      break;
    }
  }
  return omittedContent;
}

function sanitizeWarningList(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) return [];
  const sanitized: string[] = [];
  for (const item of rawList) {
    if (typeof item === 'string') {
      sanitized.push(item.replace(/[a-zA-Z]:\\[^\s]+/g, '[path]').replace(/\/[^\s]+/g, '[path]').slice(0, 200));
    }
  }
  return sanitized;
}

async function resolveWorkerDispatchConversation(
  projectId: Id,
  nodeId: Id,
  node: Node,
  activeRun: Run | null,
  activeRunId: Id | null | undefined,
  dispatchId: string,
  upstreamCursor: string | undefined,
  expectedSourceIdentity: string | undefined,
  options: { cursor?: string | null; limit?: number } | undefined,
  limit: number,
  runner: CommandRunner
): Promise<Section<ConversationPage>> {
  try {
    const readArgs = ['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'transcript'];
    if (upstreamCursor) {
      readArgs.push('--cursor', upstreamCursor);
    }
    readArgs.push('--limit', String(limit), '--json');

    let readRes: any;
    let cursorWasReset = false;
    try {
      readRes = await runOrca<any>(readArgs, runner);
    } catch (workerErr: any) {
      const isPinnedError =
        workerErr.message?.includes('The worker-read cursor is pinned to terminal output') ||
        workerErr.message?.includes('pinned to terminal output');
      if (!isPinnedError) {
        throw workerErr;
      }

      if (options?.cursor) {
        cursorStore.delete(options.cursor);
      }
      if (node.agentType === 'antigravity' || globalSourceMaps.nodeSourceMap.get(node.id)?.paneKey) {
        const agRes = await resolveAntigravityConversation(projectId, node, activeRun, { ...options, cursor: null });
        if (agRes.meta.availability !== 'unsupported') {
          if (agRes.data) {
            agRes.data.warnings = [
              ...(agRes.data.warnings || []),
              'The worker-read cursor was pinned to terminal output and was reset to recent transcript window.',
            ];
          }
          agRes.meta.partial = true;
          return agRes;
        }
      }

      const retryArgs = [
        'orchestration',
        'worker-read',
        '--dispatch',
        dispatchId,
        '--source',
        'transcript',
        '--limit',
        String(limit),
        '--json',
      ];
      readRes = await runOrca<any>(retryArgs, runner);
      cursorWasReset = true;
    }

    const res = readRes.result;
    if (res?.source !== 'transcript' || res?.sourceExact !== true) {
      return unsupportedConversationSection('Transcript source is not exact or unsupported');
    }

    if (
      !res ||
      typeof res !== 'object' ||
      typeof res.sourceIdentity !== 'string' ||
      !res.sourceIdentity.trim() ||
      !res.transcript ||
      typeof res.transcript !== 'object' ||
      !Array.isArray(res.transcript.messages)
    ) {
      return unavailableConversationSection('INVALID_UPSTREAM', 'Malformed transcript payload from upstream', false);
    }

    const rawSourceIdentity = res.sourceIdentity.trim();
    if (expectedSourceIdentity && expectedSourceIdentity !== rawSourceIdentity) {
      return unavailableConversationSection(
        'SOURCE_CHANGED',
        'Source transcript has changed. Reset cursor and reload.',
        true
      );
    }

    const rawMessages = res.transcript.messages;
    const malformedMessage = rawMessages.some(
      (m: any) => !m || typeof m !== 'object' || m.id === undefined || m.id === null || String(m.id).trim() === ''
    );
    if (malformedMessage) {
      return unavailableConversationSection('INVALID_UPSTREAM', 'Transcript message missing valid identity', false);
    }

    const opaqueSourceIdentity = hashId('src', rawSourceIdentity);
    const normalizedMessages: ConversationMessage[] = [];
    let omittedContent = appendWorkerReadMessages(rawMessages, opaqueSourceIdentity, normalizedMessages, limit);

    let latestNextCursor: string | null = res.transcript?.nextCursor || null;
    let autoPages = 1;
    while (normalizedMessages.length === 0 && latestNextCursor && autoPages < 5) {
      autoPages++;
      try {
        const nextArgs = [
          'orchestration',
          'worker-read',
          '--dispatch',
          dispatchId,
          '--source',
          'transcript',
          '--cursor',
          latestNextCursor,
          '--limit',
          String(limit),
          '--json',
        ];
        const nextReadRes = await runOrca<any>(nextArgs, runner);
        const nextData = nextReadRes.result;
        if (
          !nextData ||
          nextData.source !== 'transcript' ||
          nextData.sourceExact !== true ||
          !nextData.transcript ||
          !Array.isArray(nextData.transcript.messages)
        ) {
          break;
        }
        const nextRawId = nextData.sourceIdentity?.trim();
        if (nextRawId && nextRawId !== rawSourceIdentity) {
          break;
        }
        if (appendWorkerReadMessages(nextData.transcript.messages, opaqueSourceIdentity, normalizedMessages, limit)) {
          omittedContent = true;
        }
        if (!nextData.transcript.nextCursor || nextData.transcript.nextCursor === latestNextCursor) {
          latestNextCursor = null;
          break;
        }
        latestNextCursor = nextData.transcript.nextCursor;
      } catch {
        break;
      }
    }

    const limited = Boolean(res.transcript?.limited) || (autoPages >= 5 && normalizedMessages.length < limit);
    const hasClipping = Array.isArray(res.clipping) && res.clipping.length > 0;
    const truncated = res.contentComplete === false || hasClipping;
    const partial = limited || truncated || omittedContent || cursorWasReset;

    const warnings: string[] = [
      ...(cursorWasReset
        ? ['The worker-read cursor was pinned to terminal output and was reset to recent transcript window.']
        : []),
      ...sanitizeWarningList(res.warnings),
      ...sanitizeWarningList(res.clipping),
    ];

    let publicNextCursor: string | null = null;
    const finalUpstreamCursor = latestNextCursor || res.transcript?.nextCursor;
    if (finalUpstreamCursor) {
      publicNextCursor = issueStoredCursor({
        upstreamCursor: finalUpstreamCursor,
        projectId,
        nodeId,
        runId: activeRunId ?? null,
        dispatchId,
        sourceIdentity: rawSourceIdentity,
        sourceMode: 'worker-read-transcript',
      });
    }

    const page: ConversationPage = {
      messages: normalizedMessages,
      source: 'transcript',
      sourceIdentity: opaqueSourceIdentity,
      provider: res.provider ? String(res.provider) : null,
      cursor: options?.cursor ?? null,
      nextCursor: publicNextCursor,
      limited,
      truncated,
      warnings,
    };

    return {
      data: page,
      meta: {
        availability: normalizedMessages.length > 0 ? 'ready' : 'empty',
        observedAt: new Date().toISOString(),
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial,
        issue: null,
      },
    };
  } catch (err: any) {
    if (err instanceof CliError && err.issue.code === 'INVALID_ARGUMENT') {
      throw err;
    }
    const isPinnedToTerminal =
      err.message?.includes('pinned to terminal output') || err.issue?.message?.includes('pinned to terminal output');
    const isSourceChanged =
      err.message?.includes('source_changed') ||
      err.issue?.code === 'SOURCE_CHANGED' ||
      err.issue?.message?.includes('source_changed');
    const isUnsupported =
      err.issue?.code === 'CONVERSATION_UNSUPPORTED' ||
      err.message?.includes('transcript_required') ||
      err.message?.includes('provider_unsupported') ||
      err.message?.includes('session_not_reported') ||
      err.message?.includes('release_completed') ||
      isPinnedToTerminal;

    if (
      isUnsupported &&
      (node.agentType === 'antigravity' || globalSourceMaps.nodeSourceMap.get(node.id)?.paneKey)
    ) {
      const agRes = await resolveAntigravityConversation(projectId, node, activeRun, options);
      if (agRes.meta.availability !== 'unsupported') {
        if (isPinnedToTerminal && agRes.data) {
          agRes.data.warnings = [
            ...(agRes.data.warnings || []),
            'The worker-read cursor was pinned to terminal output and was reset to recent transcript window.',
          ];
          agRes.meta.partial = true;
        }
        return agRes;
      }
    }

    const rawMsg = err.issue?.message || err.message || 'Failed to read worker transcript';
    const cleanMsg = cleanErrorMessage(rawMsg);
    const code: ErrorCode = isSourceChanged
      ? 'SOURCE_CHANGED'
      : isUnsupported
        ? 'CONVERSATION_UNSUPPORTED'
        : err.issue?.code || 'CLI_FAILED';
    const message = isSourceChanged ? 'Source transcript has changed. Reset cursor and reload.' : cleanMsg;

    return {
      data: null,
      meta: {
        availability: isUnsupported ? 'unsupported' : 'unavailable',
        observedAt: null,
        attemptedAt: new Date().toISOString(),
        stale: false,
        partial: false,
        issue: {
          code,
          message,
          retryable: !isUnsupported && !isSourceChanged,
        },
      },
    };
  }
}

// 3. Read node details & conversation
export async function collectNodeDetails(
  projectId: Id,
  nodeId: Id,
  options?: { runId?: Id | null; cursor?: string | null; limit?: number; preloadedGraph?: Graph },
  runner: CommandRunner = defaultCommandRunner
): Promise<NodeDetails> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
  const graph = options?.preloadedGraph ?? (await collectGraph(projectId, options?.runId ?? null, runner)).graph;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new CliError('NODE_NOT_FOUND', `Node ${nodeId} not found in project ${projectId}`);
  }

  const nodeTaskSet = new Set(node.taskIds);
  const tasks = graph.tasks.filter((t) => nodeTaskSet.has(t.id));
  const activity = graph.activity.filter((a) => a.nodeId === nodeId);

  if (node.kind !== 'agent' && node.kind !== 'orchestrator') {
    return {
      node,
      tasks,
      activity,
      currentTool: null,
      conversation: unsupportedConversationSection(
        'Conversation history is only supported for agent and orchestrator nodes'
      ),
    };
  }

  const activeRunId = options?.runId ?? graph.selectedRunId;
  const activeRun = graph.runs.find((r) => r.id === activeRunId) || null;
  const isCoordinator = node.kind === 'orchestrator' || Boolean(activeRun && activeRun.coordinatorNodeId === nodeId);

  const bindingKey = `${projectId}::${activeRunId}::${nodeId}`;
  const binding = globalSourceMaps.dispatchMap.get(bindingKey);
  const currentTool: { name: string; input: string | null } | null = binding?.tool ?? null;

  let storedCursorObj: StoredCursor | undefined;
  let upstreamCursor: string | undefined;
  let expectedSourceIdentity: string | undefined;

  if (options?.cursor) {
    const stored = validateStoredCursor(options.cursor, {
      projectId,
      nodeId,
      runId: activeRunId ?? null,
      dispatchId: binding?.dispatchId,
    });
    storedCursorObj = stored;
    upstreamCursor = stored.upstreamCursor;
    expectedSourceIdentity = stored.sourceIdentity;
  }

  if (
    isCoordinator ||
    storedCursorObj?.sourceMode === 'coordinator-transcript' ||
    (localTranscriptProviders.includes(node.agentType || '') && !binding?.ambiguous && !binding?.dispatchId)
  ) {
    return {
      node,
      tasks,
      activity,
      currentTool,
      conversation: await resolveCoordinatorConversation(projectId, node, activeRun, options, !isCoordinator),
    };
  }

  if (
    storedCursorObj?.sourceMode === 'antigravity-transcript' ||
    (node.agentType === 'antigravity' && (!binding || !binding.dispatchId || binding.ambiguous))
  ) {
    return {
      node,
      tasks,
      activity,
      currentTool,
      conversation: await resolveAntigravityConversation(projectId, node, activeRun, options),
    };
  }

  if (storedCursorObj?.sourceMode === 'terminal') {
    upstreamCursor = undefined;
  }

  if (!binding || !binding.dispatchId || binding.ambiguous) {
    const isAmbiguous = Boolean(binding?.ambiguous);
    return {
      node,
      tasks,
      activity,
      currentTool,
      conversation: unsupportedConversationSection(
        isAmbiguous
          ? 'Ambiguous worker dispatch binding for node'
          : 'Node does not have an active worker dispatch binding'
      ),
    };
  }

  const conversationSection = await resolveWorkerDispatchConversation(
    projectId,
    nodeId,
    node,
    activeRun,
    activeRunId,
    binding.dispatchId,
    upstreamCursor,
    expectedSourceIdentity,
    options,
    limit,
    runner
  );

  return {
    node,
    tasks,
    activity,
    currentTool,
    conversation: conversationSection,
  };
}
