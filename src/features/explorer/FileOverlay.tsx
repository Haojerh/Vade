import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Columns2, GitCompareArrows, PanelTop } from 'lucide-react';
import type { WorkspaceFile } from '../../../shared/contracts';
import { workspaceFilesRequest } from '../../api/client';
import { Modal } from '../../components/ui/Modal';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Skeleton } from '../../components/ui/Skeleton';
import { FileTypeIcon } from '../../components/ui/FileTypeIcon';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { useEditorAutosave } from './editorPreferences';

const loadCode = () => import('./CodeEditor');
const loadRich = () => import('./RichMarkdownEditor');
const CodeEditor = lazy(loadCode), RichMarkdownEditor = lazy(loadRich);
const cache = new Map<string, WorkspaceFile>();
function remember(key: string, file: WorkspaceFile) {
  cache.delete(key); cache.set(key, file);
  let size = [...cache.values()].reduce((total, entry) => total + entry.text.length * 2 + (entry.original?.length ?? 0) * 2, 0);
  while (cache.size > 12 || size > 12 * 1024 * 1024) { const first = cache.keys().next().value!; const value = cache.get(first)!; cache.delete(first); size -= value.text.length * 2 + (value.original?.length ?? 0) * 2; }
}
export function warmWorkspaceEditor() { void loadCode().catch(() => {}); void loadRich().catch(() => {}); }

