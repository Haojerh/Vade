import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import type { AdeProvider } from '../../../shared/contracts.js';
import type { SessionRecord } from '../../runtime/store.js';
import { CliError } from '../../integrations/cli.js';
import { isPathInsideRoots } from '../common/transcriptUtils.js';
import { nativeModelContextWindow } from '../common/providerContext.js';

export const isOpenCode = (provider: string): provider is 'opencode' | 'opencode2' | 'kilo' => provider === 'opencode' || provider === 'opencode2' || provider === 'kilo';
export function validProviderSessionId(provider: AdeProvider, id: unknown): id is string {
  if (provider === 'dsh') return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id);
  return typeof id === 'string' && (isOpenCode(provider) ? /^ses_[a-zA-Z0-9]{1,100}$/.test(id) : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
}
export function openCodeFile(provider: 'opencode' | 'opencode2' | 'kilo'): string {
  const name = provider === 'kilo' ? 'kilo' : 'opencode';
  const selected = name === 'opencode' ? process.env.OPENCODE_DB : process.env.KILO_DB;
  return selected && path.isAbsolute(selected) ? selected : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), name, `${name}.db`);
}
export function withOpenCode<T>(provider: 'opencode' | 'opencode2' | 'kilo', read: (db: DatabaseSync) => T): T {
  const file = openCodeFile(provider);
  if (!isPathInsideRoots(file, [path.dirname(file)])) throw new Error('Provider database is unavailable');
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout=100'); return read(db); } finally { db.close(); }
}
export function verifyOpenCode(record: SessionRecord): string {
  if (!isOpenCode(record.provider) || !validProviderSessionId(record.provider, record.providerThreadId)) throw new Error('No exact provider session');
  const directory = withOpenCode(record.provider, db => {
    const table = record.provider === 'opencode2' ? 'session_v2' : 'session';
    return db.prepare(`SELECT directory FROM ${table} WHERE id = ? AND parent_id IS NULL`).get(record.providerThreadId!)?.directory;
  });
  if (typeof directory !== 'string' || ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(directory)) === '')) throw new Error('Provider session workspace does not match');
  return openCodeFile(record.provider);
}

export async function openCodeMajor(resolved: { executable: string; args: string[] }): Promise<1 | 2> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, [...resolved.args, '--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (major?: 1 | 2) => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill();
      if (major) resolve(major); else reject(new CliError('RUNTIME_UNAVAILABLE', 'The OpenCode CLI version could not be verified. Install a supported 1.x or 2.x CLI.'));
    };
    const timer = setTimeout(() => finish(), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 1024) finish(); });
    child.once('error', () => finish());
    child.once('exit', code => { const match = /^(?:opencode2?\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(output.trim()); finish(code === 0 && match ? Number(match[1]) as 1 | 2 : undefined); });
  });
}

// Create an empty native session through its authenticated loopback API, then
// open the TUI with that exact ID. Never bind by newest session or terminal title.
export async function createOpenCodeSession(resolved: { executable: string; args: string[] }, cwd: string, title: string, signal: AbortSignal, major: 1 | 2 = 1): Promise<string> {
  return withOpenCodeServer(resolved, cwd, signal, major, async request => {
    const response = await request(major === 2 ? '/api/session' : '/session', major === 2 ? { title, location: { directory: cwd } } : { title });
    const session = major === 2 ? response?.data : response, directory = major === 2 ? session?.location?.directory : session?.directory;
    if (!validProviderSessionId('opencode', session?.id) || typeof directory !== 'string' || path.relative(path.resolve(cwd), path.resolve(directory)) !== '' || session.parentID) throw new Error('Invalid native session binding');
    return session.id;
  });
}

