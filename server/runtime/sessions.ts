import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import type { AdeProvider, AgentCatalogResponse, AgentStatus, Section, SendMessageRequest, TerminalPage, TerminalShell, AgentInteraction, AnswerAgentRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { AdeStore, type SessionRecord } from './store.js';
import { codexThread, validCodexThreadId } from './codexThread.js';
import { installAgyHook, agyBindingFile, readAgyBinding, agyConversationSaved } from './agyBinding.js';
import { installStatusHooks, readAgentStatus, statusFile } from './statusHooks.js';
import { antigravityPromptReady, programStatusReader, PROGRAM_STATUS_REPLY, TerminalTurnStatus } from './programStatus.js';
import { attachmentPaste, attachmentReference, decodeAttachments, storeAttachments, usesNativeImageAttachment } from '../services/attachments.js';
import { TerminalScreen } from './terminalScreen.js';
import { permissionArgs, readAgentPreferences } from './agentPreferences.js';
import { terminalInteraction } from './interaction.js';

const PROVIDERS: { id: AdeProvider; name: string; command: string; package?: string; entry?: string }[] = [
  { id: 'codex', name: 'Codex', command: 'codex', package: '@openai/codex', entry: 'bin/codex.js' },
  { id: 'claude', name: 'Claude Code', command: 'claude', package: '@anthropic-ai/claude-code', entry: 'cli.js' },
  { id: 'antigravity', name: 'Antigravity', command: 'agy' },
  { id: 'terminal', name: 'Terminal', command: 'terminal' },
];
const MAX_BUFFER = 1024 * 1024;
const MAX_LIVE_SESSIONS = 16;

export function executableOnPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).map(value => value.replace(/^"|"$/g, ''));
  for (const dir of dirs.filter(Boolean)) {
    const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* Try the next fixed candidate. */ }
  }
  return null;
}

export const TERMINAL_SHELLS: TerminalShell[] = ['powershell', 'cmd', 'bash'];
const POWERSHELL_PROMPT = "function global:prompt { $h = Get-History -Count 1; if ($h) { $b = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($h.CommandLine)); [Console]::Write([char]27 + ']7502;' + $env:ADE_STATUS_TOKEN + ';' + $b + [char]7) }; 'PS ' + $executionContext.SessionState.Path.CurrentLocation + '> ' }";

function resolveTerminalShell(shell: TerminalShell): { executable: string; args: string[] } | null {
  const win = process.platform === 'win32';
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  let executable: string | null = null, args: string[] = [];
  if (shell === 'powershell') {
    executable = win ? executableOnPath('pwsh') || path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : executableOnPath('pwsh');
    args = ['-NoLogo', '-NoExit', '-Command', POWERSHELL_PROMPT];
  } else if (shell === 'cmd') {
    executable = win ? path.join(system32, 'cmd.exe') : null;
  } else {
    // Prefer Git Bash on Windows; System32\bash.exe is the WSL launcher and would not start in the worktree cwd.
    const git = win ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
      .filter((dir): dir is string => Boolean(dir)).map(dir => path.join(dir, 'Git', 'bin', 'bash.exe')).find(file => fs.existsSync(file)) : undefined;
    const found = executableOnPath('bash');
    executable = git ?? (found && !(win && found.toLowerCase().startsWith(system32.toLowerCase())) ? found : null);
    args = ['--noprofile', '--norc', '-i'];
  }
  return executable && fs.existsSync(executable) ? { executable, args } : null;
}

export function resolveAgent(provider: AdeProvider, shell?: TerminalShell): { executable: string; args: string[] } | null {
  if (provider === 'terminal') {
    if (shell) return resolveTerminalShell(shell);
    return resolveTerminalShell('powershell') ?? resolveTerminalShell('bash');
  }
  const definition = PROVIDERS.find(item => item.id === provider);
  if (!definition) return null;
  const native = executableOnPath(definition.command);
  if (native) return { executable: native, args: [] };
  if (provider === 'claude') {
    const nativeClaude = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(nativeClaude)) return { executable: nativeClaude, args: [] };
  }
  // Resolve known npm entry points directly; never run a .cmd shim or concatenate a shell command.
  if (definition.package && definition.entry) {
    const node = executableOnPath('node');
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const entry = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', definition.package, definition.entry);
      if (node && fs.existsSync(entry)) return { executable: node, args: [entry] };
    }
  }
  return null;
}

