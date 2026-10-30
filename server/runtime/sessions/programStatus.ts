import type { AdeProvider, AgentStatus } from '../../../shared/contracts.js';

// OSC 7501 is a structured provider report, not a title/spinner/text heuristic.
// Observed on Codex 0.163.0; child records and other applications cannot set its root status.
export function programStatusReader(onStatus: (status: AgentStatus) => void, onQuery: () => void, provider: AdeProvider = 'codex'): (chunk: string) => void {
  if (provider === 'dsh') return () => {}; // DSH Session events own outcomes; child CLIs cannot report for it.
  const prefix = '\x1b]7501;';
  let pending = '';
  return chunk => {
    let data = pending + chunk;
    pending = '';
    while (data.length) {
      const start = data.indexOf(prefix);
      if (start < 0) {
        for (let n = Math.min(prefix.length - 1, data.length); n > 0; n--) if (prefix.startsWith(data.slice(-n))) { pending = data.slice(-n); break; }
        return;
      }
      data = data.slice(start + prefix.length);
      const end = /\x07|\x1b\\/.exec(data);
      if (!end) { if (data.length <= 4096) pending = prefix + data; return; }
      const restart = data.indexOf(prefix);
      if (restart >= 0 && restart < end.index) { data = data.slice(restart); continue; }
      const body = data.slice(0, end.index);
      data = data.slice(end.index + end[0].length);
      if (body.length > 4096 || /[\x00-\x1f\x7f]/.test(body)) continue;
      if (body === '?') { onQuery(); continue; }
      const fields = new Map<string, string>();
      let invalid = false;
      for (const field of body.split(':')) {
        const match = /^([a-z]+)=([A-Za-z0-9_.,+/=-]*)$/.exec(field);
        if (!match || fields.has(match[1])) { invalid = true; break; }
        fields.set(match[1], match[2]);
      }
      if (invalid || fields.get('app') !== (provider === 'claude' ? 'claude-code' : 'codex') || fields.get('id')) continue;
      const state = fields.get('state');
      const mapped = state === 'working' ? 'working' : state === 'idle' ? 'idle' : state === 'done' ? 'completed' : state === 'error' ? 'failed'
        : state === 'blocked' ? ['permission', 'question', 'auth'].includes(fields.get('kind') ?? '') ? 'waiting' : 'blocked' : null;
      if (mapped) onStatus({ state: mapped, source: 'provider-terminal', event: `OSC7501:${state}`,
        ...(mapped === 'waiting' ? { attention: fields.get('kind') === 'permission' ? 'approval' as const : fields.get('kind') === 'auth' ? 'auth' as const : 'question' as const } : {}) });
    }
  };
}

// A completed turn means the provider returned to idle after reporting activity, not task success.
// Only an observed idle after an Escape during working confirms an interruption; input alone does not.
export function isInterruptionInput(data: string): boolean {
  return /^(?:\x1b){1,2}$/.test(data) || data === '\x03' || /^\x1b\[27(?:;1(?::[12])?)?u$/.test(data);
}
export class TerminalTurnStatus {
  private active = false;
  private outcome: AgentStatus | undefined;
  private interruptAt = 0;
  private working = false;
  private confirmation = '';

  input(data: string, now = Date.now(), working = this.working): void {
    if (/^(?:\x1b\[[IO]|\x1b\[<(?:\d+;){2}\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+(?:;\d+)*:3u)+$/.test(data)) return;
    if (working && isInterruptionInput(data)) { this.interruptAt = now; this.confirmation = ''; }
    else if (data !== '\x1b') this.interruptAt = 0;
  }

  confirm(chunk: string, provider: AdeProvider, now = Date.now()): AgentStatus | null {
    if (!this.interruptAt || now - this.interruptAt > 5000 || !['antigravity', 'claude', 'codebuddy'].includes(provider)) return null;
    this.confirmation = (this.confirmation + chunk).slice(-4096);
    const text = this.confirmation.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
    const names = provider === 'antigravity' ? ['Antigravity CLI'] : ['Claude', 'Claude Code'];
    const confirmed = provider === 'codebuddy' ? /(?:^|\n)\s*(?:[●•]\s*)?Interrupted by user\s*(?:\n|$)/.test(text)
      : names.some(name => text.includes(`Interrupted · What should ${name} do instead?`));
    if (!confirmed) return null;
    this.confirmation = '';
    return this.observe({ state: 'interrupted', source: 'provider-terminal', event: 'native-interrupt-confirmation' }, now);
  }

  observe(status: AgentStatus, now = Date.now()): AgentStatus {
    if (status.state === 'working' || status.state === 'waiting' || status.state === 'blocked') {
      this.active = true; this.working = status.state === 'working'; this.outcome = undefined;
      return status;
    }
    this.working = false;
    if (this.outcome && !this.active && ['completed','failed','interrupted'].includes(status.state)) return this.outcome;
    if (status.state === 'idle') {
      if (this.outcome) return this.outcome;
      if (!this.active) return status;
      status = { ...status, state: this.interruptAt && now >= this.interruptAt && now - this.interruptAt <= 5000 ? 'interrupted' : 'completed' };
    }
    if (status.state === 'completed' && this.interruptAt && now >= this.interruptAt && now - this.interruptAt <= 5000) status = { ...status, state: 'interrupted' };
    if (['completed', 'failed', 'interrupted'].includes(status.state)) {
      this.active = false; this.interruptAt = 0; this.outcome = status;
    }
    return status;
  }

  nativeEnd(status: AgentStatus, now = Date.now(), interruptionWindow = 5000): AgentStatus {
    if (this.outcome && !this.active) return this.outcome;
    return this.observe((status.state === 'completed' || status.event === 'SessionAborted') && this.interruptAt && now >= this.interruptAt && now - this.interruptAt <= interruptionWindow
      ? { ...status, state: 'interrupted' } : status, now);
  }
}

export const PROGRAM_STATUS_REPLY = '\x1b]7501;?:states=idle,working,blocked,done,error:kinds=permission,question,auth\x1b\\';

// Antigravity initializes its conversation hooks lazily. Its native composer footer
// establishes prompt readiness before the first hook, without inventing an agent state.
export function antigravityPromptReady(output: string): boolean {
  const text = output.slice(-32768).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
  const ready = text.lastIndexOf('? for shortcuts');
  return ready >= 0 && ready > text.lastIndexOf('esc to cancel');
}
