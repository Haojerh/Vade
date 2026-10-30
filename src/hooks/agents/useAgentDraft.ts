import { useEffect, useState } from 'react';
const memory = new Map<string, string>();
const storageKey = 'vade:agent-drafts:v1';
let loaded = false;
export function readAgentDraft(key: string): string {
  if (!loaded) {
    loaded = true;
    try {
      const entries = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (Array.isArray(entries)) for (const entry of entries.slice(-100)) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') memory.set(entry[0], entry[1].slice(0, 10000));
    } catch { /* Keep drafts in memory when storage is unavailable. */ }
  }
  return memory.get(key) ?? '';
}
export function writeAgentDraft(key: string, value: string): void {
  readAgentDraft(key); memory.delete(key);
  if (value) memory.set(key, value);
  while (memory.size > 100) memory.delete(memory.keys().next().value!);
  try { localStorage.setItem(storageKey, JSON.stringify([...memory])); } catch { /* Memory fallback preserves overlay drafts. */ }
}
export function useAgentDraft(projectId: string | null, nodeId: string | null) {
  const key = JSON.stringify([projectId, nodeId]);
  const [draft, setDraft] = useState(() => ({ key, text: readAgentDraft(key) }));
  useEffect(() => { setDraft({ key, text: readAgentDraft(key) }); }, [key]);
  const text = draft.key === key ? draft.text : readAgentDraft(key);
  const update = (value: string | ((previous: string) => string)) => {
    const next = typeof value === 'function' ? value(readAgentDraft(key)) : value;
    writeAgentDraft(key, next); setDraft({ key, text: next });
  };
  return [text, update] as const;
}
