import type { Id, ISO, Section, State } from './common.js';
import type { ConversationPage } from './chat.js';
import type { TerminalShell } from './terminal.js';

export type AdeProvider = 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh' | 'terminal';

/** Exact-session native measurement. A missing capacity never implies a model default. */
export interface AgentContextUsage {
  model?: string;
  estimated?: boolean;
  cacheAccounting?: 'included-in-input' | 'separate';
  usedTokens: number | null;
  windowTokens: number | null;
  /** Native auto-compact threshold, when the provider states one separately from the window. */
  autoCompactAtTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  observedAt: ISO | null;
  source: string;
  measurement: 'reported' | 'last-request';
  reason?: string;
}

/** Native errors and reasoning presence only; never reasoning text or tool results. */
export interface ProviderActivity {
  id: Id;
  at: ISO | null;
  kind: 'error' | 'reasoning';
  state: 'recorded' | 'active';
  message?: string; // bounded native error message only
}

export interface AgentWorkTime {
  startedAt: ISO;
  activeSince: ISO | null;
  workedMs: number;
  endedAt: ISO | null;
  partial: boolean;
}

export interface AgentStatus {
  state: State;
  source: 'provider-hook' | 'provider-terminal';
  event: string;
  attention?: 'question' | 'approval' | 'auth';
  toolCall?: { name: string; summary: string };
  workTime?: AgentWorkTime;
}

export type AgentPermissionMode = 'manual' | 'auto' | 'yolo';
export interface AgentPreferences {
  defaultAgent: 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh';
  providers: Record<'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh', { enabled: boolean; mode: AgentPermissionMode }>;
}

export interface AgentInteraction {
  id: string;
  kind: 'question' | 'approval';
  question: string;
  detail?: string;
  options: { id: string; label: string }[];
  textOptionId?: string;
}
export interface AnswerAgentRequest { promptId: string; optionId: string; text?: string }

/** Observed tool calls, with bounded edit-input excerpts; never tool output or private reasoning. */
export interface ToolEditPreview {
  path: string;
  location?: string;
  lines: { kind: 'add' | 'remove' | 'context'; text: string }[];
  truncated: boolean;
}
export interface ToolActivity {
  id: Id;
  at: ISO | null;
  label: string;
  detail?: string;
  edits?: ToolEditPreview[];
  children?: ToolActivity[];
}

/** Observed state of one native child agent. `unknown` is a real answer: a provider that
 *  records no completion signal never gets an inferred one. */
export type SubagentState = 'working' | 'waiting' | 'idle' | 'completed' | 'failed' | 'unknown';

/** One child agent recorded by the provider harness for an exact parent session.
 *  The ID is an opaque source-bound token; it never carries a transcript path. */
export interface Subagent {
  id: Id;
  label: string;
  /** Provider-declared role or agent type, when the harness records one. */
  role: string | null;
  state: SubagentState;
  model: string | null;
  startedAt: ISO | null;
  lastActivityAt: ISO | null;
  /** Bounded last public message text; never tool output or reasoning. */
  preview: string | null;
  /** Whether this child's own transcript is recorded and readable right now. */
  transcript: 'available' | 'unavailable';
  /** Why a transcript is unavailable, for display next to the child. */
  reason?: string;
}

/** One recorded child agent's public turns plus its observed tool calls, kept separate
 *  from conversation history exactly like native chat does. */
export interface SubagentConversation {
  conversation: Section<ConversationPage>;
  tools: ToolActivity[];
}

export interface CreateAgentRequest {
  command: string;
  title?: string;
  /** Fixed shell choice; only applies when command is "terminal". */
  shell?: TerminalShell;
}

export interface CreateAgentResponse {
  ok: boolean;
  handle?: string;
  title?: string;
  message?: string;
}

export interface CloseAgentTabResponse {
  ok: boolean;
  message?: string;
}

export interface AgentCatalogEntry {
  id: string;
  name: string;
  command: string;
  detectCmd: string;
  provider: string;
  installed: boolean;
  isDefault?: boolean;
  homepageUrl?: string;
  permissionCommands?: Partial<Record<AgentPermissionMode, string>>;
}

export interface AgentCatalogResponse {
  runtime?: 'ade' | 'orca';
  installed: AgentCatalogEntry[];
  available: AgentCatalogEntry[];
  defaultAgentId?: string | null;
}

/** One installed agent skill the Chat composer can reference. The name is the recorded
 *  directory identity; the composer applies the provider's own reference prefix. */
export interface AgentSkillSummary {
  name: string;
  description: string;
  scope: 'personal';
}

export interface AgentHistorySession {
  id: string;
  provider: Exclude<AdeProvider, 'terminal'>;
  title: string;
  cwd: string | null;
  lastMessage: string | null;
  messageCount: number;
  limited: boolean;
  updatedAt: string;
  model: string | null;
  projectId: string | null;
  groupId: string;
  groupName: string;
  activeNodeId: string | null;
  activeProjectId: string | null;
}

export interface AgentHistoryPage {
  refreshing?: boolean;
  sessions: AgentHistorySession[];
  groups: { id: string; name: string; total: number; projectTotal: number }[];
  total: number;
  indexed: number;
  scannedFiles: number;
  scannedAt: string;
  limited: boolean;
  nextOffset: number | null;
  warnings: string[];
}

export interface ResumeHistoryRequest { sessionId: string; worktreeId: string }

export interface SessionHandoff {
  sourceId: string;
  context: 'focused' | 'full';
  delivery: 'pending' | 'submitted' | 'uncertain';
}
export interface HandoffSessionRequest { agentId: string; context: 'focused' | 'full'; worktreeId: string }
export interface HandoffSessionResponse { nodeId: string; handoff: SessionHandoff }
export interface HandoffWorktree { id: string; label: string; branch: string | null; path: string; main: boolean; locked: boolean; current: boolean }
