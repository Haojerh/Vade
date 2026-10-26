import type { NotificationState, UpdateNotificationStateRequest } from '../../shared/contracts.js';
import { emptyNotificationState, mergeNotificationState } from '../../shared/notificationState.js';
import { CliError } from '../integrations/cli.js';
import type { AdeStore } from './store.js';
const invalid = (): never => { throw new CliError('INVALID_ARGUMENT', 'Invalid notification state request'); };
export function notificationScope(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1500 || /[\x00-\x1f\x7f]/.test(value) || !(value === 'inbox' || /^(?:github|commit):.+/.test(value))) return invalid();
  return value;
}
function ids(value: unknown): void {
  if (!Array.isArray(value) || value.length > 5000 || value.some(id => typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x1f\x7f]/.test(id))) invalid();
}
export function notificationState(store: AdeStore, scope: string): NotificationState {
  const row = store.db.prepare('SELECT data FROM notification_states WHERE scope=?').get(notificationScope(scope));
  if (!row) return emptyNotificationState();
  if (String(row.data).length > 2_000_000) throw new CliError('INTERNAL', 'Stored notification state exceeds its limit');
  return JSON.parse(String(row.data));
}
export function updateNotificationState(store: AdeStore, request: UpdateNotificationStateRequest): NotificationState {
  notificationScope(request.scope);
  if (!['observe','acknowledge','clear','import'].includes(request.action) || request.baseline !== undefined && typeof request.baseline !== 'boolean') invalid();
  if (request.action === 'import') {
    const legacy = request.legacy;
    if (request.ids !== undefined || request.baseline !== undefined || !legacy || typeof legacy !== 'object' || Array.isArray(legacy) || Object.keys(legacy).some(key => !['seenIds','unreadIds','readIds','clearedIds'].includes(key))) invalid();
    const legacyIds = legacy as Record<string, unknown>;
    for (const value of Object.values(legacyIds)) if (value !== undefined) ids(value);
  } else { if (request.legacy !== undefined || request.action !== 'observe' && request.baseline !== undefined) invalid(); ids(request.ids); }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const previous = notificationState(store, request.scope), next = mergeNotificationState(previous, request);
    if (next.revision !== previous.revision) {
      store.db.prepare('INSERT INTO notification_states VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(request.scope, JSON.stringify(next), new Date().toISOString());
      store.db.exec('DELETE FROM notification_states WHERE scope NOT IN (SELECT scope FROM notification_states ORDER BY updated_at DESC LIMIT 2048)');
    }
    store.db.exec('COMMIT'); return next;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
