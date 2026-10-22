import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppResources } from '../../shared/contracts.js';

export interface ProcessMemory { pid: number; parent: number; bytes: number }
export function processTreeMemory(rows: ProcessMemory[], roots: number[]) {
  const selected = new Set(roots), byParent = new Map<number, ProcessMemory[]>();
  for (const row of rows) { const group = byParent.get(row.parent) ?? []; group.push(row); byParent.set(row.parent, group); }
  const pending = [...selected];
  for (let index = 0; index < pending.length; index++) for (const child of byParent.get(pending[index]) ?? []) {
    if (!selected.has(child.pid)) { selected.add(child.pid); pending.push(child.pid); }
  }
  const found = rows.filter(row => selected.has(row.pid));
  return { memoryBytes: found.reduce((sum, row) => sum + row.bytes, 0), processCount: found.length };
}

export class ResourceReader {
  private cached?: { key: string; at: number; value: AppResources };
  private pending?: Promise<ProcessMemory[]>;
  async read(roots: number[], desktop: { bytes: number; at: number; pids?: number[] } | null): Promise<AppResources> {
    const liveDesktop = desktop && Date.now() - desktop.at < 15000 ? desktop : null;
    const allRoots = [...new Set([process.pid, ...roots, ...liveDesktop?.pids ?? []])].sort((a, b) => a - b), key = allRoots.join(':');
    if (this.cached?.key === key && Date.now() - this.cached.at < 5000) return this.cached.value;
    try {
      if (!this.pending) this.pending = this.collect().finally(() => { this.pending = undefined; });
      const rows = await this.pending;
      if (!rows.some(row => row.pid === process.pid)) throw new Error('Backend missing from process snapshot');
      const memory = processTreeMemory(rows, allRoots);
      const value: AppResources = { ...memory, scope: liveDesktop?.pids?.length ? 'desktop-tree' : 'backend-tree', observedAt: new Date().toISOString() };
      this.cached = { key, at: Date.now(), value }; return value;
    } catch {
      return { memoryBytes: liveDesktop?.bytes ?? process.memoryUsage().rss, scope: liveDesktop ? 'desktop-app' : 'backend', observedAt: new Date().toISOString() };
    }
  }
  private async collect(): Promise<ProcessMemory[]> {
    const windows = process.platform === 'win32';
    const command = promisify(execFile)(windows ? 'powershell.exe' : 'ps', windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="parent";e={$_.ParentProcessId}},@{n="bytes";e={[double]$_.WorkingSetSize}} | ConvertTo-Json -Compress']
      : ['-axo', 'pid=,ppid=,rss='], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const samplerPid = command.child.pid;
    const { stdout } = await command;
    const rows: ProcessMemory[] = windows ? JSON.parse(stdout) : stdout.trim().split('\n').map(line => {
      const [pid, parent, rss] = line.trim().split(/\s+/).map(Number); return { pid, parent, bytes: rss * 1024 };
    });
    if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !Number.isInteger(row.pid) || !Number.isInteger(row.parent) || !Number.isFinite(row.bytes) || row.bytes < 0)) throw new Error('Invalid process snapshot');
    return rows.filter(row => row.pid !== samplerPid);
  }
}
