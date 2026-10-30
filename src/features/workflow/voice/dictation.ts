export interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechConstructor = new () => SpeechRecognizer;
export type SpeechWindow = { isSecureContext: boolean; SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor };

export function dictationSupport(surface: SpeechWindow): { Recognition?: SpeechConstructor; reason?: string } {
  if (!surface.isSecureContext) return { reason: 'Dictation requires HTTPS or localhost. On mobile, open this dashboard over HTTPS.' };
  const Recognition = surface.SpeechRecognition ?? surface.webkitSpeechRecognition;
  return Recognition ? { Recognition } : { reason: 'Speech recognition is unavailable in this browser. Try a browser with Web Speech recognition support.' };
}

export function dictationError(code: string): string {
  switch (code) {
    case 'not-allowed': case 'service-not-allowed': return 'Microphone or speech recognition permission was denied. Allow access in your browser settings and try again.';
    case 'audio-capture': return 'No microphone is available. Check your microphone connection and browser permissions.';
    case 'network': return 'The browser speech service could not connect. Check your connection and try again.';
    case 'no-speech': return 'No speech was detected. Try again when you are ready.';
    case 'language-not-supported': return 'The browser speech service does not support your browser language.';
    default: return 'Dictation could not finish. Your existing draft has been kept.';
  }
}

export function appendDictation(draft: string, text: string): string {
  return draft + (draft && !/\s$/.test(draft) ? ' ' : '') + text.trim();
}

// Each recognition session owns its callbacks; disposal prevents late results reaching another draft.
export function createDictationSession(recognition: SpeechRecognizer, callbacks: {
  onText(text: string): void;
  onInterim(text: string): void;
  onError(message: string): void;
  onEnd(): void;
  onNotice?(message: string): void;
}) {
  const delivered = new Set<number>();
  let disposed = false, started = false, ended = false, stopping = false;
  let notice: ReturnType<typeof setTimeout> | undefined;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    if (disposed || ended) return;
    const final: string[] = [];
    const interim: string[] = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (result.isFinal) {
        if (!delivered.has(i)) { delivered.add(i); if (text) final.push(text); }
      } else if (text) interim.push(text);
    }
    if (final.length) callbacks.onText(final.join(' '));
    callbacks.onInterim(interim.join(' '));
    if (final.length || interim.length) { clearTimeout(notice); callbacks.onNotice?.(''); }
  };
  recognition.onerror = ({ error }) => {
    if (disposed || ended) return;
    ended = true;
    clearTimeout(notice);
    if (error === 'aborted') callbacks.onEnd();
    else callbacks.onError(dictationError(error));
  };
  recognition.onend = () => { if (!disposed && !ended) { ended = true; clearTimeout(notice); callbacks.onEnd(); } };
  return {
    start: () => { if (disposed || started) return; started = true; try { recognition.start(); if (!ended && !disposed) notice = setTimeout(() => { if (!disposed && !ended) callbacks.onNotice?.('No speech results yet. If you are speaking, stop and try Local recognition in Voice dictation settings.'); }, 15000); } catch (error) { ended = true; throw error; } },
    stop: () => { if (disposed || ended || stopping || !started) return; stopping = true; recognition.stop(); },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(notice);
      recognition.onresult = recognition.onerror = recognition.onend = null;
      if (started && !ended) { ended = true; try { recognition.abort(); } catch { /* Already released by the browser. */ } }
    },
  };
}
