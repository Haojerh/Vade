import type { Id, ISO, Section, State } from './common.js';
import type { AgentContextUsage, AgentStatus, ProviderActivity, Subagent, ToolActivity } from './agents.js';
import type { WorkflowStep } from './workflow.js';
import type { ConversationPage } from './chat.js';
import type { SessionHandoff } from './agents.js';

export interface Project {
  id: Id; // opaque registry key; never an arbitrary filesystem path
  name: string;
  kind: 'git' | 'folder' | 'unknown';
  sourceProjectId: string | null;
  repoIds: string[];
  paths: string[];
  hostIds: string[];
}

export interface Inventory {
  projects: Project[];
}

export type RegisterProjectRequest =
  | { mode?: 'existing'; path: string; name?: string }
  | { mode: 'create'; path: string; name: string }
  | { mode: 'clone'; path: string; name: string; url: string };
export interface RegisterProjectResponse { project: Project }
export interface DeleteProjectResponse { ok: true }

export interface LocalFolders {
  path: string;
  parent: string | null;
  home: string;
  folders: { name: string; path: string }[];
  limited: boolean;
}

export interface ProjectShortcut {
  id: string;
  label: string;
  action: 'terminal' | 'agent';
  command: string;
  appendEnter: boolean;
  agent: 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh';
}
export interface RunProjectShortcutResponse { nodeId: string; staged: boolean; message: string }

export interface CreateWorktreeRequest {
  name: string;
  baseBranch?: string;
  from?: { kind: 'branch' | 'pr' | 'issue'; value: string };
  agentId?: string;
  setup?: 'inherit' | 'run' | 'skip';
}
export interface CreateWorktreeResponse { ok: boolean; message?: string }
export interface DeleteWorktreeResponse {
  ok: boolean;
  message?: string;
}

export interface RenameNodeTitleRequest {
  title: string;
}
export interface RenameNodeTitleResponse {
  ok: boolean;
  title: string;
  message?: string;
}

export interface Run {
  id: Id;
  sourceRunId: string;
  objective: string;
  coordinatorNodeId: Id | null;
  association: 'coordinator-terminal' | 'worker-workspace';
}

export interface Node {
  agentStatus?: Section<AgentStatus>;
  id: Id;
  kind: 'orchestrator' | 'worktree' | 'agent' | 'terminal';
  label: string;
  worktreeId: string | null;
  runId: Id | null;
  agentType: string | null;
  branch: string | null;
  path: string | null;
  state: State;
  rawState: string | null;
  workspaceStatus: string | null;
  taskOutcome: string | null;
  liveness: 'live' | 'exited' | 'unverifiable' | 'unknown';
  observedAt: ISO | null;
  lastActivityAt: ISO | null;
  stale: boolean;
  taskIds: Id[];
  preview: string | null;
  outputAvailable: boolean;
  chatAvailable?: boolean;
  /** Provider exposes a verified native compaction command for this session. */
  chatCompact?: boolean;
  /** Observed empty native prompt; automatic queue dispatch revalidates before input. */
  chatReady?: boolean;
  workflow?: { runId: string; role: 'orchestrator' | 'worker'; stepState?: WorkflowStep['state'] };
  model?: string | null;
  effort?: string | null;
  toolActivity?: Section<ToolActivity[]>;
  providerActivity?: Section<ProviderActivity[]>;
  /** Native child agents this exact session spawned; absence means the provider records none. */
  subagents?: Section<Subagent[]>;
  contextUsage?: AgentContextUsage;
}

export interface OrchestrationMessage {
  id: Id;
  source: Id;
  target: Id;
  at: ISO;
}

export interface Edge {
  id: Id;
  source: Id;
  target: Id;
  kind: 'contains' | 'lineage' | 'delegates';
  evidence: 'workspace-membership' | 'parent-worktree' | 'parent-pane'
    | 'run-dispatch';
  active: boolean;
  messages?: OrchestrationMessage[];
}

export interface Task {
  id: Id;
  runId: Id;
  title: string;
  spec: string | null;
  specTruncated: boolean;
  rawStatus: string;
  state: State;
  assigneeNodeId: Id | null;
  result: string | null;
  dependencyIds: Id[];
  createdAt: ISO | null;
  completedAt: ISO | null;
}

export interface Progress {
  total: number;
  completed: number;
  failed: number;
  working: number;
  waiting: number;
  blocked: number;
  unknown: number;
  percent: number | null;
  coverage: 'complete' | 'partial' | 'unavailable';
  basis: 'completed-tasks';
}

export interface Activity {
  id: Id;
  nodeId: Id | null;
  taskId: Id | null;
  at: ISO;
  timestampKind: 'source' | 'observed';
  kind: 'task-status' | 'agent-status' | 'output-observed';
  text: string;
}

export interface Graph {
  runs: Run[];
  selectedRunId: Id | null;
  nodes: Node[];
  edges: Edge[];
  tasks: Task[];
  progress: Progress;
  activity: Activity[];
}

export interface DashboardSnapshot {
  projectId: Id;
  revision: string;
  generatedAt: ISO;
  runtime: Section<{ version: string | null; runtimeId: string | null }>;
  graph: Section<Graph>;
}

/** Observed status on the selected conversation stream, independent of transcript growth. */
export interface NodeStatusUpdate {
  nodeId: Id;
  observedAt: ISO;
  agentStatus: Section<AgentStatus>;
  liveness: Node['liveness'];
}

export interface NodeDetails {
  terminalPreview?: string | null;
  session?: { terminal: boolean; chat: boolean; history?: boolean; resumable: boolean; reason?: string; handoff?: SessionHandoff };
  node: Node;
  tasks: Task[];
  activity: Activity[];
  currentTool: { name: string; input: string | null } | null;
  conversation: Section<ConversationPage>; // replaces output entirely
}

export interface NodeDetailsQuery {
  direction?: 'older';
  runId?: Id | null;
  cursor?: string | null;
  limit?: number;
}
