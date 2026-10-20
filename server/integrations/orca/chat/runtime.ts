import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { CliError } from '../../cli.js';

// Fixed internal surface only. No method, session, endpoint or envelope comes from HTTP.
export type ChatRuntimeMethod = 'session.tabs.list' | 'agentSession.modelCatalog' | 'agentSession.options' | 'agentSession.history' | 'agentSession.setOption';
export type ChatRuntimeReader = (method: ChatRuntimeMethod, params: Record<string, unknown>) => Promise<any>;
export const callChatRuntime: ChatRuntimeReader = async (method, params) => {
  const root = process.env.ORCA_USER_DATA_PATH || (process.env.ORCA_APPDATA_DIR ? path.join(process.env.ORCA_APPDATA_DIR, 'orca') :
    process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'orca') :
      process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'orca') :
        path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca'));
  const file = await fs.open(path.join(root, 'orca-runtime.json'), 'r');
  let metadata: any;
  try {
    if ((await file.stat()).size > 65536) throw new Error('Invalid runtime metadata');
    metadata = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  const transport = metadata.transports?.find((item: any) => item.kind === (process.platform === 'win32' ? 'named-pipe' : 'unix'));
  if (typeof metadata.authToken !== 'string' || !metadata.authToken || typeof metadata.runtimeId !== 'string' || typeof transport?.endpoint !== 'string' ||
    (process.platform === 'win32' ? !transport.endpoint.startsWith('\\\\.\\pipe\\orca-') : !path.isAbsolute(transport.endpoint))) {
    throw new CliError('RUNTIME_UNAVAILABLE', 'Orca chat controls are unavailable');
  }
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(transport.endpoint);
    let buffer = ''; let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new CliError('CLI_TIMEOUT', 'Orca chat controls timed out', true)), 10000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ id, authToken: metadata.authToken, method, params }) + '\n'));
    socket.on('error', () => finish(new CliError('RUNTIME_UNAVAILABLE', 'Cannot connect to Orca chat controls', true)));
    socket.on('close', () => finish(new CliError('RUNTIME_UNAVAILABLE', 'Orca closed the chat connection', true)));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { finish(new CliError('INVALID_UPSTREAM', 'Orca chat response exceeds the read limit')); return; }
      let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line);
          if (frame._keepalive === true) continue;
          if (frame.id !== id || frame._meta?.runtimeId !== metadata.runtimeId) throw new Error();
          if (frame.ok !== true) finish(new CliError('RUNTIME_UNAVAILABLE', 'This Orca session does not expose these chat controls', false));
          else finish(null, frame.result);
        } catch { finish(new CliError('INVALID_UPSTREAM', 'Invalid Orca chat response')); }
      }
    });
  });
};
