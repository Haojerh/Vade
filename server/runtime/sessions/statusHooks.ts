import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdeProvider, AgentStatus, Section } from '../../../shared/contracts.js';
import type { SessionRecord } from '../store.js';
import { CliError } from '../../integrations/cli.js';
import { dshStatus } from '../../providers/dsh/dsh.js';

export const STATUS_EVENTS = {
  dsh: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
  codex: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt'],
  claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'],
  codebuddy: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'],
  opencode: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionError', 'SessionAborted'],
  opencode2: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionError', 'SessionAborted'],
  kilo: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionError', 'SessionAborted'],
  antigravity: ['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
} as const;

// Observe metadata only. Antigravity PreToolUse requires "ask" to preserve normal permission handling.
export const STATUS_HOOK_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path');
const env = process.env, provider = process.argv[2], event = process.argv[3];
process.stdout.write(provider==='antigravity' && event==='PreToolUse' ? '{"decision":"ask"}\n' : provider==='antigravity' && event==='Stop' ? '{"decision":""}\n' : '{}\n');
if (!env.ADE_STATUS_FILE || !env.ADE_STATUS_TOKEN || env.ADE_STATUS_PROVIDER !== provider || !env.ADE_STATUS_CWD) process.exit(0);
let input = '', bytes = 0;
setTimeout(() => process.exit(0), 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  bytes += Buffer.byteLength(chunk); if (bytes > 131072) process.exit(0);
  input += chunk;
  let p; try { p = JSON.parse(input); } catch { return; }
  try {
    if (!p || typeof p !== 'object' || p.agent_id || p.parent_tool_use_id || p.parent_thread_id) process.exit(0);
    const agy = provider === 'antigravity';
    const id = agy ? p.conversationId : p.session_id;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) process.exit(0);
    if (env.ADE_STATUS_SESSION && env.ADE_STATUS_SESSION !== id) process.exit(0);
    const cwd = path.resolve(env.ADE_STATUS_CWD);
    if (agy ? !Array.isArray(p.workspacePaths) || !p.workspacePaths.slice(0,32).some(v=>typeof v==='string' && v.length<=4096 && path.resolve(v)===cwd)
      : typeof p.cwd !== 'string' || p.cwd.length>4096 || path.relative(cwd,path.resolve(p.cwd))!=='' || p.hook_event_name!==event) process.exit(0);
    let previous;
    try { const stat=fs.statSync(env.ADE_STATUS_FILE); if(stat.size<=4096) previous=JSON.parse(fs.readFileSync(env.ADE_STATUS_FILE,'utf8')); } catch {}
    if (agy && previous?.token===env.ADE_STATUS_TOKEN && previous?.id===id && ['completed','failed','interrupted'].includes(previous.state) && previous.event==='Stop'
      && !['PreInvocation','SessionStart'].includes(event) && !(event==='Stop' && (p.fullyIdle===true || p.fully_idle===true))) process.exit(0);
    let state;
    if (event==='SessionStart') state='idle';
    else if (event==='Interrupt') state='interrupted';
    else if (event==='UserPromptSubmit' || event==='PreInvocation' || event==='PostInvocation' || event==='PostToolUse') state='working';
    else if (event==='PreToolUse') {
      const tool = agy ? p.toolCall?.name : p.tool_name;
      state = ['AskUserQuestion','request_user_input','ask_question','ask_user_question','ask_permission'].includes(tool) ? 'waiting' : 'working';
    } else if (event==='PermissionRequest') state='waiting';
    else if (event==='Notification' && ['permission_prompt','elicitation_dialog','agent_needs_input'].includes(p.notification_type)) state='waiting';
    else if (event==='StopFailure' && ['claude','codebuddy'].includes(provider)) state='failed';
    else if (event==='Stop') {
      if (agy) {
        const fullyIdle=p.fullyIdle ?? p.fully_idle, reason=String(p.terminationReason ?? p.termination_reason ?? '').toUpperCase();
        if (fullyIdle===false) state='working';
        else if (fullyIdle===true) state=reason==='ERROR' ? 'failed' : ['USER_CANCELLED','USER_CANCELED','USER_INTERRUPTED','CANCELLED','CANCELED','INTERRUPTED'].includes(reason) ? 'interrupted' : 'completed';
      } else state=p.is_interrupt===true ? 'interrupted' : 'completed';
    }
    if (!state) process.exit(0);
    const file = env.ADE_STATUS_FILE, temporary = file + '.' + process.pid + '.tmp';
    try {
      const tool = agy ? p.toolCall?.name : p.tool_name;
      const attention = state!=='waiting' ? undefined : event==='PermissionRequest' || p.notification_type==='permission_prompt' || tool==='ask_permission' ? 'approval'
        : ['AskUserQuestion','request_user_input','ask_question','ask_user_question'].includes(tool) || p.notification_type==='elicitation_dialog' ? 'question' : undefined;
      let args = agy ? p.toolCall?.arguments ?? p.toolCall?.args : p.tool_input;
      if(typeof args==='string' && args.length<=8192){try{args=JSON.parse(args);}catch{args=undefined;}}
      const summary = args?.command ?? args?.cmd ?? args?.CommandLine ?? args?.file_path ?? args?.path;
      const toolCall = ['PreToolUse','PermissionRequest'].includes(event) && typeof tool==='string' && typeof summary==='string' && summary.length<=1000
        ? {name:tool.slice(0,80),summary:summary.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,1000)} : undefined;
      fs.writeFileSync(temporary, JSON.stringify({ token:env.ADE_STATUS_TOKEN, provider,id,state,event,attention,toolCall,at:new Date().toISOString() }), {mode:0o600});
      fs.renameSync(temporary,file);
    } finally { try {fs.unlinkSync(temporary);} catch {} }
  } catch {}
  process.exit(0);
});
process.stdin.on('end',()=>process.exit(0)); process.stdin.on('error',()=>process.exit(0));
`;

export function statusFile(directory: string, id: string): string { return path.join(directory, 'status', id + '.json'); }

export function installStatusHooks(directory: string, provider: AdeProvider, node: string, configFile?: string): void {
  if (provider === 'terminal' || provider === 'dsh' || provider === 'opencode' || provider === 'opencode2' || provider === 'kilo') return;
  const script = path.join(directory, 'ade-status-hook.cjs');
  if (/["%\r\n]/.test(node + script)) throw new CliError('INVALID_ARGUMENT', 'Runtime path cannot be used for provider status hooks');
  fs.mkdirSync(path.join(directory, 'status'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, STATUS_HOOK_SCRIPT, { mode: 0o600 });
  const file = configFile ?? (provider === 'antigravity' ? path.join(os.homedir(), '.gemini', 'config', 'hooks.json')
    : provider === 'codebuddy' ? path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'settings.json')
    : provider === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')
    : path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'));
  let original = '{}', config: any;
  try {
    if (fs.existsSync(file)) { if (fs.statSync(file).size > 524288) throw new Error(); original = fs.readFileSync(file, 'utf8'); }
    config = JSON.parse(original); if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
  } catch { throw new CliError('INVALID_ARGUMENT', 'Provider hook configuration could not be read; existing settings were preserved'); }
  const hooks = provider === 'antigravity' ? {} as Record<string, unknown> : config.hooks ?? {};
  if (!hooks || Array.isArray(hooks) || typeof hooks !== 'object') throw new CliError('INVALID_ARGUMENT', 'Invalid provider hook configuration');
  for (const event of STATUS_EVENTS[provider]) {
    let command = `"${node}" "${script}" ${provider} ${event}`;
    const wrapper = path.join(directory, `ade-status-${provider}-${event}.cmd`);
    if (process.platform === 'win32') {
      fs.writeFileSync(wrapper, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${node}" "${script}" ${provider} ${event}\r\nexit /b 0\r\n`);
      command = /^[a-zA-Z]:[\\/][a-zA-Z0-9_./\\-]+$/.test(wrapper) ? wrapper.replaceAll('\\','/') : `"${wrapper}"`;
    }
    // The script bounds its own input wait; allow time for Windows shell/Node startup too.
    const handler = { type: 'command', command, timeout: 10 };
    const entry = provider === 'antigravity' && !['PreToolUse','PostToolUse'].includes(event) ? handler : { hooks: [handler] };
    const previous = hooks[event] ?? [];
    if (!Array.isArray(previous)) throw new CliError('INVALID_ARGUMENT', 'Invalid provider event configuration');
    const owned = (value: any) => typeof value?.command === 'string' && (value.command.includes('ade-status-hook.cjs') || value.command.includes(`ade-status-${provider}-`));
    const preserved = previous.flatMap((value: any) => {
      if (Array.isArray(value?.hooks)) { const kept = value.hooks.filter((hook: any) => !owned(hook)); return kept.length ? [{ ...value, hooks: kept }] : []; }
      return owned(value) ? [] : [value];
    });
    hooks[event] = [...preserved, entry];
  }
  if (provider === 'antigravity') config['ade-agent-status'] = hooks; else config.hooks = hooks;
  const updated = JSON.stringify(config, null, 2) + '\n';
  if (updated === original) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (original !== '{}' && !fs.existsSync(file + '.ade-status-backup')) fs.writeFileSync(file + '.ade-status-backup', original, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(file, updated, { mode: 0o600 });
}

