import { lazy,Suspense,useEffect,useState,useRef } from 'react';
import type { SourceDiff,SourceFile } from '../../../shared/contracts';
import { sourceRequest,fetchCommitDiff } from '../../api/client';
import { ChevronsDownUp,ChevronsUpDown,Columns2,PanelTop,WrapText,Space } from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { FileTypeIcon } from '../../components/ui/FileTypeIcon';
import { Skeleton } from '../../components/ui/Skeleton';
import { Disclosure } from '../../components/ui/Disclosure';
const Editor=lazy(()=>import('../explorer/CodeEditor'));
export interface DiffRow {file:SourceFile;kind:'staged'|'working'|'branch'|'commit';sha?:string;nodeId?:string}
class DiffCache {
  private entries=new Map<string,SourceDiff>();
  get(key:string){const value=this.entries.get(key);if(value){this.entries.delete(key);this.entries.set(key,value);}return value;}
  set(key:string,value:SourceDiff){this.entries.delete(key);this.entries.set(key,value);let bytes=0;for(const item of this.entries.values())bytes+=(item.original.length+item.modified.length)*2;while(bytes>8*1024*1024||this.entries.size>12){const oldest=this.entries.keys().next().value;if(oldest===undefined)break;const item=this.entries.get(oldest)!;bytes-=(item.original.length+item.modified.length)*2;this.entries.delete(oldest);}}
}
function DiffFile(props:{projectId:string;worktreeId:string;row:DiffRow;base?:string;inline:boolean;wrap:boolean;whitespace:boolean;auto:boolean;cache:DiffCache}){
  const host=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(props.auto),[focused,setFocused]=useState(false);
  useEffect(()=>{const element=host.current;if(!element)return;const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{root:element.closest('.scm-review-body'),rootMargin:'250px 0px'});observer.observe(element);return()=>observer.disconnect();},[]);
  return <div ref={host} style={{minHeight:460}} onFocusCapture={()=>setFocused(true)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocused(false);}}>{visible||focused?<LoadedDiffFile {...props}/>:<div className="scm-diff-placeholder"><Skeleton lines={7} label="Preparing visible diff"/></div>}</div>;
}
function LoadedDiffFile({projectId,worktreeId,row,base,inline,wrap,whitespace,cache}:{projectId:string;worktreeId:string;row:DiffRow;base?:string;inline:boolean;wrap:boolean;whitespace:boolean;auto:boolean;cache:DiffCache}){
  const [attempt,setAttempt]=useState(0),[data,setData]=useState<SourceDiff|null>(null),[error,setError]=useState<string|null>(null);
  useEffect(()=>{const key=JSON.stringify([projectId,worktreeId,row.file.path,row.kind,row.sha,row.nodeId,base]);const cached=cache.get(key);if(cached){setData(cached);return;}const abort=new AbortController();setError(null);const read=row.kind==='commit'?fetchCommitDiff(projectId,row.sha!,row.file.path,row.nodeId,abort.signal):sourceRequest<SourceDiff>(projectId,'diff',{worktreeId,path:row.file.path,kind:row.kind,...(base?{base}:{})},abort.signal);void read.then(value=>{if(!abort.signal.aborted){cache.set(key,value);setData(value);}}).catch(error=>{if(!abort.signal.aborted)setError(error.message);});return()=>abort.abort();},[attempt,projectId,worktreeId,row.file.path,row.kind,row.sha,row.nodeId,base,cache]);
  if(error)return <div className="scm-diff-placeholder" role="alert"><span>{error}</span><button className="btn btn-secondary btn-sm" onClick={()=>setAttempt(value=>value+1)}>Retry</button></div>;
  if(!data)return <div className="scm-diff-placeholder"><Skeleton lines={7} label="Preparing diff"/></div>;
  if(data.binary)return <div className="scm-diff-placeholder"><FileTypeIcon path={data.path} size={24}/><span>{data.reason??'Binary files cannot be displayed as a text diff.'}</span></div>;
  return <div className="scm-diff-editor"><Suspense fallback={<Skeleton lines={8} label="Opening diff"/>}><Editor path={data.path} value={data.modified} original={data.original} diff inline={inline} wrap={wrap} ignoreWhitespace={whitespace} readOnly autoFocus={false} onChange={()=>{}} onSave={()=>{}}/></Suspense></div>;
}
function DiffSection({open,onToggle,...props}:Parameters<typeof DiffFile>[0]&{open:boolean;onToggle:()=>void}){
  const [retained,setRetained]=useState(open);
  useEffect(()=>{if(open){setRetained(true);return;}const timer=setTimeout(()=>setRetained(false),180);return()=>clearTimeout(timer);},[open]);
  const {row}=props;
  return <Disclosure title={row.file.path} compact className="scm-diff-section" open={open} onOpenChange={onToggle}
    triggerContent={<><FileTypeIcon path={row.file.path} size={14}/><span className="scm-diff-path">{row.file.path}</span><small>{row.kind==='commit'?`Commit ${row.sha?.slice(0,7)}`:row.kind==='staged'?'Staged':row.kind==='branch'?'Branch':'Working tree'}</small></>}>
    {(open||retained)&&<DiffFile {...props}/>}
  </Disclosure>;
}
export function DiffReview({projectId,worktreeId,rows,base,closing,onClose}:{projectId:string;worktreeId:string;rows:DiffRow[];base?:string;closing:boolean;onClose:()=>void}){
  const [cache]=useState(()=>new DiffCache());
  const [inline,setInline]=useState(rows.length===1),[wrap,setWrap]=useState(false),[whitespace,setWhitespace]=useState(false),[collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const count=new Set(rows.map(row=>row.file.path)).size;
  return <Modal isOpen isClosing={closing} onClose={onClose} className="scm-review" aria-label="Review changed files">
    <header className="scm-review-toolbar"><strong>{count} changed {count===1?'file':'files'}{base?` · ${base}…HEAD`:''}</strong>
      <button className="btn btn-secondary btn-xs scm-icon-control" title={collapsed.size?'Expand all':'Collapse all'} aria-label={collapsed.size?'Expand all':'Collapse all'} onClick={()=>setCollapsed(collapsed.size?new Set():new Set(rows.map(row=>`${row.kind}:${row.file.path}`)))}>{collapsed.size?<ChevronsUpDown size={15}/>:<ChevronsDownUp size={15}/>}</button>
      <button className="btn btn-secondary btn-xs scm-icon-control" title={inline?'Switch to side-by-side diff':'Switch to inline diff'} aria-label={inline?'Switch to side-by-side diff':'Switch to inline diff'} aria-pressed={inline} onClick={()=>setInline(!inline)}>{inline?<Columns2 size={15}/>:<PanelTop size={15}/>}</button>
      <button className="btn btn-secondary btn-xs scm-icon-control" title={wrap?'Disable line wrapping':'Enable line wrapping'} aria-label="Wrap lines" aria-pressed={wrap} onClick={()=>setWrap(!wrap)}><WrapText size={15}/></button>
      <button className="btn btn-secondary btn-xs scm-icon-control" title={whitespace?'Show whitespace changes':'Ignore whitespace changes'} aria-label="Ignore whitespace" aria-pressed={whitespace} onClick={()=>setWhitespace(!whitespace)}><Space size={15}/></button>
      <OverlayCloseButton onClick={onClose}/>
    </header>
    <div className="scm-review-body">{rows.length?rows.map(row=>{const key=`${row.kind}:${row.file.path}`,open=!collapsed.has(key);return <DiffSection key={key} open={open} onToggle={()=>setCollapsed(current=>{const next=new Set(current);if(next.has(key))next.delete(key);else next.add(key);return next;})} projectId={projectId} worktreeId={worktreeId} row={row} base={base} inline={inline} wrap={wrap} whitespace={whitespace} auto={rows.length===1} cache={cache}/>;}):<div className="scm-diff-placeholder">No differences against this base.</div>}</div>
  </Modal>;
}
