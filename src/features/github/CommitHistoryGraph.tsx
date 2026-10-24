import React, { useEffect,useRef,useState } from 'react';
import { layoutCommitGraph } from './commitGraphLayout';
import type { useCommitGraph } from './useCommitGraph';
import type { CommitFiles } from '../../../shared/contracts';
import { fetchCommitFiles } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { FileTypeIcon } from '../../components/ui/FileTypeIcon';
import { Skeleton } from '../../components/ui/Skeleton';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { FileOverlay } from '../explorer/FileOverlay';

const colors = ['#3899ff', '#f5b700', '#e34ba0', '#40ba94', '#a78bfa', '#e98549'];
function ChangedFiles({projectId,nodeId,sha}:{projectId:string;nodeId?:string;sha:string}){
  const [data,setData]=useState<CommitFiles|null>(null),[error,setError]=useState<string|null>(null),[attempt,setAttempt]=useState(0);
  const review=useConfirmationState<{path:string;status:string}>();
  useEffect(()=>{const abort=new AbortController();setError(null);void fetchCommitFiles(projectId,sha,nodeId,abort.signal).then(value=>{if(!abort.signal.aborted)setData(value);}).catch(error=>{if(!abort.signal.aborted)setError(error.message);});return()=>abort.abort();},[projectId,nodeId,sha,attempt]);
  if(error)return <div className="commit-files-error" role="alert">{error}<button className="btn btn-secondary btn-xs" onClick={()=>setAttempt(value=>value+1)}>Retry</button></div>;
  if(!data)return <Skeleton lines={3} label="Reading commit files"/>;
  return <><ul className="commit-files" aria-label="Files changed in commit">{data.files.map(file=><li key={file.path}><button type="button" title={file.path} aria-label={`View commit diff for ${file.path}`} onClick={()=>review.open(file)}><FileTypeIcon path={file.path} size={13} status={file.status}/><span>{file.path.split('/').pop()}</span>{file.path.includes('/')&&<small>{file.path.slice(0,file.path.lastIndexOf('/'))}</small>}<b data-status={file.status}>{file.status}</b></button></li>)}</ul>{!data.files.length&&!data.excluded&&<span>No changed files.</span>}{data.excluded>0&&<span>{data.excluded} unsupported/private paths excluded.</span>}{data.truncated&&<span>Showing the first 1,000 changed files.</span>}{review.present&&review.data&&<FileOverlay key={`${sha}:${review.data.path}`} projectId={projectId} worktreeId="" path={review.data.path} commit={{sha,nodeId}} initialDiff initialInline closing={review.closing} onClose={review.close} onSaved={()=>{}}/>}</>;
}
type Observation=ReturnType<typeof useCommitGraph>;
function GraphRow({row,state,expanded,onToggle,showGraph}:{showGraph:boolean;row:ReturnType<typeof layoutCommitGraph>[number];state:Observation;expanded:boolean;onToggle:()=>void}){
  const host=useRef<HTMLLIElement>(null),[height,setHeight]=useState(36);
  useEffect(()=>{const element=host.current;if(!element||!showGraph)return;const measure=()=>setHeight(Math.max(36,element.getBoundingClientRect().height));const observer=new ResizeObserver(measure);observer.observe(element);measure();return()=>observer.disconnect();},[showGraph]);
  const {commit,lane,color,connected,before,after}=row,x=(lane:number)=>10+lane*14;
  const arrowLeft=showGraph?x(lane)+18:4,width=showGraph?Math.max(row.width+12,arrowLeft+18):22;
  return <li ref={host} className="commit-history-entry">
    <div className="commit-history-rail" style={{width}} aria-hidden="true">{showGraph&&<svg width={width} height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {before.map((item,index)=>item.sha===commit.sha?(connected&&<path key={item.sha} d={`M ${x(index)} 0 V 18`} stroke={colors[item.color%colors.length]}/>):<path key={item.sha} d={`M ${x(index)} 0 C ${x(index)} 18, ${x(after.findIndex(next=>next.sha===item.sha))} 18, ${x(after.findIndex(next=>next.sha===item.sha))} 36 V ${height}`} stroke={colors[item.color%colors.length]}/>)}
      {commit.parents.map(sha=>{const to=after.findIndex(item=>item.sha===sha);return <path key={sha} d={`M ${x(lane)} 18 C ${x(lane)} 30, ${x(to)} 24, ${x(to)} 36 V ${height}`} stroke={colors[after[to].color%colors.length]}/>;})}
      <circle cx={x(lane)} cy="18" r={commit.parents.length>1?4:3} fill={commit.parents.length>1?'var(--surface-1)':colors[color%colors.length]} stroke={colors[color%colors.length]} strokeWidth="2"/>
    </svg>}</div>
    <div className="commit-history-content"><button className="commit-history-row" aria-expanded={expanded} onClick={onToggle} title={`${commit.message}\n${commit.sha}`}><Icon name="chevron-right" size={12} style={{left:arrowLeft}} className={`commit-history-chevron ${expanded?'is-expanded':''}`}/>{state.unread.has(commit.sha)&&<span className="github-new-indicator" title="New commit"><Icon name="bell" size={12}/><span className="sr-only">New commit</span></span>}<span className="commit-history-subject">{commit.message}</span>{commit.refs.slice(0,2).map(ref=><span key={ref} className={`commit-history-ref ${/^HEAD(?: ->|$)/.test(ref)?'is-head':''}`} title={ref}>{ref.replace('HEAD -> ','')}</span>)}{commit.refs.length>2&&<span className="commit-history-ref" title={commit.refs.slice(2).join(', ')}>+{commit.refs.length-2}</span>}</button>
      {expanded&&<div className="commit-history-details"><span>{commit.author} · {new Date(commit.committedAt).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'})}</span>{commit.parents.length>1&&<span>Merge · {commit.parents.length} parents · changes against first parent</span>}{state.projectId&&<ChangedFiles projectId={state.projectId} nodeId={state.nodeId} sha={commit.sha}/>}</div>}
    </div>
  </li>;
}
export function CommitHistoryGraph({ observation: state, showGraph=true }: { observation: Observation; showGraph?:boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (state.loading && !state.section?.data) return <div className="commit-history-loading" role="status" aria-label="Loading commit graph">{[0,1,2,3,4].map(i=><div key={i} className="commit-history-skeleton"/>)}</div>;
  const errorNotice=state.error&&<div className="panel-alert alert-error" role="alert">{state.error}{state.section?.data&&' Showing previously loaded history.'}<button className="btn btn-xs btn-secondary" disabled={state.loading} onClick={state.retry}>Retry</button></div>;
  if(state.error&&!state.section?.data)return errorNotice;
  const data=state.section?.data;
  if(!data?.commits.length)return <div className="empty-hint">{state.section?.meta.availability==='unsupported'?'Commit history requires a local Git repository.':'No local commits available.'}</div>;
  return <div className="commit-history-graph" aria-busy={state.loading}>{errorNotice}<ul aria-label="Local commit history">{layoutCommitGraph(data.commits).map(row=><GraphRow key={row.commit.sha} row={row} showGraph={showGraph} state={state} expanded={expanded===row.commit.sha} onToggle={()=>{state.acknowledge(row.commit.sha);setExpanded(expanded===row.commit.sha?null:row.commit.sha);}}/>)}</ul>{data.truncated&&<p className="text-xs text-muted">Showing the newest 200 commits. Lines continue beyond this window.</p>}</div>;
}
