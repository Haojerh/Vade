import crypto from 'node:crypto';
import type { ConversationPage, DashboardSnapshot, Graph, Node, NodeDetails, NodeDetailsQuery, Section, SourceMeta } from '../../shared/contracts.js';
import { CliError, type CommandRunner, defaultCommandRunner } from '../integrations/cli.js';
import { taskProgress } from '../services/progress.js';
import { AdeStore } from './store.js';
import { AdeGit } from './git.js';
import { AdeSessions } from './sessions.js';
import { AdeConversations } from './conversation.js';
import { LocalConnections } from './connections.js';
import { ProviderAccounts } from './providerAccounts.js';
import { ResourceReader } from './resources.js';
import { AgentHistory } from './agentHistory.js';

export function section<T>(data: T | null, availability: SourceMeta['availability'] = 'ready', message?: string): Section<T> {
  const now = new Date().toISOString();
  return { data, meta: { availability, attemptedAt: now, observedAt: availability === 'ready' || availability === 'empty' ? now : null,
    partial: false, stale: false, issue: message ? { code: availability === 'unsupported' ? 'CONVERSATION_UNSUPPORTED' : 'RUNTIME_UNAVAILABLE', message, retryable: false } : null } };
}

export class LocalRuntime {
  readonly git: AdeGit;
  readonly sessions: AdeSessions;
  readonly conversations = new AdeConversations();
  readonly connectionsService: LocalConnections;
  readonly accounts: ProviderAccounts;
  readonly resources = new ResourceReader();
  readonly history: AgentHistory;
  desktopMemory: { bytes: number; at: number; pids?: number[] } | null = null;
  readonly id = crypto.randomUUID();
  connections = 0;
  private lastGood = new Map<string, DashboardSnapshot>();
  readonly streams = new Set<() => void>();

  constructor(readonly store = new AdeStore(), runner: CommandRunner = defaultCommandRunner, connectionsService?: LocalConnections) {
    this.git = new AdeGit(store, runner);
    this.history = new AgentHistory(store);
    this.accounts = new ProviderAccounts(store, runner);
    this.connectionsService = connectionsService ?? new LocalConnections(runner, { accounts: this.accounts });
    this.sessions = new AdeSessions(store);
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
      for (const record of this.store.sessions(projectId).filter(session => !session.closed)) {
        if (!trees.some(tree => tree.id === record.worktreeId)) continue;
        const terminal = this.sessions.page(projectId, record.id, Number.MAX_SAFE_INTEGER);
        const status = this.sessions.status(projectId, record.id);
        const metadata = record.provider === 'terminal' ? { preview: this.sessions.preview(projectId, record.id).command } : await this.conversations.metadata(record);
        nodes.push({ ...base(record.id, this.store.title(record.id, record.title)), kind: record.provider === 'terminal' ? 'terminal' : 'agent', worktreeId: record.worktreeId,
          ...metadata, path: record.cwd, agentType: record.provider, liveness: terminal.live ? 'live' : 'exited', outputAvailable: true, chatAvailable: record.provider !== 'terminal',
          state: status.meta.availability === 'ready' && status.data ? status.data.state : 'unknown', rawState: status.data?.event ?? null,
          agentStatus: status, lastActivityAt: status.meta.observedAt });
        edges.push({ id: `contains-${record.id}`, source: record.worktreeId, target: record.id, kind: 'contains', evidence: 'workspace-membership', active: false });
      }
      const graph: Graph = { runs: [], selectedRunId: null, nodes, edges, tasks: [], progress: taskProgress([], 'unavailable'), activity: [] };
      const snapshot: DashboardSnapshot = { projectId, generatedAt: now, revision: crypto.createHash('sha256').update(JSON.stringify(nodes.map(({ observedAt, ...node }) => node))).digest('hex'),
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

  async details(projectId: string, nodeId: string, query: NodeDetailsQuery = { direction: 'older' }): Promise<NodeDetails> {
    const snapshot = await this.snapshot(projectId);
    if (snapshot.graph.meta.availability !== 'ready') throw new CliError('RUNTIME_UNAVAILABLE', 'Refresh the repository before inspecting this node', true);
    const node = snapshot.graph.data?.nodes.find(item => item.id === nodeId);
    if (!node) throw new CliError('NODE_NOT_FOUND', 'Node does not belong to this project');
    return { node, tasks: [], activity: [], currentTool: null,
      terminalPreview: node.kind === 'terminal' ? this.sessions.preview(projectId, nodeId).output : undefined,
      session: node.kind === 'agent' || node.kind === 'terminal' ? { terminal: true, chat: node.kind === 'agent', history: node.kind === 'agent', resumable: Boolean(this.sessions.page(projectId, nodeId).resumable),
        ...(node.agentType === 'antigravity' && !this.sessions.require(projectId, nodeId).providerThreadId ? { reason: 'Antigravity has not reported a saved conversation yet. Complete a first turn in Terminal to bind chat and enable recovery.' } : {}) } : undefined,
      conversation: node.kind === 'agent' ? await this.conversations.read(this.sessions.require(projectId, nodeId), query) : section<ConversationPage>(null, 'unsupported', 'Workspaces do not have conversation history.') };
  }

  close(): void {
    for (const close of this.streams) close();
    this.accounts.close();
    this.sessions.close();
    this.store.close();
  }
}
