import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaseSensitive, WholeWord, Regex, MoreHorizontal, Folder, FolderOpen, CircleSlash, ListFilter, Search, SearchX, ListCollapse, Check, X, CodeXml } from 'lucide-react';
import type { Node, WorkspaceRoot, WorkspaceEntry, WorkspaceListing, WorkspaceSearch } from '../../../shared/contracts';
import { workspaceFilesRequest } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { FileTypeIcon } from '../../components/ui/FileTypeIcon';
import { Select } from '../../components/ui/Select';
import { Popover } from '../../components/ui/Popover';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Skeleton } from '../../components/ui/Skeleton';
import { BinaryControl } from '../../components/ui/BinaryControl';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { usePopoverState } from '../../hooks/usePopoverState';
import { FileOverlay, warmWorkspaceEditor } from './FileOverlay';
import { useExplorerActions } from './useExplorerActions';
import './explorer.css';

const errorText = (error: unknown) => error instanceof Error ? error.message.replace(/^\[[A-Z_]+\]\s*/, '') : 'Unable to access workspace files';
// Metadata only: retain a bounded warm tree across sidebar/settings remounts.
const treeCache = new Map<string, Record<string, WorkspaceListing>>();
function rememberTree(scope: string, value: Record<string, WorkspaceListing>) {
  treeCache.delete(scope); treeCache.set(scope, value);
  if (treeCache.size > 8) treeCache.delete(treeCache.keys().next().value!);
}
function preference(key: string) { try { return localStorage.getItem(`vade:explorer-${key}`) !== 'false'; } catch { return true; } }
function statusLabel(value: string | null) { return value === '??' ? 'U' : value === '!!' ? null : value?.trim().slice(-1) ?? null; }
const fileTarget = (path: string) => ({path,name:path.split('/').pop()!,directory:false,symlink:false});
function nameProjection(matches: WorkspaceSearch['matches']) {
  const listing: Record<string, WorkspaceListing> = { '': { entries: [], truncated: false, gitError: null } }, known = new Map<string, WorkspaceEntry>();
  for (const match of matches) {
    const parts = match.path.split('/'); let parent = '';
    for (let i = 0; i < parts.length; i++) {
      const path = parent ? `${parent}/${parts[i]}` : parts[i], directory = i < parts.length - 1;
      let entry = known.get(path);
      if (!entry) { entry = { path, name: parts[i], directory, symlink: false, status: match.status ?? null }; known.set(path, entry); (listing[parent] ??= { entries: [], truncated: false, gitError: null }).entries.push(entry); }
      else if (match.status && /M|D/.test(match.status)) entry.status = match.status;
      if (directory) listing[path] ??= { entries: [], truncated: false, gitError: null };
      parent = path;
    }
  }
  for (const directory of Object.values(listing)) directory.entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return listing;
}
function Highlight({ text, ranges }: { text: string; ranges?: [number, number][] }) {
  if (!ranges?.length) return <>{text}</>;
  const output: ReactNode[] = []; let from = 0;
  for (const [start, end] of ranges) { if (start < from || start > text.length) continue; output.push(text.slice(from, start), <mark key={`${start}:${end}`}>{text.slice(start, end)}</mark>); from = end; }
  output.push(text.slice(from)); return <>{output}</>;
}

