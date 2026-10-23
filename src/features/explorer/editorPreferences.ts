import { useSyncExternalStore } from 'react';

const key = 'vade:editor-autosave';
const listeners = new Set<() => void>();
let current: boolean | undefined;
export function editorAutosave() {
  if (current !== undefined) return current;
  try { current = localStorage.getItem(key) !== 'false'; } catch { current = true; }
  return current;
}
export function setEditorAutosave(value: boolean) {
  current = value;
  try { localStorage.setItem(key, String(value)); } catch { /* Keep the setting in this window. */ }
  listeners.forEach(listener => listener());
}
export function useEditorAutosave() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, editorAutosave, () => true);
}
