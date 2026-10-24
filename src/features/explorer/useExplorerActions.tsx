import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { FilePlus, FolderPlus, Files, File } from 'lucide-react';
import type { WorkspaceEntry, WorkspaceFileStat, WorkspaceFileActionResult } from '../../../shared/contracts';
import { workspaceFilesRequest } from '../../api/client';
import { ContextMenu, type ContextMenuAction } from '../../components/ui/ContextMenu';
import { Modal } from '../../components/ui/Modal';
import { DialogActions, DialogError } from '../../components/ui/DialogActions';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { ActionNotice } from '../../components/ui/ActionNotice';
import { useConfirmationState } from '../../hooks/useConfirmationState';

type Target = Pick<WorkspaceEntry,'path'|'name'|'directory'|'symlink'>;
const parent = (value: string) => value.includes('/')?value.slice(0,value.lastIndexOf('/')):'';
const join = (directory: string,name: string) => directory?`${directory}/${name}`:name;
const clean = (error: unknown) => (error instanceof Error?error.message:'File operation failed').replace(/^\[[A-Z_]+\]\s*/, '');
type TrashEntry={restoreId:string;name:string};
function readTrash(scope:string):TrashEntry[]{try{return (JSON.parse(localStorage.getItem('vade:explorer-trash')??'{}')[scope]??[]).filter((entry:TrashEntry)=>typeof entry.restoreId==='string'&&typeof entry.name==='string').slice(-20);}catch{return [];}}
function writeTrash(scope:string,entries:TrashEntry[]){try{const all=JSON.parse(localStorage.getItem('vade:explorer-trash')??'{}');delete all[scope];all[scope]=entries.slice(-20);const keys=Object.keys(all);for(const key of keys.slice(0,Math.max(0,keys.length-20)))delete all[key];localStorage.setItem('vade:explorer-trash',JSON.stringify(all));}catch{/* Undo remains available for this view. */}}
export function useExplorerActions({projectId,worktreeId,rootPath,onRefresh,onView}:{projectId:string|null;worktreeId:string;rootPath:string;onRefresh:()=>void;onView:(path:string,diff?:boolean)=>void}) {
  const [menu,setMenu]=useState<{target:Target;position:{x:number;y:number};scope:string}|null>(null);
  const [clipboard,setClipboard]=useState<{path:string;version:string}|null>(null),[notice,setNotice]=useState<{message:string;restoreId?:string}|null>(null);
  const dialog=useConfirmationState<{action:'file'|'folder'|'rename'|'trash';target:Target;version?:string;scope:string}>();
  const noticeLife=useConfirmationState({onClosed:()=>setNotice(null)});
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [trash,setTrash]=useState<TrashEntry[]>([]);
  const scope=`${projectId}:${worktreeId}`,current=useRef(scope);current.current=scope;
  const locked=useRef(false),alive=useRef(true),epoch=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!notice)return;noticeLife.open();const timer=setTimeout(noticeLife.close,notice.restoreId?8000:3200);return()=>clearTimeout(timer);},[notice,noticeLife.open,noticeLife.close]);
  useEffect(()=>{epoch.current++;setMenu(null);dialog.reset();setClipboard(null);setNotice(null);setError(null);setBusy(false);setTrash(readTrash(scope));},[scope]);
  const fresh=(owner:string,operation:number)=>alive.current&&current.current===owner&&epoch.current===operation;
  const stat=(target:Target)=>workspaceFilesRequest<WorkspaceFileStat>(projectId!,'stat',{worktreeId,path:target.path});
  const run=async(values:Record<string,string>,after?:(result:WorkspaceFileActionResult)=>void)=>{
    if(!projectId||locked.current)return;locked.current=true;setBusy(true);setError(null);const owner=scope,operation=epoch.current;
    try{const result=await workspaceFilesRequest<WorkspaceFileActionResult>(projectId,'action',{worktreeId,...values});if(fresh(owner,operation)){onRefresh();after?.(result);}}
    catch(reason){if(fresh(owner,operation))setError(clean(reason));}
    finally{locked.current=false;if(fresh(owner,operation))setBusy(false);}
  };
  const begin=async(action:'file'|'folder'|'rename'|'trash',target:Target)=>{
    if(locked.current)return;setName(action==='rename'?target.name:'');setError(null);dialog.open({action,target,scope});
    if(action==='file'||action==='folder')return;
    setBusy(true);const owner=scope,operation=++epoch.current;
    try{const info=await stat(target);if(fresh(owner,operation))dialog.open({action,target,version:info.version,scope});}catch(reason){if(fresh(owner,operation))setError(clean(reason));}finally{if(fresh(owner,operation))setBusy(false);}
  };
  const copyPath=async(target:Target,relative=false)=>{try{await navigator.clipboard.writeText(relative?target.path:join(rootPath.replaceAll('\\','/').replace(/\/$/,''),target.path));setNotice({message:relative?'Relative path copied':'Path copied'});}catch(reason){setError(clean(reason));}};
  const copy=async(target:Target)=>{
    const owner=scope,operation=epoch.current;
    try{const info=await stat(target);if(!fresh(owner,operation))return;setClipboard({path:target.path,version:info.version});await copyPath(target);if(fresh(owner,operation))setNotice({message:'Copied. Choose Paste in an Explorer folder.'});}catch(reason){if(fresh(owner,operation))setError(clean(reason));}
  };
  const paste=(target:Target)=>{if(!clipboard)return;const directory=target.directory?target.path:parent(target.path),destination=join(directory,clipboard.path.split('/').pop()!);void run({action:destination===clipboard.path?'duplicate':'copy',path:clipboard.path,version:clipboard.version,destination},()=>setNotice({message:'Item copied'}));};
  const duplicate=async(target:Target)=>{const owner=scope,operation=epoch.current;try{const info=await stat(target);if(fresh(owner,operation))await run({action:'duplicate',path:target.path,version:info.version},()=>setNotice({message:'Duplicate created'}));}catch(reason){if(fresh(owner,operation))setError(clean(reason));}};
  const reveal=async(target:Target)=>{try{await workspaceFilesRequest(projectId!,'open',{worktreeId,path:target.path,target:'system'});}catch(reason){setError(clean(reason));}};
  const restore=(restoreId:string)=>void run({action:'restore',path:'',restoreId},()=>{const next=trash.filter(entry=>entry.restoreId!==restoreId);setTrash(next);writeTrash(scope,next);setNotice({message:'Item restored'});});
  const submit=()=>{
    const data=dialog.data;if(!data||data.scope!==scope||busy)return;
    const directory=data.target.directory?data.target.path:parent(data.target.path);
    if(data.action==='trash')void run({action:'trash',path:data.target.path,version:data.version!},result=>{dialog.close();if(result.restoreId){const next=[...trash,{restoreId:result.restoreId,name:data.target.name}].slice(-20);setTrash(next);writeTrash(scope,next);}setNotice({message:`${data.target.name} moved to Trash`,restoreId:result.restoreId});});
    else if(name.trim())void run({action:data.action,path:data.action==='rename'?data.target.path:join(directory,name.trim()),...(data.action==='rename'?{destination:join(parent(data.target.path),name.trim()),version:data.version!}:{})},result=>{if(data.action==='rename')dialog.reset();else dialog.close();setNotice({message:data.action==='rename'?'Item renamed':data.action==='folder'?'Folder created':'File created'});if(data.action==='file')onView(result.path);});
  };
  const root:Target={path:'',name:'Workspace',directory:true,symlink:false};
  const context=(event:MouseEvent,target:Target=root)=>{if(!projectId||!worktreeId)return;event.preventDefault();event.stopPropagation();setMenu({target,position:{x:event.clientX,y:event.clientY},scope});};
  const keyboard=(event:KeyboardEvent,target:Target=root)=>{
    if((event.key==='F10'&&event.shiftKey)||event.key==='ContextMenu'){event.preventDefault();event.stopPropagation();const box=event.currentTarget.getBoundingClientRect();setMenu({target,position:{x:box.left+16,y:box.top+20},scope});}
    else if(event.altKey&&event.shiftKey&&event.key.toLowerCase()==='c'){event.preventDefault();event.stopPropagation();void copyPath(target,event.ctrlKey||event.metaKey);}
    else if(target.path&&(event.key==='F2'||event.key==='Delete')){event.preventDefault();event.stopPropagation();void begin(event.key==='F2'?'rename':'trash',target);}
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'&&target.path){event.preventDefault();event.stopPropagation();void copy(target);}
    else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='v'&&clipboard){event.preventDefault();event.stopPropagation();paste(target);}
  };
  const actions:ContextMenuAction[]=menu?[
    {label:'New File',icon:<FilePlus size={14}/>,onSelect:()=>void begin('file',menu.target)},
    {label:'New Folder',icon:<FolderPlus size={14}/>,onSelect:()=>void begin('folder',menu.target)},
    ...(menu.target.path?[{label:'Copy',icon:'copy' as const,separatorBefore:true,shortcut:'Ctrl+C',onSelect:()=>void copy(menu.target)},{label:'Copy Path',icon:'copy' as const,shortcut:'Alt+Shift+C',onSelect:()=>void copyPath(menu.target)},{label:'Copy Relative Path',icon:'copy' as const,shortcut:'Ctrl+Alt+Shift+C',onSelect:()=>void copyPath(menu.target,true)},{label:'Duplicate',icon:<Files size={14}/>,onSelect:()=>void duplicate(menu.target)}]:[]),
    ...(clipboard?[{label:'Paste',icon:'copy' as const,shortcut:'Ctrl+V',onSelect:()=>paste(menu.target)}]:[]),
    ...(trash.length?[{label:'Undo Last Delete',icon:'rotate-ccw' as const,onSelect:()=>restore(trash[trash.length-1].restoreId)}]:[]),
    ...(!menu.target.directory?[{label:'View File',icon:<File size={14}/>,onSelect:()=>onView(menu.target.path)},{label:'View Git Changes',icon:'git-branch' as const,onSelect:()=>onView(menu.target.path,true)},{label:'Open in Browser',icon:'globe' as const,onSelect:()=>window.open(`/api/projects/${encodeURIComponent(projectId!)}/files/browser?${new URLSearchParams({worktreeId,path:menu.target.path})}`,'_blank','noopener,noreferrer')}]:[]),
    {label:'Reveal in File Explorer',icon:'external-link',onSelect:()=>void reveal(menu.target)},
    ...(menu.target.path?[{label:'Rename',icon:'edit' as const,separatorBefore:true,shortcut:'F2',onSelect:()=>void begin('rename',menu.target)},{label:'Delete',icon:'trash' as const,danger:true,shortcut:'Delete',onSelect:()=>void begin('trash',menu.target)}]:[])
  ]:[];
  const renameEpoch=epoch.current;
  const rename=dialog.present&&dialog.data?.scope===scope&&dialog.data.action==='rename'?{path:dialog.data.target.path,name,busy,error,ready:Boolean(dialog.data.version),change:setName,commit:()=>{if(epoch.current!==renameEpoch)return;if(name===dialog.data?.target.name){dialog.reset();return;}if(dialog.data?.version)submit();},cancel:()=>{epoch.current++;dialog.reset();setError(null);setBusy(false);}}:null;
  return {context,keyboard,rename,ui:<>
    {menu&&menu.scope===scope&&<ContextMenu key={`${menu.target.path}:${menu.position.x}:${menu.position.y}`} className="workspace-context-menu" animateExit preferLeft position={menu.position} label="File actions" actions={actions.map(action=>({...action,disabled:busy||menu.target.symlink}))} onClose={()=>setMenu(null)}/>}
    {notice&&noticeLife.present&&<ActionNotice closing={noticeLife.closing} onClose={noticeLife.close} label="Dismiss file action message"><span>{notice.message}</span>{notice.restoreId&&<button className="btn btn-secondary btn-sm" disabled={busy} onClick={()=>restore(notice.restoreId!)}>Undo</button>}</ActionNotice>}
    {error&&!dialog.present&&<DialogError error={error}/>}
    {dialog.present&&(dialog.data?.action==='file'||dialog.data?.action==='folder')&&<Modal isOpen isClosing={dialog.closing} busy={busy} onClose={dialog.close} className="confirmation-dialog" aria-labelledby="workspace-action-title"><div className="overlay-heading"><h2 id="workspace-action-title">{dialog.data?.action==='folder'?'New Folder':'New File'}</h2><OverlayCloseButton disabled={busy} onClick={dialog.close}/></div><form onSubmit={event=>{event.preventDefault();submit();}}><label className="worktree-field">Name<input autoFocus aria-label="File or folder name" value={name} onChange={event=>setName(event.target.value)} disabled={busy} maxLength={200}/></label></form><DialogError error={error}/><DialogActions onCancel={dialog.close} onConfirm={submit} busy={busy} disabled={!name.trim()} confirmLabel="Create"/></Modal>}
    <ConfirmationDialog isOpen={dialog.present&&dialog.data?.action==='trash'} isClosing={dialog.closing} title="Move to Trash?" description={`Move “${dialog.data?.target.name??''}” to Vade Trash? You can restore it with Undo.`} confirmLabel="Move to Trash" confirmVariant="danger" isConfirming={busy} confirmDisabled={!dialog.data?.version} error={error} onClose={dialog.close} onConfirm={submit}/>
  </>};
}
