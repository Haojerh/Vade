import { useEffect, useRef, useState } from 'react';
import { fetchGitHub } from '../../api/client';
import type { Commit, GitHubActivity, GitHubData, GitHubIssue, GitHubQuery, PullRequest } from '../../../shared/contracts';

type Items = { commits: Commit[]; prs: PullRequest[]; issues: GitHubIssue[] };
type Pages = Partial<Record<GitHubActivity, number | null>>;
const empty = (): Items => ({ commits: [], prs: [], issues: [] });
const id = (item: Commit | PullRequest | GitHubIssue) => 'sha' in item ? item.sha : String(item.number);
export function mergeGitHubItems<T extends Commit | PullRequest | GitHubIssue>(first: T[], older: T[]): T[] {
  const seen = new Set<string>();
  return [...first, ...older].filter((item) => {
    if (seen.has(id(item))) return false;
    seen.add(id(item));
    return true;
  });
}

export function useGitHubPagination(projectId: string | null, data: GitHubData | null, query: GitHubQuery,
  onHistory: (tab: GitHubActivity, ids: string[]) => void) {
  const key = `${projectId}::${data?.repository?.url}::${query.scope}::${query.scope === 'worktree' ? query.nodeId : ''}::${data?.scope.branch}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const requests = useRef(new Map<GitHubActivity, AbortController>());
  const [state, setState] = useState<{ key: string; items: Items; pages: Pages; loading: GitHubActivity[]; errors: Partial<Record<GitHubActivity, string>> }>(
    { key, items: empty(), pages: {}, loading: [], errors: {} });
  useEffect(() => {
    setState({ key, items: empty(), pages: {}, loading: [], errors: {} });
    return () => { requests.current.forEach((controller) => controller.abort()); requests.current.clear(); };
  }, [key]);
  const visible: Omit<typeof state, 'key'> = state.key === key ? state : { items: empty(), pages: {}, loading: [], errors: {} };
  const nextPage = (tab: GitHubActivity) => {
    const section = tab === 'prs' ? data?.pullRequests : data?.[tab];
    if (!section || section.meta.issue || section.meta.stale) return null;
    return Object.prototype.hasOwnProperty.call(visible.pages, tab) ? visible.pages[tab] : data?.pagination?.[tab].nextPage;
  };
  const loadMore = async (tab: GitHubActivity) => {
    const page = nextPage(tab);
    if (!projectId || !data?.repository || !page || requests.current.has(tab)) return;
    const controller = new AbortController();
    requests.current.set(tab, controller);
    setState((previous) => ({ ...previous, loading: [...previous.loading, tab], errors: { ...previous.errors, [tab]: undefined } }));
    try {
      const result = await fetchGitHub(projectId, { ...query, activity: tab, page }, controller.signal);
      if (currentKey.current !== key || controller.signal.aborted) return;
      if (result.repository?.url !== data.repository.url || result.scope.branch !== data.scope.branch) throw new Error('Repository changed. Refresh to continue.');
      const section = tab === 'prs' ? result.pullRequests : result[tab];
      if (!section.data || section.meta.issue || section.meta.stale) throw new Error(section.meta.issue?.message ?? 'Unable to load more activity');
      const items = section.data;
      onHistory(tab, items.map(id));
      setState((previous) => ({ ...previous,
        items: { ...previous.items, [tab]: mergeGitHubItems(previous.items[tab] as (Commit | PullRequest | GitHubIssue)[], items) },
        pages: { ...previous.pages, [tab]: result.pagination?.[tab].nextPage ?? null },
      }));
    } catch (error) {
      if (!controller.signal.aborted && currentKey.current === key) setState((previous) => ({ ...previous, errors: { ...previous.errors, [tab]: error instanceof Error ? error.message : 'Unable to load more activity' } }));
    } finally {
      if (requests.current.get(tab) === controller) requests.current.delete(tab);
      if (currentKey.current === key && !controller.signal.aborted) setState((previous) => ({ ...previous, loading: previous.loading.filter((item) => item !== tab) }));
    }
  };
  return {
    commits: mergeGitHubItems(data?.commits.data ?? [], visible.items.commits),
    prs: mergeGitHubItems(data?.pullRequests.data ?? [], visible.items.prs),
    issues: mergeGitHubItems(data?.issues.data ?? [], visible.items.issues),
    nextPage, loadMore, loading: visible.loading, errors: visible.errors,
  };
}
