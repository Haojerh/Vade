import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDictation, createDictationSession, dictationSupport, type SpeechRecognizer } from '../features/workflow/voice/dictation';
import { pcmResampler } from '../features/workflow/voice/localDictation';

test('local microphone resampling preserves sample boundaries and produces 16 kHz mono PCM', () => {
  const input = Float32Array.from({ length: 48000 }, (_, index) => Math.sin(index / 100));
  const whole = pcmResampler(48000)(input);
  const resample = pcmResampler(48000), pieces: number[] = [];
  for (let i = 0; i < input.length; i += 4096) pieces.push(...resample(input.slice(i, i + 4096)));
  assert.equal(whole.length, 16000);
  assert.deepEqual(new Float32Array(pieces), whole);
  assert.ok(whole.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
});

function recognizer(): SpeechRecognizer {
  return { lang: '', continuous: false, interimResults: false, onresult: null, onerror: null, onend: null,
    start() {}, stop() {}, abort() {} };
}

test('dictation rejects insecure origins and reports missing browser support', () => {
  assert.match(dictationSupport({ isSecureContext: false }).reason!, /HTTPS/);
  assert.match(dictationSupport({ isSecureContext: true }).reason!, /unavailable/);
  class Supported { }
  const ctor = Supported as unknown as new () => SpeechRecognizer;
  assert.equal(dictationSupport({ isSecureContext: true, webkitSpeechRecognition: ctor }).Recognition, ctor);
});

test('dictation commits final speech once while keeping interim text out of the draft', () => {
  const speech = recognizer();
  const draft: string[] = [];
  const interim: string[] = [];
  createDictationSession(speech, { onText: (text) => draft.push(text), onInterim: (text) => interim.push(text), onError() {}, onEnd() {} });
  speech.onresult!({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hello' } }] });
  assert.deepEqual(draft, []);
  assert.equal(interim.at(-1), 'hello');
  const final = { isFinal: true, 0: { transcript: 'hello world' } };
  speech.onresult!({ resultIndex: 0, results: [final] });
  speech.onresult!({ resultIndex: 1, results: [final, { isFinal: true, 0: { transcript: 'again' } }] });
  assert.deepEqual(draft, ['hello world', 'again']);
  assert.equal(interim.at(-1), '');
  assert.equal(appendDictation('Existing draft', draft.join(' ')), 'Existing draft hello world again');
  assert.equal(appendDictation('Existing\n', 'next'), 'Existing\nnext');
});

test('dictation ignores late events after recognizer error and disposal', () => {
  const speech = recognizer();
  let aborted = false;
  let ended = false;
  let error = '';
  const text: string[] = [];
  speech.abort = () => { aborted = true; };
  const session = createDictationSession(speech, { onText: (value) => text.push(value), onInterim() {}, onError: (value) => { error = value; }, onEnd: () => { ended = true; } });
  const lateResult = speech.onresult!;
  const lateEnd = speech.onend!;
  speech.onerror!({ error: 'not-allowed' });
  assert.match(error, /permission was denied/);
  session.dispose();
  lateResult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'wrong node' } }] });
  lateEnd();
  assert.equal(aborted, false); // The error already ended the native service.
  assert.deepEqual(text, []);
  assert.equal(ended, false);
});

test('normal browser completion does not abort the ended recognizer and a second recording delivers fresh results', () => {
  const text: string[] = []; let aborts = 0;
  for (const word of ['first', 'second']) {
    const speech = recognizer(); speech.abort = () => { aborts++; };
    const session = createDictationSession(speech, { onText: value => text.push(value), onInterim() {}, onError() {}, onEnd: () => session.dispose() });
    session.start();
    speech.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: word } }] });
    speech.onend!(); session.dispose();
  }
  assert.deepEqual(text, ['first', 'second']); assert.equal(aborts, 0);
});

test('browser stop and active disposal are one-shot and aborted errors release the session', () => {
  const speech = recognizer(); let stops = 0, aborts = 0, ends = 0;
  speech.stop = () => { stops++; }; speech.abort = () => { aborts++; };
  const session = createDictationSession(speech, { onText() {}, onInterim() {}, onError() {}, onEnd() { ends++; } });
  session.start(); session.start(); session.stop(); session.stop();
  assert.equal(stops, 1);
  speech.onerror!({ error: 'aborted' }); session.dispose(); assert.equal(ends, 1); assert.equal(aborts, 0);
  const active = recognizer(); active.abort = () => { aborts++; };
  const other = createDictationSession(active, { onText() {}, onInterim() {}, onError() {}, onEnd() {} });
  other.start(); other.dispose(); other.dispose(); assert.equal(aborts, 1);
});

test('silent browser recognition reports missing results and clears its notice on speech or disposal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const speech = recognizer(), notices: string[] = [];
  const session = createDictationSession(speech, { onText() {}, onInterim() {}, onError() {}, onEnd() {}, onNotice: message => notices.push(message) });
  session.start(); t.mock.timers.tick(15000);
  assert.match(notices.at(-1)!, /No speech results/);
  speech.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'heard' } }] });
  assert.equal(notices.at(-1), ''); session.dispose();
  t.mock.timers.tick(60000); assert.equal(notices.length, 2);
});
