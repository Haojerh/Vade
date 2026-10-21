import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vitePackagePath = require.resolve('vite/package.json');
const viteEntry = path.resolve(path.dirname(vitePackagePath), require(vitePackagePath).bin.vite);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const serverArgs = ['--import', 'tsx', '--watch', 'server/index.ts'];
const hostArgIdx = process.argv.indexOf('--host');
const host =
  process.env.HOST ||
  (hostArgIdx !== -1 && process.argv[hostArgIdx + 1] && !process.argv[hostArgIdx + 1].startsWith('-')
    ? process.argv[hostArgIdx + 1]
    : '127.0.0.1');

const clientArgs = [viteEntry, '--host', host, '--port', '5173', '--strictPort'];

const serverProc = spawn(process.execPath, serverArgs, {
  cwd: rootDir,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});

const clientProc = spawn(process.execPath, clientArgs, {
  cwd: rootDir,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});

function cleanup(code) {
  if (!serverProc.killed) {
    serverProc.kill();
  }
  if (!clientProc.killed) {
    clientProc.kill();
  }
  process.exit(code ?? 0);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

serverProc.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    cleanup(code);
  }
});

clientProc.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    cleanup(code);
  }
});
