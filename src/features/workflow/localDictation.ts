import type { SpeechTranscript, StartSpeechResponse } from '../../../shared/contracts';
import { speechRequest } from '../../api/client';
import type { VoicePreferences } from './voicePreferences';

/** Stateful averaging resampler; device chunk boundaries preserve fractional position. */
export function pcmResampler(inputRate: number) {
  let sum = 0, weight = 0;
  const ratio = inputRate / 16000;
  return (input: Float32Array) => {
    const output: number[] = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-9) {
        const portion = Math.min(remaining, ratio - weight);
        sum += sample * portion; weight += portion; remaining -= portion;
        if (weight >= ratio - 1e-9) { output.push(Math.max(-1, Math.min(1, sum / ratio))); sum = 0; weight = 0; }
      }
    }
    return new Float32Array(output);
  };
}
export function createLocalDictationSession(preferences: VoicePreferences, callbacks: {
  onText(text: string): void; onInterim(text: string): void; onError(message: string): void; onEnd(): void;
}) {
  let disposed = false, stopping = false, sessionId: string | undefined, stream: MediaStream | undefined, context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined, processor: AudioWorkletNode | undefined, gain: GainNode | undefined;
  let sequence = 0, queued = 0, chain = Promise.resolve(), started: Promise<void> = Promise.resolve();
  let pending: number[] = [];
  let flushed: (() => void) | undefined;
  const releaseMic = () => {
    if (processor) processor.port.onmessage = null;
    source?.disconnect(); processor?.disconnect(); gain?.disconnect();
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); void context?.close().catch(() => {});
  };
  const cancel = () => { if (sessionId) { const id = sessionId; sessionId = undefined; void speechRequest(`sessions/${id}/cancel`, {}).catch(() => {}); } };
  const deliver = (result: SpeechTranscript) => {
    if (disposed) return;
    if (result.text) callbacks.onText(result.text);
    callbacks.onInterim(result.interim);
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    disposed = true; releaseMic(); cancel();
    callbacks.onError(error instanceof Error ? error.message : 'Local dictation failed. Check the microphone and selected model.');
  };
  const enqueue = (samples: Float32Array) => {
    if (!samples.length || disposed) return;
    if (++queued > 32) { fail(new Error('Local speech is falling behind. Try a smaller model.')); return; }
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const request = { pcm: btoa(binary), sequence: sequence++ };
    chain = chain.then(async () => {
      if (disposed || !sessionId) return;
      deliver(await speechRequest<SpeechTranscript>(`sessions/${sessionId}/audio`, request));
    }).catch(fail).finally(() => { queued--; });
  };
  return {
    start() {
      started = (async () => {
        if (!preferences.modelId) throw new Error('Select and download a local speech model in Settings → Voice dictation.');
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires localhost or HTTPS.');
        // Request microphone access from this explicit recording action only.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(preferences.deviceId !== 'default' ? { deviceId: { exact: preferences.deviceId } } : {}) } });
        if (disposed) { releaseMic(); return; }
        stream.getAudioTracks().forEach(track => { track.onended = () => fail(new Error('The microphone disconnected. Check the selected input device.')); });
        context = new AudioContext();
        await context.audioWorklet.addModule('/audio/dictation-capture.js');
        if (disposed) { releaseMic(); return; }
        const result = await speechRequest<StartSpeechResponse>('sessions', { modelId: preferences.modelId });
        sessionId = result.sessionId;
        if (disposed) { cancel(); releaseMic(); return; }
        const resample = pcmResampler(context.sampleRate);
        source = context.createMediaStreamSource(stream);
        processor = new AudioWorkletNode(context, 'ade-dictation-capture');
        gain = context.createGain(); gain.gain.value = 0;
        processor.port.onmessage = event => {
          if (disposed) return;
          if (event.data?.flushed) { flushed?.(); return; }
          const samples = resample(event.data);
          for (const sample of samples) pending.push(sample);
          while (pending.length >= 4000) enqueue(new Float32Array(pending.splice(0, 4000)));
        };
        source.connect(processor); processor.connect(gain); gain.connect(context.destination);
        await context.resume();
      })().catch(fail);
    },
    stop() {
      if (stopping || disposed) return;
      stopping = true;
      void started.then(async () => {
        if (processor && !disposed) await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Microphone capture did not finish. Start dictation again.')), 1000);
          flushed = () => { clearTimeout(timeout); resolve(); };
          processor!.port.postMessage('flush');
        });
        releaseMic();
        if (disposed || !sessionId) return;
        enqueue(new Float32Array(pending)); pending = [];
        await chain;
        if (disposed || !sessionId) return;
        const id = sessionId;
        const result = await speechRequest<SpeechTranscript>(`sessions/${id}/finish`, {});
        sessionId = undefined; deliver(result);
        if (!disposed) callbacks.onEnd();
      }).catch(fail);
    },
    dispose() { disposed = true; releaseMic(); cancel(); },
  };
}
