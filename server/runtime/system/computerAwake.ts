import { spawn, type ChildProcess } from 'node:child_process';
import type { ComputerAwakeStatus } from '../../../shared/contracts.js';
import type { AdeStore } from '../store.js';
import { CliError } from '../../integrations/cli.js';

export class ComputerAwake {
  private mode: ComputerAwakeStatus['mode'] = 'off';
  private child?: ChildProcess;
  private active = false;
  private error: string | null = null;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private store: AdeStore, private working: () => boolean) {
    const saved = store.db.prepare("SELECT value FROM preferences WHERE key = 'computer-awake'").get()?.value;
    if (saved === 'on' || saved === 'agent') this.mode = saved;
    this.timer = setInterval(() => this.update(), 2000); this.timer.unref(); this.update();
  }
  status(): ComputerAwakeStatus { return { mode: this.mode, active: this.active, error: this.error }; }
  set(mode: unknown): ComputerAwakeStatus {
    if (mode !== 'on' && mode !== 'off' && mode !== 'agent') throw new CliError('INVALID_ARGUMENT', 'Choose On, Agent or Off');
    this.mode = mode; this.error = null;
    this.store.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('computer-awake', ?)").run(mode);
    this.update(); return this.status();
  }
  private update(): void {
    if (this.closed) return;
    const wanted = this.mode === 'on' || (this.mode === 'agent' && this.working());
    if (!wanted) { const child = this.child; this.child = undefined; this.active = false; child?.kill(); return; }
    if (this.child || this.error) return;
    // A thread-scoped Windows power request disappears when this owned helper exits.
    const script = `$owner = Get-Process -Id ${process.pid} -ErrorAction Stop; $ownerStart = $owner.StartTime.ToUniversalTime().Ticks; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class VadePower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; if ([VadePower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }; [Console]::WriteLine('AWAKE'); while ($true) { Start-Sleep -Seconds 2; $current = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if (!$current -or $current.StartTime.ToUniversalTime().Ticks -ne $ownerStart) { break } }`;
    const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? '/usr/bin/caffeinate' : 'systemd-inhibit';
    const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
      : process.platform === 'darwin' ? ['-i', '-w', String(process.pid)] : ['--what=sleep', '--mode=block', '--who=Vade', '--why=Keep computer awake', 'sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done', 'vade-awake', String(process.pid)];
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.child = child;
    child.stdout?.on('data', data => { if (this.child === child && String(data).includes('AWAKE')) this.active = true; });
    child.stderr?.on('data', () => {});
    if (process.platform !== 'win32') child.once('spawn', () => { if (this.child === child) this.active = true; });
    const failed = () => { if (this.child === child) { this.child = undefined; this.active = false; this.error = 'The native sleep blocker could not start. Choose a mode again to retry.'; } };
    child.once('error', failed); child.once('exit', failed);
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.child?.kill(); this.child = undefined; this.active = false; }
}
