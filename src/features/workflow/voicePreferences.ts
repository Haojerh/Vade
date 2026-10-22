import { useSyncExternalStore } from 'react';

export interface VoicePreferences { enabled: boolean; engine: 'browser' | 'local'; mode: 'toggle' | 'hold'; deviceId: string; modelId: string }
const key = 'ade.voice-dictation.v1';
const defaults = (): VoicePreferences => ({ enabled: true, engine: typeof window !== 'undefined' && window.adeDesktop ? 'local' : 'browser', mode: 'toggle', deviceId: 'default', modelId: '' });
const serverDefaults: VoicePreferences = { enabled: true, engine: 'browser', mode: 'toggle', deviceId: 'default', modelId: '' };
let current: VoicePreferences | undefined;
const listeners = new Set<() => void>();
export function voicePreferences(): VoicePreferences {
  if (current) return current;
  const fallback = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    current = { enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true, engine: saved.engine === 'local' || (!window.adeDesktop && saved.engine === 'browser') ? saved.engine : fallback.engine,
      mode: saved.mode === 'hold' ? 'hold' : 'toggle', deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : 'default', modelId: typeof saved.modelId === 'string' ? saved.modelId : '' };
  } catch { current = fallback; }
  return current!;
}
export function updateVoicePreferences(update: Partial<VoicePreferences>) {
  current = { ...voicePreferences(), ...update };
  try { localStorage.setItem(key, JSON.stringify(current)); } catch { /* Preferences remain available for this window. */ }
  listeners.forEach(listener => listener());
}
export function useVoicePreferences() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, voicePreferences, () => serverDefaults);
}
