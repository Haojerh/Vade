import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppResources, ResourceDetails } from '../../shared/contracts.js';
import os from 'node:os';

export interface ProcessMemory { pid: number; parent: number; bytes: number; name?: string; commandLine?: string; startedAt?: string; privateBytes?: number; cpuSeconds?: number; cpuPercent?: number | null }
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
  private rows?: { at: number; value: ProcessMemory[] };
  private summaryRows?: { at: number; value: ProcessMemory[] };
  private summaryPending?: Promise<ProcessMemory[]>;
  private cpu = new Map<number, { at: number; seconds: number; startedAt?: string }>();
  async snapshot(force = false, detailed = true): Promise<ProcessMemory[]> {
    if (!force && this.rows && Date.now() - this.rows.at < 5000) return this.rows.value;
    if (!detailed) {
      if (!force && this.summaryRows && Date.now() - this.summaryRows.at < 5000) return this.summaryRows.value;
      if (!this.summaryPending) this.summaryPending = this.collect(false).then(value => { this.summaryRows = { at: Date.now(), value }; return value; }).finally(() => { this.summaryPending = undefined; });
      return this.summaryPending;
    }
    if (!this.pending) this.pending = this.collect().then(value => { this.rows = { at: Date.now(), value }; return value; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async details(groups: { id: string; label: string; roots: number[] }[], desktop: { pids?: number[] } | null): Promise<ResourceDetails> {
    const rows = await this.snapshot(), assigned = new Set<number>();
    const children = new Map<number, ProcessMemory[]>();
    for (const row of rows) { const group = children.get(row.parent) ?? []; group.push(row); children.set(row.parent, group); }
    const descendants = (roots: number[]) => {
      const ids = new Set(roots), pending = [...roots];
      for (let index = 0; index < pending.length; index++) for (const row of children.get(pending[index]) ?? []) if (!ids.has(row.pid)) { ids.add(row.pid); pending.push(row.pid); }
      return rows.filter(row => ids.has(row.pid) && !assigned.has(row.pid));
    };
    const result = [...groups, { id: 'vade', label: 'Vade', roots: [process.pid, ...desktop?.pids ?? []] }].map(group => {
      const processes = descendants(group.roots).map(row => { assigned.add(row.pid); return { pid: row.pid, parent: row.parent, name: row.name ?? 'Process', memoryBytes: row.bytes, privateBytes: row.privateBytes ?? null, cpuPercent: row.cpuPercent ?? null }; });
      return { id: group.id, label: group.label, processes };
    }).filter(group => group.processes.length);
    return { observedAt: new Date().toISOString(), groups: result, totalBytes: result.reduce((sum, group) => sum + group.processes.reduce((sum, row) => sum + row.memoryBytes, 0), 0) };
  }
  async read(roots: number[], desktop: { bytes: number; at: number; pids?: number[] } | null): Promise<AppResources> {
    const liveDesktop = desktop && Date.now() - desktop.at < 15000 ? desktop : null;
    const allRoots = [...new Set([process.pid, ...roots, ...liveDesktop?.pids ?? []])].sort((a, b) => a - b), key = allRoots.join(':');
    if (this.cached?.key === key && Date.now() - this.cached.at < 5000) return this.cached.value;
    try {
      const rows = await this.snapshot(false, false);
      if (!rows.some(row => row.pid === process.pid)) throw new Error('Backend missing from process snapshot');
      const memory = processTreeMemory(rows, allRoots);
      const value: AppResources = { ...memory, scope: liveDesktop?.pids?.length ? 'desktop-tree' : 'backend-tree', observedAt: new Date().toISOString() };
      this.cached = { key, at: Date.now(), value }; return value;
    } catch {
      return { memoryBytes: liveDesktop?.bytes ?? process.memoryUsage().rss, scope: liveDesktop ? 'desktop-app' : 'backend', observedAt: new Date().toISOString() };
    }
  }
  private async collect(detailed = true): Promise<ProcessMemory[]> {
    const windows = process.platform === 'win32';
    const columns = '@{n="pid";e={$_.ProcessId}},@{n="parent";e={$_.ParentProcessId}},@{n="bytes";e={[double]$_.WorkingSetSize}}';
    const details = ',@{n="name";e={$_.Name}},@{n="commandLine";e={if($_.CommandLine){$_.CommandLine.Substring(0,[Math]::Min(1024,$_.CommandLine.Length))}}},@{n="startedAt";e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}},@{n="privateBytes";e={[double]$_.PrivatePageCount}},@{n="cpuSeconds";e={([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000}}';
    const command = promisify(execFile)(windows ? 'powershell.exe' : 'ps', windows
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Select-Object ${columns}${detailed ? details : ''} | ConvertTo-Json -Compress`]
      : ['-axo', detailed ? 'pid=,ppid=,rss=,comm=,args=' : 'pid=,ppid=,rss='], { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    const samplerPid = command.child.pid;
    const { stdout } = await command;
    const rows: ProcessMemory[] = windows ? JSON.parse(stdout) : stdout.trim().split('\n').map(line => {
      const fields = (detailed ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/ : /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/).exec(line);
      if (!fields) throw new Error('Invalid process row');
      return { pid: Number(fields[1]), parent: Number(fields[2]), bytes: Number(fields[3]) * 1024, ...(detailed ? { name: fields[4].split('/').at(-1), commandLine: fields[5].slice(0, 1024) } : {}) };
    });
    if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !Number.isInteger(row.pid) || !Number.isInteger(row.parent) || !Number.isFinite(row.bytes) || row.bytes < 0)) throw new Error('Invalid process snapshot');
    const now = Date.now(), next = new Map<number, { at: number; seconds: number; startedAt?: string }>();
    for (const row of rows) if (typeof row.cpuSeconds === 'number' && Number.isFinite(row.cpuSeconds)) {
      const previous = this.cpu.get(row.pid);
      row.cpuPercent = previous && previous.startedAt === row.startedAt && now > previous.at ? Math.max(0, Math.min(100, (row.cpuSeconds - previous.seconds) * 100000 / (now - previous.at) / Math.max(1, os.cpus().length))) : null;
      next.set(row.pid, { at: now, seconds: row.cpuSeconds, startedAt: row.startedAt });
    }
    if (detailed) this.cpu = next;
    return rows.filter(row => row.pid !== samplerPid);
  }
}
