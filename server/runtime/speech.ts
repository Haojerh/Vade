import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import https from 'node:https';
import type { LocalSpeechCatalog, SpeechTranscript, SpeechAudioRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { speechModels } from './speechCatalog.js';

export function speechModulePath(applicationRoot = process.env.ADE_DIST_DIR ? path.dirname(process.env.ADE_DIST_DIR) : process.cwd()): string | null {
  const name = process.platform === 'win32' ? `sherpa-onnx-win-${process.arch}` : `sherpa-onnx-${process.platform}-${process.arch}`;
  try {
    // Desktop cwd is the real resources directory, not the application archive.
    // Resolve from the packaged app's physical unpack directory so the isolated
    // speech worker can load both the JS entry and its native libraries.
    const root = applicationRoot.replace(/app\.asar$/, 'app.asar.unpacked');
    const file = createRequire(path.join(root, 'package.json')).resolve(name);
    if (root !== applicationRoot && !file.startsWith(path.join(root, 'node_modules', name) + path.sep)) return null;
    return fs.existsSync(file) ? file : null;
  } catch { return null; }
}
const invalid = (message: string): never => { throw new CliError('INVALID_ARGUMENT', message); };
// Use Node's HTTP/1.1 transport: some model CDNs reset Undici fetch TLS
// connections on Windows, while the standard HTTPS transport works normally.
function openDownload(url: string, signal: AbortSignal, redirects = 5): Promise<Readable> {
  const windowsCurl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe');
  if (process.platform === 'win32' && fs.existsSync(windowsCurl)) {
    // Windows' bundled curl uses the system TLS stack. Only manifest URLs are
    // passed as argv, never shell text or client-provided paths/commands.
    const child = spawn(windowsCurl, ['--location', '--fail', '--silent', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '1800', '--retry', '2', '--', url], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const output = new PassThrough();
    const abort = () => { child.kill(); output.destroy(new Error('Model download cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.pipe(output, { end: false });
    child.on('error', error => output.destroy(error));
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (code === 0) output.end(); else output.destroy(new Error('Model download failed'));
    });
    output.on('close', () => { signal.removeEventListener('abort', abort); child.kill(); });
    if (signal.aborted) abort();
    return Promise.resolve(output);
  }
  return new Promise((resolve, reject) => {
    if (new URL(url).protocol !== 'https:') { reject(new Error('Model downloads require HTTPS')); return; }
    const request = https.get(url, { signal, headers: { 'User-Agent': 'ADE local speech model downloader' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location && redirects > 0) {
        response.resume(); resolve(openDownload(new URL(response.headers.location, url).href, signal, redirects - 1));
      } else if (response.statusCode !== 200) { response.resume(); reject(new Error('Model download failed')); }
      else resolve(response);
    });
    request.setTimeout(30000, () => request.destroy(new Error('Model download timed out')));
    request.on('error', reject);
  });
}
export function validateSpeechAudio(request: SpeechAudioRequest): Buffer {
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 0 || typeof request.pcm !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(request.pcm) || request.pcm.length > 90000) return invalid('Invalid speech audio chunk');
  const bytes = Buffer.from(request.pcm, 'base64');
  if (!bytes.length || bytes.length > 64000 || bytes.length % 4 || bytes.toString('base64') !== request.pcm) return invalid('Speech audio must be bounded float32 PCM');
  for (let i = 0; i < bytes.length; i += 4) if (!Number.isFinite(bytes.readFloatLE(i)) || Math.abs(bytes.readFloatLE(i)) > 1) return invalid('Invalid speech audio sample');
  return bytes;
}

export class LocalSpeech {
  private downloads = new Map<string, { abort: AbortController; bytes: number; error?: string; running: boolean }>();
  private child?: ChildProcess;
  private warmed?: string;
  private active?: { id: string; sequence: number; samples: number; busy: boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private rpcId = 0;
  private pending = new Map<number, { resolve(value: SpeechTranscript): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly dataDirectory: string, private readonly open = openDownload) {}
  private model(id: string) { return speechModels.find(model => model.id === id) ?? invalid('Choose a listed local speech model'); }
  private directory(id: string) { return path.join(this.dataDirectory, 'speech-models', this.model(id).id); }
  private ready(id: string) {
    return this.model(id).downloadFiles.every(file => {
      try { const stat = fs.lstatSync(path.join(this.directory(id), file.name)); return stat.isFile() && !stat.isSymbolicLink() && stat.size === file.sizeBytes; } catch { return false; }
    });
  }
  catalog(): LocalSpeechCatalog {
    const available = Boolean(speechModulePath());
    return { available, ...(!available ? { reason: 'The native speech recognizer is unavailable on this installation.' } : {}), models: speechModels.map(model => {
      const state = this.downloads.get(model.id);
      return { id: model.id, label: model.label, description: model.description, sizeBytes: model.sizeBytes, streaming: model.streaming, recommended: model.recommended,
        status: state?.running ? 'downloading' : this.ready(model.id) ? 'ready' : state?.error ? 'error' : 'missing', downloadedBytes: state?.bytes ?? 0, ...(state?.error ? { error: state.error } : {}) };
    }) };
  }
  download(id: string) {
    const model = this.model(id);
    if (!speechModulePath()) throw new CliError('RUNTIME_UNAVAILABLE', 'Install the native speech recognizer before downloading a model');
    if (this.ready(id) || this.downloads.get(id)?.running) return;
    if ([...this.downloads.values()].some(state => state.running)) throw new CliError('RATE_LIMITED', 'Wait for the current model download or cancel it');
    const state = { abort: new AbortController(), bytes: 0, running: true, error: undefined as string | undefined };
    this.downloads.set(id, state);
    void (async () => {
      const directory = this.directory(id); await fs.promises.mkdir(directory, { recursive: true });
      for (const file of model.downloadFiles) {
        if (state.abort.signal.aborted) throw new Error('cancelled');
        const destination = path.join(directory, file.name), temporary = destination + '.part';
        for (let attempt = 0; attempt < 3; attempt++) {
        let size = 0; const hash = crypto.createHash('sha256');
        try {
          await fs.promises.rm(temporary, { force: true });
          const signal = AbortSignal.any([state.abort.signal, AbortSignal.timeout(30 * 60 * 1000)]);
          const response = await this.open(file.url, signal);
          const check = new Transform({ transform(chunk, _encoding, done) {
            size += chunk.length; state.bytes += chunk.length;
            if (size > file.sizeBytes) { done(new Error('download too large')); return; }
            hash.update(chunk); done(null, chunk);
          } });
          await pipeline(response, check, fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' }), { signal });
          if (size !== file.sizeBytes || hash.digest('hex') !== file.sha256) throw new Error('model verification failed');
          await fs.promises.rename(temporary, destination);
          break;
        } catch (error) {
          state.bytes -= size;
          if (state.abort.signal.aborted || attempt === 2) throw error;
        } finally { await fs.promises.rm(temporary, { force: true }); }
        }
      }
    })().catch(() => { if (!state.abort.signal.aborted) state.error = 'Model download failed or verification did not match. Retry the download.'; })
      .finally(() => { state.running = false; });
  }
  cancelDownload(id: string) { this.model(id); this.downloads.get(id)?.abort.abort(); }
  private destroy() {
    clearTimeout(this.timer); this.child?.kill(); this.child = undefined; this.warmed = undefined; this.active = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CliError('RUNTIME_UNAVAILABLE', 'Local speech stopped. Start dictation again.')); }
    this.pending.clear();
  }
  private releaseWhenIdle() {
    clearTimeout(this.timer);
    const child = this.child;
    this.timer = setTimeout(() => {
      if (this.child === child && !this.active && !this.pending.size) this.destroy();
    }, 60000);
    this.timer.unref?.();
  }
  private rpc(message: object): Promise<SpeechTranscript> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new CliError('RUNTIME_UNAVAILABLE', 'Local speech is not running'));
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId;
      const timer = setTimeout(() => this.destroy(), 60000);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ ...message, id }, error => { if (error && this.child === child) this.destroy(); });
    });
  }
  async start(modelId: string): Promise<{ sessionId: string }> {
    const model = this.model(modelId), modulePath = speechModulePath();
    if (!modulePath || !this.ready(modelId)) throw new CliError('RUNTIME_UNAVAILABLE', 'Download a local speech model in Settings → Voice dictation first');
    if (this.active) throw new CliError('RATE_LIMITED', 'Another dictation session is already active');
    clearTimeout(this.timer);
    const session = { id: crypto.randomUUID(), sequence: 0, samples: 0, busy: false };
    if (this.warmed !== modelId || !this.child?.connected) {
      this.destroy();
      const child = fork(process.env.ADE_SPEECH_WORKER ?? path.join(process.cwd(), 'server/runtime/speechWorker.cjs'), [], {
        execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      this.child = child;
      child.on('message', (message: any) => {
        if (child !== this.child || !Number.isSafeInteger(message?.id)) return;
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new CliError('CLI_FAILED', 'Local speech recognition failed. Try another model.')) : pending.resolve(message.result);
      });
      child.on('exit', () => { if (this.child === child) this.destroy(); });
      child.on('error', () => { if (this.child === child) this.destroy(); });
      this.active = session;
      try { await this.rpc({ type: 'init', modulePath, model, directory: this.directory(modelId) }); this.warmed = modelId; }
      catch (error) { this.destroy(); throw error; }
    } else this.active = session;
    this.timer = setTimeout(() => this.destroy(), 90000);
    return { sessionId: session.id };
  }
  private require(id: string) {
    if (!this.active || this.active.id !== id) throw new CliError('INVALID_ARGUMENT', 'This dictation session is no longer active');
    if (this.active.busy) throw new CliError('RATE_LIMITED', 'Wait for the previous speech audio chunk');
    return this.active;
  }
  async audio(id: string, request: SpeechAudioRequest) {
    const session = this.require(id), bytes = validateSpeechAudio(request);
    if (request.sequence !== session.sequence) return invalid('Speech audio arrived out of order; start dictation again');
    if (session.samples + bytes.length / 4 > 16000 * 60) return invalid('Dictation is limited to one minute per recording');
    session.busy = true; session.sequence++; session.samples += bytes.length / 4;
    try { return await this.rpc({ type: 'audio', pcm: request.pcm }); } finally { session.busy = false; }
  }
  async finish(id: string) {
    const session = this.require(id); session.busy = true;
    try { return await this.rpc({ type: 'finish' }); }
    catch (error) { this.destroy(); throw error; }
    finally {
      if (this.active === session) { this.active = undefined; this.releaseWhenIdle(); }
    }
  }
  cancel(id: string) { if (this.active?.id === id) this.destroy(); }
  close() { for (const state of this.downloads.values()) state.abort.abort(); this.destroy(); }
}
