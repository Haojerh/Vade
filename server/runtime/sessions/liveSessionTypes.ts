import type { ChildProcess } from 'node:child_process';
import type { AgentChatOptions, AgentStatus, Section } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import type { TerminalTurnStatus } from './programStatus.js';
import type { TerminalScreen } from './terminalScreen.js';

export const MAX_BUFFER = 1024 * 1024;
export const MAX_LIVE_SESSIONS = 16;

export class UncertainMessageDelivery extends CliError {
  constructor() {
    super('CLI_FAILED', 'Delivery may be partial. Inspect Terminal before sending again; the message was not automatically retried.');
  }
}

export interface LiveSession {
  draftInput?: boolean;
  chatCurrent?: AgentChatOptions['current'];
  lastHook?: Section<AgentStatus>;
  nativeApprovalVisible?: boolean;
  answeredPrompt?: string;
  answeredAt?: number;
  inputRevision?: number;
  agentPid?: number;
  screen?: TerminalScreen;
  lastCommand?: string;
  shellTail?: string;
  turnStatus: TerminalTurnStatus;
  turnStartedAt?: number;
  resumeInitializing?: boolean;
  resumeTurnObserved?: boolean;
  resumePromptSubmitted?: boolean;
  programStatus?: Section<AgentStatus>;
  process: ChildProcess;
  buffer: string;
  start: number;
  live: boolean;
  exitCode: number | null;
  pending: Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}
