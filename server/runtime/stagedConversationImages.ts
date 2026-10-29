import fs from 'node:fs';
import path from 'node:path';
import type {ConversationImage} from '../../shared/contracts.js';
import {MAX_ATTACHMENT_BYTES} from '../../shared/contracts.js';
import {conversationImageId,MAX_MESSAGE_IMAGES,recordedImageMimeType} from '../providers/conversationImages.js';
import {parseCoordinatorTranscriptLine} from '../providers/publicTranscript.js';
import {parseAntigravityTranscriptLine} from '../providers/antigravity.js';

/** Only direct UUID files created by the backend attachment store are eligible.
 * Transcript paths elsewhere on the host are never read or sent to the browser. */
const OWNED_ATTACHMENT=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.(?:png|jpg|gif|webp)$/i;
/** A provider records the staged reference however its own composer rendered it:
 * a bare path (Codex), an `@` file mention (Antigravity, DSH, CodeBuddy) or a quoted
 * path. Only the bounded token itself is removed from the public text. */
const TOKEN_END=/[\s"'<>()[\]{},;|]+/;

export interface StagedReference{file:string;tokens:string[]}

function normalize(value:string):string{return value.replaceAll('\\','/');}

/** Public user text for one recorded row, using the same parser as chat projection. */
export function stagedUserText(provider:string,line:string):string{
  try{
    if(provider==='antigravity')return parseAntigravityTranscriptLine(line,'staged').message?.text??'';
    const message=parseCoordinatorTranscriptLine(line,provider,'staged').message;
    return message?.role==='user'?message.text:'';
  }catch{return '';}
}

/** Ordered staged attachment references recorded inside one public user turn.
 * `tokens` are the exact recorded text spans, so a preview can replace them in place. */
export function stagedReferences(text:string,root:string):StagedReference[]{
  if(!text)return [];
  const normalized=normalize(text);
  const prefix=normalize(path.resolve(root)).replace(/\/$/,'')+'/';
  const caseInsensitive=process.platform==='win32';
  const haystack=caseInsensitive?normalized.toLowerCase():normalized;
  const needle=caseInsensitive?prefix.toLowerCase():prefix;
  const found:StagedReference[]=[];
  let from=0,scanned=0;
  while(found.length<MAX_MESSAGE_IMAGES&&scanned++<32){
    const at=haystack.indexOf(needle,from);
    if(at<0)break;
    from=at+needle.length;
    const remainder=normalized.slice(from,from+128);
    const stop=remainder.search(TOKEN_END);
    const raw=stop<0?remainder:remainder.slice(0,stop);
    // Sentence punctuation can follow a bare recorded path; it is not part of the name.
    const name=raw.replace(/[.,:;!?]+$/,'');
    if(!OWNED_ATTACHMENT.test(name))continue;
    const file=path.join(root,name);
    // The `@` that marks a file mention belongs to the reference, not the prose.
    let start=at>0&&normalized[at-1]==='@'?at-1:at;
    let end=from+name.length;
    // A quoted reference is one recorded token; keep the pair out of the prose.
    const quote=normalized[start-1];
    if((quote==='"'||quote==="'")&&normalized[end]===quote){start-=1;end+=1;}
    const token=text.slice(start,end);
    const existing=found.find(item=>item.file===file);
    if(existing)existing.tokens.push(token);else found.push({file,tokens:[token]});
  }
  return found;
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

export function stagedImagesFromText(text:string,root:string,source:string,offset:number):{images:ConversationImage[];tokens:string[][]} {
  const images:ConversationImage[]=[],tokens:string[][]=[];
  for(const [index,reference] of stagedReferences(text,root).entries()){
    const image=readOwnedImage(root,reference.file);if(!image)continue;
    images.push({id:conversationImageId(source,offset,index,image.bytes.toString('base64')),mimeType:image.mimeType,bytes:image.bytes.length});
    tokens.push(reference.tokens);
  }
  return {images,tokens};
}

export function stagedUserImages(provider:string,line:string,root:string,source:string,offset:number):{images:ConversationImage[];tokens:string[][]} {
  return stagedImagesFromText(stagedUserText(provider,line),root,source,offset);
}

export function readStagedUserImage(provider:string,line:string,root:string,index:number):{mimeType:string;bytes:Buffer}|null{
  const reference=stagedReferences(stagedUserText(provider,line),root)[index];
  return reference?readOwnedImage(root,reference.file):null;
}

/** Remove the exact recorded reference tokens so a rendered preview leaves no path
 * (and no dangling `@`) behind. Ordinary prose is preserved verbatim. */
export function stripStagedImageTokens(text:string,tokens:readonly string[]):string{
  if(!tokens.length)return text;
  let result=text;
  for(const token of tokens){
    if(!token)continue;
    const at=result.indexOf(token);
    if(at<0)continue;
    result=result.slice(0,at)+result.slice(at+token.length);
  }
  return result.replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
}
