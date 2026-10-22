import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import type { TerminalServerMessage } from '../../shared/contracts.js';

export function attachTerminalSockets(server: http.Server, runtime: LocalRuntime, allowedOrigins?: string[]): void {
  const origins = new Set(allowedOrigins ?? ['http://127.0.0.1:4317', 'http://localhost:4317', 'http://127.0.0.1:5173', 'http://localhost:5173', 'https://127.0.0.1:5173', 'https://localhost:5173']);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 131072, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/nodes\/([a-zA-Z0-9_.-]+)\/terminal-stream$/);
    const rawCursor = url.searchParams.get('cursor') ?? '0';
    const reject = (status: number) => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); };
    if (!origins.has(req.headers.origin ?? '')) { reject(403); return; }
    if (!match || [...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1 || !/^\d{1,16}$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) { reject(400); return; }
    if (sockets.clients.size >= 32) { reject(429); return; }
    const [, projectId, nodeId] = match;
    try { runtime.sessions.require(projectId, nodeId); } catch { reject(404); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      sockets.emit('connection', ws, req);
      let cursor = Number(rawCursor), awaiting: number | null = null, lastLive: boolean | undefined, lastResume: boolean | undefined;
      let alive = true, operations = 0, input = Promise.resolve(), timer: NodeJS.Timeout | undefined;
      const close = () => ws.close(1008, 'Terminal unavailable');
      const send = (value: TerminalServerMessage) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'Terminal output backlog'); return; }
        ws.send(JSON.stringify(value));
      };
      const pump = () => {
        timer = undefined;
        if (awaiting !== null || ws.readyState !== WebSocket.OPEN) return;
        try {
          const page = runtime.sessions.page(projectId, nodeId, cursor, true);
          if (!page.data && !page.reset && page.live === lastLive && page.resumable === lastResume) return;
          awaiting = page.cursor; cursor = page.cursor; lastLive = page.live; lastResume = page.resumable;
          send({ type: 'output', page });
        } catch { close(); }
      };
      // Coalesce PTY bursts into short frames; the renderer returns credit after parsing each frame.
      const schedule = () => { if (!timer) timer = setTimeout(pump, 4); };
      const unsubscribe = runtime.sessions.subscribe(nodeId, schedule);
      ws.on('message', (raw, binary) => {
        if (binary) { close(); return; }
        let message: any;
        try { message = JSON.parse(raw.toString()); } catch { close(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { close(); return; }
        if (message.type === 'ack' && Object.keys(message).length === 2 && awaiting !== null && message.cursor === awaiting) { awaiting = null; schedule(); return; }
        if (++operations > 32) { close(); return; }
        const operation = async () => {
          if (ws.readyState !== WebSocket.OPEN) throw new Error('Terminal disconnected');
          if (message.type === 'input' && Object.keys(message).length === 2) await runtime.sessions.input(projectId, nodeId, message.data);
          else if (message.type === 'resize' && Object.keys(message).length === 3) await runtime.sessions.resize(projectId, nodeId, message.cols, message.rows);
          else throw new Error('Invalid terminal operation');
        };
        input = input.then(operation).catch(() => { send({ type: 'error', message: 'Terminal input delivery is uncertain. Inspect before repeating input.' }); close(); }).finally(() => { operations--; });
      });
      ws.on('pong', () => { alive = true; });
      const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; ws.ping(); }, 15000);
      ws.on('error', () => ws.terminate());
      ws.once('close', () => { unsubscribe(); clearInterval(heartbeat); clearTimeout(timer); });
      pump();
    });
  });
  const stop = () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); };
  runtime.streams.add(stop);
  server.once('close', () => { runtime.streams.delete(stop); stop(); });
}
