import { spawn } from 'node:child_process';
import path from 'node:path';
import { CliError } from '../integrations/cli.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validCodexThreadId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

// Fixed local methods only. Never start a turn or expose provider RPC to HTTP clients.
export async function codexThread(resolved: { executable: string; args: string[] }, cwd: string, title: string, threadId?: string, signal?: AbortSignal, sourceCwd = cwd): Promise<string> {
  return codexRequest(resolved, cwd, async call => {
    if (threadId !== undefined && !validCodexThreadId(threadId)) throw new CliError('CLI_FAILED', 'Codex session binding failed. Check your Codex installation and configuration.');
    const response = threadId ? await call('thread/read', { threadId, includeTurns: false }) : await call('thread/start', { cwd });
    const thread = response?.thread;
    if (!validCodexThreadId(thread?.id) || (threadId && thread.id !== threadId) || thread.ephemeral !== false || typeof thread.cwd !== 'string' || ![cwd, sourceCwd].some(root => path.resolve(thread.cwd) === path.resolve(root))) throw new CliError('CLI_FAILED', 'Codex session binding failed');
    if (!threadId) await call('thread/name/set', { threadId: thread.id, name: title });
    return thread.id;
  }, signal);
}

// Internal callers supply fixed methods; this transport is never exposed as an API.
export async function codexRequest<T>(resolved: { executable: string; args: string[] }, cwd: string, operation: (call: (method: string, params: object) => Promise<any>) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new CliError('RUNTIME_UNAVAILABLE', 'ADE is shutting down');
  const env = { ...process.env }; delete env.CODEX_THREAD_ID;
  for (const key of Object.keys(env)) if (key.startsWith('ORCA_')) delete env[key];
  const child = spawn(resolved.executable, [...resolved.args, 'app-server', '--listen', 'stdio://'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let sequence = 0, buffer = '', bytes = 0, failed = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const failure = () => new CliError('CLI_FAILED', 'Codex session binding failed. Check your Codex installation and configuration.');
  const fail = () => { failed = true; for (const entry of pending.values()) entry.reject(failure()); pending.clear(); };
  const exited = new Promise<void>(resolve => { child.once('exit', code => { if (code !== 0 || pending.size) fail(); resolve(); }); child.once('error', () => { fail(); resolve(); }); });
  const abort = () => { fail(); child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { fail(); child.kill(); return; }
    buffer += chunk.toString('utf8');
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const entry = pending.get(message.id);
        if (entry) { pending.delete(message.id); if (message.error) entry.reject(failure()); else entry.resolve(message.result); }
        // No turns are submitted, so any server request is unexpected. Do not approve it.
        else if (message.method && message.id !== undefined) { fail(); child.kill(); }
      } catch { fail(); child.kill(); }
    }
  });
  child.stdout.setEncoding('utf8');
  child.stdin.on('error', fail);
  const send = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
  const call = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    if (failed) { reject(failure()); return; }
    const id = sequence++; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  const timer = setTimeout(() => { fail(); child.kill(); }, 20000);
  try {
    await call('initialize', { clientInfo: { name: 'ade', title: 'ADE', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    const result = await operation(call);
    child.stdin.end();
    await exited;
    if (failed) throw failure();
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); child.kill(); await exited; }
}
