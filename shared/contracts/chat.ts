import type { Id, ISO } from './common.js';

/** Recorded user image attachment metadata. Bytes are never inlined here; the exact
 *  bounded bytes are served by the node conversation-image route for this opaque ID. */
export interface ConversationImage {
  id: Id; // opaque token bound to the page source identity and the recorded record offset
  mimeType: string; // sniffed from the recorded bytes; only PNG, JPEG, GIF or WebP
  bytes: number; // recorded decoded byte count
}

export interface ConversationMessage {
  /** Recorded native boundary, never a summary or inferred from message text. */
  kind?: 'compaction';
  rewindable?: boolean;
  id: Id; // stable opaque ID from source identity + upstream message ID
  role: 'agent' | 'user';
  text: string; // explicit transcript text blocks only, plain text
  at: ISO | null; // source timestamp only
  // Present only when the exact session recorded user image attachments for this turn.
  images?: ConversationImage[];
}

/** Explicit settled-turn observations, scoped to this exact native conversation. */
export interface ConversationRound {
  /** Public rows explicitly bracketed by this native turn, including steering prompts. */
  messageIds?: Id[];
  id: Id;
  startedAt: ISO;
  endedAt: ISO;
  outcome: 'completed' | 'failed' | 'interrupted' | 'ended';
  workedMs: number;
  partial: boolean;
  measurement: 'observed-work' | 'native-duration';
}

export interface ConversationPage {
  rounds?: ConversationRound[];
  revision?: string;
  // Node conversation SSE emits Section<ConversationPage> forward deltas; its cursors must never be used for older pagination.
  messages: ConversationMessage[];
  source: 'transcript';
  sourceIdentity: string; // opaque server hash; never a local transcript path
  provider: string | null;
  cursor: string | null; // input public cursor, not a raw upstream cursor
  nextCursor: string | null;
  limited: boolean;
  truncated: boolean;
  warnings: string[];
}

export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export interface MessageAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface SendMessageRequest {
  message: string;
  /** Queue dispatch must never append to a draft or submit while the agent is busy. */
  requireIdle?: boolean;
  attachments?: MessageAttachment[];
  workflowConfirmed?: boolean;
}

export interface SendMessageResponse {
  ok: boolean;
  message?: string;
}

export interface AgentChatModel {
  contextWindow?: number;
  id: string;
  label: string;
  description?: string;
  efforts: { value: string; label: string }[];
  supportsFastMode?: boolean;
  serviceTiers?: { value: string; label: string }[];
}

export interface AgentChatOptions {
  provider: string;
  transport: 'native' | 'terminal';
  models: AgentChatModel[];
  current: { model?: string; effort?: string; fastMode?: boolean; serviceTier?: string; permission?: string };
  permissions?: { value: string; label: string; description?: string }[];
  permissionsRequireRestart?: boolean;
  permissionCurrentSource?: 'native' | 'launch';
  controls: { model: boolean; effort: boolean; fastMode: boolean; fastToggle: boolean; serviceTier: boolean; providerPicker: boolean };
  unconfirmed?: boolean;
}

export interface SetAgentChatOptionRequest {
  confirmRestart?: boolean;
  key: 'model' | 'effort' | 'fastMode' | 'serviceTier' | 'providerPicker' | 'fastToggle' | 'permission';
  value: string;
}

export interface RewindConversationRequest { messageId: string; sourceIdentity: string; revision: string }
export interface RewindConversationResponse { message: string }
export interface NativeRewindPickerRequest {}
export interface NativeRewindPickerResponse { ok: true }

/** A native compaction command was submitted. `ok` requires a fresh native
 *  acknowledgement; an unconfirmed submission is reported without claiming success. */
export interface CompactConversationResponse { ok: boolean; message?: string }
