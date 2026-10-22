import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('build/orchestration', { recursive: true });
await cp('resources/orchestration', 'build/orchestration', { recursive: true });

await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'build/server.cjs', external: ['node-pty'], logLevel: 'info' });
await build({ entryPoints: ['server/runtime/ptyHost.cjs'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'build/ptyHost.cjs', external: ['node-pty'], logLevel: 'info' });
