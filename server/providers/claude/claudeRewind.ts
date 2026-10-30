import fs from 'node:fs';import path from 'node:path';
import {forkSession,type SessionStoreEntry} from '@anthropic-ai/claude-agent-sdk';
import {CliError} from '../../integrations/cli.js';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_BYTES=16*1024*1024,MAX_ROWS=20000;

/** Storage-only official fork API. No query(), model request or headless turn. */
export async function forkClaudeBefore(file:string,sessionId:string,before:string,current:()=>boolean):Promise<string|undefined>{
  if(!UUID.test(sessionId)||!UUID.test(before)||!current())throw new CliError('INVALID_ARGUMENT','The native rewind target changed.');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw new CliError('RUNTIME_UNAVAILABLE','This transcript exceeds the bounded native rewind limit.');
  const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
  if(lines.length>MAX_ROWS)throw new CliError('RUNTIME_UNAVAILABLE','This transcript exceeds the bounded native rewind limit.');
  const entries:SessionStoreEntry[]=lines.map(line=>JSON.parse(line));
  const target=entries.find(row=>row.uuid===before);
  if(!target||target.type!=='user'||target.isSidechain||target.isMeta||target.isSynthetic||target.sessionId!==sessionId)throw new CliError('INVALID_ARGUMENT','This native user message is no longer available.');
  const parent=typeof target.parentUuid==='string'?target.parentUuid:null;
  if(!parent)return undefined; // Fresh native session; selected first turn is discarded.
  if(!UUID.test(parent)||!entries.some(row=>row.uuid===parent))throw new CliError('RUNTIME_UNAVAILABLE','The native parent boundary is unavailable.');
  let destination:string|undefined;
  const result=await forkSession(sessionId,{upToMessageId:parent,sessionStore:{
    load:async key=>{if(key.subpath||key.sessionId!==sessionId||!current())throw Error('Native source changed');return entries;},
    append:async(key,rows)=>{
      if(destination||key.subpath||!UUID.test(key.sessionId)||key.sessionId===sessionId||!current())throw Error('Unconfirmed native fork');
      const text=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
      if(Buffer.byteLength(text)>MAX_BYTES||rows.length>MAX_ROWS)throw Error('Native fork exceeds bounds');
      destination=path.join(path.dirname(file),key.sessionId+'.jsonl');
      const fd=fs.openSync(destination,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    },
  }});
  if(!destination||path.basename(destination)!==result.sessionId+'.jsonl'||!current())throw new CliError('RUNTIME_UNAVAILABLE','The native fork is unconfirmed. Inspect Terminal; it will not be retried.');
  return result.sessionId;
}
