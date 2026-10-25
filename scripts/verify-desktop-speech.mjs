import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export async function verifyDesktopSpeech(output) {
  if (process.platform !== 'win32') return;
  const executable = path.join(output, 'win-unpacked', 'Vade.exe');
  const resources = path.join(output, 'win-unpacked', 'resources');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vade-speech-smoke-'));
  try {
    const result = await build({ stdin: { contents: `
      import { speechModulePath } from './server/runtime/speech.ts';
      import fs from 'node:fs';
      const file = speechModulePath();
      if (!file) throw new Error('Packaged speech addon could not be resolved');
      const native = require(file);
      if (typeof native.createOfflineRecognizer !== 'function' || typeof native.createOnlineRecognizer !== 'function') throw new Error('Packaged speech addon API is unavailable');
      if (!fs.existsSync(process.env.ADE_SPEECH_WORKER)) throw new Error('Packaged speech worker is missing');
      console.log('Packaged speech addon loads and worker exists');
    `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false });
    const script = path.join(directory, 'check.cjs'); await writeFile(script, result.outputFiles[0].contents);
    const checked = spawnSync(executable, [script], { cwd: resources, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ADE_DIST_DIR: path.join(resources, 'app.asar', 'dist'), ADE_SPEECH_WORKER: path.join(resources, 'app.asar.unpacked', 'build', 'speechWorker.cjs') }, timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 65536 });
    if (checked.error || checked.status !== 0) throw new Error(`Packaged speech check failed: ${checked.error?.message ?? checked.stderr.slice(-2000)}`);
    console.log(checked.stdout.trim());
  } finally { await rm(directory, { recursive: true, force: true }); }
}
