import React, { useState } from 'react';
import { layoutCommitGraph } from './commitGraphLayout';
import type { useCommitGraph } from './useCommitGraph';
import { Icon } from '../../components/ui/Icon';

const colors = ['#3899ff', '#f5b700', '#e34ba0', '#40ba94', '#a78bfa', '#e98549'];
export function CommitHistoryGraph({ observation: state }: { observation: ReturnType<typeof useCommitGraph> }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (state.loading && !state.section?.data) return <div className="commit-history-loading" role="status" aria-label="Loading commit graph">{[0, 1, 2, 3, 4].map(i => <div key={i} className="commit-history-skeleton" />)}</div>;
  const errorNotice = state.error && <div className="panel-alert alert-error" role="alert">{state.error}{state.section?.data && ' Showing previously loaded history.'}<button className="btn btn-xs btn-secondary" disabled={state.loading} onClick={state.retry}>Retry</button></div>;
  if (state.error && !state.section?.data) return errorNotice;
  const data = state.section?.data;
  if (!data?.commits.length) return <div className="empty-hint">{state.section?.meta.availability === 'unsupported' ? 'Commit history requires a local Git repository.' : 'No local commits available.'}</div>;
  const rows = layoutCommitGraph(data.commits);
  const width = Math.max(26, ...rows.map(r => r.width));
  const x = (lane: number) => 10 + lane * 14;
  return <div className="commit-history-graph" aria-busy={state.loading}>
    {errorNotice}
    <ul aria-label="Commit graph history">{rows.map(({ commit, lane, color, connected, before, after }) => <li key={commit.sha}>
      <div className="commit-history-rail" style={{ width }} aria-hidden="true"><svg width={width} height="100%" viewBox={`0 0 ${width} 36`} preserveAspectRatio="none">
        {before.map((l, i) => l.sha === commit.sha ? (connected && <path key={l.sha} d={`M ${x(i)} 0 V 18`} stroke={colors[l.color % colors.length]} />) : <path key={l.sha} d={`M ${x(i)} 0 C ${x(i)} 18, ${x(after.findIndex(a => a.sha === l.sha))} 18, ${x(after.findIndex(a => a.sha === l.sha))} 36`} stroke={colors[l.color % colors.length]} />)}
        {commit.parents.map(sha => { const to = after.findIndex(l => l.sha === sha); return <path key={sha} d={`M ${x(lane)} 18 C ${x(lane)} 30, ${x(to)} 24, ${x(to)} 36`} stroke={colors[after[to].color % colors.length]} />; })}
      </svg><svg className="commit-history-dot" width={width} height="36"><circle cx={x(lane)} cy="18" r={commit.parents.length > 1 ? 4 : 3} fill={commit.parents.length > 1 ? 'var(--surface-1)' : colors[color % colors.length]} stroke={colors[color % colors.length]} strokeWidth="2" /></svg></div>
      <div className="commit-history-content"><button className="commit-history-row" aria-expanded={expanded === commit.sha} onClick={() => { state.acknowledge(commit.sha); setExpanded(expanded === commit.sha ? null : commit.sha); }} title={commit.message}><span className="commit-history-chevron">{expanded === commit.sha ? '⌄' : '›'}</span>{state.unread.has(commit.sha) && <span className="github-new-indicator" title="New commit"><Icon name="bell" size={12} /><span className="sr-only">New commit</span></span>}<span className="commit-history-subject">{commit.message}</span>{commit.refs.slice(0, 2).map(ref => <span key={ref} className={`commit-history-ref ${/^HEAD(?: ->|$)/.test(ref) ? 'is-head' : ''}`} title={ref}>{ref.replace('HEAD -> ', '')}</span>)}{commit.refs.length > 2 && <span className="commit-history-ref" title={commit.refs.slice(2).join(', ')}>+{commit.refs.length - 2}</span>}</button>
        {expanded === commit.sha && <div className="commit-history-details"><span className="font-mono">{commit.sha.slice(0, 12)}</span><span>{commit.author} · {new Date(commit.committedAt).toLocaleString()}</span><span>{commit.parents.length > 1 ? `Merge · ${commit.parents.length} parents` : commit.parents.length === 0 ? 'Root commit' : ''}</span></div>}
      </div>
    </li>)}</ul>
    {data.truncated && <p className="text-xs text-muted">Showing the newest 200 commits. Lines continue beyond this window.</p>}
  </div>;
}
