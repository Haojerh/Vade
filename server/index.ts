import { createServer } from './http/api.js';

const PORT = 4317;
const HOST = '127.0.0.1';

const server = createServer();

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use on ${HOST}. Exiting.`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Orca Visualization backend server listening on http://${HOST}:${PORT}`);
});

function handleShutdown() {
  console.log('Shutting down backend server...');
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
