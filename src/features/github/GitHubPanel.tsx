import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { acknowledgeGitHubItem, observeGitHubItems, readUnreadHistory, saveUnreadHistory, type UnreadHistory } from './githubUnread';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Icon } from '../../components/ui/Icon';
import { useGitHubPagination } from './useGitHubPagination';
import type {
  GitHubData,
  GitHubQuery,
  PullRequest,
  Commit,
  GitHubIssue,
  Node,
  Project,
  Section,
} from '../../../shared/contracts';

interface GitHubPanelProps {
  projectId: string | null;
  project?: Project | null;
  projectKind?: 'git' | 'folder' | 'unknown' | null;
  data: GitHubData | null;
  loading: boolean;
  error: string | null;
  query: GitHubQuery;
  onScopeChange: (query: GitHubQuery) => void;
  availableWorktrees: Node[];
  onRefresh: () => void;
  onCollapse?: () => void;
}

type TabKey = 'commits' | 'prs' | 'issues';

export const GitHubPanel: React.FC<GitHubPanelProps> = ({
  projectId,
  project,
  projectKind,
  data,
  loading,
  error,
  query,
  onScopeChange,
  availableWorktrees,
  onRefresh,
  onCollapse,
}) => {
  const isFolder =
    projectKind === 'folder' ||
    project?.kind === 'folder' ||
    data?.projectKind === 'folder';
  const [activeTab, setActiveTab] = useState<TabKey>('commits');
  const [prFilter, setPrFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [issueFilter, setIssueFilter] = useState<'all' | 'open' | 'closed'>('all');
  const history = useRef(new Map<string, UnreadHistory>());
  const [unread, setUnread] = useState<Record<TabKey, Set<string>>>({ commits: new Set(), prs: new Set(), issues: new Set() });
  const repositoryKey = `${projectId}::${data?.repository?.url ?? ''}`;
  const scopeKey = `${data?.scope.kind}::${data?.scope.nodeId}::${data?.scope.branch}`;
  const keys = { commits: `${repositoryKey}::commits::${scopeKey}`, prs: `${repositoryKey}::prs::${scopeKey}`, issues: `${repositoryKey}::issues` };

  const handleDragStart = (
    e: React.DragEvent,
    item: {
      type: 'pr' | 'issue';
      number: number;
      title: string;
      url?: string;
      headRef?: string | null;
      baseRef?: string | null;
      author?: string | null;
      draft?: boolean;
      labels?: string[];
    }
  ) => {
    const payload = JSON.stringify(item);
    e.dataTransfer.setData('application/json', payload);
    e.dataTransfer.setData('text/plain', item.title);
    e.dataTransfer.effectAllowed = 'copy';
    window.dispatchEvent(new CustomEvent('orca:drag-github-item-start', { detail: item }));
  };

  const handleDragEnd = () => {
    window.dispatchEvent(new CustomEvent('orca:drag-github-item-end'));
  };

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

  const acknowledge = (tab: TabKey, id: string) => {
    const stored = history.current.get(keys[tab]);
    if (!stored) return;
    const acknowledged = acknowledgeGitHubItem(stored, id);
    history.current.set(keys[tab], acknowledged);
    saveUnreadHistory(keys[tab], acknowledged);
    setUnread((prev) => ({ ...prev, [tab]: acknowledged.unread }));
  };
  const selectTab = (tab: TabKey) => setActiveTab(tab);
  const notification = (tab: TabKey) => unread[tab].size > 0 ? (
    <span className="github-new-indicator" title={`${unread[tab].size} new items`}>
      <Icon name="bell" size={12} />
      <span className="sr-only">{unread[tab].size} new items</span>
    </span>
  ) : null;

  const repo = data?.repository;
  const auth = data?.auth ?? 'unknown';
  const scope = data?.scope;

  const isSafeGitHubUrl = (url: string | null | undefined): boolean => {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
    } catch {
      return false;
    }
  };

  const formatDateTime = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const renderSectionMeta = (section: Section<any> | undefined, label: string) => {
    if (!section) return null;
    const { meta } = section;
    if (!meta.issue && !meta.stale && !meta.partial && meta.availability === 'ready') {
      return null;
    }

    return (
      <div className="section-meta-alert">
        {meta.issue && (
          <div className="meta-alert-item alert-error">
            <span className="font-semibold">[{meta.issue.code}]:</span> {meta.issue.message}
          </div>
        )}
        {meta.stale && (
          <div className="meta-alert-item alert-stale">
            Data is stale. Last observed: {formatDateTime(meta.observedAt)}
          </div>
        )}
        {meta.availability === 'empty' && !meta.issue && (
          <div className="meta-alert-item alert-info">
            Repository reported empty {label.toLowerCase()}.
          </div>
        )}
      </div>
    );
  };

  const pagination = useGitHubPagination(projectId, data, query, (tab, ids) => {
    const stored = history.current.get(keys[tab]) ?? readUnreadHistory(keys[tab]);
    const next = { seen: new Set([...(stored?.seen ?? []), ...ids]), unread: stored?.unread ?? new Set<string>() };
    history.current.set(keys[tab], next);
    saveUnreadHistory(keys[tab], next);
  });
  const { commits, prs, issues } = pagination;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const more = pagination.nextPage(activeTab);
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

  const openPrCount = prs.filter((p) => p.state === 'open').length;
  const closedPrCount = prs.filter((p) => p.state === 'closed' || p.state === 'merged').length;
  const filteredPrs = prs.filter((p) => {
    if (prFilter === 'open') return p.state === 'open';
    if (prFilter === 'closed') return p.state === 'closed' || p.state === 'merged';
    return true;
  });

  const openIssueCount = issues.filter((i) => i.state === 'open').length;
  const closedIssueCount = issues.filter((i) => i.state === 'closed').length;
  const filteredIssues = issues.filter((i) => {
    if (issueFilter === 'open') return i.state === 'open';
    if (issueFilter === 'closed') return i.state === 'closed';
    return true;
  });

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
    <section className="dashboard-panel github-panel" aria-labelledby="github-panel-title">
      {/* Panel Header */}
      <div className="panel-header github-header">
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
            <h2 id="github-panel-title" className="panel-title">GitHub Activity</h2>
          </div>

          <div className="panel-actions">
            {!isFolder && (
              <span className={`badge badge-auth-${auth}`}>
                Auth: {auth}
              </span>
            )}
            {isFolder && (
              <span className="badge badge-neutral">Folder</span>
            )}
            <button
              type="button"
              className="btn-icon"
              onClick={onRefresh}
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
      </div>

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

          {/* Scope Selector */}
          <div className="github-scope-selector">
        <label htmlFor="github-scope-select" className="scope-label text-xs font-semibold">
          History Scope:
        </label>
        <div className="custom-select-control scope-select-wrapper">
          <select
            id="github-scope-select"
            className="scope-select custom-select-native"
            value={query.scope === 'worktree' ? query.nodeId : 'general'}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'general') {
                onScopeChange({ scope: 'general' });
              } else {
                onScopeChange({ scope: 'worktree', nodeId: val });
              }
            }}
          >
            <option value="general">General (Repository default branch)</option>
            {availableWorktrees.map((wt) => (
              <option key={wt.id} value={wt.id}>
                Worktree: {wt.branch ? `${wt.branch} (${wt.label})` : wt.label}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={12} className="custom-select-arrow" />
        </div>
      </div>

      {/* Tabs: Commits, Pull Requests, Issues */}
      <div ref={tabsRef} className="github-tabs-nav" role="tablist" aria-label="GitHub activity views">
        <span className="github-tab-indicator" aria-hidden="true" style={{
          transform: `translateX(${tabLine.left}px) scaleX(${tabLine.width})`, opacity: tabLine.width ? 1 : 0,
        }} />
        <button
          type="button"
          role="tab"
          id="tab-commits"
          aria-selected={activeTab === 'commits'}
          aria-controls="panel-commits"
          className={`tab-btn ${activeTab === 'commits' ? 'active' : ''} ${unread.commits.size ? 'github-has-new' : ''}`}
          onClick={() => selectTab('commits')}
        >
          Commits
          {unread.commits.size > 0 && <span className="sr-only">{unread.commits.size} new items</span>}
          <span className="tab-count font-mono" title={`${commits.length} loaded`}>{commits.length}{pagination.nextPage('commits') ? '+' : ''}</span>
        </button>

        <button
          type="button"
          role="tab"
          id="tab-prs"
          aria-selected={activeTab === 'prs'}
          aria-controls="panel-prs"
          className={`tab-btn ${activeTab === 'prs' ? 'active' : ''} ${unread.prs.size ? 'github-has-new' : ''}`}
          onClick={() => selectTab('prs')}
        >
          PR History
          {unread.prs.size > 0 && <span className="sr-only">{unread.prs.size} new items</span>}
          <span className="tab-count font-mono" title={`${prs.length} loaded`}>{prs.length}{pagination.nextPage('prs') ? '+' : ''}</span>
        </button>

        <button
          type="button"
          role="tab"
          id="tab-issues"
          aria-selected={activeTab === 'issues'}
          aria-controls="panel-issues"
          className={`tab-btn ${activeTab === 'issues' ? 'active' : ''} ${unread.issues.size ? 'github-has-new' : ''}`}
          onClick={() => selectTab('issues')}
        >
          Issues
          {unread.issues.size > 0 && <span className="sr-only">{unread.issues.size} new items</span>}
          <span className="tab-count font-mono" title={`${issues.length} loaded`}>{issues.length}{pagination.nextPage('issues') ? '+' : ''}</span>
        </button>
      </div>

      {/* Tab Panels */}
      <div className="panel-content github-tab-content" ref={scrollRef}>
        {/* Commits Tab */}
        {activeTab === 'commits' && (
          <div
            id="panel-commits"
            role="tabpanel"
            aria-labelledby="tab-commits"
            className="tab-pane"
          >
            {renderSectionMeta(data?.commits, 'Commits')}
            {commits.length === 0 ? (
              <div className="empty-hint">
                {data?.commits?.meta?.availability === 'empty'
                  ? 'Git repository is empty (no commits pushed yet).'
                  : data?.commits?.meta?.availability === 'unavailable'
                  ? 'Commits unavailable for the selected scope.'
                  : 'No commits available for this branch scope.'}
              </div>
            ) : (
              <ul className="github-item-list" role="list">
                {commits.map((c: Commit) => (
                  <li key={c.sha} className={`github-item ${unread.commits.has(c.sha) ? 'github-has-new' : ''}`} onClick={() => acknowledge('commits', c.sha)}>
                    {unread.commits.has(c.sha) && notification('commits')}
                    <div className="item-row-header">
                      <span className="font-mono commit-sha">
                        {c.sha.slice(0, 7)}
                      </span>
                      <time className="item-time font-mono" dateTime={c.committedAt ?? ''}>
                        {formatDateTime(c.committedAt)}
                      </time>
                    </div>

                    <div className="item-title commit-message">
                      {isSafeGitHubUrl(c.url) ? (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="external-link"
                        >
                          {c.message.split('\n')[0]}
                          <span className="external-arrow" aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        <span>{c.message.split('\n')[0]}</span>
                      )}
                    </div>

                    {c.author && (
                      <div className="item-author text-muted">
                        Author: <span className="font-mono">{c.author}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Pull Requests Tab */}
        {activeTab === 'prs' && (
          <div
            id="panel-prs"
            role="tabpanel"
            aria-labelledby="tab-prs"
            className="tab-pane"
          >
            {/* PR Status Filter: All, Open, Closed */}
            <div className="github-filter-pills" role="radiogroup" aria-label="Filter pull requests by status">
              <button
                type="button"
                className={`filter-pill-btn ${prFilter === 'all' ? 'active' : ''}`}
                onClick={() => setPrFilter('all')}
                aria-pressed={prFilter === 'all'}
              >
                All <span className="pill-count font-mono">{prs.length}</span>
              </button>
              <button
                type="button"
                className={`filter-pill-btn ${prFilter === 'open' ? 'active' : ''}`}
                onClick={() => setPrFilter('open')}
                aria-pressed={prFilter === 'open'}
              >
                Open <span className="pill-count font-mono">{openPrCount}</span>
              </button>
              <button
                type="button"
                className={`filter-pill-btn ${prFilter === 'closed' ? 'active' : ''}`}
                onClick={() => setPrFilter('closed')}
                aria-pressed={prFilter === 'closed'}
              >
                Closed <span className="pill-count font-mono">{closedPrCount}</span>
              </button>
            </div>

            {renderSectionMeta(data?.pullRequests, 'Pull Requests')}

            {filteredPrs.length === 0 ? (
              <div className="empty-hint">
                {prs.length === 0
                  ? 'No pull requests found for this repository and branch filter.'
                  : `No ${prFilter} pull requests found.`}
              </div>
            ) : (
              <ul className="github-item-list" role="list">
                {filteredPrs.map((pr: PullRequest) => {
                  const isOpen = pr.state === 'open';
                  return (
                    <li
                      key={pr.number}
                      draggable={isOpen}
                      onDragStart={(e) => {
                        if (isOpen) {
                          handleDragStart(e, {
                            type: 'pr',
                            number: pr.number,
                            title: pr.title,
                            url: pr.url,
                            headRef: pr.headRef,
                            baseRef: pr.baseRef,
                            author: pr.author,
                            draft: pr.draft,
                          });
                        }
                      }}
                      onDragEnd={handleDragEnd}
                      className={`github-item ${isOpen ? 'draggable-item' : ''} ${unread.prs.has(String(pr.number)) ? 'github-has-new' : ''}`}
                      onClick={() => acknowledge('prs', String(pr.number))}
                      title={isOpen ? 'Drag this PR onto an agent node in the workflow graph to review/merge' : undefined}
                    >
                      {unread.prs.has(String(pr.number)) && notification('prs')}
                      <div className="item-row-header">
                        <div className="item-badges">
                          <span className={`badge badge-pr-${pr.state}`}>
                            {pr.state}
                          </span>
                          {pr.draft && (
                            <span className="badge badge-neutral">Draft</span>
                          )}
                          <span className="font-mono pr-number">#{pr.number}</span>
                          {isOpen && (
                            <span className="drag-indicator-tag" title="Draggable to agent">⋮⋮</span>
                          )}
                        </div>
                        <time className="item-time font-mono" dateTime={pr.updatedAt ?? ''}>
                          {formatDateTime(pr.updatedAt)}
                        </time>
                      </div>

                      <div className="item-title">
                        {isSafeGitHubUrl(pr.url) ? (
                          <a
                            href={pr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="external-link"
                          >
                            {pr.title}
                            <span className="external-arrow" aria-hidden="true">↗</span>
                          </a>
                        ) : (
                          <span>{pr.title}</span>
                        )}
                      </div>

                      <div className="item-extra-info text-xs text-muted">
                        {pr.author && (
                          <span>Author: <strong className="font-mono">{pr.author}</strong></span>
                        )}
                        {pr.headRef && pr.baseRef && (
                          <span className="pr-refs font-mono ml-2">
                            {pr.headRef} → {pr.baseRef}
                          </span>
                        )}
                        {pr.mergedAt && (
                          <span className="pr-merged-at ml-2 text-success">
                            Merged: {formatDateTime(pr.mergedAt)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* Issues Tab */}
        {activeTab === 'issues' && (
          <div
            id="panel-issues"
            role="tabpanel"
            aria-labelledby="tab-issues"
            className="tab-pane"
          >
            {/* Issue Status Filter: All, Open, Closed */}
            <div className="github-filter-pills" role="radiogroup" aria-label="Filter issues by status">
              <button
                type="button"
                className={`filter-pill-btn ${issueFilter === 'all' ? 'active' : ''}`}
                onClick={() => setIssueFilter('all')}
                aria-pressed={issueFilter === 'all'}
              >
                All <span className="pill-count font-mono">{issues.length}</span>
              </button>
              <button
                type="button"
                className={`filter-pill-btn ${issueFilter === 'open' ? 'active' : ''}`}
                onClick={() => setIssueFilter('open')}
                aria-pressed={issueFilter === 'open'}
              >
                Open <span className="pill-count font-mono">{openIssueCount}</span>
              </button>
              <button
                type="button"
                className={`filter-pill-btn ${issueFilter === 'closed' ? 'active' : ''}`}
                onClick={() => setIssueFilter('closed')}
                aria-pressed={issueFilter === 'closed'}
              >
                Closed <span className="pill-count font-mono">{closedIssueCount}</span>
              </button>
            </div>

            {renderSectionMeta(data?.issues, 'Issues')}

            {filteredIssues.length === 0 ? (
              <div className="empty-hint">
                {issues.length === 0
                  ? 'No repository issues found.'
                  : `No ${issueFilter} issues found.`}
              </div>
            ) : (
              <ul className="github-item-list" role="list">
                {filteredIssues.map((issue: GitHubIssue) => {
                  const isOpen = issue.state === 'open';
                  return (
                    <li
                      key={issue.number}
                      draggable={isOpen}
                      onDragStart={(e) => {
                        if (isOpen) {
                          handleDragStart(e, {
                            type: 'issue',
                            number: issue.number,
                            title: issue.title,
                            url: issue.url,
                            author: issue.author,
                            labels: issue.labels,
                          });
                        }
                      }}
                      onDragEnd={handleDragEnd}
                      className={`github-item ${isOpen ? 'draggable-item' : ''} ${unread.issues.has(String(issue.number)) ? 'github-has-new' : ''}`}
                      onClick={() => acknowledge('issues', String(issue.number))}
                      title={isOpen ? 'Drag this issue onto an agent node in the workflow graph to fix' : undefined}
                    >
                      {unread.issues.has(String(issue.number)) && notification('issues')}
                      <div className="item-row-header">
                        <div className="item-badges">
                          <span className={`badge badge-issue-${issue.state}`}>
                            {issue.state}
                          </span>
                          <span className="font-mono pr-number">#{issue.number}</span>
                          {isOpen && (
                            <span className="drag-indicator-tag" title="Draggable to agent">⋮⋮</span>
                          )}
                        </div>
                        <time className="item-time font-mono" dateTime={issue.updatedAt ?? ''}>
                          {formatDateTime(issue.updatedAt)}
                        </time>
                      </div>

                      <div className="item-title">
                        {isSafeGitHubUrl(issue.url) ? (
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="external-link"
                          >
                            {issue.title}
                            <span className="external-arrow" aria-hidden="true">↗</span>
                          </a>
                        ) : (
                          <span>{issue.title}</span>
                        )}
                      </div>

                      <div className="item-extra-info text-xs text-muted">
                        {issue.author && (
                          <span>Author: <strong className="font-mono">{issue.author}</strong></span>
                        )}
                        {issue.labels && issue.labels.length > 0 && (
                          <div className="issue-labels-row">
                            {issue.labels.map((lbl, idx) => (
                              <span key={idx} className="badge badge-neutral text-xs">
                                {lbl}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        <div ref={sentinelRef} className="github-pagination" aria-live="polite" aria-busy={loadingMore}>
          {pageError && <span role="alert">{pageError}</span>}
          {loadingMore ? <div className="github-skeleton-list" role="status" aria-label="Loading more activity">
            <span className="sr-only">Loading more activity</span>
            {[0, 1, 2].map((row) => <div className="github-skeleton-row" key={row} aria-hidden="true">
              <div className="github-skeleton-line short" />
              <div className="github-skeleton-line" />
              <div className="github-skeleton-line medium" />
            </div>)}
          </div> : more && (
            <button className="btn btn-sm" disabled={loading} onClick={() => void pagination.loadMore(activeTab)}>
              {pageError ? 'Retry loading' : 'Load 20 more'}
            </button>
          )}
        </div>
      </div>
    </>
  )}
</section>
);
};
