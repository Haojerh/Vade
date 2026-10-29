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
  pendingProviders?: string[];
}

export interface LocalConnection {
  id: 'github' | 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh';
  label: string;
  installed: boolean;
  connected: boolean | null;
  message: string;
  installUrl: string;
  loginCommand: string;
  accounts?: ProviderAccount[];
}

export type AccountProvider = 'codex' | 'claude' | 'opencode';
export interface ProviderAccount {
  id: string;
  label: string;
  active: boolean;
  detected: boolean | null;
  signIn?: ProviderSignIn;
  loginCommand: string;
}
export interface ProviderSignIn { state: 'pending' | 'complete' | 'failed'; url?: string }
export interface AddProviderAccountRequest { label: string }
export interface SelectProviderAccountRequest { accountId: string }

export interface LocalConnectionsData {
  host: 'Windows' | 'macOS' | 'Linux';
  connections: LocalConnection[];
}

export interface AppResources {
  memoryBytes: number;
  scope: 'desktop-app' | 'backend' | 'desktop-tree' | 'backend-tree';
  processCount?: number;
  observedAt: ISO;
}
export interface ResourceProcess { pid: number; parent: number; name: string; memoryBytes: number; privateBytes: number | null; cpuPercent: number | null }
export interface ResourceDetails { observedAt: string; totalBytes: number; groups: { id: string; label: string; processes: ResourceProcess[] }[] }
export interface ComputerAwakeStatus { mode: 'on' | 'agent' | 'off'; active: boolean; error: string | null }
export interface WorkspacePort { id: string; port: number; address: string; pid: number; process: string; projectId: string | null; project: string | null; canKill: boolean }
export interface WorkspacePorts { observedAt: string; ports: WorkspacePort[]; error: string | null }

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
  contextUsage?: AgentContextUsage;
}

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

