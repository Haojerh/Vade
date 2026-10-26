export interface UnreadHistory { seen: Set<string>; unread: Set<string> }

const storagePrefix = 'orca-visualization:github-notifications:v1:';
const commitStoragePrefix = 'orca-visualization:commit-reads:v1:';

export function readUnreadHistory(key: string, storage?: Pick<Storage, 'getItem'>): UnreadHistory | undefined {
  try {
    const value = (storage ?? window.localStorage).getItem(storagePrefix + key);
    if (!value) return undefined;
    const parsed = JSON.parse(value);
    if (parsed.version !== 1 || !Array.isArray(parsed.seen) || !Array.isArray(parsed.unread) ||
      !parsed.seen.every((id: unknown) => typeof id === 'string') ||
      !parsed.unread.every((id: unknown) => typeof id === 'string')) return undefined;
    const seen = new Set<string>(parsed.seen);
    return { seen, unread: new Set<string>(parsed.unread.filter((id: string) => seen.has(id))) };
  } catch { return undefined; }
}

export function observeGitHubItems(previous: UnreadHistory | undefined, ids: string[]): UnreadHistory {
  if (!previous) return { seen: new Set(ids), unread: new Set() };
  return { seen: new Set([...previous.seen, ...ids]),
    unread: new Set([...previous.unread, ...ids.filter((id) => !previous.seen.has(id))]) };
}

export function acknowledgeGitHubItem(previous: UnreadHistory, id: string): UnreadHistory {
  const unread = new Set(previous.unread);
  unread.delete(id);
  return { ...previous, unread };
}

/** Read-only compatibility bridge for one-time import of browser-local commit reads. */
export function readLegacyCommitReads(key: string, storage?: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const raw = (storage ?? window.localStorage).getItem(commitStoragePrefix + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === 1 && Array.isArray(parsed.ids) && parsed.ids.every((id: unknown) => typeof id === 'string')) return new Set(parsed.ids);
    }
  } catch { /* Legacy storage is optional. */ }
  return new Set();
}
