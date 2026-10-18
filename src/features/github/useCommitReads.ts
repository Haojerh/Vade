import { useCallback, useEffect, useState } from 'react';

const prefix = 'orca-visualization:commit-reads:v1:';
const memory = new Map<string, Set<string>>();
const listeners = new Map<string, Set<() => void>>();
type ReadStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readCommitReads(key: string, storage?: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const raw = (storage ?? window.localStorage).getItem(prefix + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === 1 && Array.isArray(parsed.ids) && parsed.ids.every((id: unknown) => typeof id === 'string')) return new Set([...parsed.ids, ...(!storage ? memory.get(key) ?? [] : [])]);
    }
  } catch { /* Keep explicit acknowledgements working when storage is unavailable. */ }
  return storage ? new Set() : memory.get(key) ?? new Set();
}

export function markCommitRead(key: string, sha: string, storage?: ReadStorage): Set<string> {
  const next = new Set(readCommitReads(key, storage));
  next.add(sha);
  if (!storage) memory.set(key, next);
  try { (storage ?? window.localStorage).setItem(prefix + key, JSON.stringify({ version: 1, ids: [...next] })); } catch { /* Memory remains authoritative for this session. */ }
  if (!storage) listeners.get(key)?.forEach(listener => listener());
  return next;
}

export function useCommitReads(key: string) {
  const [state, setState] = useState(() => ({ key, ids: readCommitReads(key) }));
  useEffect(() => {
    const update = () => setState({ key, ids: readCommitReads(key) });
    const subscribers = listeners.get(key) ?? new Set();
    subscribers.add(update); listeners.set(key, subscribers);
    const storage = (event: StorageEvent) => { if (event.key === prefix + key) update(); };
    window.addEventListener('storage', storage); update();
    return () => {
      subscribers.delete(update);
      if (!subscribers.size) listeners.delete(key);
      window.removeEventListener('storage', storage);
    };
  }, [key]);
  const acknowledge = useCallback((sha: string) => { markCommitRead(key, sha); }, [key]);
  return { ids: state.key === key ? state.ids : readCommitReads(key), acknowledge };
}
