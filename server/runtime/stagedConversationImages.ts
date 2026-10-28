import fs from 'node:fs';
import path from 'node:path';
import type {ConversationImage} from '../../shared/contracts.js';
import {MAX_ATTACHMENT_BYTES} from '../../shared/contracts.js';
import {conversationImageId,MAX_MESSAGE_IMAGES,recordedImageMimeType} from '../providers/conversationImages.js';
import {publicTranscriptRecord} from '../providers/shared.js';

/** Only direct UUID files created by the backend attachment store are eligible.
 * Transcript paths elsewhere on the host are never read or sent to the browser. */
function references(provider:string,line:string,root:string):{file:string;text:string}[]{
  if(!['codex','claude'].includes(provider))return [];
  try{
    const raw=JSON.parse(line),record=publicTranscriptRecord(line,provider);
    if(record?.payload?.role!=='user'||raw.message?.content?.some?.((block:any)=>['tool_result','tool_use'].includes(block?.type)))return [];
    const prefix=path.resolve(root).replaceAll('\\','/').replace(/\/$/,'')+'/';
    const found:{file:string;text:string}[]=[];
    for(const block of record.payload.content??[]){
      if(!['input_text','text'].includes(block?.type)||typeof block.text!=='string')continue;
      for(const text of block.text.split(/\r?\n/)){
        const trimmed=text.trim(),reference=trimmed.replace(/^"([^"\n]+)"$|^'([^'\n]+)'$/,'$1$2').replaceAll('\\','/');
        const starts=process.platform==='win32'?reference.toLowerCase().startsWith(prefix.toLowerCase()):reference.startsWith(prefix);
        if(!starts)continue;
        const name=reference.slice(prefix.length);
        if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.(?:png|jpg|gif|webp)$/.test(name)||found.some(item=>item.file===path.join(root,name)))continue;
        found.push({file:path.join(root,name),text:trimmed});
        if(found.length>=MAX_MESSAGE_IMAGES)return found;
      }
    }
    return found;
  }catch{return [];}
}

function readOwnedImage(root:string,file:string):{mimeType:string;bytes:Buffer}|null{
  let fd:number|undefined;
  try{
    if(fs.lstatSync(root).isSymbolicLink())return null;
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!stat.size||stat.size>MAX_ATTACHMENT_BYTES)return null;
    if(fs.realpathSync(file)!==path.join(fs.realpathSync(root),path.basename(file)))return null;
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(fd);
    if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==stat.size)return null;
    const bytes=Buffer.alloc(stat.size);
    if(fs.readSync(fd,bytes,0,bytes.length,0)!==bytes.length)return null;
    const mimeType=recordedImageMimeType(bytes);
    return mimeType?{mimeType,bytes}:null;
  }catch{return null;}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function stagedUserImages(provider:string,line:string,root:string,source:string,offset:number):{images:ConversationImage[];paths:string[]} {
  const images:ConversationImage[]=[],paths:string[]=[];
  for(const [index,reference] of references(provider,line,root).entries()){
    const image=readOwnedImage(root,reference.file);if(!image)continue;
    images.push({id:conversationImageId(source,offset,index,image.bytes.toString('base64')),mimeType:image.mimeType,bytes:image.bytes.length});
    paths.push(reference.text);
  }
  return {images,paths};
}

export function readStagedUserImage(provider:string,line:string,root:string,index:number):{mimeType:string;bytes:Buffer}|null{
  const reference=references(provider,line,root)[index];
  return reference?readOwnedImage(root,reference.file):null;
}

export function stripStagedImagePaths(text:string,paths:readonly string[]):string{
  if(!paths.length)return text;
  const removed=new Set(paths);
  return text.split(/\r?\n/).filter(line=>!removed.has(line.trim())).join('\n').trim();
}
