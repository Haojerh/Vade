import { createServer } from './http/api.js';
import { LocalRuntime } from './runtime/localRuntime.js';

const PORT = 4317;
const HOST = '127.0.0.1';

const runtime = new LocalRuntime();
runtime.sessions.subscribeAttention(item => {
  (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'agent-question', item });
});
runtime.sessions.subscribeResults(item => {
  (process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }).parentPort?.postMessage({ type: 'agent-completed', item });
});
const server = createServer({ localRuntime: runtime, distDir: process.env.ADE_DIST_DIR });

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
  if (message?.type === 'desktop-memory' && typeof message.bytes === 'number' && Number.isFinite(message.bytes) && message.bytes > 0) {
    runtime.desktopMemory = { bytes: message.bytes, at: Date.now(), pids: Array.isArray(message.pids) && message.pids.length <= 128 && message.pids.every(pid => Number.isInteger(pid) && pid > 0) ? message.pids : undefined };
  }
});
