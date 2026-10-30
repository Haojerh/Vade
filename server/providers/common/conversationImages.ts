import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ConversationImage, Id } from '../../../shared/contracts.js';
import { hashId } from './transcriptUtils.js';

/** Recorded user image attachments are projected as bounded metadata only; the bytes
 *  are re-read from the exact bound record when the browser asks for one image. */
export const MAX_MESSAGE_IMAGES = 4;
export const MAX_CONVERSATION_IMAGE_BYTES = 1024 * 1024;
export const MAX_CONVERSATION_PAGE_IMAGE_BYTES = 6 * 1024 * 1024;
// One recorded row must be readable whole: four maximum images plus their JSON envelope.
export const MAX_CONVERSATION_RECORD_BYTES = 6 * 1024 * 1024;
/** Page read window for providers that record images. A smaller window would silently
 *  drop an image-bearing turn whose serialized row is larger than the window. */
export const CONVERSATION_PAGE_READ_BYTES = MAX_CONVERSATION_RECORD_BYTES;
const IMAGE_TRANSCRIPT_PROVIDERS = new Set(['claude', 'codebuddy', 'codex', 'opencode', 'opencode2', 'kilo', 'kilocode']);
/** These providers project their own recorded attachment parts as `input_image` blocks. */
const OPEN_CODE_IMAGE_PROVIDERS = new Set(['opencode', 'opencode2', 'kilo', 'kilocode']);

/** Whether this provider records user images on the transcript row this reader projects. */
export function recordsTranscriptImages(provider: string): boolean {
  return IMAGE_TRANSCRIPT_PROVIDERS.has(provider);
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;
const IMAGE_ID_PATTERN = /^img\.([0-9a-z]{1,10})\.([0-3])\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{20})$/;
const DATA_URL_PATTERN = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]*={0,2})$/;
// Codex wraps a pasted image in its own text envelope; the recorded host path never
// becomes public chat text or a browser fetch target.
const CODEX_IMAGE_ENVELOPE = /^<image\s+name=(?:"[^"]*"|\[[^\]]*\]|'[^']*')\s+path=(?:"[^"]*"|'[^']*')\s*>$/;
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isCodexImageEnvelopeText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '</image>' || CODEX_IMAGE_ENVELOPE.test(trimmed);
}

/** Bytes are authoritative: a declared media type never overrides the recorded signature. */
export function recordedImageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Exact decoded length of a validated base64 payload, without allocating the bytes. */
function decodedBase64Length(data: string): number | null {
  if (!data.length || data.length % 4 !== 0 || !BASE64_ALPHABET.test(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const length = (data.length / 4) * 3 - padding;
  return length > 0 ? length : null;
}

function imageHeader(data: string, declared: string | null): { mimeType: string; bytes: number } | null {
  if (declared !== null && !ALLOWED_IMAGE_MIME.has(declared)) return null;
  const bytes = decodedBase64Length(data);
  if (bytes === null || bytes > MAX_CONVERSATION_IMAGE_BYTES) return null;
  // 32 base64 characters decode to 24 bytes, enough for every supported signature.
  const mimeType = recordedImageMimeType(Buffer.from(data.slice(0, 32), 'base64'));
  return mimeType ? { mimeType, bytes } : null;
}

function decodeImage(data: string, declared: string | null): { mimeType: string; bytes: Buffer } | null {
  const header = imageHeader(data, declared);
  if (!header) return null;
  const bytes = Buffer.from(data, 'base64');
  // Reject non-canonical padding tricks: the decoded bytes must re-encode identically.
  if (bytes.toString('base64') !== data) return null;
  const mimeType = recordedImageMimeType(bytes);
  return mimeType && bytes.length === header.bytes ? { mimeType, bytes } : null;
}

interface ImageCandidate { data: string; declared: string | null }

function claudeFamilyCandidates(record: any): ImageCandidate[] {
  if (record.isMeta || record.isSynthetic || record.isCompactSummary) return [];
  const message = record.message;
  if (message?.role !== 'user' || !Array.isArray(message.content)) return [];
  // A tool row is never a public turn and its nested images are never user attachments.
  if (message.content.some((block: any) => block?.type === 'tool_result' || block?.type === 'tool_use')) return [];
  return message.content.flatMap((block: any) => block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string'
    ? [{ data: block.source.data, declared: typeof block.source.media_type === 'string' ? block.source.media_type : null }]
    : []);
}

function codexCandidates(record: any): ImageCandidate[] {
  if (record.type !== 'response_item' || record.payload?.type !== 'message' || record.payload?.role !== 'user') return [];
  const content = record.payload.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: any) => {
    if (block?.type !== 'input_image' || typeof block.image_url !== 'string') return [];
    const match = DATA_URL_PATTERN.exec(block.image_url);
    return match ? [{ data: match[2], declared: match[1] }] : [];
  });
}

/** Ordered raw candidates for one recorded transcript row. Index order is the locator
 *  used by the serving route, so both paths must derive it identically. */
