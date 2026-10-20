import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { createDictationSession, dictationSupport, type SpeechWindow } from './dictation';

export function DictationButton({ disabled, onText, onActiveChange }: {
  disabled: boolean;
  onText(text: string): void;
  onActiveChange(active: boolean): void;
}) {
  const [active, setActive] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const sessionRef = useRef<ReturnType<typeof createDictationSession> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ onText, onActiveChange });
  callbacks.current = { onText, onActiveChange };
  const finish = () => {
    clearTimeout(timerRef.current);
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setActive(false);
    setStopping(false);
    setInterim('');
    callbacks.current.onActiveChange(false);
  };
  useEffect(() => {
    const hidden = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      clearTimeout(timerRef.current);
      sessionRef.current?.dispose();
      callbacks.current.onActiveChange(false);
    };
  }, []);
  useEffect(() => { if (disabled) finish(); }, [disabled]);
  const stop = () => {
    if (!sessionRef.current || stopping) return;
    setStopping(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(finish, 2500);
    sessionRef.current.stop();
  };
  const toggle = () => {
    if (active) { stop(); return; }
    setError('');
    const support = dictationSupport(window as unknown as SpeechWindow);
    if (!support.Recognition) { setError(support.reason!); return; }
    try {
      const recognition = new support.Recognition();
      recognition.lang = navigator.language || 'en-US';
      sessionRef.current = createDictationSession(recognition, {
        onText: (text) => callbacks.current.onText(text),
        onInterim: setInterim,
        onError: (message) => { setError(message); finish(); },
        onEnd: finish,
      });
      setActive(true);
      callbacks.current.onActiveChange(true);
      sessionRef.current.start();
      timerRef.current = setTimeout(stop, 60000);
    } catch {
      finish();
      setError('Dictation could not start. Check microphone access and try again.');
    }
  };
  return <div className="composer-dictation">
    <button type="button" className={`btn btn-sm ${active ? 'btn-danger' : 'btn-secondary'}`}
      disabled={disabled || stopping} onClick={toggle} aria-pressed={active}
      aria-label={active ? 'Stop dictation' : 'Start dictation'}
      title="Browser dictation — audio may be processed by your browser’s speech service. Text is added to your draft; it is never sent automatically.">
      <Icon name="mic" size={14} />{stopping ? 'Finishing…' : active ? 'Stop' : 'Dictate'}
    </button>
    {(active || error) && <span role="status" className={`dictation-status text-xs ${error ? 'text-danger' : 'text-muted'}`}>
      {error || interim || (stopping ? 'Finishing dictation…' : 'Listening… Speak in your browser language.')}
    </span>}
  </div>;
}