export interface AgentWorkTime { startedAt: ISO; activeSince: ISO | null; workedMs: number; endedAt: ISO | null; partial: boolean }
export interface AgentStatus { state: State; source: 'provider-hook' | 'provider-terminal'; event: string; attention?: 'question' | 'approval' | 'auth'; toolCall?: { name: string; summary: string }; workTime?: AgentWorkTime }

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
  messageIds?:Id[];
  id:Id; startedAt:ISO; endedAt:ISO;
  outcome:'completed'|'failed'|'interrupted'|'ended';
  workedMs:number; partial:boolean;
  measurement:'observed-work'|'native-duration';
}
export interface ConversationPage {
  rounds?:ConversationRound[];
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
/** Observed status on the selected conversation stream, independent of transcript growth. */
export interface NodeStatusUpdate {nodeId:Id;observedAt:ISO;agentStatus:Section<AgentStatus>;liveness:Node['liveness']}

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
  /** Queue dispatch must never append to a draft or submit while the agent is busy. */
  requireIdle?: boolean;
  attachments?: MessageAttachment[];
  workflowConfirmed?: boolean;
}
export const WORKFLOW_CONFIRMATION_MESSAGE = 'Workflow enabled, confirm to continue implementation with workflow or disable settings yourself';
export interface AdhocOrchestrationRequest {
  request: string;
  isolatedWorktrees?: boolean;
  nodes: Omit<OrganizationNode, 'x' | 'y'>[];
  edges?: OrganizationConfig['edges'];
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
export interface NativeRewindPickerResponse { ok:true }

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

export type TerminalShell = 'powershell' | 'cmd' | 'bash';

export interface CreateAgentRequest {
  command: string;
  title?: string;
  /** Fixed shell choice; only applies when command is "terminal". */
  shell?: TerminalShell;
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
export interface CommitFiles { sha:string; files:{path:string;status:string}[]; truncated:boolean; excluded:number }

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
/** Bounded cross-project observations; handling is shared by the local backend. */
export interface InboxItem {
  id: Id;
  nodeId: Id | null;
  runId: Id | null;
  projectId: Id;
  projectName: string;
  entityId: string;
  title: string;
  outcome: 'succeeded' | 'failed' | 'completed' | 'interrupted' | 'waiting';
  at: ISO;
  source: 'agent' | 'task' | 'turn' | 'attention';
}

export interface InboxData { items: InboxItem[] }
export interface NotificationState {
  initialized: boolean; revision: number;
  seenIds: string[]; unreadIds: string[]; readIds: string[]; clearedIds: string[];
}
export interface UpdateNotificationStateRequest {
  scope: string; action: 'observe' | 'acknowledge' | 'clear' | 'import';
  ids?: string[]; baseline?: boolean;
  legacy?: { seenIds?: string[]; unreadIds?: string[]; readIds?: string[]; clearedIds?: string[] };
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
export type AdeProvider = 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh' | 'terminal';
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
export interface ProjectShortcut { id: string; label: string; action: 'terminal' | 'agent'; command: string; appendEnter: boolean; agent: 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh' }
export interface RunProjectShortcutResponse { nodeId: string; staged: boolean; message: string }
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
export interface SourceFile { path:string; index:string; worktree:string; added:number|null; removed:number|null; stagedAdded?:number|null; stagedRemoved?:number|null; workingAdded?:number|null; workingRemoved?:number|null }
export interface SourceStatus { worktreeId:string; branch:string|null; head:string|null; upstream:string|null; ahead:number; behind:number; files:SourceFile[]; version:string; refs:string[]; base:string|null; canCreatePr:boolean; conflicts:boolean; truncated:boolean; excluded:number }
export type SourceAction='stage'|'unstage'|'discard'|'commit'|'push'|'forcePush'|'pull'|'fetch'|'fastForward'|'sync'|'rebase'|'publish'|'createPr';
export interface SourceActionRequest { worktreeId:string; action:SourceAction; version:string; paths?:string[]; message?:string; base?:string; title?:string; body?:string }
export interface SourceActionResponse { ok:true; url?:string }
export interface SourceReviewQuery { worktreeId:string; base?:string }
export interface SourceDiff { path:string; original:string; modified:string; binary:boolean; reason?:string }
/** Fixed native interruption on the exact working owned agent. No client keys. */
export type InterruptAgentRequest = Record<string, never>;
export interface InterruptAgentResponse { ok: true }
/** A native compaction command was submitted. `ok` requires a fresh native
 *  acknowledgement; an unconfirmed submission is reported without claiming success. */
export interface CompactConversationResponse { ok: boolean; message?: string }
export interface TerminalResizeRequest { cols: number; rows: number }
export type TerminalClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'ack'; cursor: number };
export type TerminalServerMessage = { type: 'output'; page: TerminalPage } | { type: 'error'; message: string };
/** Saved execution graph. Requested launch options are separate from observed agent metadata. */
export type WorkflowProvider = Exclude<AdeProvider, 'terminal'>;
export interface OrganizationNode {
  id: string; title: string; prompt: string; provider: WorkflowProvider;
  model: string | null; effort: string | null; x: number; y: number;
}
export interface OrganizationConfig {
  version: 1; enabled: boolean; isolatedWorktrees: boolean;
  closeWorkersOnCompletion?: boolean;
  removeWorktreesOnCompletion?: boolean;
  orchestratorPosition?: { x: number; y: number };
  nodes: OrganizationNode[]; edges: { source: string; target: string }[];
}
export interface WorkflowModel { id: string; label: string; efforts: string[]; effortModels?: Record<string, string>; contextWindow?: number }
export interface WorkflowSetupStatus { ready: boolean; cli: boolean; skill: boolean; cliSkill: boolean; cliPath: string; version: string; error: string | null }
export interface WorkflowStep {
  nodeId: string; state: 'pending' | 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped';
  sessionId: string | null; stream: string | null; result: string | null; delivery: 'not-sent' | 'submitted' | 'uncertain';
  task?: string;
}
export interface WorkflowStream { id: string; title: string; nodes: string[]; worktreeId: string | null; integrated: boolean }
export interface WorkflowRun {
  mode?: 'configured' | 'adhoc';
  id: string; projectId: string; orchestratorId: string; worktreeId: string; originalRequest: string;
  createdAt: string; updatedAt: string; state: 'planning' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  config: OrganizationConfig; steps: WorkflowStep[]; streams: WorkflowStream[];
  baseSha: string | null; error: string | null; result: string | null;
  planReason?: string; integrationTreeId?: string; integrationPath?: string; integrationShas?: string[];
  messages: { id: string; from: string; to: string; text: string; at: string }[];
}
export interface WorkflowRunSummary {
  id:string; projectId:string; worktreeId:string; mode:'configured'|'adhoc';
  requestPreview:string; createdAt:string; updatedAt:string; state:WorkflowRun['state'];
  counts:{total:number;completed:number;running:number;pending:number;failed:number;skipped:number};
  providers:WorkflowProvider[]; hasError:boolean;
}
/** Local speech contracts. Audio is mono float32 PCM at exactly 16 kHz. */
export interface LocalSpeechModel {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  streaming: boolean;
  recommended?: boolean;
  status: 'missing' | 'downloading' | 'ready' | 'error';
  downloadedBytes: number;
  error?: string;
}
export interface LocalSpeechCatalog { available: boolean; reason?: string; models: LocalSpeechModel[] }
export interface SpeechAudioRequest { pcm: string; sequence: number }
export interface SpeechTranscript { text: string; interim: string }
export interface StartSpeechRequest { modelId: string }
export interface StartSpeechResponse { sessionId: string }
// Standalone workspace explorer. Paths are relative to a discovered worktree.
export interface WorkspaceEntry { path: string; name: string; directory: boolean; symlink: boolean; status: string | null }
export interface WorkspaceRoot { id: string; label: string; path: string; branch: string | null }
export interface SessionHandoff { sourceId: string; context: 'focused' | 'full'; delivery: 'pending' | 'submitted' | 'uncertain' }
export interface HandoffSessionRequest { agentId: string; context: 'focused' | 'full'; worktreeId: string }
export interface HandoffSessionResponse { nodeId: string; handoff: SessionHandoff }
export interface HandoffWorktree { id: string; label: string; branch: string | null; path: string; main: boolean; locked: boolean; current: boolean }
export interface DesktopUpdateStatus {
  state: 'unsupported' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  message: string | null;
}
export interface WorkspaceListing { entries: WorkspaceEntry[]; truncated: boolean; gitError: string | null }
export interface WorkspaceSearchOptions { matchCase?: boolean; wholeWord?: boolean; regex?: boolean; include?: string; exclude?: string; showDotfiles?: boolean; showIgnored?: boolean }
export interface WorkspaceSearch { matches: { path: string; line?: number; preview?: string; status?: string | null; ranges?: [number, number][] }[]; truncated: boolean }
export interface WorkspaceFile { path: string; text: string; version: string; original: string | null; gitError: string | null; git?: boolean; preview?: { kind: 'image' | 'binary'; size: number; mime: string | null; dataUrl?: string } }
export interface WorkspaceFileActionRequest { worktreeId: string; action: 'file' | 'folder' | 'duplicate' | 'copy' | 'rename' | 'trash' | 'restore'; path: string; destination?: string; version?: string; restoreId?: string }
export interface WorkspaceFileActionResult { path: string; restoreId?: string }
export interface WorkspaceFileStat { version: string; directory: boolean }
export interface SaveWorkspaceFileRequest { worktreeId: string; path: string; text: string; version: string }
export interface PhoneConnectionSettings { enabled: boolean; origin: string }
export interface PhoneSetupTerminal { projectId: string; nodeId: string; command: string }