function imageCandidates(provider: string, line: string): ImageCandidate[] {
  let record: any;
  try { record = JSON.parse(line); } catch { return []; }
  if (!record || typeof record !== 'object') return [];
  if (provider === 'claude' || provider === 'codebuddy') return claudeFamilyCandidates(record);
  if (provider === 'codex' || OPEN_CODE_IMAGE_PROVIDERS.has(provider)) return codexCandidates(record);
  // No shipped evidence records user images for these providers: DSH conversations carry
  // no image events and Antigravity keeps user turns in protobuf blobs. A staged
  // attachment reference in their public text is projected separately. They stay
  // explicitly unavailable here.
  return [];
}

/** Metadata for every recorded user image on this row, bound to the page source identity
 *  and the record's byte offset. `markerNumbers` are the 1-based recorded positions that
 *  actually carry servable bytes, so text markers for rejected images stay literal.
 *  No bytes and no host path leave the backend. */
export function recordedUserImages(provider: string, line: string, sourceIdentity: string, offset: number): { images: ConversationImage[]; markerNumbers: number[] } {
  const result: { images: ConversationImage[]; markerNumbers: number[] } = { images: [], markerNumbers: [] };
  if (!Number.isSafeInteger(offset) || offset < 0) return result;
  const candidates = imageCandidates(provider, line);
  for (let index = 0; index < candidates.length && result.images.length < MAX_MESSAGE_IMAGES; index++) {
    const candidate = candidates[index]!;
    const header = imageHeader(candidate.data, candidate.declared);
    if (!header) continue;
    result.images.push({ id: conversationImageId(sourceIdentity, offset, index, candidate.data), mimeType: header.mimeType, bytes: header.bytes });
    result.markerNumbers.push(index + 1);
  }
  return result;
}

/** Exact recorded bytes for one previously projected image locator. */
export function readRecordedImage(provider: string, line: string, index: number): { mimeType: string; bytes: Buffer } | null {
  const candidate = imageCandidates(provider, line)[index];
  return candidate ? decodeImage(candidate.data, candidate.declared) : null;
}

/** Response headers for one recorded image: a sniffed type, no sniffing, no scripting,
 *  and no cross-origin reuse. Never `no-store`, so a re-rendered bubble stays cheap. */
export function conversationImageHeaders(image: { mimeType: string; bytes: Buffer }): Record<string, string> {
  return {
    'Content-Type': image.mimeType,
    'Content-Length': String(image.bytes.length),
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** Content identity of one recorded image, taken from its canonical recorded base64.
 *  Hashing the recorded text avoids decoding image bytes just to mint a locator. */
export function imageContentDigest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('base64url').slice(0, 12);
}

/** Locator for one recorded image. It carries the record offset, the image position, the
 *  recorded content digest and a token bound to the page source identity, so a rewritten
 *  row or a re-bound transcript cannot serve different bytes under an old ID. */
export function conversationImageId(sourceIdentity: string, offset: number, index: number, content: string): Id {
  const contentDigest = imageContentDigest(content);
  return `img.${offset.toString(36)}.${index}.${contentDigest}.${hashId('img', `${sourceIdentity}:${offset}:${index}:${contentDigest}`).slice(4)}`;
}

/** Every separator is a character base64url cannot produce, so the token splits exactly. */
export function verifyConversationImageId(id: string, sourceIdentity: string): { offset: number; index: number; contentDigest: string } | null {
  const match = IMAGE_ID_PATTERN.exec(id);
  if (!match) return null;
  const offset = Number.parseInt(match[1]!, 36);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2 ** 42) return null;
  const index = Number(match[2]);
  const contentDigest = match[3]!;
  const expected = Buffer.from(hashId('img', `${sourceIdentity}:${offset}:${index}:${contentDigest}`).slice(4));
  const supplied = Buffer.from(match[4]!);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  return { offset, index, contentDigest };
}

/** Read one whole recorded row at an exact byte offset. Anything that is not a complete
 *  bounded row at a line boundary stays unavailable rather than guessed. */
export function readRecordAt(file: string, offset: number): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (offset < 0 || offset >= size) return null;
    if (offset > 0) {
      const previous = Buffer.alloc(1);
      if (fs.readSync(fd, previous, 0, 1, offset - 1) !== 1 || previous[0] !== 0x0a) return null;
    }
    const length = Math.min(size - offset, MAX_CONVERSATION_RECORD_BYTES);
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    if (read <= 0) return null;
    const slice = buffer.subarray(0, read);
    const newline = slice.indexOf(0x0a);
    if (newline < 0 && read === length && offset + length < size) return null;
    const line = slice.subarray(0, newline < 0 ? read : newline).toString('utf8').trim();
    return line || null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Replace sent image markers with nothing once the turn actually carries images, so a
 *  rendered attachment does not leave a dangling `[Image #N]` in the public text. Only
 *  positions backed by servable bytes are removed; others stay literal. OpenCode-family
 *  composers record the same placeholder without the `#`. */
export function stripImagePromptMarkers(text: string, markerNumbers: readonly number[]): string {
  if (!markerNumbers.length) return text;
  const removable = new Set(markerNumbers);
  const stripped = text.replace(/[ \t]*\[Image #?(\d+)\][ \t]*/g, (match, number: string) => removable.has(Number(number)) ? '' : match);
  return stripped === text ? text : stripped.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}
