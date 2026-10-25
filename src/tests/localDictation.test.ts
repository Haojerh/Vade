import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDictationSession } from '../features/workflow/localDictation';

test('local chat dictation can record twice and releases each microphone/context exactly once', async () => {
  const original = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode, fetch: globalThis.fetch };
  const contexts: Context[] = [], tracks: { stops: number; stop(): void }[] = [], order: string[] = [];
  let native = 0;
  class Context {
    closes = 0; sampleRate = 48000; audioWorklet = { async addModule() {} }; destination = {};
    constructor() { contexts.push(this); }
    async resume() { order.push('resume'); }
    async close() { this.closes++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  }
  class Processor {
    port = { onmessage: null as ((value: unknown) => void) | null, postMessage: () => this.port.onmessage?.({ data: { flushed: true } }) };
    connect() {} disconnect() {}
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia() { order.push('permission'); const track = { stops: 0, stop() { this.stops++; } }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; } } } });
  Object.assign(globalThis, { AudioContext: Context, AudioWorkletNode: Processor, fetch: async (input: string) => new Response(JSON.stringify(input.endsWith('/sessions') ? { sessionId: String(++native) } : input.endsWith('/finish') ? { text: `recording ${native}`, interim: '' } : {}), { headers: { 'Content-Type': 'application/json' } }) });
  const text: string[] = [];
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      let ended = false, error = '';
      const session = createLocalDictationSession({ enabled: true, engine: 'local', mode: 'toggle', deviceId: 'default', modelId: 'fixture' }, { onText: value => text.push(value), onInterim() {}, onError: value => { error = value; }, onEnd: () => { ended = true; session.dispose(); } });
      session.start();
      const startup = Date.now() + 2000;
      while (native < cycle + 1 && !error && Date.now() < startup) await new Promise(resolve => setTimeout(resolve, 1));
      session.stop();
      const deadline = Date.now() + 2000;
      while (!ended && !error && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
      assert.equal(error, ''); assert.equal(ended, true); session.dispose();
    }
    assert.deepEqual(text, ['recording 1', 'recording 2']);
    assert.deepEqual(order, ['resume', 'permission', 'resume', 'permission']);
    assert.deepEqual(contexts.map(context => context.closes), [1, 1]); assert.deepEqual(tracks.map(track => track.stops), [1, 1]);
    let cancelled = false;
    const pending = createLocalDictationSession({ enabled: true, engine: 'local', mode: 'hold', deviceId: 'default', modelId: 'fixture' }, { onText() { assert.fail('Cancelled capture must not deliver text'); }, onInterim() {}, onError(error) { assert.fail(error); }, onEnd() { cancelled = true; pending.dispose(); } });
    pending.start(); pending.stop();
    const deadline = Date.now() + 2000;
    while (!cancelled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(cancelled, true); assert.equal(native, 2);
    assert.equal(contexts[2].closes, 1); assert.equal(tracks[2].stops, 1);
  } finally {
    if (original.navigator) Object.defineProperty(globalThis, 'navigator', original.navigator); else Reflect.deleteProperty(globalThis, 'navigator');
    Object.assign(globalThis, { AudioContext: original.AudioContext, AudioWorkletNode: original.AudioWorkletNode, fetch: original.fetch });
  }
});
