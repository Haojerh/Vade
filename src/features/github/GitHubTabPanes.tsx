import React, { lazy, Suspense } from 'react';
import { Icon } from '../../components/ui/Icon';
const CommitHistoryGraph = lazy(() => import('./CommitHistoryGraph').then(module => ({ default: module.CommitHistoryGraph })));
import type { useCommitGraph } from './useCommitGraph';
import type {
  Commit,
  GitHubData,
  GitHubIssue,
  PullRequest,
  Section,
} from '../../../shared/contracts';

export type GitHubTabKey = 'commits' | 'prs' | 'issues';

export interface DraggedGitHubItem {
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

export function isSafeGitHubUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

export function formatGitHubDateTime(iso: string | null | undefined): string {
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
}

export function renderGitHubSectionMeta(section: Section<unknown> | undefined, label: string,showEmpty=true): React.ReactNode {
  if (!section) return null;
  const { meta } = section;
  if (!meta.issue && !meta.stale && !meta.partial && (meta.availability === 'ready'||!showEmpty&&meta.availability==='empty')) {
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
          Data is stale. Last observed: {formatGitHubDateTime(meta.observedAt)}
        </div>
      )}
      {showEmpty && meta.availability === 'empty' && !meta.issue && (
        <div className="meta-alert-item alert-info">
          Repository reported empty {label.toLowerCase()}.
        </div>
      )}
    </div>
  );
}

function renderUnreadBell(count: number): React.ReactNode {
  if (count <= 0) return null;
  return (
    <span className="github-new-indicator" title={`${count} new items`}>
      <Icon name="bell" size={12} />
      <span className="sr-only">{count} new items</span>
    </span>
  );
}

function handleDragStart(e: React.DragEvent, item: DraggedGitHubItem) {
  const payload = JSON.stringify(item);
  e.dataTransfer.setData('application/json', payload);
  e.dataTransfer.setData('text/plain', item.title);
  e.dataTransfer.effectAllowed = 'copy';
  window.dispatchEvent(new CustomEvent('orca:drag-github-item-start', { detail: item }));
}

function handleDragEnd() {
  window.dispatchEvent(new CustomEvent('orca:drag-github-item-end'));
}

interface CommitsTabPaneProps {
  panelId: string;
  tabId: string;
  commitGraphEnabled: boolean;
  projectId: string | null;
  graph: ReturnType<typeof useCommitGraph>;
  data: GitHubData | null;
  commits: Commit[];
  unreadCommits: Set<string>;
  onAcknowledge: (sha: string) => void;
}

export const CommitsTabPane: React.FC<CommitsTabPaneProps> = ({
  panelId,
  tabId,
  commitGraphEnabled,
  projectId,
  graph,
  data,
  commits,
  unreadCommits,
  onAcknowledge,
}) => {
  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      className="tab-pane"
    >
      {projectId ? (
        <Suspense fallback={<p role="status">Loading commit history…</p>}><CommitHistoryGraph key={graph.key} observation={graph} showGraph={commitGraphEnabled} /></Suspense>
      ) : (
        <>
          {renderGitHubSectionMeta(data?.commits, 'Commits')}
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
                <li
                  key={c.sha}
                  className={`github-item ${unreadCommits.has(c.sha) ? 'github-has-new' : ''}`}
                  onClick={() => onAcknowledge(c.sha)}
                >
                  {unreadCommits.has(c.sha) && renderUnreadBell(unreadCommits.size)}
                  <div className="item-row-header">
                    <span className="font-mono commit-sha">
                      {c.sha.slice(0, 7)}
                    </span>
                    <time className="item-time font-mono" dateTime={c.committedAt ?? ''}>
                      {formatGitHubDateTime(c.committedAt)}
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
        </>
      )}
    </div>
  );
};

interface PullRequestsTabPaneProps {
  panelId: string;
  tabId: string;
  data: GitHubData | null;
  prs: PullRequest[];
  prFilter: 'all' | 'open' | 'closed';
  onChangeFilter: (filter: 'all' | 'open' | 'closed') => void;
  unreadPrs: Set<string>;
  onAcknowledge: (id: string) => void;
}

