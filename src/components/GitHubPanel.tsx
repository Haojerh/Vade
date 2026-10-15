import React, { useState } from 'react';
import type { GitHubData, PullRequest, Commit, PushEvent, Section } from '../../shared/contracts';

interface GitHubPanelProps {
  data: GitHubData | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

type TabKey = 'prs' | 'commits' | 'pushes';

export const GitHubPanel: React.FC<GitHubPanelProps> = ({
  data,
  loading,
  error,
  onRefresh,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('prs');

  const repo = data?.repository;
  const auth = data?.auth ?? 'unknown';

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

  const renderSectionMeta = (section: Section<any> | undefined) => {
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
            Capped window: partial repository data available.
          </div>
        )}
        {meta.availability === 'empty' && !meta.issue && (
          <div className="meta-alert-item alert-info">
            Repository reported an empty resource set.
          </div>
        )}
      </div>
    );
  };

  const prs = data?.pullRequests?.data ?? [];
  const commits = data?.commits?.data ?? [];
  const pushes = data?.pushEvents?.data ?? [];

  return (
    <section className="dashboard-panel github-panel" aria-labelledby="github-panel-title">
      {/* Panel Header */}
      <div className="panel-header">
        <div className="panel-title-group">
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
          {repo ? (
            <div className="panel-subtitle">
              {isSafeGitHubUrl(repo.url) ? (
                <a
                  href={repo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="repo-link external-link"
                >
                  {repo.owner}/{repo.name}
                  {repo.remoteName && <span className="remote-badge">({repo.remoteName})</span>}
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
        </div>
      </div>

      {error && (
        <div className="panel-alert alert-error" role="alert">
          <span className="font-semibold">GitHub Request Error:</span> {error}
        </div>
      )}

      {/* Tabs */}
      <div className="github-tabs-nav" role="tablist" aria-label="GitHub activity views">
        <button
          type="button"
          role="tab"
          id="tab-prs"
          aria-selected={activeTab === 'prs'}
          aria-controls="panel-prs"
          className={`tab-btn ${activeTab === 'prs' ? 'active' : ''}`}
          onClick={() => setActiveTab('prs')}
        >
          Pull Requests
          <span className="tab-count font-mono">{prs.length}</span>
        </button>
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
          id="tab-pushes"
          aria-selected={activeTab === 'pushes'}
          aria-controls="panel-pushes"
          className={`tab-btn ${activeTab === 'pushes' ? 'active' : ''}`}
          onClick={() => setActiveTab('pushes')}
        >
          Push Events
          <span className="tab-count font-mono">{pushes.length}</span>
        </button>
      </div>

      {/* Tab Panels */}
      <div className="panel-content github-tab-content">
        {/* Pull Requests Tab */}
        {activeTab === 'prs' && (
          <div
            id="panel-prs"
            role="tabpanel"
            aria-labelledby="tab-prs"
            className="tab-pane"
          >
            {renderSectionMeta(data?.pullRequests)}
            {prs.length === 0 ? (
              <div className="empty-hint">
                No pull requests found for this repository.
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
                      <time className="item-time font-mono" dateTime={pr.updatedAt}>
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

                    {pr.author && (
                      <div className="item-author text-muted">
                        Author: <span className="font-mono">{pr.author}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Commits Tab */}
        {activeTab === 'commits' && (
          <div
            id="panel-commits"
            role="tabpanel"
            aria-labelledby="tab-commits"
            className="tab-pane"
          >
            {renderSectionMeta(data?.commits)}
            {commits.length === 0 ? (
              <div className="empty-hint">
                {data?.commits?.meta?.availability === 'empty'
                  ? 'Git repository is empty (no commits pushed yet).'
                  : 'No commits available for this repository.'}
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

        {/* Push Events Tab */}
        {activeTab === 'pushes' && (
          <div
            id="panel-pushes"
            role="tabpanel"
            aria-labelledby="tab-pushes"
            className="tab-pane"
          >
            {renderSectionMeta(data?.pushEvents)}
            <div className="push-events-disclaimer">
              <span className="font-semibold">Note:</span> Shows the available repository event window (last 100 events). This is not an exhaustive audit log.
            </div>

            {pushes.length === 0 ? (
              <div className="empty-hint">
                No push events found in the available event window.
              </div>
            ) : (
              <ul className="github-item-list" role="list">
                {pushes.map((p: PushEvent) => (
                  <li key={p.id} className="github-item">
                    <div className="item-row-header">
                      <span className="badge badge-neutral font-mono">
                        {p.ref ? p.ref.replace('refs/heads/', '') : 'Push'}
                      </span>
                      <time className="item-time font-mono" dateTime={p.at}>
                        {formatDateTime(p.at)}
                      </time>
                    </div>

                    <div className="push-details-row">
                      {p.actor && (
                        <div className="push-actor">
                          Actor: <span className="font-mono font-semibold">{p.actor}</span>
                        </div>
                      )}
                      {p.head && (
                        <div className="push-head text-muted font-mono">
                          Head: {p.head.slice(0, 7)}
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
