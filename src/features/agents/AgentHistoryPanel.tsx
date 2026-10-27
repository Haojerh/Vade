import React, { useEffect, useRef, useState } from 'react';
import type { AgentHistoryPage, AgentHistorySession, Node } from '../../../shared/contracts';
import { fetchAgentHistory } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { Select } from '../../components/ui/Select';
import { Disclosure } from '../../components/ui/Disclosure';
import { SESSION_DRAG_TYPE, type HistoryDrag } from './historyDrag';

export function historyAge(at: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
export function AgentHistoryPanel({ projectId, worktrees, onResume, onOpen, onDragSession, revision = 0 }: {
  projectId: string | null; worktrees: Node[]; onResume: (id: string, worktreeId: string) => Promise<unknown>; onOpen: (projectId: string, nodeId: string) => void; revision?: number; onDragSession?: (session: HistoryDrag | null) => void;
}) {
  const [scope, setScope] = useState<'workspace' | 'project' | 'all'>('workspace');
  const [workspaceId, setWorkspaceId] = useState('');
  const workspace = worktrees.find(tree => tree.id === workspaceId) ?? worktrees[0];
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [page, setPage] = useState<AgentHistoryPage | null>(null);
  const [loading, setLoading] = useState(false), [more, setMore] = useState(false);
  const [refresh, setRefresh] = useState(0), [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null), [resuming, setResuming] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null), force = useRef(false);
  const binding = useRef('');
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const options = { scope, ...(projectId ? { projectId } : {}), ...(workspace ? { worktreeId: workspace.id } : {}), ...(query ? { search: query } : {}) };
  useEffect(() => {
    request.current?.abort();
    if (!projectId && scope !== 'all') { setPage(null); return; }
    const abort = new AbortController(); request.current = abort;
    const shouldRefresh = force.current; force.current = false;
    const key = JSON.stringify(options);
    setLoading(true); setMore(false); if (binding.current !== key) setPage(null); binding.current = key; setError('');
    void fetchAgentHistory({ ...options, refresh: shouldRefresh }, abort.signal).then(next => { if (!abort.signal.aborted) setPage(next); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => request.current?.abort();
  }, [projectId, workspace?.id, scope, query, refresh, revision]);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden && !resuming) setRefresh(value => value + 1); }, 30000); return () => clearInterval(timer); }, [resuming]);
  useEffect(() => { if (!page?.refreshing) return; const timer = setTimeout(() => setRefresh(value => value + 1), 1000); return () => clearTimeout(timer); }, [page]);
  const loadMore = async () => {
    if (page?.nextOffset === null || !page || loading || more) return;
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    setMore(true); setError('');
    try { const next = await fetchAgentHistory({ ...options, offset: page.nextOffset }, abort.signal); if (!abort.signal.aborted) setPage(current => ({ ...next, sessions: [...new Map([...(current?.sessions ?? []), ...next.sessions].map(row => [row.id, row])).values()] })); }
    catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (!abort.signal.aborted) setMore(false); }
  };
  const resume = async (row: AgentHistorySession) => {
    if (row.activeNodeId && row.activeProjectId) { onOpen(row.activeProjectId, row.activeNodeId); return; }
    if (!workspace || resuming) return;
    setResuming(row.id); setError('');
    try { await onResume(row.id, workspace.id); setRefresh(value => value + 1); }
    catch (e) { setError((e as Error).message); }
    finally { setResuming(null); }
  };
  return <section className="agent-history-panel" aria-label="Agent session history">
    <header className="agent-history-heading"><div><h2>Agents</h2><p>Indexed history</p></div><button type="button" className="history-refresh" aria-label="Refresh session history" disabled={loading || more} onClick={() => { force.current = true; setRefresh(value => value + 1); }}><RefreshIcon busy={loading} /></button></header>
    <div className="history-scope-tabs" role="tablist" aria-label="Session scope" style={{ '--scope-index': ['workspace', 'project', 'all'].indexOf(scope) } as React.CSSProperties}><span className="history-scope-indicator" aria-hidden="true" />{(['workspace', 'project', 'all'] as const).map(value => <button key={value} role="tab" aria-selected={scope === value} onClick={() => setScope(value)}>{value === 'workspace' ? 'Workspace' : value === 'project' ? 'Project' : 'All'}</button>)}</div>
    {scope === 'workspace' && worktrees.length > 0 && <Select aria-label="Target worktree" value={workspace?.id ?? ''} onChange={event => setWorkspaceId(event.target.value)}>{worktrees.map(tree => <option key={tree.id} value={tree.id}>{tree.label}</option>)}</Select>}
    <label className="history-search"><Icon name="search" size={15} /><input type="search" placeholder="Search sessions..." aria-label="Search sessions" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {page && <><div className="history-scan-status"><Icon name="check" size={13} /><span>Scanned <strong>{page.scannedFiles}</strong> files</span><time dateTime={page.scannedAt} title={new Date(page.scannedAt).toLocaleString()}>{historyAge(page.scannedAt)}</time></div><div className="history-result-count"><strong>{page.sessions.length} of {page.total}{page.limited ? '+' : ''} sessions</strong><span>Last updated</span></div></>}
    {error && <p className="history-notice text-danger" role="alert">{error}</p>}
    <div className="history-session-list" aria-busy={loading}>
      {loading && !page && <div className="history-skeleton" role="status" aria-label="Loading agent history">{Array.from({ length: 4 }, (_, index) => <div key={index}><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line short" /></div>)}</div>}
      {!loading && page && !page.sessions.length && <div className="history-empty"><Icon name="message-square" size={24} /><strong>No sessions found</strong><p>{query ? 'Try another search.' : scope === 'workspace' ? 'Try Project or All to find earlier sessions.' : 'Recorded Codex, Claude Code and Antigravity conversations appear here.'}</p></div>}
      {!projectId && scope !== 'all' && <p className="empty-hint">Select a project or choose All.</p>}
      {page?.groups.filter(group => page.sessions.some(row => row.groupId === group.id)).map(group => <Disclosure key={group.id} compact defaultOpen className="history-project-group" title={group.name} badge={<span className="history-group-count" title={`${group.total} matching sessions; ${group.projectTotal} total indexed sessions in this project`}>{group.total === group.projectTotal ? group.total : `${group.total} / ${group.projectTotal}`}{page.limited ? '+' : ''}</span>}>
        {page.sessions.filter(row => row.groupId === group.id).map(row => <article key={row.id} className={`history-session-row ${row.activeNodeId ? 'is-running' : ''}`} draggable={!row.activeNodeId && !resuming} onDragStart={event => { event.dataTransfer.setData(SESSION_DRAG_TYPE, row.id); event.dataTransfer.effectAllowed = 'move'; onDragSession?.({ id: row.id, title: row.title, provider: row.provider }); }} onDragEnd={() => onDragSession?.(null)}>
          <button type="button" className="history-session-title" aria-expanded={expanded === row.id} onClick={() => setExpanded(value => value === row.id ? null : row.id)}><strong title={row.title}>{row.title}</strong><Icon name={expanded === row.id ? 'chevron-up' : 'chevron-down'} size={13} /></button>
          <p className="history-session-preview">{row.lastMessage ?? 'No conversation preview available'}</p>
          <div className="history-session-meta"><ProviderIcon provider={row.provider} size={14} /><span>{row.messageCount}{row.limited ? '+' : ''} msgs</span><time dateTime={row.updatedAt} title={new Date(row.updatedAt).toLocaleString()}>{historyAge(row.updatedAt)}</time>{row.model && <span className="history-session-model" title={row.model}>{row.model}</span>}{row.activeNodeId && <span>Live</span>}</div>
          {expanded === row.id && <div className="history-session-actions"><p title={row.cwd ?? undefined}>{row.cwd ?? 'Original workspace unavailable'}</p><button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(resuming) || (!workspace && !row.activeNodeId)} onClick={() => { void resume(row); }}>{resuming === row.id ? <RefreshIcon busy size={13} /> : <Icon name={row.activeNodeId ? 'message-square' : 'play'} size={13} />}{resuming === row.id ? 'Resuming...' : row.activeNodeId ? 'Open session' : 'Resume in worktree'}</button></div>}
        </article>)}
      </Disclosure>)}
      {page?.nextOffset !== null && page && <button type="button" className="btn btn-secondary history-load-more" disabled={more || loading} onClick={() => { void loadMore(); }}>{more ? 'Loading...' : 'Load more sessions'}</button>}
      {page?.limited && <p className="history-notice">Showing bounded history. Counts marked + are lower bounds.</p>}
      {page?.warnings.map(warning => <p className="history-notice" key={warning}>{warning}</p>)}
    </div>
    <p className="history-drag-hint">Drag a stopped session into a worktree to move and resume it.</p>
  </section>;
}
