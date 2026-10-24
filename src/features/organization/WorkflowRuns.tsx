import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import type { WorkflowRun,WorkflowRunSummary } from '../../../shared/contracts';
import { cancelWorkflowRun,fetchWorkflowRunDetails,fetchWorkflowRunSummaries } from '../../api/client';
import { Disclosure } from '../../components/ui/Disclosure';
import { Icon } from '../../components/ui/Icon';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Skeleton } from '../../components/ui/Skeleton';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { MessageMarkdown } from '../workflow/MessageMarkdown';
import './workflowRuns.css';

const ended=(state:string)=>['completed','failed','cancelled'].includes(state);
const names:Record<string,string>={planning:'Planning',running:'Running',blocked:'Needs attention',completed:'Completed',failed:'Failed',cancelled:'Cancelled',pending:'Pending',starting:'Starting',interrupted:'Interrupted',skipped:'Skipped'};
const date=(value:string)=>new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function Status({state}:{state:string}){return <span className={`workflow-run-status is-${state}`}><i aria-hidden="true"/>{names[state]??state}</span>;}
function RunDetails({run,onCancel}:{run:WorkflowRun;onCancel:()=>void}){
  const [messageLimit,setMessageLimit]=useState(20);
  const label=(id:string)=>id==='orchestrator'?'Coordinator':run.config.nodes.find(node=>node.id===id)?.title??id;
  return <div className="workflow-run-body">
    <div className="workflow-run-facts"><span>Started <time dateTime={run.createdAt}>{date(run.createdAt)}</time></span><span>Updated <time dateTime={run.updatedAt}>{date(run.updatedAt)}</time></span><span title={run.id}>Run <code>{run.id.slice(0,8)}</code></span></div>
    {run.error&&<div className="workflow-run-alert" role="alert"><Icon name="alert-circle" size={15}/><span>{run.error}</span></div>}
    {run.result&&<div className="workflow-run-result"><h3>Run summary</h3><MessageMarkdown text={run.result}/></div>}
    {run.planReason&&<Disclosure title="Execution plan" compact lazy><div className="workflow-run-copy"><MessageMarkdown text={run.planReason}/></div></Disclosure>}
    <Disclosure title="Original task" compact lazy><div className="workflow-run-copy"><MessageMarkdown text={run.originalRequest||'Attachment-only task'}/></div></Disclosure>
    <div className="workflow-run-steps"><h3>Agents <span>{run.steps.length}</span></h3>{run.steps.map(step=>{const node=run.config.nodes.find(node=>node.id===step.nodeId);return <div className="workflow-run-step" key={step.nodeId}><div className="workflow-run-step-heading">{node&&<ProviderIcon provider={node.provider} size={17}/>}<strong>{node?.title??step.nodeId}</strong>{step.stream&&<small title="Workstream">{step.stream}</small>}<Status state={step.state}/></div>{step.delivery==='uncertain'&&<p className="workflow-run-delivery">Delivery is uncertain. Inspect the agent before sending anything again.</p>}{step.result&&<Disclosure title="Agent result" compact lazy><div className="workflow-run-copy"><MessageMarkdown text={step.result}/></div></Disclosure>}</div>;})}</div>
    {run.streams.length>0&&<Disclosure title={`Workstreams (${run.streams.length})`} compact lazy><div className="workflow-run-streams">{run.streams.map(stream=><div key={stream.id}><strong>{stream.title}</strong><span>{stream.integrated?'Integrated':'Not integrated'}</span></div>)}</div></Disclosure>}
    {run.integrationPath&&<div className="workflow-run-path"><Icon name="folder" size={13}/><span>Integration worktree<code>{run.integrationPath}</code></span></div>}
    {run.messages.length>0&&<Disclosure title={`Team messages (${run.messages.length})`} compact lazy><div className="workflow-run-messages">{run.messages.length>messageLimit&&<button className="btn btn-secondary btn-xs" onClick={()=>setMessageLimit(value=>value+20)}>Show earlier messages</button>}{run.messages.slice(-messageLimit).map(message=><div key={message.id}><div><strong>{label(message.from)} <span>→</span> {label(message.to)}</strong><time dateTime={message.at}>{date(message.at)}</time></div><MessageMarkdown text={message.text}/></div>)}</div></Disclosure>}
    {!ended(run.state)&&<div className="workflow-run-footer"><span>Worktrees are preserved when a run is cancelled.</span><button className="btn btn-danger btn-xs" onClick={onCancel}><Icon name="x-square" size={13}/>Cancel run</button></div>}
  </div>;
}
export function WorkflowRuns(){
  const [runs,setRuns]=useState<WorkflowRunSummary[]>([]),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[error,setError]=useState<string|null>(null);
  const [filter,setFilter]=useState('all'),[search,setSearch]=useState(''),[limit,setLimit]=useState(20),[selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<WorkflowRun|null>(null),[detailError,setDetailError]=useState<string|null>(null),[detailLoading,setDetailLoading]=useState(false),[retry,setRetry]=useState(0);
  const confirmation=useConfirmationState<WorkflowRunSummary>(),[cancelling,setCancelling]=useState(false),[cancelError,setCancelError]=useState<string|null>(null);
  const alive=useRef(true),currentRuns=useRef(runs),request=useRef<AbortController|null>(null),pending=useRef<Promise<void>|null>(null),signature=useRef('');currentRuns.current=runs;
  const detailsCache=useRef(new Map<string,{run:WorkflowRun;size:number}>());
  const load=useCallback((manual=false):Promise<void>=>{
    if(pending.current&&!request.current?.signal.aborted)return pending.current;
    const abort=new AbortController();request.current=abort;if(manual)setRefreshing(true);
    const operation=fetchWorkflowRunSummaries(abort.signal).then(next=>{if(!alive.current||abort.signal.aborted)return;const nextSignature=next.map(run=>`${run.id}:${run.updatedAt}:${run.state}`).join('|');if(nextSignature!==signature.current){signature.current=nextSignature;currentRuns.current=next;setRuns(next);}setError(null);}).catch(error=>{if(alive.current&&!abort.signal.aborted)setError(error.message);}).finally(()=>{if(alive.current&&!abort.signal.aborted){setLoading(false);setRefreshing(false);}if(request.current===abort){request.current=null;pending.current=null;}});
    pending.current=operation;return operation;
  },[]);
  useEffect(()=>{alive.current=true;let disposed=false,generation=0,timer:ReturnType<typeof setTimeout>|undefined;const tick=async()=>{if(document.hidden||disposed)return;const version=++generation;await load();if(!disposed&&version===generation&&!document.hidden)timer=setTimeout(tick,currentRuns.current.some(run=>!ended(run.state))?3000:15000);};const visibility=()=>{generation++;clearTimeout(timer);if(document.hidden)request.current?.abort();else void tick();};document.addEventListener('visibilitychange',visibility);void tick();return()=>{disposed=true;alive.current=false;clearTimeout(timer);request.current?.abort();document.removeEventListener('visibilitychange',visibility);};},[load]);
  const active=runs.filter(run=>!ended(run.state)).length;
  const filtered=useMemo(()=>[...runs].filter(run=>(filter==='all'||(filter==='active'?!ended(run.state):ended(run.state)))&&`${run.requestPreview} ${run.id}`.toLowerCase().includes(search.trim().toLowerCase())).sort((a,b)=>Number(ended(a.state))-Number(ended(b.state))||Date.parse(b.createdAt)-Date.parse(a.createdAt)),[runs,filter,search]);
  const selectedSummary=filtered.slice(0,limit).find(run=>run.id===selected);
  useEffect(()=>{
    if(!selectedSummary){setDetail(null);setDetailError(null);return;}
    const {id,updatedAt}=selectedSummary,cached=detailsCache.current.get(id);setDetail(cached?.run??null);setDetailError(null);
    if(cached?.run.updatedAt===updatedAt){setDetailLoading(false);return;}
    const abort=new AbortController();setDetailLoading(true);
    void fetchWorkflowRunDetails(id,abort.signal).then(run=>{if(abort.signal.aborted)return;setDetail(run);const size=JSON.stringify(run).length*2;const cache=detailsCache.current;cache.delete(id);cache.set(id,{run,size});let total=[...cache.values()].reduce((sum,entry)=>sum+entry.size,0);while(cache.size>3||total>4*1024*1024){const oldest=cache.keys().next().value!;total-=cache.get(oldest)!.size;cache.delete(oldest);}}).catch(error=>{if(!abort.signal.aborted)setDetailError(error.message);}).finally(()=>{if(!abort.signal.aborted)setDetailLoading(false);});
    return()=>abort.abort();
  },[selectedSummary?.id,selectedSummary?.updatedAt,retry]);
  const cancel=async()=>{const run=confirmation.data;if(!run||cancelling)return;const latest=currentRuns.current.find(item=>item.id===run.id);if(!latest||ended(latest.state)){confirmation.close();return;}setCancelling(true);setCancelError(null);try{await cancelWorkflowRun(run.id);if(alive.current){confirmation.close();await load(true);}}catch(error){if(alive.current)setCancelError((error as Error).message);}finally{if(alive.current)setCancelling(false);}};
  return <section className="workflow-runs" aria-labelledby="workflow-runs-heading"><header className="workflow-runs-heading"><div><h2 id="workflow-runs-heading">Workflow runs <span>{runs.length}</span></h2><p>Execution history for workflows and agent-defined teams.</p></div><button className="btn-icon" title="Refresh workflow runs" aria-label="Refresh workflow runs" disabled={loading||refreshing} onClick={()=>void load(true)}><RefreshIcon busy={loading||refreshing} size={16}/></button></header>
    {!loading&&runs.length>0&&<><div className="workflow-runs-counts"><span><i className="is-running"/>{active} active</span><span><i className="is-blocked"/>{runs.filter(run=>run.state==='blocked'||run.state==='failed').length} need attention</span><span><i className="is-completed"/>{runs.filter(run=>run.state==='completed').length} completed</span></div><div className="workflow-runs-toolbar"><div className="workflow-runs-search"><Icon name="search" size={14}/><input aria-label="Search workflow run summaries" placeholder="Search tasks or run IDs…" value={search} onChange={event=>{setSearch(event.target.value);setLimit(20);}}/>{search&&<button className="btn-icon" aria-label="Clear run search" onClick={()=>setSearch('')}><Icon name="close" size={12}/></button>}</div><SegmentedControl label="Filter workflow runs" choices={[{value:'all',label:'All'},{value:'active',label:'Active'},{value:'finished',label:'Finished'}]} value={filter} onChange={value=>{setFilter(value);setLimit(20);}} radius={6}/></div></>}
    {error&&<div className="workflow-run-alert" role="alert"><Icon name="alert-circle" size={16}/><span>{error}{runs.length>0?' Showing the last loaded runs.':''}</span><button className="btn btn-secondary btn-xs" onClick={()=>void load(true)}>Retry</button></div>}
    {loading?<Skeleton lines={6} label="Loading workflow runs"/>:!runs.length&&!error?<div className="workflow-runs-empty"><Icon name="workflow" size={28}/><strong>No runs yet</strong><p>Confirmed workflow tasks and explicitly launched agent teams appear here.</p></div>:!filtered.length&&!error?<div className="workflow-runs-empty"><Icon name="search" size={24}/><strong>No matching runs</strong><p>Try another search or filter.</p><button className="btn btn-secondary btn-xs" onClick={()=>{setSearch('');setFilter('all');}}>Clear filters</button></div>:<div className="workflow-runs-list">{filtered.slice(0,limit).map(run=><Disclosure key={run.id} title={run.requestPreview||'Attachment-only task'} compact className={`workflow-run-card is-${run.state}`} open={selected===run.id} onOpenChange={open=>setSelected(open?run.id:null)} triggerContent={<span className="workflow-run-summary"><strong>{run.requestPreview||'Attachment-only task'}</strong><span><small>{run.mode==='adhoc'?'Agent team':'Saved workflow'}</small><time dateTime={run.createdAt}>{date(run.createdAt)}</time><span>{run.counts.completed}/{run.counts.total-run.counts.skipped} agents completed</span></span></span>} badge={<Status state={run.state}/>}>{selected===run.id&&<>{detailError&&<div className="workflow-run-alert" role="alert"><span>{detailError}</span><button className="btn btn-secondary btn-xs" onClick={()=>setRetry(value=>value+1)}>Retry</button></div>}{detailLoading&&!detail?<div className="workflow-run-body"><Skeleton lines={5} label="Loading run details"/></div>:detail&&detail.id===run.id?<RunDetails key={run.id} run={detail} onCancel={()=>{setCancelError(null);confirmation.open(run);}}/>:null}</>}</Disclosure>)}</div>}
    {filtered.length>limit&&<button className="btn btn-secondary btn-sm workflow-runs-more" onClick={()=>setLimit(value=>value+20)}>Show more <span>({filtered.length-limit} remaining)</span></button>}
    <ConfirmationDialog isOpen={confirmation.present} isClosing={confirmation.closing} title="Cancel this workflow run?" description="Stop its active workers and end this run. All worktrees and their files are kept." confirmLabel="Cancel run" cancelLabel="Keep running" confirmVariant="danger" isConfirming={cancelling} error={cancelError} onClose={confirmation.close} onConfirm={()=>void cancel()}/>
  </section>;
}
