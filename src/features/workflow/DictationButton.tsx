import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { createDictationSession, dictationSupport, type SpeechWindow } from './dictation';
import { createLocalDictationSession } from './localDictation';
import { useVoicePreferences } from './voicePreferences';

export function DictationButton({ disabled, onText, onActiveChange,iconOnly=false }: {
  disabled: boolean;
  onText(text: string): void;
  onActiveChange(active: boolean): void;
  iconOnly?:boolean;
}) {
  const preferences = useVoicePreferences();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const held = useRef(false);
  const [active, setActive] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sessionRef = useRef<ReturnType<typeof createDictationSession> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0), stoppingRef = useRef(false);
  const callbacks = useRef({ onText, onActiveChange });
  callbacks.current = { onText, onActiveChange };
  const finish = (owner?: number) => {
    if (owner !== undefined && owner !== generation.current) return;
    generation.current++;
    held.current = false;
    clearTimeout(timerRef.current);
    const previous = sessionRef.current;
    sessionRef.current = null;
    stoppingRef.current = false;
    previous?.dispose();
    setActive(false);
    setStopping(false);
    setInterim('');
    setNotice('');
    callbacks.current.onActiveChange(false);
  };
  useEffect(() => {
    const hidden = () => { if (document.hidden) finish(); };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      clearTimeout(timerRef.current);
      generation.current++;
      sessionRef.current?.dispose();
      sessionRef.current = null;
      callbacks.current.onActiveChange(false);
    };
  }, []);
  useEffect(() => { if (disabled || !preferences.enabled) finish(); }, [disabled, preferences.enabled]);
  const stop = (owner = generation.current) => {
    if (owner !== generation.current || !sessionRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { if (owner !== generation.current) return; setError(preferences.engine === 'local' ? 'Dictation took too long to finish. Try a smaller local model.' : 'The browser speech service did not finish. Try again or choose Local recognition in Voice dictation settings.'); finish(owner); }, preferences.engine === 'local' ? 65000 : 10000);
    try { sessionRef.current.stop(); } catch { setError('Dictation could not stop cleanly. Try again.'); finish(owner); }
  };
  const toggle = () => {
    if (disabled || !preferences.enabled || stoppingRef.current) return;
    if (sessionRef.current) { stop(); return; }
    setError('');
    const owner = ++generation.current;
    const current = () => owner === generation.current && Boolean(sessionRef.current);
    const events = {
      onText: (text: string) => { if (current()) callbacks.current.onText(text); },
      onInterim: (text: string) => { if (current()) setInterim(text); },
      onError: (message: string) => { if (current()) { setError(message); finish(owner); } },
      onEnd: () => finish(owner),
      onNotice: (message: string) => { if (current()) setNotice(message); },
    };
    if (preferences.engine === 'local') {
      sessionRef.current = createLocalDictationSession(preferences, events);
      setActive(true); callbacks.current.onActiveChange(true);
      sessionRef.current.start(); if (current()) timerRef.current = setTimeout(() => stop(owner), 60000); return;
    }
    const support = dictationSupport(window as unknown as SpeechWindow);
    if (!support.Recognition) { setError(support.reason!); return; }
    try {
      const recognition = new support.Recognition();
      recognition.lang = navigator.language || 'en-US';
      sessionRef.current = createDictationSession(recognition, events);
      setActive(true);
      callbacks.current.onActiveChange(true);
      sessionRef.current.start();
      if (current()) timerRef.current = setTimeout(() => stop(owner), 60000);
    } catch {
      finish();
      setError('Dictation could not start. Check microphone access and try again.');
    }
  };
  const actions = useRef({ toggle, stop, active, stopping, disabled, preferences });
  actions.current = { toggle, stop, active, stopping, disabled, preferences };
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || !event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
      const state = actions.current;
      if (state.disabled || !state.preferences.enabled || !buttonRef.current?.closest('.agent-chatbox-section')?.contains(document.activeElement)) return;
      event.preventDefault();
      if (state.preferences.mode === 'hold') { if (!state.active && !state.stopping) { held.current = true; state.toggle(); } }
      else state.toggle();
    };
    const up = (event: KeyboardEvent) => {
      if ((event.code === 'KeyE' || event.key === 'Control') && held.current) { held.current = false; actions.current.stop(); }
    };
    const blur = () => { if (held.current) { held.current = false; actions.current.stop(); } };
    document.addEventListener('keydown', down); document.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  if (!preferences.enabled) return null;
  return <div className="composer-dictation">
    <button ref={buttonRef} type="button" className={`btn btn-sm ${active ? 'btn-danger' : 'btn-secondary'}`}
      disabled={disabled || stopping} onClick={toggle} aria-pressed={active}
      aria-label={active ? 'Stop dictation' : 'Start dictation'}
      title={`${preferences.engine === 'local' ? 'Local dictation — audio is processed by the computer running Vade.' : 'Browser dictation — audio may be processed by your browser’s speech service.'} Ctrl+E to dictate. Text is added to your draft; it is never sent automatically.`}>
      <Icon name="mic" size={iconOnly?18:14} />{!iconOnly&&<span className="composer-action-label">{stopping ? 'Finishing…' : active ? 'Stop' : 'Dictate'}</span>}
    </button>
    {(active || error) && <span role="status" className={`dictation-status text-xs ${error ? 'text-danger' : 'text-muted'}`}>
      {error || interim || notice || (stopping ? 'Finishing dictation…' : preferences.engine === 'local' ? 'Listening locally…' : 'Listening… Speak in your browser language.')}
    </span>}
  </div>;
}
