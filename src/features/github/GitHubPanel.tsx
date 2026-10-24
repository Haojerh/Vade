import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acknowledgeGitHubItem, observeGitHubItems, readUnreadHistory, saveUnreadHistory, type UnreadHistory } from './githubUnread';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Icon } from '../../components/ui/Icon';
import { useGitHubPagination } from './useGitHubPagination';
import { useCommitGraph } from './useCommitGraph';
import {
  CommitsTabPane,
  PullRequestsTabPane,
  IssuesTabPane,
  isSafeGitHubUrl,
  type GitHubTabKey,
} from './GitHubTabPanes';
import type {
  GitHubData,
  GitHubQuery,
  Project,
} from '../../../shared/contracts';

interface GitHubPanelProps {
  projectId: string | null;
  project?: Project | null;
  projectKind?: 'git' | 'folder' | 'unknown' | null;
  data: GitHubData | null;
  loading: boolean;
  error: string | null;
  query?: GitHubQuery;
  embedded?: boolean;
  onRefresh: () => void;
  onCollapse?: () => void;
  commitGraphEnabled?: boolean;
  worktreeBranch?: string;
  onCreatePr?:()=>void;
  refreshVersion?:number;
}

const REPOSITORY_QUERY: GitHubQuery = { scope: 'general' };

