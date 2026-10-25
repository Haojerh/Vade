import { useSyncExternalStore } from 'react';

const key = 'vade:automatic-kanban';
const event = 'vade:automatic-kanban-changed';
export function automaticKanban() {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}
export function setAutomaticKanban(value: boolean) {
  localStorage.setItem(key, String(value));
  window.dispatchEvent(new Event(event));
}
export function useAutomaticKanban() {
  return useSyncExternalStore(callback => {
    window.addEventListener(event, callback); window.addEventListener('storage', callback);
    return () => { window.removeEventListener(event, callback); window.removeEventListener('storage', callback); };
  }, automaticKanban, () => false);
}
