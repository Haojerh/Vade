import type { MessageAttachment } from './chat.js';

export type TerminalShell = 'powershell' | 'cmd' | 'bash';

export interface TerminalPage {
  cols?: number;
  rows?: number;
  restartable?: boolean;
  recoverable?: boolean;
  resumable?: boolean;
  data: string;
  cursor: number;
  reset: boolean;
  live: boolean;
  exitCode: number | null;
}

export interface TerminalInputRequest { data: string }
/** Paste validated image bytes into an owned native composer, without Enter. */
export interface TerminalAttachmentsRequest { attachments: MessageAttachment[] }

/** Fixed native interruption on the exact working owned agent. No client keys. */
export type InterruptAgentRequest = Record<string, never>;
export interface InterruptAgentResponse { ok: true }

export interface TerminalResizeRequest { cols: number; rows: number }
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; cursor: number };
export type TerminalServerMessage =
  | { type: 'output'; page: TerminalPage }
  | { type: 'error'; message: string };
