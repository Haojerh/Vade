import crypto from 'node:crypto';
import path from 'node:path';
import type { ConversationPage, DashboardSnapshot, Graph, HandoffWorktree, Node, NodeDetails, NodeDetailsQuery, Section, SourceMeta, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { CliError, type CommandRunner, defaultCommandRunner } from '../integrations/cli.js';
import { taskProgress } from '../services/progress.js';
import { AdeStore } from './store.js';
import { AdeGit } from './git.js';
import { AdeSessions } from './sessions.js';
import { AdeConversations } from './conversation.js';
import { LocalConnections } from './connections.js';
import { ProviderAccounts } from './providerAccounts.js';
import { ResourceReader } from './resources.js';
import { ComputerAwake } from './computerAwake.js';
import { Ports } from './ports.js';
import { AgentHistory } from './agentHistory.js';
import { OrganizationRuntime } from './organization.js';
import { LocalSpeech } from './speech.js';
import { WorkspaceFiles } from './workspaceFiles.js';
import { WorkspaceActions } from './workspaceActions.js';
import { SourceControl } from './sourceControl.js';
import { SessionHandoffs } from './sessionHandoff.js';
import { WorkflowSetup } from './workflowSetup.js';
import { compactCommand } from './providerCompaction.js';
import { discoverSubagents, readSubagentTranscript } from './subagents.js';

export function section<T>(data: T | null, availability: SourceMeta['availability'] = 'ready', message?: string): Section<T> {
  const now = new Date().toISOString();
  return { data, meta: { availability, attemptedAt: now, observedAt: availability === 'ready' || availability === 'empty' ? now : null,
    partial: false, stale: false, issue: message ? { code: availability === 'unsupported' ? 'CONVERSATION_UNSUPPORTED' : 'RUNTIME_UNAVAILABLE', message, retryable: false } : null } };
}

export class LocalRuntime {
  readonly git: AdeGit;
  readonly sessions: AdeSessions;
  readonly conversations: AdeConversations;
  readonly connectionsService: LocalConnections;
  readonly accounts: ProviderAccounts;
  readonly resources = new ResourceReader();
  readonly awake: ComputerAwake;
  readonly ports: Ports;
  readonly history: AgentHistory;
  readonly organization: OrganizationRuntime;
  readonly phoneSetup: WorkflowSetup;
  readonly speech: LocalSpeech;
  readonly files: WorkspaceFiles;
  readonly fileActions: WorkspaceActions;
  readonly sourceControl: SourceControl;
  readonly handoffs: SessionHandoffs;
  desktopMemory: { bytes: number; at: number; pids?: number[] } | null = null;
  readonly id = crypto.randomUUID();
  connections = 0;
  private lastGood = new Map<string, DashboardSnapshot>();
  readonly streams = new Set<() => void>();

  constructor(readonly store = new AdeStore(), runner: CommandRunner = defaultCommandRunner, connectionsService?: LocalConnections) {
    this.conversations = new AdeConversations(store.directory,record=>this.sessions.nativeRewindAvailable(record),record=>this.sessions.conversationRounds(record));
    this.git = new AdeGit(store, runner);
    this.files = new WorkspaceFiles(store, this.git);
    this.fileActions = new WorkspaceActions(store, this.files);
    this.sourceControl = new SourceControl(this.git,this.files);
    this.speech = new LocalSpeech(store.directory);
    this.history = new AgentHistory(store);
    this.accounts = new ProviderAccounts(store, runner);
    this.connectionsService = connectionsService ?? new LocalConnections(runner, { accounts: this.accounts });
    this.sessions = new AdeSessions(store);
    this.ports = new Ports(store, this.sessions, this.resources);
    this.awake = new ComputerAwake(store, () => this.sessions.processGroups().some(group => this.sessions.status(group.projectId, group.id).data?.state === 'working'));
    this.organization = new OrganizationRuntime(store, this.git, () => this.sessions);
    this.phoneSetup = new WorkflowSetup(store, 'phone');
    this.handoffs = new SessionHandoffs(store, this.git, this.sessions, this.conversations, this.organization);
    this.sessions.setCliEnvironment(record => this.organization.cliEnvironment(record));
  }

  async snapshot(projectId: string): Promise<DashboardSnapshot> {
    const project = this.store.project(projectId);
    try {
      const trees = await this.git.worktrees(project);
      const now = new Date().toISOString();
      const base = (id: string, label: string): Node => ({ id, label, kind: 'worktree', worktreeId: id, runId: null, agentType: null,
        branch: null, path: null, state: 'unknown', rawState: null, workspaceStatus: null, taskOutcome: null,
        liveness: 'unknown', observedAt: now, lastActivityAt: null, stale: false, taskIds: [], preview: null, outputAvailable: false });
      const nodes: Node[] = trees.map(tree => ({ ...base(tree.id, this.store.title(tree.id, tree.main ? project.name : tree.branch || 'Detached worktree')),
        path: tree.path, branch: tree.branch, workspaceStatus: project.kind === 'folder' ? 'folder workspace' : tree.locked ? 'locked' : tree.main ? 'main checkout' : 'linked checkout' }));
      const edges: Graph['edges'] = [];
      const workflows = this.organization.runs(projectId).filter(run => !['completed', 'failed', 'cancelled'].includes(run.state));
      for (const record of this.store.sessions(projectId).filter(session => !session.closed)) {
        if (!trees.some(tree => tree.id === record.worktreeId)) continue;
        const terminal = this.sessions.page(projectId, record.id, Number.MAX_SAFE_INTEGER);
        const status = this.sessions.status(projectId, record.id);
        const metadata = record.provider === 'terminal' ? { preview: this.sessions.preview(projectId, record.id).command } : await this.conversations.metadata(record);
        const workflow = workflows.find(run => run.orchestratorId === record.id || run.steps.some(step => step.sessionId === record.id));
        nodes.push({ ...base(record.id, this.store.title(record.id, record.title)), kind: record.provider === 'terminal' ? 'terminal' : 'agent', worktreeId: record.worktreeId,
          ...metadata, path: record.cwd, agentType: record.provider, liveness: terminal.live ? 'live' : 'exited', outputAvailable: true, chatAvailable: record.provider !== 'terminal',
          chatCompact: compactCommand(record.provider) !== null,
          chatReady: this.sessions.handoffPromptReady(projectId, record.id),
          ...(record.provider === 'terminal' ? {} : { subagents: await discoverSubagents(record) }),
          state: status.meta.availability === 'ready' && status.data ? status.data.state : 'unknown', rawState: status.data?.event ?? null,
          agentStatus: status, lastActivityAt: status.meta.observedAt,
          ...(workflow ? { workflow: { runId: workflow.id, role: workflow.orchestratorId === record.id ? 'orchestrator' as const : 'worker' as const, stepState: workflow.steps.find(step => step.sessionId === record.id)?.state } } : {}) });
        edges.push({ id: `contains-${record.id}`, source: record.worktreeId, target: record.id, kind: 'contains', evidence: 'workspace-membership', active: false });
      }
      for (const run of workflows) for (const step of run.steps) {
        if (!step.sessionId || !nodes.some(node => node.id === step.sessionId)) continue;
        const source = run.orchestratorId;
        if (nodes.some(node => node.id === source)) edges.push({ id: `workflow-${run.id}-${source}-${step.sessionId}`, source, target: step.sessionId, kind: 'delegates', evidence: 'run-dispatch', active: step.state === 'running' });
      }
      const graph: Graph = { runs: [], selectedRunId: null, nodes, edges, tasks: [], progress: taskProgress([], 'unavailable'), activity: [] };
      const snapshot: DashboardSnapshot = { projectId, generatedAt: now, revision: crypto.createHash('sha256').update(JSON.stringify({ nodes: nodes.map(({ observedAt, ...node }) => node), edges })).digest('hex'),
        runtime: section({ version: 'ADE v1', runtimeId: this.id }), graph: section(graph) };
      this.lastGood.set(projectId, snapshot);
      return snapshot;
    } catch (error) {
      const previous = this.lastGood.get(projectId);
      const issue = error instanceof CliError ? error.issue : { code: 'INTERNAL' as const, message: 'Local project collection failed', retryable: true };
      return { projectId, revision: previous?.revision ?? 'unavailable', generatedAt: new Date().toISOString(), runtime: section({ version: 'ADE v1', runtimeId: this.id }),
        graph: { data: previous?.graph.data ?? null, meta: { ...section(null, 'unavailable').meta, observedAt: previous?.graph.meta.observedAt ?? null, stale: Boolean(previous), issue } } };
    }
  }

  async handoffWorktrees(projectId: string, nodeId: string): Promise<HandoffWorktree[]> {
    const source = this.sessions.require(projectId, nodeId);
    this.handoffs.assertSourceAvailable(source);
    const project = this.store.project(projectId);
    const trees = await this.git.worktrees(project);
    return trees.map(tree => ({
      id: tree.id,
      label: this.store.title(tree.id, tree.main ? project.name : tree.branch || 'Detached worktree'),
      branch: tree.branch,
      path: tree.path,
      main: tree.main,
      locked: tree.locked,
      current: tree.id === source.worktreeId,
    }));
  }

  async chatOptions(projectId: string, nodeId: string, request?: SetAgentChatOptionRequest) {
    const record = this.sessions.require(projectId, nodeId);
    if(request?.key==='permission'&&record.provider!=='dsh'){
      this.handoffs.assertSourceAvailable(record);
      const tree=await this.git.requireWorktree(this.store.project(projectId),record.worktreeId);
      if(tree.locked||path.relative(tree.path,record.cwd))throw new CliError('INVALID_ARGUMENT','The original unlocked session workspace is no longer available.');
    }
    const metadata = {...await this.conversations.metadata(record),nativeResumable:this.conversations.resumeAvailable(record)};
    return request ? this.sessions.setChatOption(projectId, nodeId, request, metadata) : this.sessions.chatOptions(projectId, nodeId, metadata);
  }

  async openNativeRewindPicker(projectId:string,nodeId:string){
    const record=this.sessions.require(projectId,nodeId);this.handoffs.assertSourceAvailable(record);
    const tree=await this.git.requireWorktree(this.store.project(projectId),record.worktreeId);
    if(tree.locked||path.relative(tree.path,record.cwd))throw new CliError('INVALID_ARGUMENT','The original unlocked session workspace is no longer available.');
    return this.sessions.openNativeRewindPicker(projectId,nodeId);
  }

  async compact(projectId:string,nodeId:string){
    this.sessions.require(projectId,nodeId);
    return this.sessions.compact(projectId,nodeId);
  }

  async rewind(projectId:string,nodeId:string,request:import('../../shared/contracts.js').RewindConversationRequest){
    const record=this.sessions.require(projectId,nodeId);this.handoffs.assertSourceAvailable(record);
    if(record.rewindPending&&['sourceIdentity','revision','messageId'].every(key=>record.rewindPending![key as keyof typeof request]===request[key as keyof typeof request]))throw new CliError('RUNTIME_UNAVAILABLE','The previous rewind is unconfirmed. Inspect Terminal; it will not be replayed.');
    const tree=await this.git.requireWorktree(this.store.project(projectId),record.worktreeId);
    if(tree.locked||path.relative(tree.path,record.cwd))throw new CliError('INVALID_ARGUMENT','The original unlocked session workspace is no longer available.');
    const target=await this.conversations.rewindTarget(record,request);
    return this.sessions.rewind(projectId,nodeId,{...target,receipt:request},record.statusToken);
  }

  /** Recorded user image bytes for one projected locator on this exact project/node session. */
  conversationImage(projectId: string, nodeId: string, source: string, id: string): { mimeType: string; bytes: Buffer } {
    return this.conversations.image(this.sessions.require(projectId, nodeId), source, id);
  }

  async details(projectId: string, nodeId: string, query: NodeDetailsQuery = { direction: 'older' }): Promise<NodeDetails> {
    const snapshot = await this.snapshot(projectId);
    if (snapshot.graph.meta.availability !== 'ready') throw new CliError('RUNTIME_UNAVAILABLE', 'Refresh the repository before inspecting this node', true);
    const node = snapshot.graph.data?.nodes.find(item => item.id === nodeId);
    if (!node) throw new CliError('NODE_NOT_FOUND', 'Node does not belong to this project');
    return { node, tasks: [], activity: [], currentTool: null,
      terminalPreview: node.kind === 'terminal' ? this.sessions.preview(projectId, nodeId).output : undefined,
      session: node.kind === 'agent' || node.kind === 'terminal' ? { terminal: true, chat: node.kind === 'agent', history: node.kind === 'agent', resumable: Boolean(this.sessions.page(projectId, nodeId).resumable),
        ...(() => { const handoff = this.sessions.require(projectId, nodeId).handoff; return handoff ? { handoff: { sourceId: handoff.sourceId, context: handoff.context, delivery: handoff.delivery } } : {}; })(),
        ...(node.agentType === 'antigravity' && !this.sessions.require(projectId, nodeId).providerThreadId ? { reason: 'Antigravity has not reported a saved conversation yet. Complete a first turn in Terminal to bind chat and enable recovery.' } : {}) } : undefined,
      conversation: node.kind === 'agent' ? await this.conversations.read(this.sessions.require(projectId, nodeId), query) : section<ConversationPage>(null, 'unsupported', 'Workspaces do not have conversation history.') };
  }

  /** Native child agents recorded for one exact session. */
  async subagents(projectId: string, nodeId: string) {
    return await discoverSubagents(this.sessions.require(projectId, nodeId));
  }

  /** Public turns and observed tool calls of one recorded child agent. */
  async subagentConversation(projectId: string, nodeId: string, subagentId: string, query: NodeDetailsQuery = {}) {
    return readSubagentTranscript(this.sessions.require(projectId, nodeId), subagentId, query);
  }

  close(): void {
    this.speech.close();
    this.awake.close(); this.history.close();
    for (const close of this.streams) close();
    this.accounts.close();
    this.organization.close();
    this.phoneSetup.close();
    this.sessions.close();
    this.store.close();
  }
}
