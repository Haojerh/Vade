import { createServer } from './http/api.js';
import { LocalRuntime } from './runtime/localRuntime.js';
import { phoneOrigin } from './http/phoneOrigin.js';

const PORT = 4317;
const HOST = '127.0.0.1';

const runtime = new LocalRuntime();
runtime.sessions.subscribeAttention(item => {
  (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'agent-question', item });
});
runtime.sessions.subscribeResults(item => {
  (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'agent-completed', item });
});
let remoteOrigin = process.env.ADE_PHONE_ENABLED === '1' ? phoneOrigin(process.env.ADE_PHONE_ORIGIN) : null;
const server = createServer({ localRuntime: runtime, distDir: process.env.ADE_DIST_DIR, phoneOrigin: () => remoteOrigin });

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use on ${HOST}. Exiting.`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`ADE listening on http://${HOST}:${PORT}`);
  (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'ready' });
});

function handleShutdown() {
  console.log('Shutting down backend server...');
  runtime.close();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
(process as NodeJS.Process & { parentPort?: { on: (event: string, listener: (event: { data: unknown }) => void) => void } }).parentPort?.on('message', event => {
  if (event.data === 'shutdown') handleShutdown();
  const message = event.data as { type?: string; bytes?: number; pids?: number[] } | null;
  if (message?.type === 'phone-setup' || message?.type === 'phone-setup-close') {
    const value = event.data as { type: string; requestId: string; projectId?: string; nodeId?: string };
    const reply = (result: unknown, error?: string) => (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'phone-setup-result', requestId: value.requestId, result, error });
    if (value.type === 'phone-setup-close') { runtime.phoneSetup.closeTerminal(value.projectId, value.nodeId); reply(null); }
    else void runtime.phoneSetup.prepareTerminal().then(result => reply(result), error => reply(null, error instanceof Error ? error.message : 'Could not open setup terminal.'));
  }
  if (message?.type === 'phone-access') {
    const value = event.data as { enabled?: boolean; origin?: unknown; requestId?: string };
    remoteOrigin = value.enabled === true ? phoneOrigin(value.origin) : null;
    server.emit('phone-access-changed');
    (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'phone-access-applied', requestId: value.requestId });
  }
  if (message?.type === 'desktop-memory' && typeof message.bytes === 'number' && Number.isFinite(message.bytes) && message.bytes > 0) {
    runtime.desktopMemory = { bytes: message.bytes, at: Date.now(), pids: Array.isArray(message.pids) && message.pids.length <= 128 && message.pids.every(pid => Number.isInteger(pid) && pid > 0) ? message.pids : undefined };
  }
});
