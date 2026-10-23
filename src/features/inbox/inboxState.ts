import type { InboxItem } from '../../../shared/contracts';

export const INBOX_STORAGE_KEY = 'orca-visualization:inbox-handled:v1';

export function readHandled(value: string | null): Set<string> {
  try {
    const ids: unknown = JSON.parse(value ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(-2000) : []);
  } catch { return new Set(); }
}

export function failedInboxProjects(items: InboxItem[], handled: ReadonlySet<string>, now = Date.now()): Set<string> {
  const latest = new Map<string, InboxItem>();
  for (const item of items) {
    if (item.source === 'attention') continue;
    const key = `${item.projectId}:${item.entityId}`;
    if (!latest.has(key) || latest.get(key)!.at < item.at) latest.set(key, item);
  }
  return new Set([...latest.values()].filter(item => item.outcome === 'failed' && !handled.has(item.id)
    && now - Date.parse(item.at) >= 0 && now - Date.parse(item.at) <= 24 * 60 * 60 * 1000).map(item => item.projectId));
}
