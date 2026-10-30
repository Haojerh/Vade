import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AdeStore} from '../store.js';import {AdeSessions} from '../sessions/sessions.js';
for(const provider of ['antigravity','codebuddy'] as const)test(`${provider} opens only its fixed native rewind command under the owned input lock`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-rewind-picker-')),store=new AdeStore(root),input=path.join(root,'input');
 const project=store.register(root,'Rewind','folder');
 const script=`const fs=require('fs');process.stdin.setRawMode?.(true);process.stdin.on('data',data=>fs.appendFileSync(${JSON.stringify(input)},data));const e=String.fromCharCode(27);process.stdout.write(e+'[2J'+e+'[H> '+e+'[1;3H');`;
 const sessions=new AdeSessions(store,()=>({executable:process.execPath,args:['-e',script,'--']}),undefined,undefined,()=>{});
 try{
  const launched=await sessions.launch(project.id,'worktree',root,'claude');store.saveSession({...launched,provider});
  (sessions as any).status=()=>({data:{state:'idle'},meta:{availability:'ready'}});
  const deadline=Date.now()+5000;while(!(sessions as any).live.get(launched.id)?.screen?.composerEmpty()){if(Date.now()>deadline)throw Error('Prompt not ready');await new Promise(resolve=>setTimeout(resolve,20));}
  (sessions as any).sending.add(launched.id);await assert.rejects(sessions.openNativeRewindPicker(project.id,launched.id),/busy/);(sessions as any).sending.delete(launched.id);
  await sessions.openNativeRewindPicker(project.id,launched.id);
  // A PTY write receipt precedes consumption by the fixture process.
  const consumed=Date.now()+3000;while(!fs.existsSync(input)||fs.readFileSync(input,'utf8')!=='/rewind\r'){if(Date.now()>consumed)throw Error('Fixture did not consume the complete command');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(fs.readFileSync(input,'utf8'),'/rewind\r');
  assert.equal(sessions.require(project.id,launched.id).providerThreadId,launched.providerThreadId);
 }finally{sessions.close();store.close();await fs.promises.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