export function ExplorerPanel({ projectId, worktrees: snapshotTrees, active = true }: { projectId: string | null; worktrees: Node[]; active?: boolean }) {
  const [roots, setRoots] = useState<{ projectId: string; data: WorkspaceRoot[] } | null>(null);
  const worktrees = roots?.projectId === projectId ? roots.data : snapshotTrees;
  const [selected, setSelected] = useState(''), [expanded, setExpanded] = useState<Set<string>>(new Set([''])), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [directories, setDirectories] = useState<Record<string, WorkspaceListing>>({}), [query, setQuery] = useState(''), [mode, setMode] = useState<'names' | 'contents'>('names');
  const [results, setResults] = useState<{ key: string; data: WorkspaceSearch } | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const [matchCase, setMatchCase] = useState(false), [wholeWord, setWholeWord] = useState(false), [regex, setRegex] = useState(false), [include, setInclude] = useState(''), [exclude, setExclude] = useState('');
  const [showDotfiles, setShowDotfiles] = useState(() => preference('dotfiles')), [showIgnored, setShowIgnored] = useState(() => preference('ignored'));
  const overlay = useConfirmationState<{ path: string; line?: number; diff?: boolean }>(), menu = usePopoverState(), menuTrigger = useRef<HTMLButtonElement>(null);
  const worktree = worktrees.find(tree => tree.id === selected) ?? worktrees[0], worktreeId = worktree?.id ?? '';
  const scope = `${projectId}:${worktreeId}`, currentScope = useRef(scope); currentScope.current = scope;
  const directoryRef = useRef(directories); directoryRef.current = directories;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const fileActions = useExplorerActions({projectId,worktreeId,rootPath:worktree?.path??'',onRefresh:refresh,onView:(path,diff)=>overlay.open({path,diff})});
  const searchKey = JSON.stringify([query.trim(), mode, matchCase, wholeWord, regex, include, exclude, showDotfiles, showIgnored]);
  const searchData = results?.key === searchKey ? results.data : null;
  const projected = useMemo(() => nameProjection(searchData?.matches ?? []), [searchData]);
  const groups = useMemo(() => { const values = new Map<string, WorkspaceSearch['matches']>(); for (const match of searchData?.matches ?? []) { const group = values.get(match.path) ?? []; group.push(match); values.set(match.path, group); } return values; }, [searchData]);
  const filtered = query.trim() !== '' && mode === 'names';
  const visible = filtered ? projected : directories;
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (!projectId) return;
    const abort = new AbortController();
    // Worktree discovery avoids waiting for the full provider/session snapshot.
    void workspaceFilesRequest<WorkspaceRoot[]>(projectId, 'roots', {}, abort.signal).then(data => { if (!abort.signal.aborted) setRoots({ projectId, data }); }).catch(() => { /* Snapshot roots remain available on discovery failure. */ });
    return () => abort.abort();
  }, [projectId, active]);
  useEffect(() => { const cached = treeCache.get(scope) ?? {}; directoryRef.current = cached; setDirectories(cached); setExpanded(new Set([''])); setCollapsed(new Set()); setResults(null); setError(null); setQuery(''); overlay.reset(); }, [scope]);
  useEffect(() => { if (!active) return; const timer = setTimeout(warmWorkspaceEditor, 250); return () => clearTimeout(timer); }, [active]);
  useEffect(() => {
    if (!projectId || !worktreeId || !active && directoryRef.current['']) return;
    const abort = new AbortController(); let running = false;
    const load = async (force = false) => {
      if (running || document.hidden) return; running = true; setLoading(true);
      try {
        if (query.trim()) {
          const next = await workspaceFilesRequest<WorkspaceSearch>(projectId, 'search', { worktreeId, q: query.trim(), mode, matchCase: String(matchCase), wholeWord: String(wholeWord), regex: String(regex), include, exclude, showDotfiles: String(showDotfiles), showIgnored: String(showIgnored) }, abort.signal);
          if (!abort.signal.aborted) setResults({ key: searchKey, data: next });
        } else {
          const paths = (active ? [...expanded] : ['']).filter(path => force || !directoryRef.current[path]).slice(0, 50), data: Record<string, WorkspaceListing> = {};
          for (let i = 0; i < paths.length; i += 4) await Promise.all(paths.slice(i, i + 4).map(async path => { data[path] = await workspaceFilesRequest<WorkspaceListing>(projectId, 'list', { worktreeId, path }, abort.signal); }));
          if (!abort.signal.aborted) setDirectories(current => { const next = { ...current, ...data }; if (Object.keys(next).length > 80) for (const path of Object.keys(next)) if (!expanded.has(path)) delete next[path]; directoryRef.current = next; rememberTree(scope, next); return next; });
        }
        if (!abort.signal.aborted) setError(null);
      } catch (reason) { if (!abort.signal.aborted) setError(errorText(reason)); }
      finally { running = false; if (!abort.signal.aborted) setLoading(false); }
    };
    const force = revision !== lastRevision.current; lastRevision.current = revision;
    const debounce = setTimeout(() => void load(force), query && mode === 'contents' ? 120 : 0), timer = active ? setInterval(() => void load(true), 4000) : undefined;
    return () => { abort.abort(); clearTimeout(debounce); if (timer) clearInterval(timer); };
  }, [projectId, worktreeId, active, searchKey, expanded, revision]);
  const toggle = (path: string) => {
    if (filtered) setCollapsed(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    else setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else if (next.size < 50) next.add(path); return next; });
  };
  const tree = (parent: string, depth = 0): ReactNode => visible[parent]?.entries.filter(entry => (showDotfiles || !entry.name.startsWith('.')) && (showIgnored || entry.status !== '!!')).map(entry => {
    const open = filtered ? !collapsed.has(entry.path) : expanded.has(entry.path), label = statusLabel(entry.status);
    const rename=fileActions.rename;
    if(rename?.path===entry.path)return <div key={entry.path}><div className="workspace-inline-rename" style={{paddingLeft:25+depth*16}}>{entry.directory?<Folder size={13}/>:<FileTypeIcon path={entry.path} size={13}/>}<div><input aria-label={`Rename ${entry.name}`} autoFocus value={rename.name} disabled={rename.busy&&rename.ready} maxLength={200} onFocus={event=>{const dot=entry.directory?-1:entry.name.lastIndexOf('.');event.currentTarget.setSelectionRange(0,dot>0?dot:entry.name.length);}} onChange={event=>rename.change(event.target.value)} onBlur={()=>{if(rename.ready&&!rename.busy)rename.commit();}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();rename.commit();}else if(event.key==='Escape'){event.preventDefault();rename.cancel();}}}/>{rename.error&&<span role="alert">{rename.error}</span>}</div></div>{entry.directory&&open&&tree(entry.path,depth+1)}</div>;
    return <div key={entry.path}><button className={`workspace-tree-row ${entry.status === '!!' ? 'ignored' : ''}`} data-status={label} style={{ paddingLeft: 8 + depth * 16 }} role="treeitem" aria-expanded={entry.directory ? open : undefined} disabled={entry.symlink} title={entry.symlink ? 'Symbolic links are not editable' : entry.path}
      onContextMenu={event=>fileActions.context(event,entry)} onKeyDown={event=>fileActions.keyboard(event,entry)} onClick={() => entry.directory ? toggle(entry.path) : overlay.open({ path: entry.path })}>
      <span className="workspace-tree-caret">{entry.directory && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />}</span>
      {entry.directory ? open ? <FolderOpen size={13} /> : <Folder size={13} /> : <FileTypeIcon path={entry.path} size={13} />}
      <span className="workspace-file-name">{entry.name}</span>{label ? <span className="workspace-git-status">{label}</span> : entry.status === '!!' ? <CircleSlash className="workspace-ignored-icon" size={13} /> : null}
    </button>{entry.directory && open && <div role="group">{visible[entry.path] ? tree(entry.path, depth + 1) : <Skeleton lines={3} label="Loading folder" />}</div>}</div>;
  });
  const updatePreference = (key: string, value: boolean) => { try { localStorage.setItem(`vade:explorer-${key}`, String(value)); } catch { /* Retain in memory. */ } };
  const openExternal = async (target: 'vscode' | 'system') => { menu.close(); if (!projectId || !worktreeId) return; const owner = scope; try { await workspaceFilesRequest(projectId, 'open', { worktreeId, target }); } catch (reason) { if (currentScope.current === owner) setError(errorText(reason)); } };
  return <section className="workspace-explorer" aria-label="File explorer">
    <div className="workspace-explorer-heading"><strong title={worktree?.path ?? ''}>{worktree?.label ?? 'Explorer'}</strong>
      <button className="btn-icon" title="Collapse folders" aria-label="Collapse folders" onClick={() => { if (filtered) setCollapsed(new Set(Object.keys(projected))); else setExpanded(new Set([''])); }}><ListCollapse size={15} /></button>
      <button className="btn-icon" title="Refresh files" aria-label="Refresh files" disabled={loading} onClick={refresh}><RefreshIcon busy={loading} size={15} /></button>
      <button className="btn-icon" ref={menuTrigger} title="Explorer options" aria-label="Explorer options" aria-expanded={menu.present} onClick={menu.toggle}><MoreHorizontal size={16} /></button>
      <Popover isOpen={menu.present} isClosing={menu.closing} onClose={menu.close} triggerRef={menuTrigger} floating floatingWidth={235} className="workspace-options-menu"><div role="menu" aria-label="Explorer options">
        <button role="menuitemcheckbox" aria-checked={showDotfiles} onClick={() => { setShowDotfiles(!showDotfiles); updatePreference('dotfiles', !showDotfiles); }}><span className="workspace-menu-check">{showDotfiles && <Check size={14} />}</span>Show Dotfiles</button>
        <button role="menuitemcheckbox" aria-checked={showIgnored} onClick={() => { setShowIgnored(!showIgnored); updatePreference('ignored', !showIgnored); }}><span className="workspace-menu-check">{showIgnored && <Check size={14} />}</span>Show Git Ignored Files</button><hr />
        <button role="menuitem" onClick={() => void openExternal('vscode')} disabled={!worktreeId}><CodeXml size={15} />Open in VS Code</button>
        <button role="menuitem" onClick={() => void openExternal('system')} disabled={!worktreeId}><FolderOpen size={15} />Open in File Explorer</button>
      </div></Popover>
    </div>
    {!projectId || !worktreeId ? <p className="empty-hint">Select a project to browse files.</p> : <>
      {worktrees.length > 1 && <Select wrapperClassName="workspace-root-select" aria-label="Explorer worktree" value={worktreeId} onChange={event => setSelected(event.target.value)}>{worktrees.map(tree => <option key={tree.id} value={tree.id}>{tree.label}{tree.branch ? ` · ${tree.branch}` : ''}</option>)}</Select>}
      <div className="workspace-search">{mode === 'names' ? <ListFilter size={15} /> : <Search size={15} />}<input aria-label="Find files" placeholder={mode === 'names' ? 'Find files…' : 'Search contents…'} value={query} onChange={event => { setQuery(event.target.value); setCollapsed(new Set()); }} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />
        {query && <button className="btn-icon" title="Clear file search" aria-label="Clear file search" onClick={() => setQuery('')}><X size={13} /></button>}
        {mode === 'contents' && <><button className="btn-icon workspace-search-option" title="Match case" aria-label="Match case" aria-pressed={matchCase} onClick={() => setMatchCase(!matchCase)}><CaseSensitive size={16} /></button><button className="btn-icon workspace-search-option" title="Match whole word" aria-label="Match whole word" aria-pressed={wholeWord} onClick={() => setWholeWord(!wholeWord)}><WholeWord size={16} /></button><button className="btn-icon workspace-search-option" title="Use regular expression" aria-label="Use regular expression" aria-pressed={regex} onClick={() => setRegex(!regex)}><Regex size={16} /></button></>}
      </div>
      <div className="workspace-search-tabs"><BinaryControl label="File search mode" choices={[{value:'names',label:'Names'},{value:'contents',label:'Contents'}]} value={mode} onChange={value => setMode(value as 'names' | 'contents')} /></div>
      {mode === 'contents' && <div className="workspace-search-filters"><label>Files to include<input aria-label="Files to include" placeholder="e.g. *.ts, src/**" value={include} onChange={event => setInclude(event.target.value)} /></label><label>Files to exclude<input aria-label="Files to exclude" placeholder="e.g. *.min.js, dist/**" value={exclude} onChange={event => setExclude(event.target.value)} /></label></div>}
      {error && <div className="workspace-error panel-alert alert-error" role="alert"><Icon name="alert-circle" size={16} /><div><strong>Unable to load files</strong><p>{error}</p><button className="btn btn-secondary btn-sm" disabled={loading} onClick={refresh}><RefreshIcon busy={loading} size={13} />Retry</button></div></div>}
      {directories['']?.gitError && <p className="workspace-error">{directories[''].gitError}</p>}
      {query.trim() && mode === 'contents' && searchData && <div className="workspace-result-count">{searchData.matches.length ? <>{searchData.matches.length}{searchData.truncated?'+':''} {searchData.matches.length===1?'result':'results'} in {groups.size} {groups.size===1?'file':'files'}</> : searchData.truncated?'Search limit reached':'No results'}</div>}
      <div className="workspace-tree" role={mode === 'names' ? 'tree' : undefined} aria-label="Workspace files" aria-busy={loading} onContextMenu={fileActions.context} onKeyDown={fileActions.keyboard}>
        {query.trim() && !searchData && !error ? <Skeleton lines={7} label="Searching files" /> : mode === 'names' || !query.trim() ? tree('') : [...groups].map(([path, matches]) => <div className="workspace-result-group" key={path}>
          <button className="workspace-result-heading" onContextMenu={event=>fileActions.context(event,fileTarget(path))} onKeyDown={event=>fileActions.keyboard(event,fileTarget(path))} aria-expanded={!collapsed.has(path)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })}><Icon name={collapsed.has(path) ? 'chevron-right' : 'chevron-down'} size={12} /><FileTypeIcon path={path} size={14} /><strong>{path.split('/').pop()}</strong><small>{path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}</small><span className="workspace-result-badge">{matches.length}</span></button>
          {fileActions.rename?.path===path && <div className="workspace-inline-rename"><FileTypeIcon path={path} size={13}/><div><input autoFocus aria-label={`Rename ${path}`} value={fileActions.rename.name} disabled={fileActions.rename.busy} onChange={event=>fileActions.rename?.change(event.target.value)} onFocus={event=>{const name=path.split('/').pop()!;const dot=name.lastIndexOf('.');event.currentTarget.setSelectionRange(0,dot>0?dot:name.length);}} onBlur={()=>{if(fileActions.rename?.ready&&!fileActions.rename.busy)fileActions.rename.commit();}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();fileActions.rename?.commit();}else if(event.key==='Escape'){event.preventDefault();fileActions.rename?.cancel();}}}/>{fileActions.rename.error&&<span role="alert">{fileActions.rename.error}</span>}</div></div>}
          {!collapsed.has(path) && matches.map((match, index) => <button className="workspace-search-result" key={`${match.line}:${index}`} onContextMenu={event=>fileActions.context(event,fileTarget(path))} onKeyDown={event=>fileActions.keyboard(event,fileTarget(path))} onClick={() => overlay.open(match)}><span className="workspace-match-line">{match.line}</span><code><Highlight text={match.preview ?? ''} ranges={match.ranges} /></code></button>)}
        </div>)}
        {!Object.keys(directories).length && !query.trim() && loading && <Skeleton lines={9} label="Loading files" />}
        {query.trim() && searchData && !searchData.matches.length && <div className="workspace-search-empty"><SearchX size={27}/><strong>{searchData.truncated?'No matches in searched files':mode==='contents'?'No content matches':'No matching files'}</strong><p>{searchData.truncated?'The search reached its scan limit. Narrow the included folders and try again.':<>Nothing matched <q>{query}</q>. Try a different search or relax your filters.</>}</p><div><button className="btn btn-secondary btn-sm" onClick={()=>setQuery('')}>Clear search</button>{(include||exclude||regex||wholeWord||matchCase||!showDotfiles||!showIgnored)&&<button className="btn btn-secondary btn-sm" onClick={()=>{setInclude('');setExclude('');setRegex(false);setWholeWord(false);setMatchCase(false);setShowDotfiles(true);setShowIgnored(true);}}>Reset filters</button>}</div></div>}
        {(query.trim()?searchData?.truncated&&Boolean(searchData.matches.length):Object.values(directories).some(list=>list.truncated))&&<p className="workspace-search-limit">Showing a limited set of results. Narrow the search or folder.</p>}
      </div>
    </>}
    {fileActions.ui}
    {overlay.present && overlay.data && projectId && worktreeId && <FileOverlay key={`${scope}:${overlay.data.path}:${overlay.data.diff}`} projectId={projectId} worktreeId={worktreeId} path={overlay.data.path} line={overlay.data.line} initialDiff={overlay.data.diff} closing={overlay.closing} onClose={overlay.close} onSaved={refresh} />}
  </section>;
}
