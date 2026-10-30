import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import type {
  AdeProvider,
  AgentChatOptions,
  AgentInteraction,
  AgentStatus,
  AnswerAgentRequest,
  InboxItem,
  Section,
  SendMessageRequest,
  SetAgentChatOptionRequest,
  TerminalAttachmentsRequest,
  TerminalPage,
  TerminalShell,
} from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { readAgentPreferences } from '../system/agentPreferences.js';
import { AgentWorkClock } from './agentWorkClock.js';
import { agyBindingFile, agyConversationSaved, installAgyHook, readAgyBinding } from '../../providers/antigravity/agyBinding.js';
import { AntigravityChatControls } from '../../providers/antigravity/antigravityChatControls.js';
import { CodeBuddyChatControls } from '../../providers/codebuddy/codeBuddyChatControls.js';
import { codexPaginatedBinding, codexThread } from '../../providers/codex/codexThread.js';
import { ConversationRounds } from '../chat/conversationRounds.js';
import { dshBinding, dshReady, dshResumable, prepareDsh } from '../../providers/dsh/dsh.js';
import { answerCodeBuddyQuestion, codeBuddyApprovalVisible, terminalInteraction } from './interaction.js';
import { OpenCodeChatControls } from '../../providers/opencode/openCodeChatControls.js';
import { createOpenCodeSession, installOpenCodePlugin, isOpenCode, openCodeMajor, validProviderSessionId, verifyOpenCode } from '../../providers/opencode/openCodeSessions.js';
import { antigravityPromptReady, isInterruptionInput, PROGRAM_STATUS_REPLY, programStatusReader, TerminalTurnStatus } from './programStatus.js';
import { ProviderChatControls } from '../chat/controls/providerChatControls.js';
import { resolveSessionLaunchPermission } from '../chat/controls/providerPermissions.js';
import type { NativeUserAnchor } from '../chat/controls/providerRewind.js';
import { agentCatalog, executableOnPath, PROVIDERS, resolveAgent, TERMINAL_SHELLS } from './agentDiscovery.js';
import { type LiveSession, MAX_BUFFER, MAX_LIVE_SESSIONS, UncertainMessageDelivery } from './liveSessionTypes.js';
import {
  compactSessionConversation,
  openSessionNativeRewindPicker,
  readSessionChatOptions,
  rewindSessionConversation,
  setSessionChatOption,
} from './sessionChatActions.js';
import { pasteSessionTerminalAttachments, sendSessionMessage } from './sessionSend.js';
import { installStatusHooks, readAgentStatus, statusFile } from './statusHooks.js';
import { AdeStore, type SessionRecord } from '../store.js';
import { TerminalScreen } from './terminalScreen.js';

export { agentCatalog, executableOnPath, resolveAgent, TERMINAL_SHELLS, UncertainMessageDelivery };

export class AdeSessions {
  private cliEnvironment?: (record: SessionRecord) => Record<string, string>;
  setCliEnvironment(factory: (record: SessionRecord) => Record<string, string>): void { this.cliEnvironment = factory; }
  readonly live = new Map<string, LiveSession>();
  private helpers = new Set<ChildProcess>();
  readonly starting = new Set<string>();
  private historyStarting = new Set<string>();
  readonly sending = new Set<string>();
  readonly shutdown = new AbortController();
  private statusWatcher?: fs.FSWatcher;
  private statusOwners = new Map<string, string>();
  private statusTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Map<string, Set<() => void>>();
  private statusListeners = new Map<string, Set<() => void>>();
  private resultTurns = new Map<string, { state: string; turn: string; token?: string; attention?: AgentStatus['attention'] }>();
  private workClock = new AgentWorkClock();
  conversationRounds(record: SessionRecord) { return new ConversationRounds(this.store).read(record); }
  readonly chatControls = new ProviderChatControls();
  readonly openCodeControls = new OpenCodeChatControls();
  readonly codeBuddyControls = new CodeBuddyChatControls();
  readonly antigravityControls = new AntigravityChatControls();
  private resultListeners = new Set<(item: InboxItem) => void>();
  private attentionListeners = new Set<(item: InboxItem) => void>();
  private questionEvents = new Map<string, string>();

