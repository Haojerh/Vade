import { build } from 'esbuild';

await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'build/server.cjs', external: ['node-pty'], logLevel: 'info' });
await build({ entryPoints: ['server/runtime/ptyHost.cjs'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'build/ptyHost.cjs', external: ['node-pty'], logLevel: 'info' });
