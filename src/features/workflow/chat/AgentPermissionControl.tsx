import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert, Eye, Hand, FolderCheck, ChevronDown, Check } from 'lucide-react';
import type { AgentChatOptions } from '../../../../shared/contracts';
import { fetchAgentChatOptions, setAgentChatOption } from '../../../api/client';
import { Popover } from '../../../components/ui/Popover';
import { usePopoverState } from '../../../hooks/ui/usePopoverState';
import { useConfirmationState } from '../../../hooks/ui/useConfirmationState';
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog';
import { permissionPresentation } from './permissionPresentation';

const permissionIcons={eye:Eye,hand:Hand,folder:FolderCheck,shield:ShieldCheck,alert:ShieldAlert};
type PermissionChoice=NonNullable<AgentChatOptions['permissions']>[number];

export function AgentPermissionControl({projectId,nodeId,runId,disabled}:{projectId:string;nodeId:string;runId:string|null;disabled:boolean}) {
  return <BoundAgentPermissionControl key={JSON.stringify([projectId,nodeId,runId])} projectId={projectId} nodeId={nodeId} runId={runId} disabled={disabled}/>;
}

function BoundAgentPermissionControl({projectId,nodeId,runId,disabled}:{projectId:string;nodeId:string;runId:string|null;disabled:boolean}) {
  const [options,setOptions]=useState<AgentChatOptions|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const trigger=useRef<HTMLButtonElement>(null),request=useRef<AbortController|null>(null),mutation=useRef<AbortController|null>(null),overlay=usePopoverState();
  const confirmation=useConfirmationState<PermissionChoice>();
  const [uncertain,setUncertain]=useState(false);
  useEffect(()=>{
    let disposed=false,attempts=0,timer:ReturnType<typeof setTimeout>|undefined;
    const retry=()=>{if(!disposed&&attempts<15)timer=setTimeout(load,1000);};
    const load=()=>{
      if(disposed||mutation.current||document.visibilityState==='hidden')return;
      clearTimeout(timer);request.current?.abort();const abort=new AbortController();request.current=abort;attempts++;
      void fetchAgentChatOptions(projectId,nodeId,runId,abort.signal).then(section=>{
        if(abort.signal.aborted||disposed)return;
        if(!section.meta.stale&&section.data)setOptions(section.data);
        if(section.meta.stale||!section.data?.permissions?.length)retry();
      }).catch(()=>{if(!abort.signal.aborted)retry();});
    };
    const refresh=()=>{attempts=0;load();};
    load();window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{disposed=true;clearTimeout(timer);request.current?.abort();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[projectId,nodeId,runId,overlay.present,disabled]);
  useEffect(()=>()=>mutation.current?.abort(),[]);
  const apply=async(value:string,restart=false)=>{
    if(busy||disabled||mutation.current)return;request.current?.abort();const abort=new AbortController();mutation.current=abort;setBusy(true);setError(null);
    try{const next=await setAgentChatOption(projectId,nodeId,runId,{key:'permission',value,...(restart?{confirmRestart:true}:{})},abort.signal);if(!abort.signal.aborted){setOptions(next);overlay.close();confirmation.close();}}
    catch(e){if(!abort.signal.aborted){setError(e instanceof Error?e.message:'Unable to confirm permissions. Inspect Terminal.');if(restart)setUncertain(true);}}
    finally{if(mutation.current===abort)mutation.current=null;if(!abort.signal.aborted)setBusy(false);}
  };
  if(!options?.permissions?.length)return null;
  const selected=options.permissions.find(p=>p.value===options.current.permission);
  const current=selected?permissionPresentation(selected):{label:'Permissions',tone:'neutral',icon:'shield' as const};
  const CurrentIcon=permissionIcons[current.icon];
  const choose=(choice:PermissionChoice)=>{
    if(disabled||busy)return;setError(null);setUncertain(false);
    if(choice.value===options.current.permission){overlay.close();return;}
    if(options.permissionsRequireRestart){overlay.close();confirmation.open(choice);}
    else void apply(choice.value);
  };
  return <div className="native-permission-control">
    <button type="button" className={`native-permission-trigger permission-tone-${current.tone}`} ref={trigger} disabled={disabled||busy} title={`${options.permissionCurrentSource==='launch'?'Launch access':'Permissions'}: ${current.label}`} aria-label={`Permissions: ${current.label}`} aria-haspopup="dialog" aria-expanded={overlay.present&&!overlay.closing} onClick={()=>{setError(null);overlay.toggle();}}><CurrentIcon size={14}/><span>{current.label}</span><ChevronDown size={12}/></button>
    <Popover triggerRef={trigger} isOpen={overlay.present} isClosing={overlay.closing} onClose={overlay.close} floating portal placement="top" floatingWidth={320} className="agent-settings-popover native-permission-popover" aria-label="Agent permissions" inert={overlay.closing}>
      <div className="native-permission-heading"><strong>Permissions</strong><span>{options.permissionCurrentSource==='launch'?'Launch access':'Native access'}</span></div>
      <div className="native-permission-options">{options.permissions.map(p=>{const view=permissionPresentation(p),PermissionIcon=permissionIcons[view.icon];return <button key={p.value} type="button" className={`native-permission-option permission-tone-${view.tone}`} disabled={disabled||busy} aria-pressed={p.value===options.current.permission} onClick={()=>choose(p)}><PermissionIcon size={16}/><span><strong>{view.label}</strong>{view.description&&<small>{view.description}</small>}</span>{p.value===options.current.permission&&<Check size={14}/>}</button>;})}</div>
      {options.permissionsRequireRestart&&<p className="native-permission-footer">Changing access restarts this idle session.</p>}
      {busy&&<p role="status">Waiting for native confirmation…</p>}{error&&<p className="text-danger" role="alert">{error}</p>}
    </Popover>
    <ConfirmationDialog isOpen={confirmation.present} isClosing={confirmation.closing} title="Restart with different access?" description={`Restart this idle session with ${confirmation.data?permissionPresentation(confirmation.data).label:'the selected permissions'}? Your recorded conversation and disk files are kept. No message will be sent.`} confirmLabel="Restart session" confirmVariant="primary" isConfirming={busy} confirmDisabled={disabled||uncertain} error={error} onClose={()=>{if(!busy)confirmation.close();}} onConfirm={()=>{if(confirmation.data&&!uncertain)return apply(confirmation.data.value,true);}} />
  </div>;
}