  subscribeAttention(listener: (item: InboxItem) => void): () => void {
    this.attentionListeners.add(listener);
    return () => { this.attentionListeners.delete(listener); };
  }
  subscribeResults(listener: (item: InboxItem) => void): () => void {
    this.resultListeners.add(listener);
    return () => { this.resultListeners.delete(listener); };
  }
  processRoots(): number[] {
    return [...this.helpers]
      .flatMap(child => (child.pid ? [child.pid] : []))
      .concat([...this.live.values()].flatMap(session => (session.live && session.agentPid ? [session.agentPid] : [])));
  }
  processGroups(): { id: string; projectId: string; provider: AdeProvider; label: string; roots: number[] }[] {
    const projects = this.store.projects();
    const records = new Map(projects.flatMap(project => this.store.sessions(project.id)).map(record => [record.id, record]));
    return [...this.live].flatMap(([id, live]) => {
      if (!live.live || !live.agentPid) return [];
      const record = records.get(id);
      const project = projects.find(p => p.id === record?.projectId);
      return record ? [{ id, projectId: record.projectId, provider: record.provider, label: `${project?.name ?? 'Project'} / ${this.store.title(id, record.title)}`, roots: [live.agentPid] }] : [];
    });
  }
  subscribeStatus(projectId: string, listener: () => void): () => void {
    const listeners = this.statusListeners.get(projectId) ?? new Set();
    listeners.add(listener);
    this.statusListeners.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.statusListeners.delete(projectId);
    };
  }
  statusChanged(projectId: string, observed?: SessionRecord): void {
    if (this.shutdown.signal.aborted) return;
    for (const record of observed ? [observed] : this.store.sessions(projectId)) {
      if (!record.closed && record.provider !== 'terminal' && this.live.get(record.id)?.live) this.status(projectId, record.id);
    }
    for (const listener of this.statusListeners.get(projectId) ?? []) listener();
  }
  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  changed(id: string): void {
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  constructor(
    readonly store: AdeStore,
    readonly resolve: typeof resolveAgent = resolveAgent,
    private bindCodex = codexThread,
    private prepareAgy = installAgyHook,
    private prepareStatus = installStatusHooks,
    readonly savedAgy = agyConversationSaved,
  ) {}

  status(projectId: string, id: string) {
    const record = this.require(projectId, id);
    const live = this.live.get(id);
    const rawHook = readAgentStatus(this.store.directory, record, Boolean(live?.live));
    const hook = this.attentionStatus(record, rawHook);
    if (live && (isOpenCode(record.provider) || record.provider === 'codebuddy') && hook.data) {
      hook.data = ['Stop', 'SessionAborted'].includes(hook.data.event)
        ? live.turnStatus.nativeEnd(hook.data, Date.parse(hook.meta.observedAt ?? '') || Date.now(), 5000)
        : live.turnStatus.observe(hook.data);
    }
    if (live) live.lastHook = rawHook;
    if (live?.resumeTurnObserved === false && hook.data?.state === 'working' && ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(hook.data.event)) {
      live.resumeInitializing = false;
      live.resumeTurnObserved = true;
      live.turnStatus.observe(hook.data);
    }
    if (
      live?.programStatus &&
      hook.data?.state === 'working' &&
      (hook.data.event === 'UserPromptSubmit' || (record.provider === 'antigravity' && hook.data.event === 'PreInvocation')) &&
      Date.parse(hook.meta.observedAt ?? '') > Date.parse(live.programStatus.meta.observedAt ?? '')
    ) {
      live.programStatus = undefined;
      live.turnStatus.observe(hook.data);
    }
    if (live?.live && live.programStatus) {
      if (hook.data?.state === 'waiting' && Date.parse(hook.meta.observedAt ?? '') > Date.parse(live.programStatus.meta.observedAt ?? '')) {
        return this.observeResult(record, hook);
      }
      if (['failed', 'interrupted'].includes(live.programStatus.data?.state ?? '')) {
        return this.observeResult(record, live.programStatus);
      }
      if (['failed', 'interrupted', 'completed'].includes(hook.data?.state ?? '') && Date.parse(hook.meta.observedAt ?? '') >= (live.turnStartedAt ?? 0)) {
        return this.observeResult(record, hook);
      }
      return this.observeResult(record, live.programStatus);
    }
    return this.observeResult(record, hook);
  }

  interaction(projectId: string, id: string): AgentInteraction | null {
    const record = this.require(projectId, id);
    const session = this.live.get(id);
    const status = this.status(projectId, id);
    if (!session?.live || status.data?.state !== 'waiting' || status.data.attention === 'auth') return null;
    const screen = session.screen?.text();
    const prompt = screen
      ? terminalInteraction(screen, record.provider, `${record.id}:${record.statusToken}:${status.meta.observedAt}:${session.inputRevision ?? 0}`, status.data.toolCall?.summary)
      : null;
    const signature = prompt ? JSON.stringify([record.statusToken, prompt.question, prompt.detail, prompt.options]) : '';
    return prompt && !(session.answeredPrompt === signature && Date.parse(status.meta.observedAt ?? '') <= (session.answeredAt ?? Infinity)) ? prompt : null;
  }

  async answer(projectId: string, id: string, request: AnswerAgentRequest): Promise<void> {
    const prompt = this.interaction(projectId, id);
    const session = this.live.get(id);
    const record = this.require(projectId, id);
    if (this.sending.has(id)) throw new CliError('RUNTIME_UNAVAILABLE', 'Input is already being sent to this terminal');
    if (!prompt || !session?.live || prompt.id !== request.promptId || !prompt.options.some(option => option.id === request.optionId)) {
      throw new CliError('INVALID_ARGUMENT', 'This question has changed or was already answered. Review the current prompt.');
    }
    if (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 2000 || /[\x00-\x1f\x7f]/.test(request.text) || request.optionId !== prompt.textOptionId)) {
      throw new CliError('INVALID_ARGUMENT', 'Free text is only supported for the displayed Other option');
    }
    if (request.optionId === prompt.textOptionId && !request.text?.trim()) {
      throw new CliError('INVALID_ARGUMENT', 'Enter your answer for Other');
    }
    this.sending.add(id);
    session.answeredPrompt = JSON.stringify([record.statusToken, prompt.question, prompt.detail, prompt.options]);
    session.answeredAt = Date.parse(this.status(projectId, id).meta.observedAt ?? '') || Date.now();
    try {
      if (record.provider === 'codebuddy' && prompt.kind === 'question') {
        const verify = () => {
          if (!session.live || this.live.get(id) !== session || this.require(projectId, id).statusToken !== record.statusToken) {
            throw new CliError('RUNTIME_UNAVAILABLE', 'Terminal changed while answering. Inspect Terminal before retrying.');
          }
        };
        await answerCodeBuddyQuestion(prompt, request.optionId, request.text, {
          screen: () => session.screen?.text() ?? '',
          output: () => '',
          write: async data => { verify(); await this.command(session, { type: 'input', data }); },
          waitFor: async predicate => {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              verify();
              const screen = session.screen?.text() ?? '';
              if (predicate(screen)) return screen;
              await new Promise(resolve => setTimeout(resolve, 40));
            }
            throw new CliError('CLI_TIMEOUT', 'The native question did not advance. Inspect Terminal before retrying; no answer was replayed.');
          },
        });
        return;
      }
      if (request.text && record.provider === 'codex') {
        const screen = session.screen?.text() ?? '';
        const selected = /^\s*[›❯>]\s*([1-9])[.)]/m.exec(screen);
        const delta = Number(request.optionId) - Number(selected?.[1] ?? 1);
        if (delta) await this.command(session, { type: 'input', data: (delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)) });
        await this.command(session, { type: 'input', data: '\t' });
      } else {
        await this.command(session, { type: 'input', data: request.optionId });
      }
      if (request.text) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!session.live || this.live.get(id) !== session) {
          throw new CliError('RUNTIME_UNAVAILABLE', 'Terminal changed while answering. Inspect Terminal before retrying.');
        }
        await this.command(session, { type: 'input', data: `\x1b[200~${request.text.trim()}\x1b[201~` });
        await this.command(session, { type: 'input', data: '\r' });
      }
    } finally {
      this.sending.delete(id);
      this.statusChanged(projectId, record);
    }
  }

  private attentionStatus(record: SessionRecord, status: Section<AgentStatus>): Section<AgentStatus> {
    if (!status.data) return status;
    if (record.provider === 'claude' && status.data.state === 'waiting' && status.data.event === 'Notification' && !status.data.attention) {
      const live = this.live.get(record.id);
      if (live?.live && !this.sending.has(record.id) && live.screen?.composerEmpty()) {
        return { ...status, data: { ...status.data, state: 'idle', source: 'provider-terminal', event: 'native-idle-prompt' } };
      }
    }
    if (record.provider === 'codebuddy' && status.data.state === 'waiting' && status.data.attention === 'approval') {
      const visible = codeBuddyApprovalVisible(this.live.get(record.id)?.screen?.viewportText() ?? '');
      return {
        ...status,
        data: {
          ...status.data,
          state: visible ? 'waiting' : 'working',
          attention: visible ? 'approval' : undefined,
          event: visible ? 'native-approval-prompt' : 'permission-check',
        },
      };
    }
    if (record.provider === 'antigravity' && status.data.state === 'working' && status.data.event === 'PreToolUse' && status.data.toolCall?.summary) {
      const screen = this.live.get(record.id)?.screen?.text() ?? '';
      const summary = status.data.toolCall.summary;
      const prompt = terminalInteraction(screen, record.provider, record.statusToken ?? '', summary);
      if (prompt?.kind === 'approval' && screen.replace(/\s/g, '').includes(summary.replace(/\s/g, '')) && /(?:Esc|escape|enter|navigate|↑|↓)/i.test(screen)) {
        status = { ...status, data: { ...status.data, state: 'waiting', attention: 'approval', source: 'provider-terminal', event: 'native-approval-prompt' } };
      }
    }
    return status;
  }

  private observeResult(record: SessionRecord, status: Section<AgentStatus>): Section<AgentStatus> {
    if (record.provider === 'terminal') return status;
    if (status.meta.availability !== 'ready' || !status.data) {
      const workTime = this.workClock.observe(record, status);
      return status.data && workTime ? { ...status, data: { ...status.data, workTime } } : status;
    }
    if (this.live.get(record.id)?.resumeInitializing && ['working', 'completed'].includes(status.data.state)) {
      return { ...status, data: { state: 'idle', source: status.data.source, event: 'resume-initialization' } };
    }
    if (this.live.get(record.id)?.resumeTurnObserved === false && status.data.state === 'completed') {
      return { ...status, data: { state: 'idle', source: status.data.source, event: 'resume-ready' } };
    }
    status = this.attentionStatus(record, status);
    const workTime = this.workClock.observe(record, status);
    if (workTime) status = { ...status, data: { ...status.data!, workTime } };
    new ConversationRounds(this.store).observe(record, status);
    const state = status.data!.state;
    const previous = this.resultTurns.get(record.id);
    if (
      state === 'waiting' &&
      status.data!.attention === 'question' &&
      status.meta.observedAt &&
      this.live.get(record.id)?.live &&
      (previous?.state !== 'waiting' || previous.attention !== 'question' || previous.token !== record.statusToken)
    ) {
      const event = `${record.statusToken}:${status.meta.observedAt}`;
      if (this.questionEvents.get(record.id) !== event) {
        this.questionEvents.set(record.id, event);
        const project = this.store.project(record.projectId);
        const item: InboxItem = {
          id: `question-${crypto.createHash('sha256').update(`${record.id}:${event}`).digest('hex').slice(0, 32)}`,
          projectId: project.id,
          projectName: project.name,
          nodeId: record.id,
          runId: null,
          entityId: record.id,
          title: this.store.title(record.id, record.title),
          outcome: 'waiting',
          at: status.meta.observedAt,
          source: 'attention',
        };
        this.store.db.prepare('INSERT OR REPLACE INTO inbox_attention VALUES (?, ?, ?)').run(item.id, item.at, JSON.stringify(item));
        this.store.db.exec('DELETE FROM inbox_attention WHERE id NOT IN (SELECT id FROM inbox_attention ORDER BY at DESC LIMIT 200)');
        if (previous && previous.token === record.statusToken) for (const listener of this.attentionListeners) listener(item);
      }
    }
    if (previous?.state === state && previous.token === record.statusToken && previous.attention === status.data!.attention) return status;
    const turn =
      !previous ||
      previous.token !== record.statusToken ||
      (['working', 'waiting', 'blocked'].includes(state) && ['completed', 'failed', 'interrupted', 'idle'].includes(previous.state))
        ? crypto.randomUUID()
        : previous.turn;
    this.resultTurns.set(record.id, { state, turn, token: record.statusToken, attention: status.data!.attention });
    if (['completed', 'failed', 'interrupted'].includes(state) && status.meta.observedAt) {
      const project = this.store.project(record.projectId);
      const item = {
        id: turn,
        projectId: project.id,
        projectName: project.name,
        nodeId: record.id,
        runId: null,
        entityId: record.id,
        title: this.store.title(record.id, record.title),
        outcome: state,
        at: status.meta.observedAt,
        source: 'turn',
      };
      this.store.db.prepare('INSERT OR REPLACE INTO turn_results VALUES (?, ?, ?)').run(turn, item.at, JSON.stringify(item));
      this.store.db.exec('DELETE FROM turn_results WHERE id NOT IN (SELECT id FROM turn_results ORDER BY at DESC LIMIT 200)');
      if (state === 'completed' && previous && previous.token === record.statusToken && ['working', 'waiting', 'blocked'].includes(previous.state) && this.live.get(record.id)?.live) {
        for (const listener of this.resultListeners) listener({ ...item, outcome: 'completed', source: 'turn' });
      }
    }
    return status;
  }

  async launch(
    projectId: string,
    worktreeId: string,
    cwd: string,
    command: string,
    title?: string,
    shell?: TerminalShell,
    workflowLaunch?: SessionRecord['workflowLaunch'],
  ): Promise<SessionRecord> {
    const definition = PROVIDERS.find(provider => provider.command === command || provider.id === command);
    if (!definition) throw new CliError('INVALID_ARGUMENT', 'Select a detected agent; custom commands and flags are not accepted');
    if (definition.id !== 'terminal' && !readAgentPreferences(this.store).providers[definition.id].enabled) {
      throw new CliError('INVALID_ARGUMENT', 'This agent is disabled in Settings > Agents');
    }
    if (shell !== undefined && (definition.id !== 'terminal' || !TERMINAL_SHELLS.includes(shell))) {
      throw new CliError('INVALID_ARGUMENT', 'Shell selection applies only to Terminal and must be PowerShell, Command Prompt or Bash');
    }
    const resolved = this.resolve(definition.id, shell);
    if (!resolved && shell) {
      throw new CliError('CLI_MISSING', `The selected shell (${({ powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'Bash' })[shell]}) is not available on this machine. Change it in Settings > General.`);
    }
    if (!resolved) throw new CliError('CLI_MISSING', `${definition.name} is not installed or its executable is not available`);
    if (this.store.sessions(projectId).length >= 200) throw new CliError('RATE_LIMITED', 'Project session history has reached the 200 session limit');
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      projectId,
      worktreeId,
      cwd,
      provider: definition.id,
      title: title || definition.name,
      createdAt: new Date().toISOString(),
      closed: false,
      ...(shell ? { shell } : {}),
      ...(workflowLaunch ? { workflowLaunch } : {}),
    };
    return this.start(record, resolved);
  }

  async resume(projectId: string, id: string): Promise<SessionRecord> {
    const record = this.require(projectId, id);
    if (record.provider !== 'terminal' && !validProviderSessionId(record.provider, record.providerThreadId)) {
      throw new CliError('INVALID_ARGUMENT', 'This session has no exact provider recovery binding');
    }
    if (record.provider === 'antigravity' && !this.savedAgy(record)) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'Antigravity has not saved this conversation yet. Empty sessions cannot be resumed; start a new agent.');
    }
    if (record.provider === 'dsh' && !dshResumable(this.store.directory, record)) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'DSH has not saved this empty session yet. Start a new agent.');
    }
    if (this.live.get(id)?.live) throw new CliError('INVALID_ARGUMENT', 'This terminal is already running');
    const resolved = this.resolve(record.provider, record.shell);
    if (!resolved) throw new CliError('CLI_MISSING', 'This agent is not installed');
    return this.start(record, resolved);
  }

  async resumeHistory(
    projectId: string,
    worktreeId: string,
    cwd: string,
    source: { provider: 'codex' | 'claude' | 'antigravity' | 'codebuddy' | 'opencode' | 'opencode2' | 'kilo' | 'dsh'; threadId: string; cwd: string | null; title: string },
  ): Promise<SessionRecord> {
    if (source.provider === 'dsh' && !source.cwd) throw new CliError('INVALID_ARGUMENT', 'DSH continuation requires its verified source workspace.');
    const dshContinuation = source.provider === 'dsh' && path.relative(path.resolve(cwd), path.resolve(source.cwd!)) !== '';
    const key = `${source.provider}:${source.threadId}`;
    if (!validProviderSessionId(source.provider, source.threadId) || this.historyStarting.has(key)) {
      throw new CliError('INVALID_ARGUMENT', 'This session is already resuming or has no verified provider identity');
    }
    this.historyStarting.add(key);
    try {
      if (!readAgentPreferences(this.store).providers[source.provider].enabled) {
        throw new CliError('INVALID_ARGUMENT', 'Enable this agent in Settings before resuming');
      }
      const matches = this.store.projects().flatMap(project => this.store.sessions(project.id)).filter(record => record.provider === source.provider && record.providerThreadId === source.threadId);
      const running = matches.find(record => this.live.get(record.id)?.live || this.starting.has(record.id));
      if (running) {
        if (running.projectId === projectId && running.worktreeId === worktreeId) return running;
        throw new CliError('INVALID_ARGUMENT', 'This session is running in another worktree. Stop it in Terminal before moving it.');
      }
      const previous = matches.find(record => !record.closed) ?? matches[0];
      if (source.provider === 'dsh' && previous && !dshResumable(this.store.directory, previous)) {
        throw new CliError('RUNTIME_UNAVAILABLE', 'DSH has not saved this empty session yet. Start a new agent; there is no saved conversation to resume.');
      }
      if ((!previous || dshContinuation) && this.store.sessions(projectId).length >= 200) {
        throw new CliError('RATE_LIMITED', 'Project session history has reached the 200 session limit');
      }
      const resolved = this.resolve(source.provider);
      if (!resolved) throw new CliError('CLI_MISSING', 'Install this agent before resuming');
      const record: SessionRecord = {
        id: previous?.id ?? crypto.randomUUID(),
        projectId,
        worktreeId,
        cwd,
        provider: source.provider,
        title: previous ? this.store.title(previous.id, source.title) : source.title,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        closed: false,
        providerThreadId: source.threadId,
        ...(source.cwd ? { sourceCwd: source.cwd } : {}),
      };
      if (previous?.permissionOverride) record.permissionOverride = previous.permissionOverride;
      if (previous?.rewindPending) record.rewindPending = previous.rewindPending;
      if (dshContinuation) {
        record.id = crypto.randomUUID();
        record.providerThreadId = crypto.randomUUID();
        record.createdAt = new Date().toISOString();
        record.dshContinuation = { threadId: source.threadId, cwd: source.cwd! };
      }
      if (source.provider === 'antigravity' && !this.savedAgy(record)) {
        throw new CliError('RUNTIME_UNAVAILABLE', 'Antigravity no longer has this saved conversation');
      }
      try {
        const started = await this.start(record, resolved);
        if (previous && previous.projectId !== projectId) this.statusChanged(previous.projectId);
        return started;
      } catch (error) {
        if (previous && !this.live.get(record.id)?.live) this.store.saveSession(previous);
        throw error;
      }
    } finally {
      this.historyStarting.delete(key);
    }
  }

  async start(record: SessionRecord, resolved: { executable: string; args: string[] }): Promise<SessionRecord> {
    if (this.shutdown.signal.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
    if (this.starting.has(record.id)) throw new CliError('INVALID_ARGUMENT', 'This terminal is already starting');
    if (this.live.size + this.starting.size - (this.live.has(record.id) ? 1 : 0) >= MAX_LIVE_SESSIONS) {
      throw new CliError('RATE_LIMITED', 'Close an agent before starting more than 16 sessions');
    }
    this.starting.add(record.id);
    const initializingCodex = record.provider === 'codex';
    const initializeVariant = isOpenCode(record.provider) && !record.providerThreadId && Boolean(record.workflowLaunch?.effort);
    const initializeDsh = record.provider === 'dsh' && !record.providerThreadId && Boolean(record.workflowLaunch?.model);
    try {
      const node = executableOnPath('node');
      if (!node) throw new CliError('CLI_MISSING', 'Node.js is required for provider status hooks');
      if (record.provider !== 'terminal' && record.provider !== 'dsh') this.prepareStatus(this.store.directory, record.provider, node);
      record = { ...record, statusToken: crypto.randomBytes(32).toString('hex') };
      if (record.provider === 'codex') {
        record = { ...record, providerThreadId: await this.bindCodex(resolved, record.cwd, record.title, record.providerThreadId, this.shutdown.signal, record.sourceCwd ?? record.cwd) };
        if (this.shutdown.signal.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
        if (!validProviderSessionId(record.provider, record.providerThreadId)) throw new CliError('CLI_FAILED', 'Codex returned an invalid session binding');
        resolved = {
          executable: resolved.executable,
          args: [...resolved.args, 'resume', record.providerThreadId, ...(record.sourceCwd && record.sourceCwd !== record.cwd ? ['--cd', record.cwd] : [])],
        };
        this.store.project(record.projectId);
        this.store.saveSession(record);
      } else if (record.provider === 'claude' || record.provider === 'codebuddy') {
        const existing = record.providerThreadId;
        record = { ...record, providerThreadId: existing ?? crypto.randomUUID() };
        resolved = { ...resolved, args: [...resolved.args, existing ? '--resume' : '--session-id', record.providerThreadId!] };
      } else if (isOpenCode(record.provider)) {
        if (record.provider !== 'kilo') {
          const major = await openCodeMajor(resolved);
          if (major !== (record.provider === 'opencode2' ? 2 : 1)) {
            throw new CliError('RUNTIME_UNAVAILABLE', `This CLI is OpenCode ${major}. Select OpenCode${major === 2 ? ' 2' : ''} to start or resume it.`);
          }
        }
        if (record.providerThreadId) verifyOpenCode(record);
        else record = { ...record, providerThreadId: await createOpenCodeSession(resolved, record.cwd, record.title, this.shutdown.signal, record.provider === 'opencode2' ? 2 : 1) };
        verifyOpenCode(record);
        resolved = { ...resolved, args: [...resolved.args, ...(record.provider === 'opencode2' ? ['--standalone'] : []), '--session', record.providerThreadId!] };
      } else if (record.provider === 'dsh') {
        const patch = prepareDsh(this.store.directory, record);
        resolved = { ...resolved, args: [...resolved.args, '--patch', patch, '--backend', 'dsh', ...(record.providerThreadId ? ['--resume', record.providerThreadId] : ['.'])] };
      } else if (record.provider === 'antigravity') {
        const node = executableOnPath('node');
        if (!node) throw new CliError('CLI_MISSING', 'Node.js is required for Antigravity session recovery');
        this.prepareAgy(this.store.directory, node);
        record = { ...record, bindingToken: crypto.randomBytes(32).toString('hex') };
        if (record.providerThreadId) resolved = { ...resolved, args: [...resolved.args, '--conversation', record.providerThreadId] };
      }
      if (record.provider !== 'terminal') {
        const access = resolveSessionLaunchPermission(this.store, record);
        record = access.record;
        resolved = { ...resolved, args: [...resolved.args, ...access.args] };
        const options = record.workflowLaunch;
        if (options?.model && record.provider !== 'dsh') resolved.args.push('--model', options.model);
        if (options?.effort && record.provider !== 'dsh' && !isOpenCode(record.provider)) {
          resolved.args.push(...(record.provider === 'codex' ? ['-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`] : ['--effort', options.effort]));
        }
      }
      if (this.shutdown.signal.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
      const started = await this.startTerminal(record, resolved, initializingCodex);
      if (initializeVariant) await this.initializeOpenCodeVariant(started);
      if (initializeDsh) await this.initializeDshSettings(started);
      return started;
    } finally {
      this.starting.delete(record.id);
    }
  }

  private async initializeDshSettings(record: SessionRecord): Promise<void> {
    const live = this.live.get(record.id);
    const revision = live?.inputRevision;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (!live?.live || this.shutdown.signal.aborted || this.live.get(record.id) !== live || live.inputRevision !== revision) {
        throw new CliError('RUNTIME_UNAVAILABLE', 'The DSH terminal changed during startup. Select its settings in Chat; no command was replayed.');
      }
      const current = this.require(record.projectId, record.id);
      await live.screen?.settled();
      if (dshReady(this.store.directory, current) && live.screen?.dshPromptReady()) {
        await this.setChatOption(record.projectId, record.id, { key: 'model', value: record.workflowLaunch!.model! }, {});
        if (record.workflowLaunch?.effort) await this.setChatOption(record.projectId, record.id, { key: 'effort', value: record.workflowLaunch.effort }, {});
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new CliError('RUNTIME_UNAVAILABLE', 'DSH started but its native session is not ready. Finish setup in Terminal, select the settings in Chat, then dispatch again. No task was sent.');
  }

  private async initializeOpenCodeVariant(record: SessionRecord): Promise<void> {
    const live = this.live.get(record.id);
    const revision = live?.inputRevision;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (!live?.live || this.shutdown.signal.aborted || this.live.get(record.id) !== live || this.require(record.projectId, record.id).statusToken !== record.statusToken || live.inputRevision !== revision) {
        throw new CliError('RUNTIME_UNAVAILABLE', 'The new terminal changed before its effort could be applied. Inspect Terminal; no setting was replayed.');
      }
      await live.screen?.settled();
      if (live.inputRevision !== revision) throw new CliError('RATE_LIMITED', 'Terminal input changed during startup. Select effort in Chat; no setting was replayed.');
      if (live.screen?.openCodePromptReady()) {
        await this.setChatOption(record.projectId, record.id, { key: 'effort', value: record.workflowLaunch!.effort! }, { model: record.workflowLaunch!.model });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new CliError('RUNTIME_UNAVAILABLE', 'The agent started, but its effort could not be applied before startup timed out. Finish any setup in Terminal and select effort in Chat. No command was retried.');
  }

  private async startTerminal(record: SessionRecord, resolved: { executable: string; args: string[] }, initializingCodex = false): Promise<SessionRecord> {
    const definition = PROVIDERS.find(provider => provider.id === record.provider)!;
    const cwd = record.cwd;
    fs.mkdirSync(path.join(this.store.directory, 'status'), { recursive: true, mode: 0o700 });
    this.statusOwners.set(record.id, record.projectId);
    if (!this.statusWatcher) {
      this.statusWatcher = fs.watch(path.join(this.store.directory, 'status'), { persistent: false }, (_event, filename) => {
        const id = filename?.toString().match(/^([0-9a-f-]{36})\.json$/i)?.[1];
        const projectId = id && this.statusOwners.get(id);
        if (!projectId || this.statusTimers.has(projectId)) return;
        this.statusTimers.set(projectId, setTimeout(() => { this.statusTimers.delete(projectId); this.statusChanged(projectId); }, 15));
      });
      this.statusWatcher.on('error', () => { this.statusWatcher?.close(); this.statusWatcher = undefined; });
    }
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.TERM = 'xterm-256color';
    delete env.CLAUDECODE;
    delete env.CODEX_THREAD_ID;
    for (const key of Object.keys(env)) if (key.startsWith('ORCA_')) delete env[key];
    delete env.VADE_IDENTITY_FILE;
    delete env.VADE_CLI_PATH;
    if (record.provider !== 'terminal' && this.cliEnvironment) Object.assign(env, this.cliEnvironment(record));
    delete env.ADE_BINDING_FILE;
    delete env.ADE_BINDING_TOKEN;
    delete env.ADE_BINDING_CWD;
    env.ADE_STATUS_FILE = statusFile(this.store.directory, record.id);
    env.ADE_STATUS_TOKEN = record.statusToken!;
    env.ADE_STATUS_PROVIDER = record.provider;
    env.ADE_STATUS_CWD = record.cwd;
    env.ADE_STATUS_SOURCE_CWD = record.sourceCwd ?? '';
    env.ADE_STATUS_SESSION = record.providerThreadId ?? '';
    if (isOpenCode(record.provider)) {
      env.ADE_OPENCODE_PLUGIN_API = record.provider === 'opencode2' ? 'v2' : 'v1';
      const key = record.provider === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT';
      let config: any = {};
      try { config = JSON.parse(env[key] || '{}'); } catch { throw new CliError('INVALID_ARGUMENT', 'Provider inline configuration is invalid'); }
      if (!config || typeof config !== 'object' || Array.isArray(config) || (config.plugin !== undefined && !Array.isArray(config.plugin))) {
        throw new CliError('INVALID_ARGUMENT', 'Provider plugin configuration is invalid');
      }
      installOpenCodePlugin(record.provider, env);
    }
    if (record.provider === 'terminal' && (record.shell === 'bash' || (!record.shell && process.platform !== 'win32'))) {
      env.PROMPT_COMMAND = 'printf "\\033]7502;%s;%s\\007" "$ADE_STATUS_TOKEN" "$(history 1 | sed "s/^ *[0-9]* *//" | base64 | tr -d "\\n")"';
    }
    if (record.provider === 'antigravity' && record.bindingToken) {
      env.ADE_BINDING_FILE = agyBindingFile(this.store.directory, record);
      env.ADE_BINDING_TOKEN = record.bindingToken;
      env.ADE_BINDING_CWD = record.cwd;
    }
    let child: ChildProcess;
    const host = process.env.ADE_PTY_HOST || path.resolve('server/runtime/sessions/ptyHost.cjs');
    const node = executableOnPath('node');
    if (!node) throw new CliError('CLI_MISSING', 'Node.js is required for owned terminals');
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      child = fork(host, [], { execPath: node, env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    } catch {
      throw new CliError('CLI_FAILED', `${definition.name} could not start; check its local installation`);
    }
    const session: LiveSession = {
      process: child,
      buffer: '',
      start: 0,
      live: false,
      exitCode: null,
      pending: new Map(),
      turnStatus: new TerminalTurnStatus(),
      resumeInitializing: initializingCodex,
      resumeTurnObserved: !initializingCodex,
    };
    session.screen = new TerminalScreen(
      data => {
        if (child.connected && !this.shutdown.signal.aborted) void this.command(session, { type: 'input', data }).catch(() => {});
      },
      () => {
        if (record.provider === 'terminal') this.statusChanged(record.projectId, record);
        const hook = session.lastHook;
        if (['antigravity', 'codebuddy'].includes(record.provider) && this.live.get(record.id) === session && session.live && hook?.data) {
          const visible = this.attentionStatus(record, hook).data?.event === 'native-approval-prompt';
          if (visible !== Boolean(session.nativeApprovalVisible)) {
            session.nativeApprovalVisible = visible;
            this.statusChanged(record.projectId, record);
          }
        }
      },
    );
    const programStatus = programStatusReader(
      status => {
        if (!['codex', 'claude'].includes(record.provider)) return;
        if (session.resumeInitializing) {
          if (status.state === 'idle') {
            session.resumeInitializing = false;
            session.turnStatus = new TerminalTurnStatus();
          } else if (['working', 'completed'].includes(status.state)) return;
        }
        if (session.resumeTurnObserved === false && ['working', 'completed'].includes(status.state) && !session.resumePromptSubmitted) return;
        if (status.state === 'working') session.resumeTurnObserved = true;
        if (status.state === 'working' && session.programStatus?.data?.state !== 'working') session.turnStartedAt = Date.now();
        status = session.turnStatus.observe(status);
        if (session.programStatus?.data?.state === status.state && session.programStatus?.data?.attention === status.attention) return;
        const now = new Date().toISOString();
        session.programStatus = { data: status, meta: { availability: 'ready', observedAt: now, attemptedAt: now, partial: false, stale: false, issue: null } };
        this.statusChanged(record.projectId, record);
      },
      () => {
        if (['codex', 'claude'].includes(record.provider) && session.live) {
          void this.command(session, { type: 'input', data: PROGRAM_STATUS_REPLY }).catch(() => {});
        }
      },
      record.provider,
    );
    this.helpers.add(child);
    this.live.get(record.id)?.screen?.dispose();
    this.live.set(record.id, session);
    const stopped = () => {
      const wasLive = session.live;
      session.live = false;
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new CliError('RUNTIME_UNAVAILABLE', 'Terminal stopped before confirming input. Inspect before retrying.'));
      }
      session.pending.clear();
      this.changed(record.id);
      if (wasLive) this.statusChanged(record.projectId, record);
    };
    child.on('exit', () => { this.helpers.delete(child); stopped(); });
    child.on('error', stopped);
    child.on('message', (message: any) => {
      if (message.type === 'data' && this.live.get(record.id) !== session) return;
      if (message.type === 'data' && typeof message.data === 'string' && message.data.length <= 32768) {
        if (record.provider === 'terminal') {
          session.shellTail = ((session.shellTail ?? '') + message.data).slice(-32768);
          for (const match of session.shellTail.matchAll(/\x1b\]7502;([a-f0-9]{64});([A-Za-z0-9+/=]{1,16384})\x07/g)) {
            if (match[1] === record.statusToken) {
              session.lastCommand = Buffer.from(match[2], 'base64').toString('utf8').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
            }
          }
          this.statusChanged(record.projectId, record);
        }
        programStatus(message.data);
        const interruption = session.turnStatus.confirm(message.data, record.provider);
        if (interruption) {
          const now = new Date().toISOString();
          session.programStatus = { data: interruption, meta: { availability: 'ready', observedAt: now, attemptedAt: now, partial: false, stale: false, issue: null } };
          this.statusChanged(record.projectId, record);
        }
        session.buffer += message.data;
        session.screen?.write(message.data);
        if (session.buffer.length > MAX_BUFFER) {
          const excess = session.buffer.length - MAX_BUFFER;
          session.buffer = session.buffer.slice(excess);
          session.start += excess;
        }
        this.changed(record.id);
      } else if (message.type === 'exit') {
        session.exitCode = Number.isInteger(message.exitCode) ? message.exitCode : null;
        stopped();
      } else if (message.type === 'ack' || message.type === 'error') {
        const pending = session.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          session.pending.delete(message.id);
          if (message.type === 'ack') pending.resolve();
          else pending.reject(new CliError('CLI_FAILED', 'Terminal operation failed. Inspect before retrying.'));
        }
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new CliError('CLI_TIMEOUT', `${definition.name} terminal startup timed out`)); }, 12000);
        const ready = (message: any) => {
          if (message.type !== 'ready' && message.type !== 'error') return;
          cleanup();
          if (message.type === 'ready') {
            session.agentPid = Number.isInteger(message.pid) && message.pid > 0 ? message.pid : undefined;
            session.live = true;
            resolve();
          } else {
            reject(new CliError('CLI_FAILED', `${definition.name} terminal could not initialize`));
          }
        };
        const failed = () => { cleanup(); reject(new CliError('CLI_FAILED', `${definition.name} terminal helper stopped during startup`)); };
        const cleanup = () => { clearTimeout(timer); child.off('message', ready); child.off('exit', failed); child.off('error', failed); };
        child.on('message', ready);
        child.once('exit', failed);
        child.once('error', failed);
        child.send({ type: 'start', ...resolved, cwd }, error => { if (error) failed(); });
      });
      this.store.saveSession(record);
      this.changed(record.id);
      this.statusChanged(record.projectId, record);
    } catch (error) {
      child.kill();
      this.live.delete(record.id);
      throw error;
    }
    return record;
  }

  require(projectId: string, id: string): SessionRecord {
    this.store.project(projectId);
    const record = this.store.sessions(projectId).find(session => session.id === id && !session.closed);
    if (!record) throw new CliError('NODE_NOT_FOUND', 'Agent session does not belong to this project');
    const observedId = record.provider === 'dsh' ? dshBinding(this.store.directory, record) : readAgyBinding(this.store.directory, record);
    if (observedId !== record.providerThreadId) {
      const updated = { ...record, providerThreadId: observedId };
      this.store.saveSession(updated);
      return updated;
    }
    return record;
  }

  messagePromptReady(projectId: string, id: string): boolean {
    const record = this.require(projectId, id);
    if (record.provider === 'dsh') return dshReady(this.store.directory, record) && this.live.get(id)?.screen?.dshPromptReady() === true;
    if (record.provider === 'codex') return this.live.get(id)?.screen?.composerEmpty() === true;
    return !isOpenCode(record.provider) || this.live.get(id)?.screen?.openCodePromptReady() === true;
  }

  handoffPromptReady(projectId: string, id: string): boolean {
    const record = this.require(projectId, id);
    const live = this.live.get(id);
    if (!live?.live || this.sending.has(id) || record.provider === 'terminal') return false;
    if (record.provider === 'dsh' && !dshReady(this.store.directory, record)) return false;
    const state = this.status(projectId, id).data?.state;
    if (['working', 'waiting', 'blocked'].includes(state ?? '')) return false;
    const empty =
      record.provider === 'dsh'
        ? live.screen?.dshPromptReady()
        : isOpenCode(record.provider)
          ? live.screen?.openCodePromptReady()
          : live.screen?.composerEmpty(record.provider === 'antigravity', record.provider === 'codebuddy');
    const native = isOpenCode(record.provider)
      ? empty
      : record.provider === 'codebuddy'
        ? live.screen?.codeBuddyPromptReady()
        : record.provider === 'antigravity' && antigravityPromptReady(live.screen?.text() ?? '');
    return Boolean(empty && (['idle', 'completed', 'failed', 'interrupted'].includes(state ?? '') || native));
  }

  liveness(projectId: string, id: string): 'live' | 'exited' {
    this.require(projectId, id);
    return this.live.get(id)?.live ? 'live' : 'exited';
  }

  page(projectId: string, id: string, cursor = 0, checkpoint = false): TerminalPage {
    const session = this.live.get(id);
    const record = this.require(projectId, id);
    const resumable =
      validProviderSessionId(record.provider, record.providerThreadId) &&
      !session?.live &&
      !this.starting.has(id) &&
      (record.provider !== 'antigravity' || this.savedAgy(record)) &&
      (record.provider !== 'dsh' || dshResumable(this.store.directory, record));
    const restartable = record.provider === 'terminal' && !session?.live && !this.starting.has(id);
    if (!session) return { data: '', cursor: 0, reset: cursor !== 0, live: false, exitCode: null, resumable, recoverable: resumable || restartable, restartable };
    const reset = cursor < session.start || cursor > session.start + session.buffer.length;
    if (checkpoint && (cursor === 0 || reset)) {
      const screen = session.screen?.checkpoint();
      if (screen && screen.cursor >= session.start) {
        return { ...screen, reset: true, live: session.live, exitCode: session.exitCode, resumable, restartable, recoverable: restartable };
      }
    }
    const offset = reset ? 0 : cursor - session.start;
    const data = session.buffer.slice(offset, offset + 65536);
    return {
      data,
      cursor: session.start + offset + data.length,
      reset,
      live: session.live,
      exitCode: session.exitCode,
      resumable,
      restartable,
      recoverable: restartable,
      ...session.screen?.dimensions(),
    };
  }

  preview(projectId: string, id: string): { command: string | null; output: string | null } {
    this.require(projectId, id);
    const session = this.live.get(id);
    const output = session?.screen?.text();
    return { command: session?.lastCommand ?? null, output: output || null };
  }

  chatOptions(projectId: string, id: string, observed: { model?: string | null; effort?: string | null; nativeResumable?: boolean }): Promise<AgentChatOptions> {
    return readSessionChatOptions(this, projectId, id, observed);
  }

  setChatOption(
    projectId: string,
    id: string,
    request: SetAgentChatOptionRequest,
    observed: { model?: string | null; effort?: string | null; nativeResumable?: boolean },
  ): Promise<AgentChatOptions> {
    return setSessionChatOption(this, projectId, id, request, observed);
  }

  openNativeRewindPicker(projectId: string, id: string) {
    return openSessionNativeRewindPicker(this, projectId, id);
  }

  nativeRewindAvailable(record: SessionRecord): boolean {
    return (
      record.provider === 'codex' &&
      Boolean(this.live.get(record.id)?.live) &&
      Boolean(record.providerThreadId) &&
      codexPaginatedBinding(record.providerThreadId!, record.cwd, record.sourceCwd)
    );
  }

  compact(projectId: string, id: string) {
    return compactSessionConversation(this, projectId, id);
  }

  rewind(
    projectId: string,
    id: string,
    target: {
      beforeSeq?: number;
      beforeMessageId?: string;
      anchor?: NativeUserAnchor;
      materialize?: () => Promise<string | undefined>;
      message: string;
      current: () => boolean;
      receipt?: SessionRecord['rewindPending'];
    },
    token: string | undefined,
  ) {
    return rewindSessionConversation(this, projectId, id, target, token);
  }

  async interrupt(projectId: string, id: string): Promise<void> {
    const record = this.require(projectId, id);
    const session = this.live.get(id);
    if (!session?.live || record.provider === 'terminal') {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent terminal is not running. Open Terminal to inspect or resume it.');
    }
    if (this.sending.has(id)) throw new CliError('RATE_LIMITED', 'Agent input is busy. No interruption was sent.');
    await session.screen?.settled();
    const current = this.require(projectId, id);
    const status = this.status(projectId, id);
    if (this.live.get(id) !== session || !session.live || current.statusToken !== record.statusToken) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'The agent session changed. No interruption was sent.');
    }
    if (status.meta.availability !== 'ready' || status.meta.stale || status.data?.state !== 'working') {
      throw new CliError('INVALID_ARGUMENT', 'The agent is no longer working. No interruption was sent.');
    }
    const armed = /\besc(?:ape)?\s+again to interrupt\b/i.test(session.screen?.viewportText().split('\n').slice(-8).join('\n') ?? '');
    const outputBefore = session.start + session.buffer.length;
    const first = this.input(projectId, id, record.provider === 'dsh' ? '\x03' : '\x1b');
    if (!isOpenCode(record.provider) || armed) {
      await first;
      return;
    }
    this.sending.add(id);
    try {
      await first;
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 30));
        await session.screen?.settled();
        const current = this.require(projectId, id);
        const status = this.status(projectId, id);
        if (this.live.get(id) !== session || !session.live || current.statusToken !== record.statusToken) {
          throw new CliError('RUNTIME_UNAVAILABLE', 'The agent session changed. No confirmation key was sent.');
        }
        if (status.meta.availability !== 'ready' || status.meta.stale) {
          throw new CliError('RUNTIME_UNAVAILABLE', 'Agent status is unavailable. Inspect Terminal before trying again.');
        }
        if (status.data?.state !== 'working') return;
        const footer = session.screen?.viewportText().split('\n').slice(-8).join('\n') ?? '';
        if (session.start + session.buffer.length <= outputBefore || !/\besc(?:ape)?\s+again to interrupt\b/i.test(footer)) continue;
        session.inputRevision = (session.inputRevision ?? 0) + 1;
        session.turnStatus.input('\x1b', Date.now(), true);
        await this.command(session, { type: 'input', data: '\x1b' });
        return;
      }
      throw new CliError('CLI_FAILED', 'The native interruption confirmation did not appear. Open Terminal to inspect the agent; no keys were retried.');
    } finally {
      this.sending.delete(id);
    }
  }

  input(projectId: string, id: string, data: string): Promise<void> {
    this.require(projectId, id);
    if (this.sending.has(id)) throw new CliError('RATE_LIMITED', 'A chat message is being staged. Wait before typing in Terminal.');
    if (typeof data !== 'string' || !data.length || data.length > 16384) {
      throw new CliError('INVALID_ARGUMENT', 'Terminal input must contain 1–16384 characters');
    }
    const session = this.live.get(id);
    if (!session?.live) throw new CliError('RUNTIME_UNAVAILABLE', 'Agent terminal is no longer running; start a new agent');
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    const pointerInput = /^(?:\x1b\[<(?:\d+;){2}\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO])+$/.test(data);
    if (!pointerInput && !/^(?:\x1b\[[IO])$/.test(data)) session.chatCurrent = undefined;
    session.draftInput =
      data === '\r' || data === '\n' || data === '\x03' || data === '\x15'
        ? false
        : pointerInput || /^(?:\x1b|\x1b\[[IO])$/.test(data)
          ? session.draftInput
          : true;
    const sent = this.command(session, { type: 'input', data });
    if (session.resumeTurnObserved === false && /[\r\n]/.test(data)) session.resumePromptSubmitted = true;
    const interrupt = isInterruptionInput(data);
    if (!pointerInput) session.turnStatus.input(data, Date.now(), interrupt ? this.status(projectId, id).data?.state === 'working' : undefined);
    return sent.catch(error => {
      session.turnStatus.input('');
      throw error;
    });
  }

  pasteTerminalAttachments(projectId: string, id: string, request: TerminalAttachmentsRequest): Promise<{ ok: true }> {
    return pasteSessionTerminalAttachments(this, projectId, id, request);
  }

  send(
    projectId: string,
    id: string,
    request: SendMessageRequest,
    internalWorkflow = false,
    submit = true,
    requireEmpty = false,
  ): Promise<{ ok: true; message: string }> {
    return sendSessionMessage(this, projectId, id, request, internalWorkflow, submit, requireEmpty);
  }

  resize(projectId: string, id: string, cols: number, rows: number): Promise<void> {
    this.require(projectId, id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid terminal dimensions');
    }
    const session = this.live.get(id);
    session?.screen?.resize(cols, rows);
    const resized = session?.live ? this.command(session, { type: 'resize', cols, rows }) : Promise.resolve();
    return resized.then(() => { this.changed(id); });
  }

  command(session: LiveSession, message: object): Promise<void> {
    if (!session.process.connected || session.pending.size >= 32) {
      throw new CliError('RATE_LIMITED', 'Terminal is not accepting input; wait and inspect it before retrying');
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new CliError('CLI_TIMEOUT', 'Terminal did not confirm input. Inspect before retrying.'));
      }, 5000);
      session.pending.set(id, { resolve, reject, timer });
      session.process.send({ ...message, id }, error => {
        if (error) {
          clearTimeout(timer);
          session.pending.delete(id);
          reject(new CliError('CLI_FAILED', 'Terminal input delivery is uncertain. Inspect before retrying.'));
        }
      });
    });
  }

  closeSession(projectId: string, id: string): void {
    if (this.starting.has(id)) throw new CliError('INVALID_ARGUMENT', 'Wait for this terminal to finish starting');
    if (this.store.sessions(projectId).find(record => record.id === id)?.closed) return;
    const record = this.require(projectId, id);
    const session = this.live.get(id);
    if (session) {
      session.live = false;
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new CliError('RUNTIME_UNAVAILABLE', 'Terminal tab was closed.'));
      }
      session.pending.clear();
      if (session.process.connected) {
        try { session.process.send({ type: 'stop' }, () => {}); } catch { /* Already exited. */ }
      }
      setTimeout(() => { if (!session.process.killed) session.process.kill(); }, 1000).unref();
    }
    this.live.delete(id);
    session?.screen?.dispose();
    if (session) session.screen = undefined;
    this.statusOwners.delete(id);
    this.store.saveSession({ ...record, closed: true });
    this.changed(id);
    this.statusChanged(projectId);
  }

  isClosed(projectId: string, id: string): boolean {
    return !this.shutdown.signal.aborted && this.store.sessions(projectId).find(record => record.id === id)?.closed === true;
  }

  /** Keep the tab/history, and require a native PTY exit before another writer uses its checkout. */
  async stopWorkflowWorker(projectId: string, id: string): Promise<void> {
    this.require(projectId, id);
    const session = this.live.get(id);
    if (!session?.live) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); session.process.off('message', onMessage); };
      const onMessage = (message: any) => { if (message.type === 'exit') { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new CliError('CLI_TIMEOUT', 'Worker exit was not confirmed. Stop it in Terminal before continuing.')); }, 10000);
      session.process.on('message', onMessage);
      session.process.send({ type: 'stop' }, error => { if (error) { cleanup(); reject(new CliError('CLI_FAILED', 'Worker stop could not be confirmed')); } });
    });
  }

  close(): void {
    for (const project of this.store.projects()) {
      for (const record of this.store.sessions(project.id)) {
        if (!record.closed) this.require(project.id, record.id);
      }
    }
    this.shutdown.abort();
    this.statusWatcher?.close();
    this.statusWatcher = undefined;
    for (const timer of this.statusTimers.values()) clearTimeout(timer);
    this.statusTimers.clear();
    this.statusOwners.clear();
    this.listeners.clear();
    this.statusListeners.clear();
    this.resultListeners.clear();
    for (const helper of this.helpers) helper.kill();
    this.helpers.clear();
    for (const session of this.live.values()) session.screen?.dispose();
    this.live.clear();
  }
}
