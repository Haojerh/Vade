import type { ConversationImage } from '../../../shared/contracts.js';
import { parseAntigravityTranscriptLine } from '../../providers/antigravity/antigravity.js';
import { recordedUserImages, stripImagePromptMarkers } from '../../providers/common/conversationImages.js';
import { parseCoordinatorTranscriptLine } from '../../providers/common/publicTranscript.js';
import { hashId, toIsoOrNull } from '../../providers/common/transcriptUtils.js';
import { publicRewindTarget } from './controls/providerRewind.js';
import { stagedImagesFromText, stripStagedImageTokens } from './stagedConversationImages.js';
import type { SessionRecord } from '../store.js';

export function publicMessage(
  record: SessionRecord,
  line: string,
  sourceIdentity: string,
  offset?: number,
  imageBudget?: { remaining: number },
  attachmentRoot?: string,
) {
  const visible = (message: ReturnType<typeof parseCoordinatorTranscriptLine>['message']) => {
    if (!message || message.role !== 'user' || !message.text.startsWith('[Vade workflow assignment; protocol 1.0.0]')) return message;
    if (!message.text.includes('\nYou are the orchestrator.')) {
      const role = message.text.indexOf('\nRole:\n');
      const task = message.text.indexOf('\nTask:\n', role);
      const original = message.text.indexOf('\nOriginal user request:\n', task);
      const end = message.text.lastIndexOf('\nPredecessor results (full results via context):\n');
      if (role < 0 || task < role || original < task || end < original) return null;
      return {
        ...message,
        text:
          'Workflow assignment\n\nRole:\n' +
          message.text.slice(role + 7, task) +
          '\n\nTask:\n' +
          message.text.slice(task + 7, original) +
          '\n\nOriginal user request:\n' +
          message.text.slice(original + 24, end),
      };
    }
    const marker = '\nOriginal user request:\n';
    const start = message.text.indexOf(marker);
    return start < 0 ? null : { ...message, text: message.text.slice(start + marker.length) };
  };

  // Recorded user images are metadata only; their bytes are served by the exact-record route.
  const projected = (message: ReturnType<typeof parseCoordinatorTranscriptLine>['message']) => {
    if (!message || message.role !== 'user' || offset === undefined) return message;
    const { images, markerNumbers } = recordedUserImages(record.provider, line, sourceIdentity, offset);
    // Every provider that records the staged attachment reference as public text
    // (a bare path, an `@` mention or a quoted path) projects the same owned bytes.
    const staged =
      !images.length && attachmentRoot
        ? stagedImagesFromText(message.text, attachmentRoot, sourceIdentity, offset)
        : { images: [], tokens: [] };
    const kept: ConversationImage[] = [];
    const keptMarkers: number[] = [];
    const keptTokens: string[] = [];
    (images.length ? images : staged.images).forEach((image, index) => {
      if (imageBudget && image.bytes > imageBudget.remaining) return;
      if (imageBudget) imageBudget.remaining -= image.bytes;
      kept.push(image);
      if (staged.tokens[index]) keptTokens.push(...staged.tokens[index]!);
      else keptMarkers.push(markerNumbers[index]!);
    });
    if (!kept.length) return message;
    return {
      ...message,
      text: stripStagedImageTokens(stripImagePromptMarkers(message.text, keptMarkers), keptTokens),
      images: kept,
    };
  };

  try {
    const row = JSON.parse(line);
    const codeBuddySummaryCompaction =
      row.providerData?.isSummary === true &&
      typeof row.providerData?.compactionId === 'string' &&
      row.providerData?.isCompactInternal !== true &&
      row.providerData?.isCompactRecovery !== true;
    const codeBuddyManualCompaction =
      row.providerData?.isCompacted === true &&
      typeof row.providerData?.compactionId === 'string' &&
      row.providerData?.compactType === 'user-command' &&
      row.providerData?.compactionKind === 'manual' &&
      row.providerData?.compactionTrigger === 'manual' &&
      row.providerData?.isCompactRecovery !== true;
    const compaction =
      !row.isSidechain &&
      !row._fromSubAgent &&
      (!row.sessionId || row.sessionId === record.providerThreadId) &&
      ((['codex', 'dsh', 'opencode', 'kilo', 'opencode2'].includes(record.provider) && row.type === 'compacted') ||
        (record.provider === 'claude' && row.type === 'system' && row.subtype === 'compact_boundary') ||
        (record.provider === 'codebuddy' && (codeBuddySummaryCompaction || codeBuddyManualCompaction)));
    if (compaction) {
      return {
        id: hashId('msg', `${sourceIdentity}:compaction:${row.uuid ?? row.id ?? hashId('record', line)}`),
        role: 'agent' as const,
        kind: 'compaction' as const,
        text: 'Context compacted',
        at: toIsoOrNull(row.timestamp),
      };
    }
    if (
      record.provider === 'codebuddy' &&
      typeof row.providerData?.compactionId === 'string' &&
      (row.providerData?.isCompacted === true || row.providerData?.isSummary === true || row.providerData?.isCompactInternal === true)
    ) {
      return null;
    }
    if (record.provider !== 'antigravity') {
      if (['claude', 'codebuddy'].includes(record.provider) && row.sessionId && row.sessionId !== record.providerThreadId) return null;
      const message = projected(visible(parseCoordinatorTranscriptLine(line, record.provider, sourceIdentity).message));
      if (
        message?.role === 'user' &&
        record.provider === 'claude' &&
        !message.images?.length &&
        publicRewindTarget('claude', line, sourceIdentity)?.messageId === message.id &&
        !row.message?.content?.some?.((part: any) => ['image', 'document', 'tool_result'].includes(part?.type))
      ) {
        return { ...message, rewindable: true };
      }
      return message &&
        record.provider === 'dsh' &&
        message.role === 'user' &&
        !row.payload?.hasAttachments &&
        Number.isSafeInteger(row.payload?.nativeSeq) &&
        row.payload.nativeSeq >= 0 &&
        row.payload.nativeSeq < 4000
        ? { ...message, rewindable: true }
        : message;
    }
    if (['USER_EXPLICIT', 'USER'].includes(row.source) && ['USER_INPUT', 'REQUEST'].includes(row.type)) {
      return projected(visible(parseAntigravityTranscriptLine(JSON.stringify({ ...row, type: 'USER_INPUT' }), sourceIdentity).message));
    }
    return (row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE') || (row.type === 'CHECKPOINT' && row.source === 'SYSTEM')
      ? parseAntigravityTranscriptLine(line, sourceIdentity).message
      : null;
  } catch {
    return null;
  }
}
