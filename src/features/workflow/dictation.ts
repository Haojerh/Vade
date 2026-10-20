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
}) {
  const delivered = new Set<number>();
  let disposed = false;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    if (disposed) return;
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
  };
  recognition.onerror = ({ error }) => {
    if (!disposed && error !== 'aborted') callbacks.onError(dictationError(error));
  };
  recognition.onend = () => { if (!disposed) callbacks.onEnd(); };
  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    dispose: () => {
      disposed = true;
      recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition.abort();
    },
  };
}
