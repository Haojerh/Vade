export interface UnreadHistory { seen: Set<string>; unread: Set<string> }

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
