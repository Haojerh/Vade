import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Undo2 } from 'lucide-react';
import type { ConversationMessage, ConversationPage, RewindConversationRequest } from '../../../../shared/contracts';
import { rewindConversation } from '../../../api/client';
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog';
import { useConfirmationState } from '../../../hooks/ui/useConfirmationState';

const RewindContext=createContext<{disabled:boolean;nativePicker:boolean;open:(message:ConversationMessage)=>void}|null>(null);
export function ConversationRewind({projectId,nodeId,page,disabled,onRewound,onNativeRewind,children}:{projectId:string;nodeId:string;page:ConversationPage;disabled:boolean;onRewound:(message:string)=>void;onNativeRewind:()=>void;children:ReactNode}){
  const dialog=useConfirmationState<{request:RewindConversationRequest}>(),request=useRef<AbortController|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[uncertain,setUncertain]=useState(false);
  useEffect(()=>()=>{request.current?.abort();},[]);
  const nativePicker=['antigravity','codebuddy'].includes(page.provider??'');
  const available=nativePicker||Boolean(page.revision);
  const confirm=async()=>{
    if(!dialog.data||busy||disabled||uncertain||request.current)return;
    const abort=new AbortController();request.current=abort;setBusy(true);setError(null);
    try{const result=await rewindConversation(projectId,nodeId,dialog.data.request,abort.signal);if(!abort.signal.aborted){onRewound(result.message);dialog.close();}}
    catch(e){if(!abort.signal.aborted){setError(e instanceof Error?e.message:'Rewind was not confirmed. Inspect Terminal before continuing.');setUncertain(true);}}
    finally{if(request.current===abort)request.current=null;if(!abort.signal.aborted)setBusy(false);}
  };
  return <RewindContext.Provider value={available?{disabled:disabled||busy,nativePicker,open:message=>{if(disabled||busy)return;if(nativePicker){onNativeRewind();return;}if(!page.revision)return;setError(null);setUncertain(false);dialog.open({request:{messageId:message.id,sourceIdentity:page.sourceIdentity,revision:page.revision}});}}:null}>
    {children}
    <ConfirmationDialog isOpen={dialog.present} isClosing={dialog.closing} title="Rewind to here?" description="Continue from just before this message? This message and everything after it leave the active conversation, and its text returns to the composer so you can edit and resend it. File changes on disk are kept. The original native session is preserved." confirmLabel="Rewind" isConfirming={busy} confirmDisabled={disabled||uncertain} error={error} onConfirm={confirm} onClose={()=>{if(!busy)dialog.close();}} />
  </RewindContext.Provider>;
}
export function ConversationRewindButton({message}:{message:ConversationMessage}){
  const context=useContext(RewindContext);
  if(!context||(!context.nativePicker&&!message.rewindable)||message.role!=='user'||(!context.nativePicker&&message.images?.length))return null;
  const label=context.nativePicker?'Choose a rewind point in Terminal':'Rewind to this message';
  return <button type="button" className="btn-icon" title={label} aria-label={label} disabled={context.disabled} onClick={()=>context.open(message)}><Undo2 size={13}/></button>;
}