export const PullRequestsTabPane: React.FC<PullRequestsTabPaneProps> = ({
  panelId,
  tabId,
  data,
  prs,
  prFilter,
  onChangeFilter,
  unreadPrs,
  onAcknowledge,
}) => {
  const openPrCount = prs.filter((p) => p.state === 'open').length;
  const closedPrCount = prs.filter((p) => p.state === 'closed' || p.state === 'merged').length;
  const filteredPrs = prs.filter((p) => {
    if (prFilter === 'open') return p.state === 'open';
    if (prFilter === 'closed') return p.state === 'closed' || p.state === 'merged';
    return true;
  });

  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      className="tab-pane"
    >
      <div className="github-filter-pills" role="radiogroup" aria-label="Filter pull requests by status">
        <button
          type="button"
          className={`filter-pill-btn ${prFilter === 'all' ? 'active' : ''}`}
          onClick={() => onChangeFilter('all')}
          aria-pressed={prFilter === 'all'}
        >
          All <span className="pill-count font-mono">{prs.length}</span>
        </button>
        <button
          type="button"
          className={`filter-pill-btn ${prFilter === 'open' ? 'active' : ''}`}
          onClick={() => onChangeFilter('open')}
          aria-pressed={prFilter === 'open'}
        >
          Open <span className="pill-count font-mono">{openPrCount}</span>
        </button>
        <button
          type="button"
          className={`filter-pill-btn ${prFilter === 'closed' ? 'active' : ''}`}
          onClick={() => onChangeFilter('closed')}
          aria-pressed={prFilter === 'closed'}
        >
          Closed <span className="pill-count font-mono">{closedPrCount}</span>
        </button>
      </div>

      {renderGitHubSectionMeta(data?.pullRequests, 'Pull Requests',false)}

      {filteredPrs.length === 0 ? (
        data?.pullRequests?.meta.issue?null:
        <div className="empty-hint">
          {prs.length === 0
            ? 'No pull requests found.'
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
                className={`github-item ${isOpen ? 'draggable-item' : ''} ${unreadPrs.has(String(pr.number)) ? 'github-has-new' : ''}`}
                onClick={() => onAcknowledge(String(pr.number))}
                title={isOpen ? 'Drag this PR onto an agent node in the workflow graph to review/merge' : undefined}
              >
                {unreadPrs.has(String(pr.number)) && renderUnreadBell(unreadPrs.size)}
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
                    {formatGitHubDateTime(pr.updatedAt)}
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
                      Merged: {formatGitHubDateTime(pr.mergedAt)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

interface IssuesTabPaneProps {
  panelId: string;
  tabId: string;
  data: GitHubData | null;
  issues: GitHubIssue[];
  issueFilter: 'all' | 'open' | 'closed';
  onChangeFilter: (filter: 'all' | 'open' | 'closed') => void;
  unreadIssues: Set<string>;
  onAcknowledge: (id: string) => void;
}

export const IssuesTabPane: React.FC<IssuesTabPaneProps> = ({
  panelId,
  tabId,
  data,
  issues,
  issueFilter,
  onChangeFilter,
  unreadIssues,
  onAcknowledge,
}) => {
  const openIssueCount = issues.filter((i) => i.state === 'open').length;
  const closedIssueCount = issues.filter((i) => i.state === 'closed').length;
  const filteredIssues = issues.filter((i) => {
    if (issueFilter === 'open') return i.state === 'open';
    if (issueFilter === 'closed') return i.state === 'closed';
    return true;
  });

  return (
    <div
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      className="tab-pane"
    >
      <div className="github-filter-pills" role="radiogroup" aria-label="Filter issues by status">
        <button
          type="button"
          className={`filter-pill-btn ${issueFilter === 'all' ? 'active' : ''}`}
          onClick={() => onChangeFilter('all')}
          aria-pressed={issueFilter === 'all'}
        >
          All <span className="pill-count font-mono">{issues.length}</span>
        </button>
        <button
          type="button"
          className={`filter-pill-btn ${issueFilter === 'open' ? 'active' : ''}`}
          onClick={() => onChangeFilter('open')}
          aria-pressed={issueFilter === 'open'}
        >
          Open <span className="pill-count font-mono">{openIssueCount}</span>
        </button>
        <button
          type="button"
          className={`filter-pill-btn ${issueFilter === 'closed' ? 'active' : ''}`}
          onClick={() => onChangeFilter('closed')}
          aria-pressed={issueFilter === 'closed'}
        >
          Closed <span className="pill-count font-mono">{closedIssueCount}</span>
        </button>
      </div>

      {renderGitHubSectionMeta(data?.issues, 'Issues',false)}

      {filteredIssues.length === 0 ? (
        data?.issues?.meta.issue?null:
        <div className="empty-hint">
          {issues.length === 0
            ? 'No issues found.'
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
                className={`github-item ${isOpen ? 'draggable-item' : ''} ${unreadIssues.has(String(issue.number)) ? 'github-has-new' : ''}`}
                onClick={() => onAcknowledge(String(issue.number))}
                title={isOpen ? 'Drag this issue onto an agent node in the workflow graph to fix' : undefined}
              >
                {unreadIssues.has(String(issue.number)) && renderUnreadBell(unreadIssues.size)}
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
                    {formatGitHubDateTime(issue.updatedAt)}
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
  );
};
