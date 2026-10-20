import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDictation, createDictationSession, dictationSupport, type SpeechRecognizer } from '../features/workflow/dictation';

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

test('disposing dictation aborts recording and ignores late events from the old node', () => {
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
  assert.equal(aborted, true);
  assert.deepEqual(text, []);
  assert.equal(ended, false);
});
