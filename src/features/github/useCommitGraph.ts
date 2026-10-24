import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitGraphData, Section } from '../../../shared/contracts';
import { fetchCommitGraph } from '../../api/client';
import { acknowledgeGitHubItem, observeGitHubItems, readUnreadHistory, saveUnreadHistory, type UnreadHistory } from './githubUnread';
import { useCommitReads } from './useCommitReads';

export function commitGraphNotificationKey(projectId: string | null, nodeId?: string, branch?: string, repositoryId?: string) {
  return JSON.stringify(['local-commit-graph', projectId, repositoryId ?? null, nodeId ?? null, nodeId ? branch ?? null : null]);
}

interface GraphObservation { key: string; section: Section<CommitGraphData> | null; loading: boolean; error: string; unread: Set<string> }

export function useCommitGraph(projectId: string | null, nodeId: string | undefined, branch: string | undefined, refresh: number, enabled: boolean, repositoryId?: string) {
  const key = commitGraphNotificationKey(projectId, nodeId, branch, repositoryId);
  const reads = useCommitReads(key);
  const histories = useRef(new Map<string, UnreadHistory>());
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<GraphObservation>({ key, section: null, loading: true, error: '', unread: new Set() });
  useEffect(() => {
    if (!enabled || !projectId) return;
    let request: AbortController | null = null;
    const load = async () => {
      request?.abort();
      const controller = new AbortController(); request = controller;
      const previous = histories.current.get(key) ?? readUnreadHistory(key);
      if (previous) histories.current.set(key, previous);
      setState(prev => ({ key, section: prev.key === key ? prev.section : null, error: '', loading: true, unread: previous?.unread ?? new Set() }));
      try {
        const section = await fetchCommitGraph(projectId, nodeId, controller.signal);
        if (controller.signal.aborted) return;
        let history = histories.current.get(key);
        if (section.data && !section.meta.stale && !section.meta.issue && ['ready', 'empty'].includes(section.meta.availability)) {
          history = observeGitHubItems(history, section.data.commits.map(commit => commit.sha));
          histories.current.set(key, history); saveUnreadHistory(key, history);
        }
        setState(prev => ({ key, section: section.data ? section : prev.key === key ? prev.section ?? section : section, error: section.meta.issue?.message ?? '', loading: false, unread: history?.unread ?? new Set() }));
      } catch (e) { if (!controller.signal.aborted) setState(prev => ({ ...prev, error: (e as Error).message, loading: false })); }
    };
    void load();
    const timer = setInterval(() => void load(), 60000);
    return () => { clearInterval(timer); request?.abort(); };
  }, [enabled, projectId, nodeId, key, refresh, attempt]);
  const acknowledge = useCallback((sha: string) => {
    reads.acknowledge(sha);
    const history = histories.current.get(key) ?? readUnreadHistory(key);
    if (!history) return;
    const next = acknowledgeGitHubItem(history, sha);
    histories.current.set(key, next); saveUnreadHistory(key, next);
    setState(prev => prev.key === key ? { ...prev, unread: next.unread } : prev);
  }, [key, reads.acknowledge]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const current = state.key === key ? state : { key, section: null, error: '', loading: true, unread: new Set<string>() };
  return { ...current, ...(projectId?{projectId}:{}),...(nodeId?{nodeId}:{}), unread: new Set([...current.unread].filter(sha => !reads.ids.has(sha))), readIds: reads.ids, acknowledge, retry };
}
