// One owned helper per terminal keeps native PTY startup and teardown off the HTTP process.
const pty = require('node-pty');
let terminal;
let closing = false;
let queuedBytes = 0;
const send = message => {
  if (!process.connected) return;
  const bytes = message.data?.length || 0;
  queuedBytes += bytes;
  if (queuedBytes > 2 * 1024 * 1024) { shutdown(); return; }
  process.send(message, () => { queuedBytes -= bytes; });
};
const shutdown = () => {
  if (closing) return;
  closing = true;
  try { terminal?.kill(); } catch { /* The terminal may have exited already. */ }
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('message', message => {
  try {
    if (message.type === 'start' && !terminal && !closing) {
      terminal = pty.spawn(message.executable, message.args, { cwd: message.cwd, env: process.env,
        name: 'xterm-256color', cols: message.cols === 1000 ? 1000 : 100, rows: 28,
        // The bundled headless host avoids system console delegation and teardown forks.
        ...(process.platform === 'win32' ? { useConptyDll: true } : {}) });
      terminal.onData(data => {
        for (let i = 0; i < data.length; i += 32768) send({ type: 'data', data: data.slice(i, i + 32768) });
      });
      terminal.onExit(event => {
        send({ type: 'exit', exitCode: event.exitCode });
        // Exit the helper, including node-pty's output workers, after the final IPC message flushes.
        if (process.connected) process.send({ type: 'ended' }, () => process.exit(0));
        else process.exit(0);
      });
      send({ type: 'ready' });
    } else if (message.type === 'stop') shutdown();
    else if (message.type === 'input' && terminal) { terminal.write(message.data); send({ type: 'ack', id: message.id }); }
    else if (message.type === 'resize' && terminal) { terminal.resize(message.cols, message.rows); send({ type: 'ack', id: message.id }); }
  } catch {
    send({ type: 'error', id: message.id });
    if (message.type === 'start') shutdown();
  }
});
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
