import { build } from 'esbuild';
import './build-brand-icons.mjs';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const nativeSpeech = process.platform === 'win32' ? `sherpa-onnx-win-${process.arch}` : `sherpa-onnx-${process.platform}-${process.arch}`;
try { createRequire(import.meta.url).resolve(nativeSpeech); }
catch { throw new Error(`Missing desktop speech dependency ${nativeSpeech}. Run npm install --include=optional before building.`); }

await mkdir('build/orchestration', { recursive: true });
await cp('resources/orchestration', 'build/orchestration', { recursive: true });
await cp('server/runtime/speechWorker.cjs', 'build/speechWorker.cjs');

await build({ entryPoints: ['server/index.ts'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'build/server.cjs', external: ['node-pty'], logLevel: 'info',
  define:{'import.meta.url':'__ADE_IMPORT_META_URL__'},
  banner:{js:"const __ADE_IMPORT_META_URL__ = require('node:url').pathToFileURL(__filename).href;"} });
await build({ entryPoints: ['server/runtime/ptyHost.cjs'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'build/ptyHost.cjs', external: ['node-pty'], logLevel: 'info' });