export async function openCodeV2Models(resolved: { executable: string; args: string[] }, cwd: string): Promise<import('../../../shared/contracts.js').AgentChatModel[]> {
  return withOpenCodeServer(resolved, cwd, AbortSignal.timeout(30000), 2, async request => {
    const response = await request('/api/model?' + new URLSearchParams({ 'location[directory]': cwd }), undefined, 4 * 1024 * 1024);
    if (!Array.isArray(response?.data)) throw new Error('Invalid native model catalog');
    return response.data.slice(0, 2000).flatMap((model: any) => {
      if (model?.status === 'deprecated' || model?.enabled === false || typeof model?.providerID !== 'string' || typeof model.id !== 'string' || typeof model.name !== 'string') return [];
      const id = model.providerID + '/' + model.id;
      if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/@+-]{1,200}$/.test(id)) return [];
      const variants: string[] = Array.isArray(model.variants) ? model.variants.slice(0,32).flatMap((variant: any) => typeof variant?.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(variant.id) ? [variant.id] : []) : [];
      const contextWindow = nativeModelContextWindow(model);
      return [{ id, label: model.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0,160), description: model.providerID.slice(0,160), ...(contextWindow ? { contextWindow } : {}), efforts: variants.length ? ['default', ...variants.filter(value => value !== 'default')].map(value => ({ value, label: value === 'default' ? 'Default' : value })) : [] }];
    }).slice(0,500);
  });
}

