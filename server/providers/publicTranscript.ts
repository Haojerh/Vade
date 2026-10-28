import type { ConversationMessage } from '../../shared/contracts.js';
import { isCodexImageEnvelopeText, recordedUserImages } from './conversationImages.js';
import { publicTranscriptRecord } from './shared.js';
import { hashId,isCodexTurnAbortedNotice,isSystemInjectedUserText,toIsoOrNull } from './transcriptUtils.js';

export function parseCoordinatorTranscriptLine(
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
        if (role === 'user' && (isSystemInjectedUserText(trimmed, false)
          || (provider === 'codex' && (isCodexTurnAbortedNotice(trimmed) || isCodexImageEnvelopeText(trimmed))))) {
          // A Codex image envelope only wraps the recorded host path; the image itself is projected separately.
          omitted = true;
          continue;
        }
        if (trimmed) textBlocks.push(b.text);
      } else {
        omitted = true;
      }
    }

    if (textBlocks.length === 0 && !(role==='user'&&recordedUserImages(provider,line,opaqueSourceIdentity,0).images.length)) {
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
