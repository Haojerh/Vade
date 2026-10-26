import type { NotificationState, UpdateNotificationStateRequest } from './contracts.js';
export const emptyNotificationState = (): NotificationState => ({ initialized: false, revision: 0, seenIds: [], unreadIds: [], readIds: [], clearedIds: [] });
const union = (a: string[], b: string[] = []) => [...new Set([...a, ...(b ?? [])])].slice(-5000);
/** Additive acknowledgements win over observations and legacy imports. */
export function mergeNotificationState(previous: NotificationState, request: UpdateNotificationStateRequest): NotificationState {
  const next = { ...previous }, ids = request.ids ?? [];
  if (request.action === 'observe') {
    const seen = new Set(previous.seenIds);
    if (previous.initialized && !request.baseline) next.unreadIds = union(previous.unreadIds, ids.filter(id => !seen.has(id)));
    next.seenIds = union(previous.seenIds, ids); next.initialized = true;
  } else if (request.action === 'acknowledge') next.readIds = union(previous.readIds, ids);
  else if (request.action === 'clear') { next.clearedIds = union(previous.clearedIds, ids); next.readIds = union(previous.readIds, ids); }
  else if (request.action === 'import') {
    const legacy = request.legacy ?? {};
    next.seenIds = union(previous.seenIds, legacy.seenIds);
    next.readIds = union(previous.readIds, legacy.readIds);
    next.clearedIds = union(previous.clearedIds, legacy.clearedIds);
    next.unreadIds = union(previous.unreadIds, legacy.unreadIds);
    next.initialized = previous.initialized || Boolean(legacy.seenIds?.length);
  }
  const read = new Set([...next.readIds, ...next.clearedIds]);
  next.unreadIds = next.unreadIds.filter(id => !read.has(id));
  if (JSON.stringify(next) !== JSON.stringify(previous)) next.revision++;
  return next;
}
