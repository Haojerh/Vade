import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxData, Section } from '../../../shared/contracts';
import { fetchInbox } from '../../api/client';
import { failedInboxProjects, INBOX_STORAGE_KEY, readHandled } from './inboxState';

export function useInbox(enabled: boolean) {
  const [section, setSection] = useState<Section<InboxData> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const [handled, setHandled] = useState(() => {
    try { return readHandled(localStorage.getItem(INBOX_STORAGE_KEY)); } catch { return new Set<string>(); }
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
    const storage = (event: StorageEvent) => {
      if (event.key === INBOX_STORAGE_KEY) setHandled(readHandled(event.newValue));
    };
    window.addEventListener('storage', storage);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('storage', storage);
      request.current?.abort(); request.current = null;
    };
  }, [refresh]);
  useEffect(() => window.adeDesktop?.onAgentNotification(() => { void refresh(); }), [refresh]);
  const markHandled = useCallback((ids: string[]) => {
    setHandled(current => {
      const next = new Set([...current, ...ids].slice(-2000));
      try { localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify([...next])); } catch { /* Session-only if storage is unavailable. */ }
      return next;
    });
  }, []);
  const [cleared, setCleared] = useState(() => { try { return readHandled(localStorage.getItem('vade:inbox-cleared:v1')); } catch { return new Set<string>(); } });
  const clearItems = useCallback((ids: string[]) => {
    setCleared(current => { const next = new Set([...current, ...ids].slice(-2000)); try { localStorage.setItem('vade:inbox-cleared:v1', JSON.stringify([...next])); } catch { /* Session-only fallback. */ } return next; });
  }, []);
  const items = (section?.data?.items ?? []).filter(item => !cleared.has(item.id));
  return { section, items, loading, error, refresh, handled, markHandled, clearItems,
    unreadCount: items.filter(item => !handled.has(item.id)).length,
    failedProjectIds: failedInboxProjects(items, handled) };
}