export function agentCatalog(): AgentCatalogResponse {
  const available = PROVIDERS.map(provider => ({ id: provider.id, name: provider.name, command: provider.command,
    detectCmd: provider.command, provider: provider.id, installed: Boolean(resolveAgent(provider.id)), isDefault: provider.id === 'codex' }));
  const installed = available.filter(provider => provider.installed);
  return { runtime: 'ade', installed, available, defaultAgentId: installed.find(item => item.isDefault)?.id ?? installed[0]?.id ?? null };
}

interface LiveSession {
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
  programStatus?: Section<AgentStatus>;
  process: ChildProcess;
  buffer: string;
  start: number;
  live: boolean;
  exitCode: number | null;
  pending: Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
}

export class AdeSessions {
  private live = new Map<string, LiveSession>();
  private helpers = new Set<ChildProcess>();
  private starting = new Set<string>();
  private historyStarting = new Set<string>();
  private sending = new Set<string>();
  private shutdown = new AbortController();
  private statusWatcher?: fs.FSWatcher;
  private statusOwners = new Map<string, string>();
  private statusTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Map<string, Set<() => void>>();
  private statusListeners = new Map<string, Set<() => void>>();
  private resultTurns = new Map<string, { state: string; turn: string; token?: string }>();
  processRoots(): number[] { return [...this.helpers].flatMap(child => child.pid ? [child.pid] : []).concat([...this.live.values()].flatMap(session => session.live && session.agentPid ? [session.agentPid] : [])); }
  subscribeStatus(projectId: string, listener: () => void): () => void {
    const listeners = this.statusListeners.get(projectId) ?? new Set(); listeners.add(listener); this.statusListeners.set(projectId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.statusListeners.delete(projectId); };
  }
  private statusChanged(projectId: string, observed?: SessionRecord): void {
    if (this.shutdown.signal.aborted) return;
    for (const record of observed ? [observed] : this.store.sessions(projectId)) {
      if (!record.closed && record.provider !== 'terminal' && this.live.get(record.id)?.live) this.status(projectId, record.id);
    }
    for (const listener of this.statusListeners.get(projectId) ?? []) listener();
  }
  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  private changed(id: string): void { for (const listener of this.listeners.get(id) ?? []) listener(); }
  constructor(readonly store: AdeStore, private resolve: typeof resolveAgent = resolveAgent, private bindCodex = codexThread, private prepareAgy = installAgyHook, private prepareStatus = installStatusHooks, private savedAgy = agyConversationSaved) {}

  status(projectId: string, id: string) {
    const record = this.require(projectId, id), live = this.live.get(id);
    const hook = readAgentStatus(this.store.directory, record, Boolean(live?.live));
    if (live) live.lastHook = hook;
    if (live?.programStatus && hook.data?.state === 'working' && (record.provider === 'antigravity' || hook.data.event === 'UserPromptSubmit')
      && Date.parse(hook.meta.observedAt ?? '') > Date.parse(live.programStatus.meta.observedAt ?? '')) {
      live.programStatus = undefined; live.turnStatus.observe(hook.data);
    }
    if (live?.live && live.programStatus) {
      if (hook.data?.state === 'waiting' && Date.parse(hook.meta.observedAt ?? '') > Date.parse(live.programStatus.meta.observedAt ?? '')) return this.observeResult(record, hook);
      if (['failed', 'interrupted'].includes(live.programStatus.data?.state ?? '')) return this.observeResult(record, live.programStatus);
      if (['failed', 'interrupted', 'completed'].includes(hook.data?.state ?? '') && Date.parse(hook.meta.observedAt ?? '') >= (live.turnStartedAt ?? 0)) return this.observeResult(record, hook);
      return this.observeResult(record, live.programStatus);
    }
    return this.observeResult(record, hook);
  }

  interaction(projectId: string, id: string): AgentInteraction | null {
    const record = this.require(projectId, id), session = this.live.get(id), status = this.status(projectId, id);
    if (!session?.live || status.data?.state !== 'waiting' || status.data.attention === 'auth') return null;
    const screen = session.screen?.text();
    const prompt = screen ? terminalInteraction(screen, record.provider, `${record.id}:${record.statusToken}:${status.meta.observedAt}:${session.inputRevision ?? 0}`, status.data.toolCall?.summary) : null;
    const signature = prompt ? JSON.stringify([record.statusToken, prompt.question, prompt.detail, prompt.options]) : '';
    return prompt && !(session.answeredPrompt === signature && Date.parse(status.meta.observedAt ?? '') <= (session.answeredAt ?? Infinity)) ? prompt : null;
  }