async function withOpenCodeServer<T>(resolved: { executable: string; args: string[] }, cwd: string, signal: AbortSignal, major: 1 | 2, read: (request: (route: string, body?: unknown, limit?: number) => Promise<any>) => Promise<T>): Promise<T> {
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address() as net.AddressInfo; server.close(() => resolve(address.port)); }); });
  const password = crypto.randomBytes(32).toString('hex');
  const username = major === 2 ? 'opencode' : 'ade';
  const env = { ...process.env, OPENCODE_SERVER_USERNAME: username, KILO_SERVER_USERNAME: username, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password, KILO_SERVER_PASSWORD: password };
  for (const key of Object.keys(env)) if (key.startsWith('ADE_STATUS_') || key.startsWith('ORCA_')) delete (env as NodeJS.ProcessEnv)[key];
  const child = spawn(resolved.executable, [...resolved.args, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd, windowsHide: true, stdio: 'ignore', env,
  });
  let exited = false;
  const stopped = new Promise<void>(resolve => {
    child.once('error', () => { exited = true; resolve(); });
    child.once('exit', () => { exited = true; resolve(); });
  });
  const cancel = () => child.kill(); signal.addEventListener('abort', cancel, { once: true });
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !signal.aborted && !exited) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${major === 2 ? '/api/info' : '/global/health'}`, { redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* Wait only for this owned server to become ready. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (signal.aborted || exited || Date.now() >= deadline) throw new Error('Provider server did not become ready');
    return await read(async (route, body, limit = 65536) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'error', method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.ok || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Native request failed'); }
      const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > limit) throw new Error('Native response too large'); chunks.push(part.value); } } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    });
  } catch { throw new CliError('CLI_FAILED', 'The native provider API could not be read. Check its CLI installation and retry.'); }
  finally {
    signal.removeEventListener('abort', cancel); child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([stopped, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); }
    if (!exited) { child.kill('SIGKILL'); throw new CliError('CLI_FAILED', 'The temporary provider server did not stop. The terminal was not started.'); }
  }
}

// Native status plugins are fenced to the owned launch environment.
// Only the exact root session can publish status with the current launch token.
export function openCodePlugin(directory: string): string {
  const file = path.join(directory, 'ade-opencode-status.mjs');
  fs.writeFileSync(file, OPEN_CODE_PLUGIN, { mode: 0o600 });
  return pathToFileURL(file).href;
}
/** Native v2 ignores the legacy inline plugin list. A managed drop-in is
 * inert outside a launch carrying our exact session, cwd and token. */
export function installOpenCodePlugin(provider: 'opencode' | 'opencode2' | 'kilo', env: NodeJS.ProcessEnv): void {
  const name = provider === 'kilo' ? 'kilo' : 'opencode';
  const configured = env[provider === 'kilo' ? 'KILO_CONFIG_DIR' : 'OPENCODE_CONFIG_DIR'];
  const root = configured || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
  if (!path.isAbsolute(root)) throw new CliError('INVALID_ARGUMENT', 'Provider configuration directory must be absolute');
  const plugins = path.join(root, 'plugins'), file = path.join(plugins, 'vade-agent-status.js');
  const marker = '// Vade managed native status plugin\n';
  for (const candidate of [root, plugins, file]) {
    try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new CliError('INVALID_ARGUMENT', 'Provider status plugin cannot follow a symbolic link'); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  if (fs.existsSync(file) && (!fs.statSync(file).isFile() || fs.statSync(file).size > 65536 || !fs.readFileSync(file, 'utf8').startsWith(marker))) throw new CliError('INVALID_ARGUMENT', 'An unrelated provider plugin occupies the Vade status filename');
  fs.mkdirSync(plugins, { recursive: true, mode: 0o700 });
  const source = marker + OPEN_CODE_PLUGIN;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source, { mode: 0o600 });
}
const OPEN_CODE_PLUGIN = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const factory = async (context) => {
  const env = process.env; let active = false, outcome = false;
  const normalize = value => { const result=path.resolve(value); return process.platform==='win32' ? result.toLowerCase() : result; };
  const roots = [env.ADE_STATUS_CWD, env.ADE_STATUS_SOURCE_CWD].filter(value => typeof value === 'string' && path.isAbsolute(value));
  if (typeof context?.directory !== 'string' || !env.ADE_STATUS_CWD || !roots.some(root => normalize(context.directory) === normalize(root))) return {};
  const publish = (state, event, attention) => {
    if (!env.ADE_STATUS_FILE || !env.ADE_STATUS_TOKEN || !env.ADE_STATUS_SESSION) return;
    const temporary = env.ADE_STATUS_FILE + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify({ token: env.ADE_STATUS_TOKEN, provider: env.ADE_STATUS_PROVIDER, id: env.ADE_STATUS_SESSION, state, event, attention, at: new Date().toISOString() }), {mode:0o600}); fs.renameSync(temporary, env.ADE_STATUS_FILE); } catch {} finally {try{fs.unlinkSync(temporary)}catch{}}
  };
  let initialized = false;
  try { const stat=fs.statSync(env.ADE_STATUS_FILE); initialized=stat.size<=4096 && JSON.parse(fs.readFileSync(env.ADE_STATUS_FILE,'utf8')).token===env.ADE_STATUS_TOKEN; } catch {}
  if (!initialized) publish('idle', 'SessionStart');
  return { event: async ({event}) => {
    let p = event?.properties;
    if (event?.type === 'form.created') p = p?.form;
    const id = p?.sessionID ?? p?.info?.sessionID;
    if (id !== env.ADE_STATUS_SESSION) return;
    if (event.type === 'session.execution.started' || event.type === 'session.status' && ['busy','retry'].includes(p.status?.type)) { active=true; outcome=false; publish('working','UserPromptSubmit'); }
    else if (['permission.asked','permission.v2.asked','question.asked','question.v2.asked','form.created'].includes(event.type)) { active=true; publish('waiting', 'PermissionRequest', event.type.startsWith('permission.') ? 'approval' : 'question'); }
    else if (['permission.replied','permission.v2.replied','question.replied','question.rejected','question.v2.replied','question.v2.rejected','form.replied','form.cancelled'].includes(event.type) && active) publish('working', 'PostToolUse');
    else if (event.type === 'session.execution.failed' && active) { outcome=true; active=false; publish('failed','SessionError'); }
    else if (event.type === 'session.execution.interrupted' && active) { outcome=true; active=false; publish(p.reason === 'user' ? 'interrupted' : 'unknown','Stop'); }
    else if (event.type === 'session.error' && active) { outcome=true; active=false; publish(p.error?.name === 'MessageAbortedError' ? 'interrupted' : 'failed', p.error?.name === 'MessageAbortedError' ? 'SessionAborted' : 'SessionError'); }
    else if ((event.type === 'session.execution.succeeded' || event.type === 'session.idle' || event.type === 'session.status' && p.status?.type === 'idle') && active && !outcome) { active=false; outcome=true; publish('completed','Stop'); }
  } };
};
const setup = async context => {
  const noop = async () => {};
  if (typeof context?.event?.subscribe !== 'function' || typeof context?.session?.hook !== 'function') return noop;
  const hooks = await factory({ directory: process.env.ADE_STATUS_CWD });
  if (!hooks.event) return noop;
  const controller = new AbortController();
  const registration = await context.session.hook('prompt', async properties => {
    await hooks.event({ event: { type: 'session.execution.started', properties } });
  });
  const consuming = (async () => {
    for await (const input of context.event.subscribe({ signal: controller.signal })) {
      if (controller.signal.aborted) break;
      await hooks.event({ event: { type: input.type, properties: input.data } });
    }
  })().catch(() => {});
  return async () => { controller.abort(); try { await registration?.dispose?.(); } finally { await consuming; } };
};
export default process.env.ADE_OPENCODE_PLUGIN_API === 'v1' ? factory : { id: 'ade-opencode-status', setup, server: factory };
`;