export const GitHubPanel: React.FC<GitHubPanelProps> = ({
  projectId,
  project,
  projectKind,
  data,
  loading,
  error,
  query = REPOSITORY_QUERY,
  embedded = false,
  onRefresh,
  onCollapse,
  commitGraphEnabled = false,
  worktreeBranch,
  onCreatePr,
  refreshVersion=0,
}) => {
  const instanceId = React.useId();
  const titleId = `${instanceId}-github-title`;
  const tabId = (tab: GitHubTabKey) => `${instanceId}-tab-${tab}`;
  const panelId = (tab: GitHubTabKey) => `${instanceId}-panel-${tab}`;
  const isFolder =
    projectKind === 'folder' ||
    project?.kind === 'folder' ||
    data?.projectKind === 'folder';
  const [activeTab, setActiveTab] = useState<GitHubTabKey>('commits');
  const [graphRefresh, setGraphRefresh] = useState(0);
  const graph = useCommitGraph(projectId, query.scope === 'worktree' ? query.nodeId : undefined, worktreeBranch, graphRefresh+refreshVersion, !isFolder, project?.repoIds.join('|'));
  const graphUnread = graph.unread.size;
  const [prFilter, setPrFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [issueFilter, setIssueFilter] = useState<'all' | 'open' | 'closed'>('all');
  const history = useRef(new Map<string, UnreadHistory>());
  const [observedUnread, setUnread] = useState<Record<GitHubTabKey, Set<string>>>({ commits: new Set(), prs: new Set(), issues: new Set() });
  const unread = { ...observedUnread, commits: new Set([...observedUnread.commits].filter(sha => !graph.readIds.has(sha))) };
  const repositoryKey = `${projectId}::${data?.repository?.url ?? ''}`;
  const scopeKey = `${data?.scope.kind}::${data?.scope.nodeId}::${data?.scope.branch}`;
  const keys = { commits: `${repositoryKey}::commits::${scopeKey}`, prs: `${repositoryKey}::prs::${scopeKey}`, issues: `${repositoryKey}::issues` };

  useEffect(() => {
    const next = { commits: new Set<string>(), prs: new Set<string>(), issues: new Set<string>() };
    if (data?.repository) {
      const sections = { commits: data.commits, prs: data.pullRequests, issues: data.issues };
      for (const tab of ['commits', 'prs', 'issues'] as const) {
        const section = sections[tab];
        let stored = history.current.get(keys[tab]) ?? readUnreadHistory(keys[tab]);
        if (stored) history.current.set(keys[tab], stored);
        if (!section.meta.stale && !section.meta.issue && ['ready', 'empty'].includes(section.meta.availability) && section.data) {
          const ids = tab === 'commits' ? data.commits.data?.map((item) => item.sha) ?? [] :
            tab === 'prs' ? data.pullRequests.data?.map((item) => String(item.number)) ?? [] :
              data.issues.data?.map((item) => String(item.number)) ?? [];
          stored = observeGitHubItems(stored, ids);
          history.current.set(keys[tab], stored);
          saveUnreadHistory(keys[tab], stored);
        }
        next[tab] = stored?.unread ?? new Set();
      }
    }
    setUnread(next);
  }, [data, projectId]);

  const acknowledge = (tab: GitHubTabKey, id: string) => {
    if (tab === 'commits') graph.acknowledge(id);
    const stored = history.current.get(keys[tab]);
    if (!stored) return;
    const acknowledged = acknowledgeGitHubItem(stored, id);
    history.current.set(keys[tab], acknowledged);
    saveUnreadHistory(keys[tab], acknowledged);
    setUnread((prev) => ({ ...prev, [tab]: acknowledged.unread }));
  };
  const selectTab = (tab: GitHubTabKey) => setActiveTab(tab);

  const repo = data?.repository;

  const pagination = useGitHubPagination(projectId, data, query, (tab, ids) => {
    const stored = history.current.get(keys[tab]) ?? readUnreadHistory(keys[tab]);
    const next = { seen: new Set([...(stored?.seen ?? []), ...ids]), unread: stored?.unread ?? new Set<string>() };
    history.current.set(keys[tab], next);
    saveUnreadHistory(keys[tab], next);
  });
  const { commits, prs, issues } = pagination;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const more = !!projectId && activeTab === 'commits' ? null : pagination.nextPage(activeTab);
  const loadingMore = pagination.loading.includes(activeTab);
  const pageError = pagination.errors[activeTab];
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !more || loading || loadingMore || pageError || error) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void pagination.loadMore(activeTab);
    }, { root: scrollRef.current, rootMargin: '160px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeTab, more, loading, loadingMore, pageError, error, data]);

  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabLine, setTabLine] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    const measure = () => {
      const tab = bar.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!tab) return;
      const style = getComputedStyle(tab);
      const paddingLeft = parseFloat(style.paddingLeft);
      const paddingRight = parseFloat(style.paddingRight);
      const left = tab.offsetLeft + tab.clientLeft + paddingLeft;
      const width = Math.max(0, tab.clientWidth - paddingLeft - paddingRight);
      setTabLine((current) => current.left === left && current.width === width
        ? current : { left, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    bar.querySelectorAll('button').forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [activeTab]);

  return (
    <section className={`dashboard-panel github-panel ${embedded ? 'worktree-history-panel' : ''}`} aria-labelledby={embedded?titleId:undefined} aria-label={embedded?undefined:'Repository activity'}>
      {/* Panel Header */}
      {embedded&&<div className="panel-header github-header">
        <div className="github-header-top">
          <div className="panel-title-row">
            <svg
              className="github-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            <h2 id={titleId} className="panel-title">{embedded ? 'Branch Activity' : 'GitHub Activity'}</h2>
          </div>

          <div className="panel-actions">
            {isFolder && (
              <span className="badge badge-neutral">Folder</span>
            )}
            <button
              type="button"
              className="btn-icon"
              onClick={() => { setGraphRefresh(value => value + 1); onRefresh(); }}
              disabled={loading || isFolder}
              aria-label={isFolder ? 'GitHub not connected for folder project' : 'Refresh GitHub activity'}
              title={isFolder ? 'GitHub not connected for folder project' : 'Refresh GitHub activity'}
            >
              <RefreshIcon busy={loading} />
            </button>
            {onCollapse && (
              <button
                type="button"
                className="btn-icon panel-collapse-btn"
                onClick={onCollapse}
                aria-label="Collapse GitHub sidebar"
                title="Collapse GitHub sidebar"
              >
                <Icon name="chevrons-right" size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="github-header-sub">
          {isFolder ? (
            <div className="panel-subtitle text-muted">Folder workspace</div>
          ) : repo ? (
            <div className="panel-subtitle">
              {isSafeGitHubUrl(repo.url) ? (
                <a
                  href={repo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="repo-link external-link"
                >
                  <span className="repo-link-text">
                    {repo.owner}/{repo.name}{repo.remoteName ? ` (${repo.remoteName})` : ''}
                  </span>
                  <span className="external-arrow" aria-hidden="true">↗</span>
                </a>
              ) : (
                <span className="repo-name font-mono">{repo.owner}/{repo.name}</span>
              )}
            </div>
          ) : (
            <div className="panel-subtitle text-muted">No associated repository</div>
          )}
        </div>
      </div>}

      {isFolder ? (
        <div className="github-folder-empty-state" role="status">
          <div className="github-folder-empty-icon" aria-hidden="true">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="9" y1="13" x2="15" y2="13" />
            </svg>
          </div>
          <h3 className="github-folder-empty-title">No GitHub connected for project</h3>
          <p className="github-folder-empty-desc">
            This project is a local folder workspace and is not linked to a Git repository or GitHub remote.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div className="panel-alert alert-error" role="alert">
              <span className="font-semibold">GitHub Request Error:</span> {error}
            </div>
          )}

          {/* Tabs: Commits, Pull Requests, Issues */}
          <div ref={tabsRef} className="github-tabs-nav" role="tablist" aria-label={embedded ? 'Worktree history views' : 'GitHub activity views'}>
            <span className="github-tab-indicator" aria-hidden="true" style={{
              transform: `translateX(${tabLine.left}px) scaleX(${tabLine.width})`, opacity: tabLine.width ? 1 : 0,
            }} />
            <button
              type="button"
              role="tab"
              id={tabId('commits')}
              aria-selected={activeTab === 'commits'}
              aria-controls={panelId('commits')}
              className={`tab-btn ${activeTab === 'commits' ? 'active' : ''} ${(projectId ? graphUnread : unread.commits.size) ? 'github-has-new' : ''}`}
              onClick={() => selectTab('commits')}
            >
              Commits
              {!projectId && unread.commits.size > 0 && <span className="sr-only">{unread.commits.size} new items</span>}
              {projectId && graphUnread > 0 && <span className="sr-only">{graphUnread} new items</span>}
              {!projectId && <span className="tab-count font-mono" title={`${commits.length} loaded`}>{commits.length}{pagination.nextPage('commits') ? '+' : ''}</span>}
              {projectId && graph.section?.data && <span className="tab-count font-mono" title={`${graph.section.data.commits.length} local commits loaded`}>{graph.section.data.commits.length}{graph.section.data.truncated ? '+' : ''}</span>}
            </button>

            <button
              type="button"
              role="tab"
              id={tabId('prs')}
              aria-selected={activeTab === 'prs'}
              aria-controls={panelId('prs')}
              className={`tab-btn ${activeTab === 'prs' ? 'active' : ''} ${unread.prs.size ? 'github-has-new' : ''}`}
              onClick={() => selectTab('prs')}
            >
              PR History
              {unread.prs.size > 0 && <span className="sr-only">{unread.prs.size} new items</span>}
              <span className="tab-count font-mono" title={`${prs.length} loaded`}>{prs.length}{pagination.nextPage('prs') ? '+' : ''}</span>
            </button>

            {!embedded && (
              <button
                type="button"
                role="tab"
                id={tabId('issues')}
                aria-selected={activeTab === 'issues'}
                aria-controls={panelId('issues')}
                className={`tab-btn ${activeTab === 'issues' ? 'active' : ''} ${unread.issues.size ? 'github-has-new' : ''}`}
                onClick={() => selectTab('issues')}
              >
                Issues
                {unread.issues.size > 0 && <span className="sr-only">{unread.issues.size} new items</span>}
                <span className="tab-count font-mono" title={`${issues.length} loaded`}>{issues.length}{pagination.nextPage('issues') ? '+' : ''}</span>
              </button>
            )}
          </div>

          {/* Tab Panels */}
          <div className="panel-content github-tab-content" ref={scrollRef}>
            {activeTab==='prs'&&onCreatePr&&<button type="button" className="btn btn-secondary btn-xs scm-pr-entry" onClick={onCreatePr}><Icon name="git-pull-request" size={13}/>Create PR</button>}
            {activeTab === 'commits' && (
              <CommitsTabPane
                panelId={panelId('commits')}
                tabId={tabId('commits')}
                commitGraphEnabled={commitGraphEnabled}
                projectId={projectId}
                graph={graph}
                data={data}
                commits={commits}
                unreadCommits={unread.commits}
                onAcknowledge={(sha) => acknowledge('commits', sha)}
              />
            )}

            {activeTab === 'prs' && (
              <PullRequestsTabPane
                panelId={panelId('prs')}
                tabId={tabId('prs')}
                data={data}
                prs={prs}
                prFilter={prFilter}
                onChangeFilter={setPrFilter}
                unreadPrs={unread.prs}
                onAcknowledge={(id) => acknowledge('prs', id)}
              />
            )}

            {activeTab === 'issues' && (
              <IssuesTabPane
                panelId={panelId('issues')}
                tabId={tabId('issues')}
                data={data}
                issues={issues}
                issueFilter={issueFilter}
                onChangeFilter={setIssueFilter}
                unreadIssues={unread.issues}
                onAcknowledge={(id) => acknowledge('issues', id)}
              />
            )}

            {!(!!projectId && activeTab === 'commits') && (
              <div ref={sentinelRef} className="github-pagination" aria-live="polite" aria-busy={loadingMore}>
                {pageError && <span role="alert">{pageError}</span>}
                {loadingMore ? (
                  <div className="github-skeleton-list" role="status" aria-label="Loading more activity">
                    <span className="sr-only">Loading more activity</span>
                    {[0, 1, 2].map((row) => (
                      <div className="github-skeleton-row" key={row} aria-hidden="true">
                        <div className="github-skeleton-line short" />
                        <div className="github-skeleton-line" />
                        <div className="github-skeleton-line medium" />
                      </div>
                    ))}
                  </div>
                ) : (
                  more && (
                    <button className="btn btn-sm" disabled={loading} onClick={() => void pagination.loadMore(activeTab)}>
                      {pageError ? 'Retry loading' : 'Load 20 more'}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};
