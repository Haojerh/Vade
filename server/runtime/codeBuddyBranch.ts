import fs from 'node:fs';import {hashId} from '../providers/transcriptUtils.js';
type Branch={epoch:string;limited:boolean;allows:(line:string)=>boolean};
const cache=new Map<string,{stamp:string;branch:Branch}>(),MAX_BYTES=16*1024*1024,MAX_ROWS=20000;
/** Read-only replay of native resend-fork-notice parent pointers. Never truncate logs. */
export function codeBuddyBranch(file:string,sessionId:string):Branch{
 const stat=fs.statSync(file),key=file+':'+sessionId,stamp=`${stat.ino}:${stat.size}:${stat.mtimeMs}`;
 const hit=cache.get(key);if(hit?.stamp===stamp)return hit.branch;
 const fd=fs.openSync(file,'r'),size=Math.min(stat.size,MAX_BYTES),bytes=Buffer.alloc(size);
 try{fs.readSync(fd,bytes,0,size,stat.size-size);}finally{fs.closeSync(fd);}
 const text=bytes.toString('utf8'),lines=(stat.size>size?text.slice(text.indexOf('\n')+1):text).split('\n').filter(Boolean);
 const limited=stat.size>size||lines.length>MAX_ROWS;
 const nodes=new Map<string,string|null>();let tip:string|null=null,epoch='initial';
 for(const line of lines.slice(-MAX_ROWS)){
  let row:any;try{row=JSON.parse(line);}catch{continue;}
  if(row.sessionId&&row.sessionId!==sessionId)continue;
  if(row.type==='resend-fork-notice'&&row.providerData?.resendForkNotice===true){
   tip=typeof row.parentId==='string'?row.parentId:null;epoch=typeof row.id==='string'?row.id:hashId('branch',line);continue;
  }
  if(typeof row.id!=='string'||row.id.length>200)continue;
  if(typeof row.parentId==='string'||['message','reasoning','function_call','function_call_result'].includes(row.type)){
   nodes.set(row.id,typeof row.parentId==='string'?row.parentId:typeof row.logicalParentId==='string'?row.logicalParentId:null);tip=row.id;
  }
 }
 const active=new Set<string>();let current=tip;
 while(current&&!active.has(current)&&active.size<MAX_ROWS){active.add(current);current=nodes.get(current)??null;}
 const branch:Branch={epoch,limited,allows:line=>{
  if(epoch==='initial'&&!limited)return true;
  try{const row=JSON.parse(line);if(row.sessionId&&row.sessionId!==sessionId)return false;
   if(row.type==='resend-fork-notice')return false;
   if(typeof row.id==='string'&&nodes.has(row.id))return active.has(row.id);
   return !['message','reasoning','function_call','function_call_result'].includes(row.type);
  }catch{return false;}
 }};
 if(cache.size>=32)cache.delete(cache.keys().next().value!);cache.set(key,{stamp,branch});return branch;
}
