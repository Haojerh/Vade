import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AdeStore} from '../store.js';
import {AdeSessions} from '../sessions/sessions.js';

const image={name:'clipboard.png',mimeType:'image/png',dataBase64:Buffer.from('89504e470d0a1a0a','hex').toString('base64')};
for(const provider of ['codex','claude'] as const)test(`${provider} terminal image paste stages native attachment paths without Enter or a message`,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ade-terminal-image-')),store=new AdeStore(directory),inputs=path.join(directory,'input');
  const project=store.register(directory,'Images','folder');
  const script=`const fs=require('fs');process.stdin.setRawMode?.(true);process.stdin.on('data',data=>fs.appendFileSync(${JSON.stringify(inputs)},data));const e=String.fromCharCode(27);process.stdout.write(e+'[2J'+e+'[H> existing draft'+e+'[1;17H');`;
  const sessions=new AdeSessions(store,()=>({executable:process.execPath,args:['-e',script,'--']}),undefined,undefined,()=>{});
  try{
    const launched=await sessions.launch(project.id,'worktree',directory,'claude');
    store.saveSession({...launched,provider});
    (sessions as any).status=()=>({data:{state:'idle'},meta:{availability:'ready',stale:false}});
    const deadline=Date.now()+5000;
    while(!(sessions as any).live.get(launched.id)?.screen?.composerPresent()){
      if(Date.now()>deadline)throw Error('Prompt not ready');await new Promise(resolve=>setTimeout(resolve,20));
    }
    await assert.rejects(sessions.pasteTerminalAttachments(project.id,launched.id,{attachments:[{...image,mimeType:'text/plain'}]}),/valid image/);
    assert.equal(fs.existsSync(inputs),false);
    await sessions.pasteTerminalAttachments(project.id,launched.id,{attachments:[image]});
    while(!fs.existsSync(inputs)){if(Date.now()>deadline)throw Error('Input not received');await new Promise(resolve=>setTimeout(resolve,20));}
    const data=fs.readFileSync(inputs,'utf8');
    assert.match(data,/^\x1b\[200~.*\/attachments\/[a-f0-9-]+\.png\x1b\[201~\x1b\[200~\n\x1b\[201~$/);
    assert.equal(data.includes('\r'),false,'no Enter');
    assert.equal(data.includes('Please review'),false,'no synthetic user message');
    assert.equal(fs.readdirSync(path.join(directory,'attachments')).length,1);
    assert.equal(sessions.require(project.id,launched.id).statusToken,launched.statusToken);
    (sessions as any).sending.add(launched.id);
    await assert.rejects(sessions.pasteTerminalAttachments(project.id,launched.id,{attachments:[image]}),/busy/);
    (sessions as any).sending.delete(launched.id);
    const original=(sessions as any).command;let attempts=0;
    (sessions as any).command=async()=>{attempts++;throw Error('uncertain write');};
    await assert.rejects(sessions.pasteTerminalAttachments(project.id,launched.id,{attachments:[image]}),/no Enter or retry/);
    assert.equal(attempts,1);(sessions as any).command=original;
    sessions.closeSession(project.id,launched.id);
    await assert.rejects(sessions.pasteTerminalAttachments(project.id,launched.id,{attachments:[image]}),/NODE_NOT_FOUND|terminal changed/);
  }finally{sessions.close();store.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
