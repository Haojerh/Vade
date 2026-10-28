import { useEffect,useRef,useState } from 'react';
import { Copy,Check,Share2,Download } from 'lucide-react';
import type { ConversationMessage } from '../../../shared/contracts';
import { Modal } from '../../components/ui/Modal';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { ConversationRewindButton } from './ConversationRewind';

function useResponseCopy(message:ConversationMessage){
  const [copied,setCopied]=useState(false),[error,setError]=useState<string|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),alive=useRef(true),text=useRef(message.text);text.current=message.text;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;clearTimeout(timer.current);};},[]);
  useEffect(()=>{setCopied(false);setError(null);clearTimeout(timer.current);},[message.text]);
  const copy=async()=>{const value=message.text;try{await navigator.clipboard.writeText(value);if(!alive.current||text.current!==value)return;setCopied(true);setError(null);clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),1800);}catch{if(alive.current)setError('Could not copy. Open Share response to select the text.');}};
  return {copied,error,setError,copy,alive};
}

function MessageTimestamp({message}:{message:ConversationMessage}){
  const date=message.at&&Number.isFinite(Date.parse(message.at))?new Date(message.at):null;
  return date?<time className="bubble-time" dateTime={message.at!} title={date.toLocaleString()}>{date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>:null;
}

export function UserMessageMeta({message}:{message:ConversationMessage}){
  const {copied,error,copy}=useResponseCopy(message);
  return <div className="user-message-meta">
    <button type="button" className="btn-icon" title={copied?'Copied':'Copy message'} aria-label={copied?'Message copied':'Copy message'} onClick={()=>void copy()}>{copied?<Check size={12}/>:<Copy size={12}/>}</button>
    <MessageTimestamp message={message}/>
    <ConversationRewindButton message={message}/>
    {copied&&<span className="sr-only" role="status">Message copied</span>}{error&&<span className="response-action-error" role="alert">Could not copy this message.</span>}
  </div>;
}

export function ResponseActions({message}:{message:ConversationMessage}){
  const share=useConfirmationState();
  const {copied,error,setError,copy,alive}=useResponseCopy(message);
  const download=()=>{const url=URL.createObjectURL(new Blob([message.text],{type:'text/markdown;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=`vade-response-${message.id.replace(/[^a-z0-9_-]/gi,'').slice(0,24)||'message'}.md`;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const nativeShare=async()=>{try{await navigator.share({title:'Vade response',text:message.text});}catch(reason){if(alive.current&&!(reason instanceof Error&&reason.name==='AbortError'))setError('Sharing is unavailable. Copy the response or save it as Markdown.');}};
  return <><div className="response-actions" aria-label="Response actions">
    <button type="button" className="btn-icon" aria-label={copied?'Response copied':'Copy response'} title={copied?'Copied':'Copy response'} onClick={()=>void copy()}>{copied?<Check size={15}/>:<Copy size={15}/>}</button>
    <button type="button" className="btn-icon" aria-label="Share response" title="Share response" onClick={()=>{setError(null);share.open();}}><Share2 size={15}/></button>
    <button type="button" className="btn-icon" aria-label="Save response as Markdown" title="Save as Markdown" onClick={download}><Download size={15}/></button>
    <MessageTimestamp message={message}/>
    {copied&&<span className="sr-only" role="status">Response copied</span>}
    {error&&!share.present&&<span className="response-action-error" role="alert">{error}</span>}
  </div>
    {share.present&&<Modal isOpen isClosing={share.closing} onClose={share.close} className="response-share-dialog" aria-label="Share response">
      <header className="modal-dialog-header"><h2>Share response</h2><OverlayCloseButton onClick={share.close}/></header>
      <div className="modal-dialog-body"><p className="text-muted">Copy this response or save it as Markdown.</p><textarea className="response-share-text" readOnly value={message.text} aria-label="Response text" spellCheck={false}/>{error&&<p className="text-danger" role="alert">{error}</p>}</div>
      <footer className="response-share-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={download}><Download size={14}/>Save Markdown</button>{typeof navigator!=='undefined'&&typeof navigator.share==='function'&&<button type="button" className="btn btn-secondary btn-sm" onClick={()=>void nativeShare()}><Share2 size={14}/>Share…</button>}<button type="button" className="btn btn-primary btn-sm" onClick={()=>void copy()}>{copied?<Check size={14}/>:<Copy size={14}/>} {copied?'Copied':'Copy response'}</button></footer>
    </Modal>}
  </>;
}