export function readAgentStatus(directory: string, record: SessionRecord, live: boolean): Section<AgentStatus> {
  const now = new Date().toISOString();
  const missing: Section<AgentStatus> = { data: null, meta: { availability: 'unavailable', observedAt: null, attemptedAt: now, partial: false, stale: false,
    issue: { code: 'RUNTIME_UNAVAILABLE', message: live ? 'No verified provider status event yet. Resume a new ADE session and enable its status hooks if the provider requests trust.' : 'Terminal is stopped; no current agent status is available.', retryable: true } } };
  if (!record.statusToken || record.provider === 'terminal') return missing;
  try {
    const file = statusFile(directory, record.id); if (record.provider !== 'dsh' && fs.statSync(file).size > 4096) return missing;
    const event = record.provider === 'dsh' ? dshStatus(directory, record) : JSON.parse(fs.readFileSync(file, 'utf8'));
    if (event.token !== record.statusToken || event.provider !== record.provider || event.id !== record.providerThreadId || !STATUS_EVENTS[record.provider].includes(event.event as never)
      || !['working','waiting','idle','completed','failed','interrupted','unknown'].includes(event.state) || !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) > Date.now() + 5000) return missing;
    const toolCall = typeof event.toolCall?.name === 'string' && event.toolCall.name.length <= 80 && typeof event.toolCall?.summary === 'string' && event.toolCall.summary.length <= 1000 ? event.toolCall : undefined;
    return { data: { state: event.state, source: 'provider-hook', event: event.event, ...(toolCall ? { toolCall } : {}), ...(['question', 'approval', 'auth'].includes(event.attention) ? { attention: event.attention } : {}) }, meta: { availability: live ? 'ready' : 'unavailable', observedAt: event.at, attemptedAt: now, partial: false, stale: !live, issue: live ? null : missing.meta.issue } };
  } catch { return missing; }
}
