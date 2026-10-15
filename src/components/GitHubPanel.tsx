import React, { useState } from 'react';
import type {
  GitHubData,
  GitHubQuery,
  PullRequest,
  Commit,
  GitHubIssue,
  Node,
  Section,
} from '../../shared/contracts';

interface GitHubPanelProps {
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
  data,
  loading,
  error,
  query,
  onScopeChange,
  availableWorktrees,
  onRefresh,
  onCollapse,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('commits');

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
        {meta.partial && (
          <div className="meta-alert-item alert-partial">
            Capped window: partial {label.toLowerCase()} data returned (20 items max).
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

  const commits = data?.commits?.data ?? [];
  const prs = data?.pullRequests?.data ?? [];
  const issues = data?.issues?.data ?? [];

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
            <span className={`badge badge-auth-${auth}`}>
              Auth: {auth}
            </span>
            <button
              type="button"
              className="btn-icon"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh GitHub activity"
              title="Refresh GitHub activity"
            >
              <svg
                className={loading ? 'spin' : ''}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
            {onCollapse && (
              <button
                type="button"
                className="btn-icon panel-collapse-btn"
                onClick={onCollapse}
                aria-label="Collapse GitHub sidebar"
                title="Collapse GitHub sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="13 17 18 12 13 7" />
                  <polyline points="6 17 11 12 6 7" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="github-header-sub">
          {repo ? (
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
          <svg
            className="custom-select-arrow"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>

      {/* Tabs: Commits, Pull Requests, Issues */}
      <div className="github-tabs-nav" role="tablist" aria-label="GitHub activity views">
        <button
          type="button"
          role="tab"
          id="tab-commits"
          aria-selected={activeTab === 'commits'}
          aria-controls="panel-commits"
          className={`tab-btn ${activeTab === 'commits' ? 'active' : ''}`}
          onClick={() => setActiveTab('commits')}
        >
          Commits
          <span className="tab-count font-mono">{commits.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          id="tab-prs"
          aria-selected={activeTab === 'prs'}
          aria-controls="panel-prs"
          className={`tab-btn ${activeTab === 'prs' ? 'active' : ''}`}
          onClick={() => setActiveTab('prs')}
        >
          PR History
          <span className="tab-count font-mono">{prs.length}</span>
        </button>

        <button
          type="button"
          role="tab"
          id="tab-issues"
          aria-selected={activeTab === 'issues'}
          aria-controls="panel-issues"
          className={`tab-btn ${activeTab === 'issues' ? 'active' : ''}`}
          onClick={() => setActiveTab('issues')}
        >
          Issues
          <span className="tab-count font-mono">{issues.length}</span>
        </button>
      </div>

      {/* Tab Panels */}
      <div className="panel-content github-tab-content">
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
                  <li key={c.sha} className="github-item">
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
            {renderSectionMeta(data?.pullRequests, 'Pull Requests')}
            {prs.length === 0 ? (
              <div className="empty-hint">
                No pull requests found for this repository and branch filter.
              </div>
            ) : (
              <ul className="github-item-list" role="list">
                {prs.map((pr: PullRequest) => (
                  <li key={pr.number} className="github-item">
                    <div className="item-row-header">
                      <div className="item-badges">
                        <span className={`badge badge-pr-${pr.state}`}>
                          {pr.state}
                        </span>
                        {pr.draft && (
                          <span className="badge badge-neutral">Draft</span>
                        )}
                        <span className="font-mono pr-number">#{pr.number}</span>
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
                ))}
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
            {renderSectionMeta(data?.issues, 'Issues')}
            {issues.length === 0 ? (
              <div className="empty-hint">
                No repository issues found.
              </div>
            ) : (
              <ul className="github-item-list" role="list">
                {issues.map((issue: GitHubIssue) => (
                  <li key={issue.number} className="github-item">
                    <div className="item-row-header">
                      <div className="item-badges">
                        <span className={`badge badge-issue-${issue.state}`}>
                          {issue.state}
                        </span>
                        <span className="font-mono pr-number">#{issue.number}</span>
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
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
