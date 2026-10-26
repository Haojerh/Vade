import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxData, Section } from '../../../shared/contracts';
import { fetchInbox } from '../../api/client';
import { changeNotifications, retryNotifications, useSharedNotifications } from '../notifications/useSharedNotifications';
import { failedInboxProjects, INBOX_STORAGE_KEY, readHandled } from './inboxState';

export function useInbox(enabled: boolean) {
  const [section, setSection] = useState<Section<InboxData> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const notificationState = useSharedNotifications(enabled ? 'inbox' : null, () => {
    try {
      return {
        readIds: [...readHandled(localStorage.getItem(INBOX_STORAGE_KEY))],
        clearedIds: [...readHandled(localStorage.getItem('vade:inbox-cleared:v1'))],
      };
    } catch { return undefined; }
  });
  const refresh = useCallback(async () => {
    if (!enabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await fetchInbox(controller.signal);
      if (!controller.signal.aborted) { setSection(next); setError(null); }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Inbox could not refresh');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, [enabled]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, window.adeDesktop ? 30_000 : 5_000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      request.current?.abort(); request.current = null;
    };
  }, [refresh]);
  useEffect(() => window.adeDesktop?.onAgentNotification(() => { void refresh(); }), [refresh]);
  const handled = new Set(notificationState.state?.readIds ?? []);
  const cleared = new Set(notificationState.state?.clearedIds ?? []);
  const markHandled = useCallback((ids: string[]) => {
    void changeNotifications({ scope: 'inbox', action: 'acknowledge', ids });
  }, []);
  const clearItems = useCallback((ids: string[]) => {
    void changeNotifications({ scope: 'inbox', action: 'clear', ids });
  }, []);
  const items = (section?.data?.items ?? []).filter(item => !cleared.has(item.id));
  const notificationError = notificationState.error;
  const retryNotificationChanges = useCallback(() => retryNotifications('inbox'), []);
  return { section, items, loading, error, notificationError, retryNotificationChanges, refresh, handled, markHandled, clearItems,
    unreadCount: items.filter(item => !handled.has(item.id)).length,
    failedProjectIds: failedInboxProjects(items, handled) };
}
