import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import type { WorkspacePorts } from '../../shared/contracts.js';
import type { AdeSessions } from './sessions.js';
import type { AdeStore } from './store.js';
import type { ResourceReader } from './resources.js';
import { CliError } from '../integrations/cli.js';

export class Ports {
  private cached?: { at: number; data: WorkspacePorts };
  private pending?: Promise<WorkspacePorts>;
  private identities = new Map<string, string>();
  constructor(private store: AdeStore, private sessions: AdeSessions, private resources: ResourceReader) {}
  read(force = false): Promise<WorkspacePorts> {
    if (this.pending) return this.pending;
    if (!force && this.cached && Date.now() - this.cached.at < 5000) return Promise.resolve(this.cached.data);
    this.pending = this.collect(force).then(data => { this.cached = { at: Date.now(), data }; return data; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async collect(force: boolean): Promise<WorkspacePorts> {
    try {
      const win = process.platform === 'win32';
      const [processes, result] = await Promise.all([this.resources.snapshot(force), promisify(execFile)(win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'netstat.exe') : 'lsof', win
        ? ['-ano', '-p', 'tcp']
        : ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })]);
      let listeners: { port: number; address: string; pid: number }[] = [];
      if (win) {
        for (const line of result.stdout.split('\n')) {
          const fields = line.trim().split(/\s+/);
          if (fields[0] !== 'TCP' || fields[3]?.toUpperCase() !== 'LISTENING') continue;
          const local = fields[1].match(/^(.*):(\d+)$/);
          if (local) listeners.push({ port: Number(local[2]), address: local[1].replace(/^\[|\]$/g, ''), pid: Number(fields[4]) });
        }
      }
      else {
        let pid = 0;
        for (const line of result.stdout.split('\n')) {
          if (line[0] === 'p') pid = Number(line.slice(1));
          if (line[0] === 'n') { const match = line.slice(1).match(/^(.*):(\d+)$/); if (match) listeners.push({ pid, address: match[1], port: Number(match[2]) }); }
        }
      }
      const byPid = new Map(processes.map(row => [row.pid, row])), groups = this.sessions.processGroups(), projects = this.store.projects();
      const identities = new Map<string, string>();
      const ports = listeners.slice(0, 2000).flatMap(row => {
        if (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || !Number.isInteger(row.pid) || row.pid < 1) return [];
        let ancestor = row.pid, group: typeof groups[number] | undefined;
        for (let depth = 0; ancestor && depth < 128; depth++) { group = groups.find(group => group.roots.includes(ancestor)); if (group) break; const parent = byPid.get(ancestor)?.parent ?? 0; if (parent === ancestor) break; ancestor = parent; }
        const processRow = byPid.get(row.pid), project = projects.find(project => project.id === group?.projectId);
        const id = crypto.createHash('sha256').update(`${row.pid}:${processRow?.startedAt ?? ''}:${row.port}:${row.address}`).digest('hex').slice(0, 40);
        if (typeof processRow?.startedAt === 'string') identities.set(id, processRow.startedAt);
        return [{ id, port: row.port, address: String(row.address).slice(0, 128), pid: row.pid, process: processRow?.name ?? 'Process', projectId: project?.id ?? null, project: project?.name ?? null, canKill: Boolean(project && processRow?.startedAt && row.pid !== process.pid && row.port !== 4317) }];
      });
      this.identities = identities;
      ports.sort((a, b) => Number(!a.projectId) - Number(!b.projectId) || a.port - b.port);
      return { observedAt: new Date().toISOString(), ports: [...new Map(ports.map(row => [`${row.pid}:${row.port}`, row])).values()], error: null };
    } catch { return { observedAt: new Date().toISOString(), ports: [], error: 'Listening ports could not be read on this host. Re-open Ports to retry.' }; }
  }
  async stop(id: string): Promise<{ ok: true }> {
    if (!/^[a-f0-9]{40}$/.test(id)) throw new CliError('INVALID_ARGUMENT', 'Invalid observed port');
    const observed = this.cached?.data.ports.find(row => row.id === id);
    if (!observed?.canKill) throw new CliError('INVALID_ARGUMENT', 'Only a verified workspace-owned process can be stopped.');
    const current = (await this.read(true)).ports.find(row => row.id === id);
    if (!current?.canKill || current.pid !== observed.pid) throw new CliError('INVALID_ARGUMENT', 'The listener changed. Refresh Ports before stopping it.');
    const identity = this.identities.get(id);
    if (process.platform === 'win32') {
      if (!identity || !/^\d{1,20}$/.test(identity)) throw new CliError('INVALID_ARGUMENT', 'Process identity is unavailable. Refresh Ports.');
      // GetProcessById opens the process before checking its start time; Kill uses that same handle.
      // CIM creation timestamps can round to microseconds, so allow less than one millisecond.
      const script = `$p = [System.Diagnostics.Process]::GetProcessById(${current.pid}); if ([Math]::Abs($p.StartTime.ToUniversalTime().Ticks - [long]${identity}) -ge 10000) { throw 'Process changed' }; $p.Kill()`;
      await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    } else process.kill(current.pid, 'SIGTERM');
    this.cached = undefined; return { ok: true };
  }
}
