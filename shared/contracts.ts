export type Id = string; // opaque server-issued ID, 1..256 chars
export type ISO = string; // validated UTC ISO-8601 timestamp
export type State = 'working' | 'waiting' | 'blocked' | 'completed' | 'failed'
  | 'interrupted' | 'idle' | 'unknown';
export type Availability = 'ready' | 'empty' | 'unavailable' | 'unsupported';
export type ErrorCode = 'INVALID_ARGUMENT' | 'PROJECT_NOT_FOUND' | 'RUN_NOT_FOUND'
  | 'NODE_NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'FORBIDDEN_ORIGIN'
  | 'CLI_MISSING' | 'CLI_TIMEOUT' | 'CLI_FAILED' | 'INVALID_UPSTREAM'
  | 'RUNTIME_UNAVAILABLE' | 'AUTH_REQUIRED' | 'REMOTE_MISSING'
  | 'REMOTE_AMBIGUOUS' | 'REMOTE_UNSUPPORTED' | 'GITHUB_FORBIDDEN'
  | 'GITHUB_NOT_FOUND' | 'RATE_LIMITED' | 'SOURCE_CHANGED' | 'INTERNAL'
  | 'CONVERSATION_UNSUPPORTED' | 'SCOPE_UNAVAILABLE';

export interface Issue {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface SourceMeta {
  availability: Availability;
  observedAt: ISO | null; // last successful collection, not HTTP response time
  attemptedAt: ISO;
  stale: boolean;
  partial: boolean; // true for capped, omitted-host, or incomplete collections
  issue: Issue | null;
}

export interface Section<T> {
  data: T | null;
  meta: SourceMeta;
}

export interface ApiError {
  error: Issue;
  requestId: string;
}

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

export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: ISO | null;
}

export interface ProviderUsage {
  provider: string;
  label: string;
  windows: UsageWindow[];
  buckets: UsageWindow[];
  meta: SourceMeta;
}

export interface UsageData {
  providers: ProviderUsage[];
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
  model?: string | null;
  effort?: string | null;
  toolActivity?: Section<ToolActivity[]>;
}

export interface AgentStatus { state: State; source: 'provider-hook' | 'provider-terminal'; event: string }

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

export interface ConversationMessage {
  id: Id; // stable opaque ID from source identity + upstream message ID
  role: 'agent' | 'user';
  text: string; // explicit transcript text blocks only, plain text
  at: ISO | null; // source timestamp only
}

export interface ConversationPage {
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

export interface NodeDetails {
  session?: { terminal: boolean; chat: boolean; history?: boolean; resumable: boolean; reason?: string };
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

export type GitHubActivity = 'commits' | 'prs' | 'issues';
export type GitHubQuery = (
  | { scope: 'general' }
  | { scope: 'worktree'; nodeId: Id }
) & { activity?: GitHubActivity; page?: number };

export interface GitHubScope {
  kind: 'general' | 'worktree';
  nodeId: Id | null;
  branch: string | null;
  commits: 'default-branch' | 'branch' | 'unavailable';
  pullRequests: 'repository' | 'head-branch' | 'unavailable';
  issues: 'repository';
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string | null;
  updatedAt: ISO | null;
  mergedAt: ISO | null;
  headRef: string | null;
  baseRef: string | null;
}

export interface Commit {
  sha: string;
  message: string;
  url: string;
  author: string | null;
  committedAt: ISO | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author: string | null;
  updatedAt: ISO | null;
  labels: string[];
}

export interface GitHubData {
  pagination?: Record<GitHubActivity, { nextPage: number | null }>;
  projectKind?: 'git' | 'folder' | 'unknown';
  repository: {
    owner: string;
    name: string;
    url: string;
    remoteName: string | null;
  } | null;
  auth: 'available' | 'required' | 'unknown';
  scope: GitHubScope;
  pullRequests: Section<PullRequest[]>;
  commits: Section<Commit[]>;
  issues: Section<GitHubIssue[]>;
}

export interface HealthResponse {
  status: 'ok';
  readOnly: boolean;
}

export interface SendMessageRequest {
  message: string;
  attachments?: MessageAttachment[];
}

export interface AgentChatModel {
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
  current: { model?: string; effort?: string; fastMode?: boolean; serviceTier?: string };
  controls: { model: boolean; effort: boolean; fastMode: boolean; fastToggle: boolean; serviceTier: boolean; providerPicker: boolean };
  unconfirmed?: boolean;
}
export interface SetAgentChatOptionRequest {
  key: 'model' | 'effort' | 'fastMode' | 'serviceTier' | 'providerPicker' | 'fastToggle';
  value: string;
}

export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export interface MessageAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface SendMessageResponse {
  ok: boolean;
  message?: string;
}

export interface PrerequisitesStatus {
  runtime?: 'ade' | 'orca';
  git?: boolean;
  orcaApp: boolean;
  orcaAppOpen: boolean;
  orcaCli: boolean;
  orchestrationSkill: boolean;
  orcaCliSkill: boolean;
  ready: boolean;
  version?: string | null;
  issues?: string[];
}

export interface CloseAgentTabResponse {
  ok: boolean;
  message?: string;
}

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

export interface CreateAgentRequest {
  command: string;
  title?: string;
}

export interface CreateWorktreeRequest {
  name: string;
  baseBranch?: string;
  from?: { kind: 'branch' | 'pr' | 'issue'; value: string };
  agentId?: string;
  setup?: 'inherit' | 'run' | 'skip';
}
export interface CreateWorktreeResponse { ok: boolean; message?: string }
export interface CommitGraphEntry {
  sha: string;
  parents: string[];
  message: string;
  author: string;
  committedAt: string;
  refs: string[];
}
export interface CommitGraphData { commits: CommitGraphEntry[]; truncated: boolean }

export interface CreateAgentResponse {
  ok: boolean;
  handle?: string;
  title?: string;
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
}

export interface AgentCatalogResponse {
  runtime?: 'ade' | 'orca';
  installed: AgentCatalogEntry[];
  available: AgentCatalogEntry[];
  defaultAgentId?: string | null;
}
/** Bounded cross-project observations; handling is browser-local. */
export interface InboxItem {
  id: Id;
  nodeId: Id | null;
  runId: Id | null;
  projectId: Id;
  projectName: string;
  entityId: string;
  title: string;
  outcome: 'succeeded' | 'failed';
  at: ISO;
  source: 'agent' | 'task';
}

export interface InboxData { items: InboxItem[] }

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
export type AdeProvider = 'codex' | 'claude' | 'antigravity';
export interface TerminalPage {
  resumable?: boolean;
  data: string;
  cursor: number;
  reset: boolean;
  live: boolean;
  exitCode: number | null;
}
export interface TerminalInputRequest { data: string }
export interface TerminalResizeRequest { cols: number; rows: number }
export type TerminalClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'ack'; cursor: number };
export type TerminalServerMessage = { type: 'output'; page: TerminalPage } | { type: 'error'; message: string };