  async answer(projectId: string, id: string, request: AnswerAgentRequest): Promise<void> {
    const prompt = this.interaction(projectId, id), session = this.live.get(id), record = this.require(projectId, id);
    if (this.sending.has(id)) throw new CliError('RUNTIME_UNAVAILABLE', 'Input is already being sent to this terminal');
    if (!prompt || !session?.live || prompt.id !== request.promptId || !prompt.options.some(option => option.id === request.optionId)) throw new CliError('INVALID_ARGUMENT', 'This question has changed or was already answered. Review the current prompt.');
    if (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 2000 || /[\x00-\x1f\x7f]/.test(request.text) || request.optionId !== prompt.textOptionId)) throw new CliError('INVALID_ARGUMENT', 'Free text is only supported for the displayed Other option');
    if (request.optionId === prompt.textOptionId && !request.text?.trim()) throw new CliError('INVALID_ARGUMENT', 'Enter your answer for Other');
    this.sending.add(id); session.answeredPrompt = JSON.stringify([record.statusToken, prompt.question, prompt.detail, prompt.options]); session.answeredAt = Date.parse(this.status(projectId, id).meta.observedAt ?? '') || Date.now();
    try {
      if (request.text && record.provider === 'codex') {
        // Codex notes: move without committing, open notes with Tab, then submit.
        const screen = session.screen?.text() ?? '';
        const selected = /^\s*[›❯>]\s*([1-9])[.)]/m.exec(screen);
        const delta = Number(request.optionId) - Number(selected?.[1] ?? 1);
        if (delta) await this.command(session, { type: 'input', data: (delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)) });
        await this.command(session, { type: 'input', data: '\t' });
      } else await this.command(session, { type: 'input', data: request.optionId });
      if (request.text) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!session.live || this.live.get(id) !== session) throw new CliError('RUNTIME_UNAVAILABLE', 'Terminal changed while answering. Inspect Terminal before retrying.');
        await this.command(session, { type: 'input', data: `\x1b[200~${request.text.trim()}\x1b[201~` });
        await this.command(session, { type: 'input', data: '\r' });
      }
    } finally { this.sending.delete(id); this.statusChanged(projectId, record); }
  }

  private observeResult(record: SessionRecord, status: Section<AgentStatus>): Section<AgentStatus> {
    if (record.provider === 'terminal' || status.meta.availability !== 'ready' || !status.data) return status;
    if (record.provider === 'antigravity' && status.data.state === 'working' && status.data.event === 'PreToolUse' && status.data.toolCall?.summary) {
      const screen = this.live.get(record.id)?.screen?.text() ?? '';
      const summary = status.data.toolCall.summary;
      const prompt = terminalInteraction(screen, record.provider, record.statusToken ?? '', summary);
      // Antigravity has no PermissionRequest hook: require its exact recorded tool
      // arguments in a current native approval widget, never a generic output line.
      if (prompt?.kind === 'approval' && screen.replace(/\s/g, '').includes(summary.replace(/\s/g, '')) && /(?:Esc|escape|enter|navigate|↑|↓)/i.test(screen)) {
        status = { ...status, data: { ...status.data, state: 'waiting', attention: 'approval', source: 'provider-terminal', event: 'native-approval-prompt' } };
      }
    }
    const state = status.data!.state, previous = this.resultTurns.get(record.id);
    if (previous?.state === state && previous.token === record.statusToken) return status;
    const turn = !previous || previous.token !== record.statusToken || (['working', 'waiting', 'blocked'].includes(state) && ['completed', 'failed', 'interrupted', 'idle'].includes(previous.state)) ? crypto.randomUUID() : previous.turn;
    this.resultTurns.set(record.id, { state, turn, token: record.statusToken });
    if (['completed', 'failed', 'interrupted'].includes(state) && status.meta.observedAt) {
      const project = this.store.project(record.projectId);
      const item = { id: turn, projectId: project.id, projectName: project.name, nodeId: record.id, runId: null,
        entityId: record.id, title: this.store.title(record.id, record.title), outcome: state, at: status.meta.observedAt, source: 'turn' };
      this.store.db.prepare('INSERT OR REPLACE INTO turn_results VALUES (?, ?, ?)').run(turn, item.at, JSON.stringify(item));
      this.store.db.exec('DELETE FROM turn_results WHERE id NOT IN (SELECT id FROM turn_results ORDER BY at DESC LIMIT 200)');
    }
    return status;
  }

  async launch(projectId: string, worktreeId: string, cwd: string, command: string, title?: string, shell?: TerminalShell): Promise<SessionRecord> {
    const definition = PROVIDERS.find(provider => provider.command === command || provider.id === command);
    if (!definition) throw new CliError('INVALID_ARGUMENT', 'Select Codex, Claude Code or Antigravity; custom commands and flags are not accepted');
    if (definition.id !== 'terminal' && !readAgentPreferences(this.store).providers[definition.id].enabled) throw new CliError('INVALID_ARGUMENT', 'This agent is disabled in Settings > Agents');
    if (shell !== undefined && (definition.id !== 'terminal' || !TERMINAL_SHELLS.includes(shell))) throw new CliError('INVALID_ARGUMENT', 'Shell selection applies only to Terminal and must be PowerShell, Command Prompt or Bash');
    const resolved = this.resolve(definition.id, shell);
    if (!resolved && shell) throw new CliError('CLI_MISSING', `The selected shell (${({ powershell: 'PowerShell', cmd: 'Command Prompt', bash: 'Bash' })[shell]}) is not available on this machine. Change it in Settings > General.`);
    if (!resolved) throw new CliError('CLI_MISSING', `${definition.name} is not installed or its executable is not available`);
    if (this.store.sessions(projectId).length >= 200) throw new CliError('RATE_LIMITED', 'Project session history has reached the 200 session limit');
    const record: SessionRecord = { id: crypto.randomUUID(), projectId, worktreeId, cwd, provider: definition.id,
      title: title || definition.name, createdAt: new Date().toISOString(), closed: false, ...(shell ? { shell } : {}) };
    return this.start(record, resolved);
  }

  async resume(projectId: string, id: string): Promise<SessionRecord> {
    const record = this.require(projectId, id);
    if (record.provider !== 'terminal' && !validCodexThreadId(record.providerThreadId)) throw new CliError('INVALID_ARGUMENT', 'This session has no exact provider recovery binding');
    if (record.provider === 'antigravity' && !this.savedAgy(record)) throw new CliError('RUNTIME_UNAVAILABLE', 'Antigravity has not saved this conversation yet. Empty sessions cannot be resumed; start a new agent.');
    if (this.live.get(id)?.live) throw new CliError('INVALID_ARGUMENT', 'This terminal is already running');
    const resolved = this.resolve(record.provider, record.shell);
    if (!resolved) throw new CliError('CLI_MISSING', 'This agent is not installed');
    return this.start(record, resolved);
  }

  async resumeHistory(projectId: string, worktreeId: string, cwd: string, source: { provider: 'codex' | 'claude' | 'antigravity'; threadId: string; cwd: string | null; title: string }): Promise<SessionRecord> {
    const key = `${source.provider}:${source.threadId}`;
    if (!validCodexThreadId(source.threadId) || this.historyStarting.has(key)) throw new CliError('INVALID_ARGUMENT', 'This session is already resuming or has no verified provider identity');
    this.historyStarting.add(key);
    try {
      if (!readAgentPreferences(this.store).providers[source.provider].enabled) throw new CliError('INVALID_ARGUMENT', 'Enable this agent in Settings before resuming');
      const matches = this.store.projects().flatMap(project => this.store.sessions(project.id)).filter(record => record.provider === source.provider && record.providerThreadId === source.threadId);
      const running = matches.find(record => this.live.get(record.id)?.live || this.starting.has(record.id));
      if (running) {
        if (running.projectId === projectId && running.worktreeId === worktreeId) return running;
        throw new CliError('INVALID_ARGUMENT', 'This session is running in another worktree. Stop it in Terminal before moving it.');
      }
      const previous = matches.find(record => !record.closed) ?? matches[0];
      if (!previous && this.store.sessions(projectId).length >= 200) throw new CliError('RATE_LIMITED', 'Project session history has reached the 200 session limit');
      const resolved = this.resolve(source.provider);
      if (!resolved) throw new CliError('CLI_MISSING', 'Install this agent before resuming');
      const record: SessionRecord = { id: previous?.id ?? crypto.randomUUID(), projectId, worktreeId, cwd, provider: source.provider, title: previous ? this.store.title(previous.id, source.title) : source.title, createdAt: previous?.createdAt ?? new Date().toISOString(), closed: false, providerThreadId: source.threadId, ...(source.cwd ? { sourceCwd: source.cwd } : {}) };
      if (source.provider === 'antigravity' && !this.savedAgy(record)) throw new CliError('RUNTIME_UNAVAILABLE', 'Antigravity no longer has this saved conversation');
      try {
        const started = await this.start(record, resolved);
        if (previous && previous.projectId !== projectId) this.statusChanged(previous.projectId);
        return started;
      } catch (error) {
        if (previous && !this.live.get(record.id)?.live) this.store.saveSession(previous);
        throw error;
      }
    } finally { this.historyStarting.delete(key); }
  }

  private async start(record: SessionRecord, resolved: { executable: string; args: string[] }): Promise<SessionRecord> {
    if (this.shutdown.signal.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
    if (this.starting.has(record.id)) throw new CliError('INVALID_ARGUMENT', 'This terminal is already starting');
    if (this.live.size + this.starting.size - (this.live.has(record.id) ? 1 : 0) >= MAX_LIVE_SESSIONS) throw new CliError('RATE_LIMITED', 'Close an agent before starting more than 16 sessions');
    this.starting.add(record.id);
    try {
      const node = executableOnPath('node');
      if (!node) throw new CliError('CLI_MISSING', 'Node.js is required for provider status hooks');
      if (record.provider !== 'terminal') this.prepareStatus(this.store.directory, record.provider, node);
      record = { ...record, statusToken: crypto.randomBytes(32).toString('hex') };
      if (record.provider === 'codex') {
        record = { ...record, providerThreadId: await this.bindCodex(resolved, record.cwd, record.title, record.providerThreadId, this.shutdown.signal, record.sourceCwd ?? record.cwd) };
        if (this.shutdown.signal.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
        if (!validCodexThreadId(record.providerThreadId)) throw new CliError('CLI_FAILED', 'Codex returned an invalid session binding');
        resolved = { executable: resolved.executable, args: [...resolved.args, 'resume', record.providerThreadId, ...(record.sourceCwd && record.sourceCwd !== record.cwd ? ['--cd', record.cwd] : [])] };
        // Save identity before PTY startup so a failed terminal can still recover this exact thread.
        this.store.project(record.projectId);
        this.store.saveSession(record);
      } else if (record.provider === 'claude') {
        const existing = record.providerThreadId;
        record = { ...record, providerThreadId: existing ?? crypto.randomUUID() };
        resolved = { ...resolved, args: [...resolved.args, existing ? '--resume' : '--session-id', record.providerThreadId!] };
      } else if (record.provider === 'antigravity') {
        const node = executableOnPath('node');
        if (!node) throw new CliError('CLI_MISSING', 'Node.js is required for Antigravity session recovery');
        this.prepareAgy(this.store.directory, node);
        record = { ...record, bindingToken: crypto.randomBytes(32).toString('hex') };
        if (record.providerThreadId) resolved = { ...resolved, args: [...resolved.args, '--conversation', record.providerThreadId] };
      }
      if (record.provider !== 'terminal') {
        const preference = readAgentPreferences(this.store).providers[record.provider];
        resolved = { ...resolved, args: [...resolved.args, ...permissionArgs[record.provider][preference.mode]!] };
      }
      if (this.shutdown.signal.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
      return await this.startTerminal(record, resolved);
    } finally { this.starting.delete(record.id); }
  }

  private async startTerminal(record: SessionRecord, resolved: { executable: string; args: string[] }): Promise<SessionRecord> {
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
    // Authentication still uses the provider's existing local credentials.
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    env.TERM = 'xterm-256color';
    delete env.CLAUDECODE;
    delete env.CODEX_THREAD_ID;
    for (const key of Object.keys(env)) if (key.startsWith('ORCA_')) delete env[key];
    delete env.ADE_BINDING_FILE; delete env.ADE_BINDING_TOKEN; delete env.ADE_BINDING_CWD;
    env.ADE_STATUS_FILE = statusFile(this.store.directory, record.id);
    env.ADE_STATUS_TOKEN = record.statusToken!;
    env.ADE_STATUS_PROVIDER = record.provider;
    env.ADE_STATUS_CWD = record.cwd;
    env.ADE_STATUS_SESSION = record.providerThreadId ?? '';
    if (record.provider === 'terminal' && (record.shell === 'bash' || (!record.shell && process.platform !== 'win32'))) env.PROMPT_COMMAND = 'printf "\\033]7502;%s;%s\\007" "$ADE_STATUS_TOKEN" "$(history 1 | sed "s/^ *[0-9]* *//" | base64 | tr -d "\\n")"';
    if (record.provider === 'antigravity' && record.bindingToken) {
      env.ADE_BINDING_FILE = agyBindingFile(this.store.directory, record);
      env.ADE_BINDING_TOKEN = record.bindingToken;
      env.ADE_BINDING_CWD = record.cwd;
    }
    let child: ChildProcess;
    const host = process.env.ADE_PTY_HOST || path.resolve('server/runtime/ptyHost.cjs');
    // Use Node directly: Electron is a GUI executable, including for node-pty's own helpers.
    const node = executableOnPath('node');
    if (!node) throw new CliError('CLI_MISSING', 'Node.js is required for owned terminals');
    delete env.ELECTRON_RUN_AS_NODE;
    try { child = fork(host, [], { execPath: node, env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); }
    catch { throw new CliError('CLI_FAILED', `${definition.name} could not start; check its local installation`); }
    const session: LiveSession = { process: child, buffer: '', start: 0, live: false, exitCode: null, pending: new Map(), turnStatus: new TerminalTurnStatus() };
    session.screen = new TerminalScreen(data => {
      if (child.connected && !this.shutdown.signal.aborted) void this.command(session, { type: 'input', data }).catch(() => {});
    }, () => {
      if (record.provider === 'terminal') this.statusChanged(record.projectId, record);
      const hook = session.lastHook;
      if (record.provider === 'antigravity' && this.live.get(record.id) === session && session.live && hook?.data?.event === 'PreToolUse' && hook.data.state === 'working' && hook.data.toolCall) {
        const visible = this.observeResult(record, hook).data?.event === 'native-approval-prompt';
        if (visible !== Boolean(session.nativeApprovalVisible)) { session.nativeApprovalVisible = visible; this.statusChanged(record.projectId, record); }
      }
    });
    const programStatus = programStatusReader(status => {
      if (!['codex', 'claude'].includes(record.provider)) return;
      if (status.state === 'working' && session.programStatus?.data?.state !== 'working') session.turnStartedAt = Date.now();
      status = session.turnStatus.observe(status);
      if (session.programStatus?.data?.state === status.state && session.programStatus?.data?.attention === status.attention) return;
      const now = new Date().toISOString();
      session.programStatus = { data: status, meta: { availability: 'ready', observedAt: now, attemptedAt: now, partial: false, stale: false, issue: null } };
      this.statusChanged(record.projectId, record);
    }, () => {
      if (['codex', 'claude'].includes(record.provider) && session.live) void this.command(session, { type: 'input', data: PROGRAM_STATUS_REPLY }).catch(() => {});
    }, record.provider);
    this.helpers.add(child);
    this.live.get(record.id)?.screen?.dispose();
    this.live.set(record.id, session);
    const stopped = () => {
      const wasLive = session.live;
      session.live = false;
      for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(new CliError('RUNTIME_UNAVAILABLE', 'Terminal stopped before confirming input. Inspect before retrying.')); }
      session.pending.clear();
      this.changed(record.id);
      if (wasLive) this.statusChanged(record.projectId, record);
    };
    child.on('exit', () => { this.helpers.delete(child); stopped(); });
    child.on('error', stopped);
    child.on('message', (message: any) => {
      if (message.type === 'data' && typeof message.data === 'string' && message.data.length <= 32768) {
        if (record.provider === 'terminal') {
          session.shellTail = ((session.shellTail ?? '') + message.data).slice(-32768);
          for (const match of session.shellTail.matchAll(/\x1b\]7502;([a-f0-9]{64});([A-Za-z0-9+/=]{1,16384})\x07/g)) if (match[1] === record.statusToken) {
            session.lastCommand = Buffer.from(match[2], 'base64').toString('utf8').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
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
          session.buffer = session.buffer.slice(excess); session.start += excess;
        }
        this.changed(record.id);
      } else if (message.type === 'exit') {
        session.exitCode = Number.isInteger(message.exitCode) ? message.exitCode : null; stopped();
      } else if (message.type === 'ack' || message.type === 'error') {
        const pending = session.pending.get(message.id);
        if (pending) { clearTimeout(pending.timer); session.pending.delete(message.id);
          if (message.type === 'ack') pending.resolve(); else pending.reject(new CliError('CLI_FAILED', 'Terminal operation failed. Inspect before retrying.')); }
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new CliError('CLI_TIMEOUT', `${definition.name} terminal startup timed out`)); }, 12000);
        const ready = (message: any) => {
          if (message.type !== 'ready' && message.type !== 'error') return;
          cleanup();
          if (message.type === 'ready') { session.agentPid = Number.isInteger(message.pid) && message.pid > 0 ? message.pid : undefined; session.live = true; resolve(); }
          else reject(new CliError('CLI_FAILED', `${definition.name} terminal could not initialize`));
        };
        const failed = () => { cleanup(); reject(new CliError('CLI_FAILED', `${definition.name} terminal helper stopped during startup`)); };
        const cleanup = () => { clearTimeout(timer); child.off('message', ready); child.off('exit', failed); child.off('error', failed); };
        child.on('message', ready); child.once('exit', failed); child.once('error', failed);
        child.send({ type: 'start', ...resolved, cwd }, error => { if (error) failed(); });
      });
      this.store.saveSession(record);
      this.changed(record.id);
      this.statusChanged(record.projectId, record);
    } catch (error) { child.kill(); this.live.delete(record.id); throw error; }
    return record;
  }

  require(projectId: string, id: string): SessionRecord {
    this.store.project(projectId);
    const record = this.store.sessions(projectId).find(session => session.id === id && !session.closed);
    if (!record) throw new CliError('NODE_NOT_FOUND', 'Agent session does not belong to this project');
    const observedId = readAgyBinding(this.store.directory, record);
    if (observedId !== record.providerThreadId) {
      const updated = { ...record, providerThreadId: observedId }; this.store.saveSession(updated); return updated;
    }
    return record;
  }

  page(projectId: string, id: string, cursor = 0, checkpoint = false): TerminalPage {
    const session = this.live.get(id);
    const record = this.require(projectId, id);
    const resumable = validCodexThreadId(record.providerThreadId) && !session?.live && !this.starting.has(id) && (record.provider !== 'antigravity' || this.savedAgy(record));
    const restartable = record.provider === 'terminal' && !session?.live && !this.starting.has(id);
    if (!session) return { data: '', cursor: 0, reset: cursor !== 0, live: false, exitCode: null, resumable, recoverable: resumable || restartable, restartable };
    const reset = cursor < session.start || cursor > session.start + session.buffer.length;
    if (checkpoint && (cursor === 0 || reset)) {
      const screen = session.screen?.checkpoint();
      if (screen && screen.cursor >= session.start) return { ...screen, reset: true, live: session.live, exitCode: session.exitCode, resumable, restartable, recoverable: restartable };
    }
    const offset = reset ? 0 : cursor - session.start;
    const data = session.buffer.slice(offset, offset + 65536);
    return { data, cursor: session.start + offset + data.length, reset, live: session.live, exitCode: session.exitCode, resumable, restartable, recoverable: restartable };
  }

  preview(projectId: string, id: string): { command: string | null; output: string | null } {
    this.require(projectId, id);
    const session = this.live.get(id);
    const output = session?.screen?.text();
    return { command: session?.lastCommand ?? null, output: output || null };
  }

  input(projectId: string, id: string, data: string): Promise<void> {
    this.require(projectId, id);
    if (this.sending.has(id)) throw new CliError('RATE_LIMITED', 'A chat message is being staged. Wait before typing in Terminal.');
    if (typeof data !== 'string' || !data.length || data.length > 16384) throw new CliError('INVALID_ARGUMENT', 'Terminal input must contain 1–16384 characters');
    const session = this.live.get(id);
    if (!session?.live) throw new CliError('RUNTIME_UNAVAILABLE', 'Agent terminal is no longer running; start a new agent');
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    const sent = this.command(session, { type: 'input', data });
    const interrupt = data === '\x1b' || data === '\x03' || /^\x1b\[27(?:;1(?::[12])?)?u$/.test(data);
    session.turnStatus.input(data, Date.now(), interrupt ? this.status(projectId, id).data?.state === 'working' : undefined);
    return sent.catch(error => { session.turnStatus.input(''); throw error; });
  }

  async send(projectId: string, id: string, request: SendMessageRequest): Promise<{ ok: true; message: string }> {
    const record = this.require(projectId, id), session = this.live.get(id);
    // Antigravity hides shortcuts in a nonempty composer. Preserve initial readiness
    // only within this locked send, while every write still checks fresh status/liveness.
    const initialNativeReady = record.provider === 'antigravity' && antigravityPromptReady(session?.screen?.text() ?? session?.buffer ?? '');
    if (typeof request.message !== 'string' || request.message.length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(request.message)) throw new CliError('INVALID_ARGUMENT', 'Message must contain up to 10000 characters without terminal control codes');
    const uploads = decodeAttachments(request.attachments);
    if (!request.message.trim() && !uploads.length) throw new CliError('INVALID_ARGUMENT', 'Enter a message or attach a file');
    if (this.sending.has(id)) throw new CliError('RATE_LIMITED', 'A message is already being sent to this agent');
    const writable = () => {
      if (!session?.live || this.live.get(id) !== session) throw new CliError('RUNTIME_UNAVAILABLE', 'This session is stopped. Open Terminal to resume it before sending.');
      const status = this.status(projectId, id);
      if (['waiting', 'blocked'].includes(status.data?.state ?? '')) throw new CliError('RUNTIME_UNAVAILABLE', 'The agent needs input. Answer its question or approval controls in Chat, or use Terminal for native setup.');
      const nativeReady = record.provider === 'antigravity' && (!status.data || status.data.state === 'unknown') && initialNativeReady;
      if (!nativeReady && (status.meta.availability !== 'ready' || !['idle', 'working', 'completed', 'failed', 'interrupted'].includes(status.data?.state ?? ''))) throw new CliError('RUNTIME_UNAVAILABLE', 'The agent input prompt is not ready yet. Open Terminal to finish setup, then try again.');
    };
    writable(); this.sending.add(id);
    let staged = false;
    try {
      const files = (await storeAttachments(uploads, path.join(this.store.directory, 'attachments'))).map(file => ({ ...file, path: file.path.replaceAll('\\', '/') }));
      const write = async (data: string) => {
        writable();
        staged = true;
        for (let offset = 0; offset < data.length; offset += 8192) await this.command(session!, { type: 'input', data: data.slice(offset, offset + 8192) });
      };
      // Same provider-specific staging rules as Orca's agent-image-paste: native image chips
      // for Codex/Claude, file mentions for Antigravity and non-image attachments.
      for (const file of files) if (usesNativeImageAttachment(record.provider, file)) await write(attachmentPaste(record.provider, file));
      const references = files.filter(file => !usesNativeImageAttachment(record.provider, file)).map(attachmentReference);
      const prompt = [...references, request.message.trim() || 'Please review the attached files.'].join('\n');
      await write(`\x1b[200~${prompt.replace(/\r\n?/g, '\n')}\x1b[201~`);
      await new Promise(resolve => setTimeout(resolve, 300));
      writable();
      await this.command(session!, { type: 'input', data: '\r' });
      return { ok: true, message: 'Submitted to the agent terminal' };
    } catch (error) {
      if (staged) throw new CliError('CLI_FAILED', 'Delivery may be partial. Inspect Terminal before sending again; the message was not automatically retried.');
      throw error;
    } finally { this.sending.delete(id); }
  }

  resize(projectId: string, id: string, cols: number, rows: number): Promise<void> {
    this.require(projectId, id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) throw new CliError('INVALID_ARGUMENT', 'Invalid terminal dimensions');
    const session = this.live.get(id);
    session?.screen?.resize(cols, rows);
    return session?.live ? this.command(session, { type: 'resize', cols, rows }) : Promise.resolve();
  }

  private command(session: LiveSession, message: object): Promise<void> {
    if (!session.process.connected || session.pending.size >= 32) throw new CliError('RATE_LIMITED', 'Terminal is not accepting input; wait and inspect it before retrying');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(id); reject(new CliError('CLI_TIMEOUT', 'Terminal did not confirm input. Inspect before retrying.')); }, 5000);
      session.pending.set(id, { resolve, reject, timer });
      session.process.send({ ...message, id }, error => { if (error) { clearTimeout(timer); session.pending.delete(id); reject(new CliError('CLI_FAILED', 'Terminal input delivery is uncertain. Inspect before retrying.')); } });
    });
  }

  closeSession(projectId: string, id: string): void {
    if (this.starting.has(id)) throw new CliError('INVALID_ARGUMENT', 'Wait for this terminal to finish starting');
    const record = this.require(projectId, id);
    const session = this.live.get(id);
    if (session?.process.connected) { session.process.send({ type: 'stop' }); session.live = false; setTimeout(() => session.process.kill(), 1000).unref(); }
    this.live.delete(id);
    session?.screen?.dispose();
    this.statusOwners.delete(id);
    this.store.saveSession({ ...record, closed: true });
    this.changed(id);
    this.statusChanged(projectId);
  }

  close(): void {
    for (const project of this.store.projects()) for (const record of this.store.sessions(project.id)) if (!record.closed) this.require(project.id, record.id);
    this.shutdown.abort();
    this.statusWatcher?.close(); this.statusWatcher = undefined;
    for (const timer of this.statusTimers.values()) clearTimeout(timer);
    this.statusTimers.clear(); this.statusOwners.clear();
    this.listeners.clear();
    this.statusListeners.clear();
    // Include helpers whose tabs have closed but whose native PTY teardown is still pending.
    // The backend may exit immediately after this method, so do not defer termination.
    for (const helper of this.helpers) helper.kill();
    this.helpers.clear();
    for (const session of this.live.values()) session.screen?.dispose();
    this.live.clear();
  }
}
