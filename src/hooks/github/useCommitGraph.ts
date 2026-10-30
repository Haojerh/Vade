import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitGraphData, Section } from '../../../shared/contracts';
import { fetchCommitGraph } from '../../api/client';
import { changeNotifications, retryNotifications, useSharedNotifications } from '../workspace/useSharedNotifications';
import { observeGitHubItems, readLegacyCommitReads, readUnreadHistory } from '../../features/github/githubUnread';

export function commitGraphNotificationKey(projectId: string | null, nodeId?: string, branch?: string, repositoryId?: string) {
  return JSON.stringify(['local-commit-graph', projectId, repositoryId ?? null, nodeId ?? null, nodeId ? branch ?? null : null]);
}
export const commitNotificationScope = (key: string) => `commit:${key}`;

interface GraphObservation { key: string; section: Section<CommitGraphData> | null; loading: boolean; error: string }

export function mergeCommitGraphSnapshot(previous: GraphObservation, key: string, section: Section<CommitGraphData>): GraphObservation {
  return {
    key,
    section: section.data ? section : previous.key === key ? previous.section ?? section : section,
    error: section.meta.issue?.message ?? '',
    loading: false,
  };
}

export function useCommitGraph(projectId: string | null, nodeId: string | undefined, branch: string | undefined, refresh: number, enabled: boolean, repositoryId?: string) {
  const key = commitGraphNotificationKey(projectId, nodeId, branch, repositoryId);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<GraphObservation>({ key, section: null, loading: true, error: '' });
  const legacyReadIds = projectId ? readLegacyCommitReads(key) : new Set<string>();
  const legacyReadKey = [...legacyReadIds].join('\0');
  const shared = useSharedNotifications(projectId ? commitNotificationScope(key) : null, () => {
    const section = state.key === key ? state.section : null;
    const history = observeGitHubItems(readUnreadHistory(key), section?.data?.commits.map(commit => commit.sha) ?? []);
    if (!history.seen.size && !legacyReadIds.size) return undefined;
    return {
      seenIds: [...history.seen],
      unreadIds: [...history.unread],
      readIds: [...legacyReadIds],
    };
  }, [key, state.key, state.section?.data?.commits.map(commit => commit.sha).join('\0'), legacyReadKey]);
  useEffect(() => {
    if (!enabled || !projectId) return;
    let request: AbortController | null = null;
    const load = async () => {
      if (document.hidden) return;
      request?.abort();
      const controller = new AbortController(); request = controller;
      setState(prev => ({ key, section: prev.key === key ? prev.section : null, error: '', loading: true }));
      try {
        const section = await fetchCommitGraph(projectId, nodeId, controller.signal);
        if (controller.signal.aborted) return;
        if (section.data && !section.meta.stale && !section.meta.issue && ['ready', 'empty'].includes(section.meta.availability)) {
          void changeNotifications({
            scope: commitNotificationScope(key), action: 'observe',
            ids: section.data.commits.map(commit => commit.sha),
          });
        }
        setState(prev => mergeCommitGraphSnapshot(prev, key, section));
      } catch (e) { if (!controller.signal.aborted) setState(prev => ({ ...prev, error: (e as Error).message, loading: false })); }
    };
    void load();
    const timer = setInterval(() => void load(), 60000);
    document.addEventListener('visibilitychange', load);
    return () => { clearInterval(timer); request?.abort(); document.removeEventListener('visibilitychange', load); };
  }, [enabled, projectId, nodeId, key, refresh, attempt]);
  const acknowledge = useCallback((sha: string) => {
    void changeNotifications({ scope: commitNotificationScope(key), action: 'acknowledge', ids: [sha] });
  }, [key]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const retryNotificationChanges = useCallback(() => retryNotifications(commitNotificationScope(key)), [key]);
  const current = state.key === key ? state : { key, section: null, error: '', loading: true };
  const readIds = new Set(shared.state?.readIds ?? []);
  return { ...current, ...(projectId?{projectId}:{}),...(nodeId?{nodeId}:{}), unread: new Set(shared.state?.unreadIds ?? []), readIds, notificationError: shared.error, acknowledge, retry, retryNotificationChanges };
}