export function FileOverlay({ projectId, worktreeId, path, line, closing, onClose, onSaved }: {
  projectId: string; worktreeId: string; path: string; line?: number; closing: boolean; onClose: () => void; onSaved: () => void;
}) {
  const key = `${projectId}:${worktreeId}:${path}`, cached = cache.get(key);
  const [file, setFile] = useState<WorkspaceFile | null>(cached ?? null), [text, setText] = useState(cached?.text ?? ''), [error, setError] = useState<string | null>(null);
  const markdown = /\.(md|markdown)$/i.test(path), richSafe = markdown && text.length <= 256 * 1024 && !/^---\r?\n|^\s*<[/!A-Za-z]/m.test(text);
  const [loading, setLoading] = useState(!cached), [refreshing, setRefreshing] = useState(false), [saving, setSaving] = useState(false), [diffLoading, setDiffLoading] = useState(false);
  const [diffStats, setDiffStats] = useState<{ added: number; removed: number } | null>(null);
  const [view, setView] = useState<'code' | 'diff' | 'rich'>(markdown && !line ? 'rich' : 'code'), [inline, setInline] = useState(false), [navigation, setNavigation] = useState<{direction: 'next' | 'previous'; id: number}>();
  const autosave = useEditorAutosave(), lastView = useRef<'code' | 'rich'>(markdown ? 'rich' : 'code');
  const confirm = useConfirmationState<'close' | 'reload'>(), alive = useRef(true), savingRef = useRef(false), latest = useRef(text), loaded = useRef(file); latest.current = text; loaded.current = file;
  const dirty = file !== null && text !== file.text;
  const load = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true); setError(null);
    const before = loaded.current;
    try {
      const next = await workspaceFilesRequest<WorkspaceFile>(projectId, 'read', { worktreeId, path }, signal);
      if (!signal?.aborted && alive.current) {
        remember(key, next);
        if (!before || latest.current === before.text) { setFile(next); setText(next.text); }
        else if (before.version !== next.version) setError('File changed on disk. Your edits have been kept; reload before saving.');
      }
    } catch (reason) { if (!signal?.aborted && alive.current) setError(reason instanceof Error ? reason.message : 'Unable to read this file'); }
    finally { if (!signal?.aborted && alive.current) { setLoading(false); setRefreshing(false); } }
  }, [projectId, worktreeId, path, key]);
  useEffect(() => { alive.current = true; const abort = new AbortController(); void load(abort.signal); return () => { alive.current = false; abort.abort(); }; }, [load]);
  const save = useCallback(async () => {
    const current = loaded.current;
    if (!current || savingRef.current || latest.current === current.text) return;
    savingRef.current = true; setSaving(true); setError(null); const submitted = latest.current;
    try {
      const next = await workspaceFilesRequest<WorkspaceFile>(projectId, 'save', { worktreeId, path, text: submitted, version: current.version });
      if (alive.current) { const saved = { ...next, original: current.original }; remember(key, saved); loaded.current = saved; setFile(saved); onSaved(); }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : 'Unable to save this file'); }
    finally { savingRef.current = false; if (alive.current) setSaving(false); }
  }, [projectId, worktreeId, path, key, onSaved]);
  useEffect(() => { if (!autosave || !dirty || saving || error || confirm.present) return; const timer = setTimeout(() => void save(), 600); return () => clearTimeout(timer); }, [autosave, dirty, text, saving, error, save, confirm.present]);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  useEffect(() => {
    if (dirty || loading || saving) return;
    const abort = new AbortController(); let running = false;
    const timer = setInterval(async () => {
      if (document.hidden || running) return; running = true;
      try {
        const next = await workspaceFilesRequest<WorkspaceFile>(projectId, 'read', { worktreeId, path }, abort.signal);
        if (!abort.signal.aborted && latest.current === loaded.current?.text && next.version !== loaded.current?.version) { remember(key, next); setFile(next); setText(next.text); }
      } catch { /* Keep the last good file; explicit reload surfaces failures. */ }
      finally { running = false; }
    }, 3000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [dirty, loading, saving, projectId, worktreeId, path, key]);
  useEffect(() => {
    if (view !== 'diff') { setDiffLoading(false); return; }
    const abort = new AbortController();
    setDiffLoading(loaded.current?.original === null);
    void workspaceFilesRequest<WorkspaceFile>(projectId, 'diff', { worktreeId, path }, abort.signal).then(next => {
      if (!abort.signal.aborted) setFile(current => current && ({ ...current, original: next.original, gitError: next.gitError }));
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to read Git changes'); })
      .finally(() => { if (!abort.signal.aborted) setDiffLoading(false); });
    return () => abort.abort();
  }, [view, file?.version, projectId, worktreeId, path]);
  const showDiff = () => {
    if (view === 'diff') { setView(lastView.current); return; }
    lastView.current = view; setView('diff');
  };
  const close = async () => {
    if (savingRef.current) return;
    if (dirty && autosave && !error) { await save(); if (latest.current === loaded.current?.text) onClose(); return; }
    if (dirty) confirm.open('close'); else onClose();
  };
  const blur = () => { if (autosave && !error && !confirm.present) void save(); };
  return <>
    <Modal isOpen isClosing={closing} busy={saving} onClose={() => void close()} className="workspace-file-dialog" aria-label={`Edit ${path}`} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    }}>
      <header className="workspace-editor-toolbar"><FileTypeIcon path={path} /><span className="workspace-editor-path" title={path}>{path}{!autosave && dirty ? ' •' : ''}</span><span className="workspace-save-state" role="status">{saving ? 'Saving…' : !autosave && dirty ? 'Unsaved' : ''}</span>
        {markdown && <SegmentedControl label="Markdown view" choices={[{ value: 'rich', label: 'Rich' }, { value: 'code', label: 'Code' }]} value={view === 'diff' ? undefined : view} onChange={choice => setView(choice as 'code' | 'rich')} radius={5} />}
        <button className="btn-icon" disabled={!file?.git} aria-pressed={view === 'diff'} aria-label="Show Git changes" title="Show Git changes" onClick={() => void showDiff()}><GitCompareArrows size={16} /></button>
        {view === 'diff' && <>{diffStats && <span className="workspace-diff-stats" aria-label={`${diffStats.added} added lines, ${diffStats.removed} removed lines`}><span className="workspace-diff-added">+{diffStats.added}</span><span className="workspace-diff-removed">−{diffStats.removed}</span></span>}<span className="workspace-toolbar-divider" /><button className="btn-icon" title={inline ? 'Switch to side-by-side diff' : 'Switch to inline diff'} aria-label={inline ? 'Switch to side-by-side diff' : 'Switch to inline diff'} onClick={() => setInline(!inline)}>{inline ? <Columns2 size={16} /> : <PanelTop size={16} />}</button>
          <button className="btn-icon" title="Previous change" aria-label="Previous change" onClick={() => setNavigation(current => ({ direction: 'previous', id: (current?.id ?? 0) + 1 }))}><ArrowUp size={16} /></button>
          <button className="btn-icon" title="Next change" aria-label="Next change" onClick={() => setNavigation(current => ({ direction: 'next', id: (current?.id ?? 0) + 1 }))}><ArrowDown size={16} /></button></>}
        <span className="workspace-toolbar-divider" /><button className="btn-icon" title="Reload file" aria-label="Reload file" disabled={saving || refreshing} onClick={() => dirty ? confirm.open('reload') : void load()}><RefreshIcon busy={refreshing} size={16} /></button>
        <OverlayCloseButton aria-label="Close file editor" disabled={saving} onClick={() => void close()} />
      </header>
      {error && <p className="workspace-error" role="alert">{error}</p>}
      {file?.gitError && <p className="workspace-error">Diff unavailable: {file.gitError}</p>}
      <div className="workspace-editor-body">{loading ? <Skeleton lines={14} className="workspace-editor-skeleton" label="Loading file" /> : file && <Suspense fallback={<Skeleton lines={14} className="workspace-editor-skeleton" label="Loading editor" />}>
        {view === 'rich' && richSafe ? <RichMarkdownEditor value={text} onChange={setText} onSave={() => void save()} onBlur={blur} /> : <>
          {view === 'rich' && !richSafe && <p className="workspace-editor-note">This document uses the source editor to preserve its size or embedded syntax.</p>}
          <CodeEditor path={path} value={text} original={file.original} diff={view === 'diff' && file.original !== null} inline={inline} navigation={navigation} line={line} onChange={setText} onSave={() => void save()} onBlur={blur} onDiffStats={setDiffStats} />
        </>}
      </Suspense>}{view === 'diff' && diffLoading && <div className="workspace-baseline-loading"><Skeleton lines={14} className="workspace-editor-skeleton" label="Loading Git changes" /></div>}</div>
    </Modal>
    <ConfirmationDialog isOpen={confirm.present} isClosing={confirm.closing} title="Discard unsaved changes?" description="Your latest edits have not been saved. Keep editing to save them, or discard them to continue." confirmLabel="Discard changes" cancelLabel="Keep editing" onClose={confirm.close} onConfirm={() => { const action = confirm.data; confirm.close(); if (action === 'close') onClose(); else { const saved = loaded.current?.text ?? ''; latest.current = saved; setText(saved); void load(); } }} />
  </>;
}
