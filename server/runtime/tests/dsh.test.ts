import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DSH_PLUGIN } from '../../providers/dsh/dshPlugin.js';
import { dshBinding, dshDirectory, dshOptions, dshReady, dshResumable, applyDshOption } from '../../providers/dsh/dsh.js';
import { readAgentStatus } from '../sessions/statusHooks.js';
import { AdeConversations } from '../chat/conversation.js';
import { TerminalScreen } from '../sessions/terminalScreen.js';
import type { SessionRecord } from '../store.js';
import { AdeStore } from '../store.js';
import { AdeSessions } from '../sessions/sessions.js';
import { programStatusReader } from '../sessions/programStatus.js';
import { mergeDshModels, WorkflowModels } from '../workflow/workflowModels.js';

async function fixture(withChannel = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'vade-dsh-test-'));
  const record: SessionRecord = { id: '01234567-1234-1234-1234-123456789abc', projectId:'project',worktreeId:'worktree',cwd:directory,provider:'dsh',title:'DSH',createdAt:new Date().toISOString(),closed:false,statusToken:'a'.repeat(64) };
  const root=dshDirectory(directory,record);fs.mkdirSync(root,{recursive:true});
  const plugin=path.join(root,'observer.mjs');fs.writeFileSync(plugin,DSH_PLUGIN);
  const callbacks=new Map<string,Function>();
  const ctx:any={on(event:string,callback:Function){callbacks.set(event,callback)},get(){return undefined}};
  const registry=path.join(root,'registry.mjs');
  if(withChannel){fs.writeFileSync(registry,"export const getTuiChannelRegistration=ctx=>({channel:ctx.channel});export const onTuiChannelRegistration=(ctx,fn)=>{ctx.replace=fn;return()=>{ctx.released=true}};");ctx.channel={sessionId:'11234567-1234-1234-1234-123456789abc',ready:true,provider:'route',model:'model',listModels:async()=>[],subscribe:(fn:Function)=>{ctx.changed=fn;return()=>{}}};}
  const module=await import(pathToFileURL(plugin).href);
  module.apply(ctx,{directory:root,token:record.statusToken,cwd:directory,...(withChannel?{registry}: {})});
  const session={id:'11234567-1234-1234-1234-123456789abc',header:{id:'11234567-1234-1234-1234-123456789abc',cwd:directory},snapshotEvents:()=>[]};
  let seq=0;
  const emit=(type:string,data:unknown,source=session)=>callbacks.get('session/event')?.(source,{type,data,seq:seq++,time:Date.now()});
  return {module,directory,record,root,ctx,callbacks,session,emit,bind(){callbacks.get('session/created')?.(session);record.providerThreadId=dshBinding(directory,record)},close(){callbacks.get('dispose')?.();fs.rmSync(directory,{recursive:true,force:true})}};
}

test('DSH cross-worktree continuation copies the full native log once, preserves source, and fences uncertain attempts',async()=>{
  const f=await fixture();
  try {
    const source='source-session',target='target-session',cwd=path.join(f.directory,'destination');
    const originalEvents=[{seq:0,type:'user/message',time:1,data:{text:'history'}},{seq:1,type:'tool/result',time:2,data:{text:'native tool context'}}];
    const logs=new Map<string,any>([[source,{header:{id:source,cwd:f.directory,createdAt:1},events:structuredClone(originalEvents)}]]);
    let creates=0,lease=false,fail=false,dispose:Function|undefined;
    const persistence:any={
      async open(id:string,access:string){const log=logs.get(id);if(!log){const e:any=new Error('missing');e.name='SessionPersistenceNotFoundError';e.sessionId=id;throw e;}if(id===source&&access==='write'){assert.equal(lease,false);lease=true;}return{header:log.header,inheritedEventCount:0,read:async()=>({events:structuredClone(log.events)}),close:async()=>{if(id===source)lease=false;}};},
      async create(header:any){creates++;assert.equal(lease,true);const log={header,events:[] as any[]};logs.set(header.id,log);return{append:async(events:any[])=>{if(fail)throw Error('write failed');log.events=structuredClone(events);},flush:async()=>{},close:async()=>{}};},
    };
    const original=persistence.open;
    const ctx:any={inject(_keys:any,fn:Function){fn({get:()=>persistence,on:(_name:string,fn:Function)=>{dispose=fn;}});}};
    const receipt=path.join(f.directory,'continuation.json'),config={continuation:{threadId:source,cwd:f.directory},expected:target,cwd,continuationReceipt:receipt};
    f.module.installContinuation(ctx,config);
    await Promise.all([persistence.open(target,'read'),persistence.open(target,'read')]);
    assert.equal(creates,1);assert.equal(lease,false);assert.deepEqual(logs.get(source).events,originalEvents);
    assert.equal(logs.get(source).header.cwd,f.directory);assert.equal(logs.get(target).header.cwd,cwd);assert.deepEqual(logs.get(target).events,originalEvents);
    dispose!();assert.equal(persistence.open,original);
    f.module.installContinuation(ctx,config);await persistence.open(target,'read');assert.equal(creates,1);dispose!();
    fail=true;
    const bad={...config,expected:'failed-target',continuationReceipt:path.join(f.directory,'failed.json')};
    f.module.installContinuation(ctx,bad);await assert.rejects(persistence.open('failed-target','read'),/write failed/);assert.equal(lease,false);dispose!();
    f.module.installContinuation(ctx,bad);await assert.rejects(persistence.open('failed-target','read'),/uncertain/);assert.equal(creates,2);dispose!();
    f.module.installContinuation(ctx,{...config,expected:'foreign-target',continuationReceipt:path.join(f.directory,'foreign.json'),continuation:{threadId:source,cwd}});
    await assert.rejects(persistence.open('foreign-target','read'),/workspace or identity changed/);assert.equal(creates,2);assert.equal(lease,false);dispose!();
  }finally{f.close();}
});

test('DSH compaction is projected only after the native transaction ends without error',async()=>{
  const f=await fixture();try{
    f.bind();f.emit('compaction/start',{compactionId:'compact'});f.emit('compaction/end',{compactionId:'failed',error:{message:'private failure'}});f.emit('compaction/end',{compactionId:'compact'});
    const page=(await new AdeConversations(f.directory).read(f.record)).data!;
    assert.deepEqual(page.messages.map(message=>[message.kind,message.text]),[['compaction','Context compacted']]);
  }finally{f.close();}
});

test('DSH permissions use only the native runtime roster and require observed confirmation',async()=>{
  const f=await fixture(true);
  try{
    f.bind();let permission='workspace-write';
    f.ctx.channel.permissionPresets=()=>({availability:'runtime',options:[{value:'workspace-write',name:'Workspace writes',description:'Ask outside the workspace'},{value:'read-only',name:'Read only'}],current:{value:permission}});
    f.callbacks.get('ready')?.();
    await new Promise(resolve=>setTimeout(resolve,70));
    assert.equal(dshOptions(f.directory,f.record).current.permission,'workspace-write');
    assert.equal(dshOptions(f.directory,f.record).permissions?.length,2);
    const writes:string[]=[];
    const io:any={write:async(text:string)=>{writes.push(text);if(text==='\r'){permission='read-only';f.ctx.changed();await new Promise(resolve=>setTimeout(resolve,20));}},waitFor:async(predicate:Function)=>{assert.equal(predicate('❯ /permission read-only'),true);return '';}};
    await assert.rejects(applyDshOption(f.directory,f.record,{key:'permission',value:'invented-full-access'},io),/advertised/);
    assert.equal(writes.length,0);
    assert.equal((await applyDshOption(f.directory,f.record,{key:'permission',value:'read-only'},io)).current.permission,'read-only');
    assert.deepEqual(writes,['\x1b[200~/permission read-only\x1b[201~','\r']);
    f.ctx.channel.permissionPresets=()=>({availability:'unavailable',options:[{value:'invented',name:'Hidden'}]});f.ctx.changed();await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(dshOptions(f.directory,f.record).permissions,undefined);
  }finally{f.close();}
});

test('DSH rewind targets are exact public native user boundaries and reject changed history',async()=>{
  const f=await fixture();
  try{
    f.bind();f.emit('user/message',{id:'user-one',role:'user',source:{kind:'user'},content:[{type:'text',text:'First message'}]});
    f.emit('assistant/message',{message:{id:'answer-one',role:'assistant',source:{kind:'model'},content:[{type:'text',text:'Response'}]}});
    f.emit('user/message',{id:'user-two',role:'user',source:{kind:'user'},content:[{type:'text',text:'Edit this'}]});
    const reader=new AdeConversations(f.directory),page=(await reader.read(f.record,{direction:'older',limit:20})).data!;
    assert.ok(page.revision);assert.equal(page.messages[0].rewindable,true);assert.equal(page.messages[1].rewindable,undefined);
    const request={messageId:page.messages[2].id,sourceIdentity:page.sourceIdentity,revision:page.revision!};
    const target=await reader.rewindTarget(f.record,request);
    assert.equal(target.beforeSeq,2);assert.equal(target.beforeMessageId,'user-two');assert.equal(target.message,'Edit this');assert.equal(target.current(),true);
    await assert.rejects(reader.rewindTarget(f.record,{...request,messageId:page.messages[1].id}),/not an available/);
    f.emit('user/message',{id:'newer',role:'user',source:{kind:'user'},content:[{type:'text',text:'Changed'}]});
    assert.equal(target.current(),false);await assert.rejects(reader.rewindTarget(f.record,request),/changed/);
  }finally{f.close();}
});

test('DSH observer binds the owned root, projects only public messages, and uses explicit native turn outcomes',async()=>{
  const f=await fixture();
  try {
    const foreign={...f.session,header:{...f.session.header,cwd:path.dirname(f.directory)}};
    f.callbacks.get('session/created')?.(foreign);
    assert.equal(dshBinding(f.directory,f.record),undefined);
    f.bind();assert.equal(f.record.providerThreadId,f.session.id);
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'idle');
    f.emit('user/message',{id:'injected',role:'user',source:{kind:'instructions'},content:[{type:'text',text:'PRIVATE CONTEXT'}]});
    f.emit('turn/start',{turn:1});
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'working');
    f.emit('user/message',{id:'human',role:'user',source:{kind:'user'},content:[{type:'text',text:'Hello'}]});
    f.emit('request/header',{header:{config:{provider:'route',model:'model',reasoningEffort:'high'}}});
    f.emit('assistant/message',{message:{id:'answer',role:'assistant',source:{kind:'model'},content:[{type:'thinking',text:'PRIVATE THINKING'},{type:'text',text:'Hello back'}]}});
    f.emit('tool/call',{callId:'tool',name:'read_file',arguments:'{"path":"file.ts"}'});
    f.emit('tool/call',{callId:'question',name:'ask_user_question',arguments:'{"questions":[]}'});
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'waiting');
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.attention,'question');
    f.emit('tool/result',{result:'PRIVATE TOOL OUTPUT'});
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'working');
    f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'completed');
    const reader=new AdeConversations(f.directory), page=await reader.read(f.record);
    assert.deepEqual(page.data?.messages.map(m=>m.text),['Hello','Hello back']);
    assert.equal((await reader.metadata(f.record)).toolActivity.data?.length,2);
    assert.equal((await reader.metadata(f.record)).model,'route/model');
    assert.equal((await reader.metadata(f.record)).effort,'high');
    assert.doesNotMatch(fs.readFileSync(path.join(f.root,'conversation.jsonl'),'utf8'),/PRIVATE/);
    f.emit('turn/start',{turn:2});f.emit('turn/end',{turn:2,reason:{kind:'aborted',reason:{kind:'user'}}});
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'interrupted');
    f.emit('turn/start',{turn:3});f.emit('turn/end',{turn:3,reason:{kind:'error'}});
    assert.equal(readAgentStatus(f.directory,f.record,true).data?.state,'failed');
    assert.equal(readAgentStatus(f.directory,{...f.record,statusToken:'b'.repeat(64)},true).data,null);
  }finally{f.close()}
});

test('DSH model selection refuses unadvertised values and waits for native confirmation',async()=>{
  const f=await fixture();
  try {
    f.bind();
    const file=path.join(f.root,'options.json');
    const value={token:f.record.statusToken,id:f.record.providerThreadId,cwd:f.record.cwd,ready:true,current:{model:'route/model',effort:'high'},models:[{id:'route/model',label:'Native model',efforts:[{value:'high',label:'High'},{value:'low',label:'Low'}]}]};
    fs.writeFileSync(file,JSON.stringify(value));
    const writes:string[]=[];
    const io={screen:()=>'',output:()=>'',write:async(data:string)=>{writes.push(data)},waitFor:async(predicate:(screen:string)=>boolean)=>{assert.equal(predicate(''),false);if(writes.length===1){assert.equal(predicate('❯ /effort low'),true);return '❯ /effort low';}value.current.effort='low';fs.writeFileSync(file,JSON.stringify(value));assert.equal(predicate(''),true);return ''}};
    await assert.rejects(applyDshOption(f.directory,f.record,{key:'model',value:'invented/model'},io),/native DSH/);
    assert.equal(writes.length,0);
    const result=await applyDshOption(f.directory,f.record,{key:'effort',value:'low'},io);
    assert.deepEqual(writes,['\x1b[200~/effort low\x1b[201~','\r']);assert.equal(result.current.effort,'low');
    assert.equal(dshOptions(f.directory,f.record).controls.fastMode,false);
    assert.throws(()=>dshOptions(f.directory,{...f.record,statusToken:'b'.repeat(64)}),/settings are not available/);
  }finally{f.close()}
});

test('DSH composer readiness excludes setup, side controls and existing drafts',async()=>{
  const screen=new TerminalScreen(()=>{},()=>{});
  try {
    screen.resize(100,28);
    screen.write('\x1b[2J\x1b[HDSH\r\n╭────────────────────╮\r\n❯                  ⛶\r\n╰────────────────────╯\r\nmodel · high\x1b[3;3H');
    await screen.settled();assert.equal(screen.dshPromptReady(),true);
    screen.write('\x1b[3;1H⌸ ❯                  ⛶\x1b[3;5H');
    await screen.settled();assert.equal(screen.dshPromptReady(),true);
    screen.write('\x1b[3;5Hdraft');await screen.settled();assert.equal(screen.dshPromptReady(),false);assert.equal(screen.dshComposerHasText('draft'),true);
    screen.write('\x1b[3;1H\x1b[2K❯ \x1b[3;3H');
    screen.write('\x1b[3;3Hhello');await screen.settled();assert.equal(screen.dshPromptReady(),false);assert.equal(screen.dshComposerHasText('hello'),true);
    screen.write('\x1b[2J\x1b[HWelcome to dsh-TUI\r\nStep 1 of 4\r\n❯ API key and connectivity');await screen.settled();assert.equal(screen.dshPromptReady(),false);
  }finally{screen.dispose()}
});

test('DSH folded paste chips witness the exact long draft and reject mismatching or historical chips',async()=>{
  const screen=new TerminalScreen(()=>{},()=>{});
  const prompt='Continue from the prior Vade agent session.\n'+Array(12).fill('Historical context for the handoff.').join('\n');
  const chip=(count=prompt.length,preview='Continue from the…')=>`▸ ${prompt.split('\n').length} lines・${count} chars・${preview}・hover to peek`;
  const draw=async(text:string)=>{screen.resize(160,20);screen.write(`\x1b[2J\x1b[HDSH\r\n╭──────────────────────────────────────────────────────────────────────────────────────────────╮\r\n⌸ ❯ ${text}\r\n╰──────────────────────────────────────────────────────────────────────────────────────────────╯\r\nmodel · high\x1b[3;${5+text.length}H`);await screen.settled()};
  try {
    await draw(chip());assert.equal(screen.dshComposerHasText(prompt),true);assert.equal(screen.dshPromptReady(),false);
    await draw(chip(prompt.length+1));assert.equal(screen.dshComposerHasText(prompt),false);
    await draw(chip(prompt.length,'A different prompt…'));assert.equal(screen.dshComposerHasText(prompt),false);
    await draw(`▸ ${prompt.split('\n').length} 行・${prompt.length} 字・Continue from the…・悬停查看`);assert.equal(screen.dshComposerHasText(prompt),true);
    await draw('');assert.equal(screen.dshComposerHasText(prompt),false);
    screen.write('\x1b[H'+chip());await screen.settled();assert.equal(screen.dshComposerHasText(prompt),false);
  }finally{screen.dispose()}
});

test('DSH discovers models promptly when the native channel mounts after observer readiness',async()=>{
  const f=await fixture(true);
  try {
    const channel=f.ctx.channel;f.ctx.channel=undefined;
    channel.listModels=async()=>[{provider:'route',id:'model',name:'Native model'}];
    channel.listEfforts=async()=>({efforts:[{id:'high',name:'High'}]});
    f.bind();f.callbacks.get('ready')?.();
    const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+3500;while(!predicate()){if(Date.now()>deadline)throw Error('Catalog did not attach promptly');await new Promise(r=>setTimeout(r,20))}};
    await wait(()=>typeof f.ctx.replace==='function');
    f.ctx.replace({channel});
    await wait(()=>dshOptions(f.directory,f.record).models.length===1);
    assert.equal(dshOptions(f.directory,f.record).controls.model,true);
    assert.deepEqual(dshOptions(f.directory,f.record).models[0].efforts,[{value:'high',label:'High'}]);
  } finally {f.close()}
});

test('DSH workflow catalog retains native efforts after its session tab closes',async()=>{
  const f=await fixture(true);
  const store=new AdeStore(f.directory);
  try {
    store.db.prepare("INSERT OR REPLACE INTO projects VALUES (?, ?, ?)").run('project',f.directory,JSON.stringify({id:'project',name:'DSH',kind:'folder',sourceProjectId:null,repoIds:[],paths:[f.directory],hostIds:['local']}));
    store.saveSession(f.record);f.bind();
    const options=path.join(f.root,'options.json');
    fs.writeFileSync(options,JSON.stringify({token:f.record.statusToken,id:f.record.providerThreadId,cwd:f.record.cwd,ready:true,current:{model:'route/model',effort:'high'},models:[{id:'route/model',label:'Native model',efforts:[{value:'low',label:'Low'},{value:'high',label:'High'}]}]}));
    const catalog=new WorkflowModels(store);
    assert.deepEqual((await catalog.list('dsh'))[0].efforts,['low','high']);
    const remembered=JSON.parse(String(store.db.prepare("SELECT value FROM preferences WHERE key = 'workflow-models:dsh'").get()!.value));
    assert.deepEqual(remembered[0].efforts,['low','high']);
    const closed={...f.record,closed:true};store.saveSession(closed);
    assert.deepEqual(mergeDshModels([{id:'route/model',label:'CLI model',efforts:[]}],remembered)[0],{id:'route/model',label:'Native model',efforts:['low','high']});
  } finally { store.close(); f.close(); }
});

test('DSH context observes native request input and capacity without double-counting caches after a model change',async()=>{
  const f=await fixture(true);
  try {
    f.ctx.channel.lastUsage={input:100,cacheRead:200,cacheWrite:50,output:20};
    f.ctx.channel.contextWindow=1000000;
    f.bind();f.callbacks.get('ready')?.();
    const deadline=Date.now()+3000;
    while(!f.ctx.changed){if(Date.now()>deadline)throw Error('Channel did not attach');await new Promise(resolve=>setTimeout(resolve,20));}
    const reader=new AdeConversations(f.directory);
    assert.equal((await reader.metadata(f.record)).contextUsage.usedTokens,350);
    assert.equal((await reader.metadata(f.record)).contextUsage.windowTokens,1000000);
    f.ctx.channel.model='another-model';f.ctx.channel.contextWindow=undefined;f.ctx.changed();
    assert.equal((await reader.metadata(f.record)).contextUsage.usedTokens,null);
    f.ctx.channel.lastUsage={input:20,cacheRead:40,cacheWrite:0,output:10};f.ctx.channel.contextWindow=64000;f.ctx.changed();
    assert.equal((await reader.metadata(f.record)).contextUsage.usedTokens,60);
    assert.equal((await reader.metadata(f.record)).contextUsage.windowTokens,64000);
    f.ctx.channel.contextOccupancy={usedTokens:1234.4,contextWindow:64000,source:'projection'};f.ctx.changed();
    assert.equal((await reader.metadata(f.record)).contextUsage.usedTokens,1234);
    assert.equal((await reader.metadata(f.record)).contextUsage.estimated,true);
  }finally{f.close()}
});

test('DSH native session or channel replacement revokes send readiness',async()=>{
  const f=await fixture(true);
  try{
    f.bind();f.callbacks.get('ready')?.();
    const deadline=Date.now()+3000;while(!dshReady(f.directory,f.record)){if(Date.now()>deadline)throw Error('Observer did not attach');await new Promise(r=>setTimeout(r,20))}
    f.ctx.channel.sessionId='another-root';f.ctx.changed();assert.equal(dshReady(f.directory,f.record),false);
    f.ctx.replace(undefined);assert.equal(dshReady(f.directory,f.record),false);
    assert.equal(f.record.providerThreadId,f.session.id);
  }finally{f.close();assert.equal(f.ctx.released,true)}
});

test('DSH durability distinguishes an in-memory empty session from a saved native log',async()=>{
  const f=await fixture(true);
  try {
    let sizeBytes:number|undefined;
    f.ctx.get=(name:string)=>name==='sessionPersistence'?{stat:async()=>({header:{id:f.session.id},sizeBytes})}:undefined;
    f.bind();f.callbacks.get('ready')?.();
    const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+3500;while(!predicate()){if(Date.now()>deadline)throw Error('Durability observation timed out');await new Promise(r=>setTimeout(r,20))}};
    await wait(()=>!dshResumable(f.directory,f.record));
    sizeBytes=256;
    await wait(()=>dshResumable(f.directory,f.record));
  }finally{f.close()}
});

test('owned DSH sends require native readiness, submit once and interrupt with Ctrl+C',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vade-dsh-send-')),store=new AdeStore(directory);
  const project=store.register(directory,'DSH send','folder');
  const script=String.raw`
    const fs=require('fs'),path=require('path'),args=process.argv.slice(1),patch=args[args.indexOf('--patch')+1];
    const config=JSON.parse(fs.readFileSync(patch,'utf8'))[0].insert[0].config;
    const id=config.expected??'11234567-1234-1234-1234-123456789abc',base={token:config.token,id,cwd:config.cwd};let enters=0,cancels=0;
    fs.writeFileSync(path.join(config.directory,'binding.json'),JSON.stringify(base));
    fs.writeFileSync(path.join(config.directory,'options.json'),JSON.stringify({...base,ready:true,current:{},models:[]}));
    const status=(state,event)=>{const value={...base,provider:'dsh',state,event,at:new Date().toISOString()};fs.writeFileSync(path.join(config.directory,'status.json'),JSON.stringify(value));fs.writeFileSync(config.statusFile,JSON.stringify(value))};
    const draw=text=>process.stdout.write('\x1b[2J\x1b[HDSH\r\n╭────────────────────────────────────────╮\r\n❯ '+text+'\r\n╰────────────────────────────────────────╯\r\nmodel · high\x1b[3;'+(3+text.length)+'H');
    let pending='';
    process.stdin.setRawMode?.(true);status('idle','SessionStart');draw('');process.stdin.on('data',buffer=>{const text=buffer.toString();
      if(pending||text.includes('\x1b[200~')){pending+=text;if(pending.includes('\x1b[201~')){const draft=pending.replace('\x1b[200~','').replace('\x1b[201~','');pending='';draw(draft.length>=600?'▸ '+draft.split('\n').length+' lines・'+draft.length+' chars・'+draft.split('\n')[0].slice(0,16)+'…・hover to peek':draft);}}
      if(text==='\r'){enters++;status('working','UserPromptSubmit');draw('');}
      if(text==='\x03'){cancels++;status('interrupted','Stop');draw('');}
      fs.writeFileSync(path.join(config.directory,'counts.json'),JSON.stringify({enters,cancels}));
    });`;
  const sessions=new AdeSessions(store,()=>({executable:process.execPath,args:['-e',script,'--']}));
  try {
    const record=await sessions.launch(project.id,'worktree',directory,'dsh');
    const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('DSH fixture timed out');await new Promise(r=>setTimeout(r,20))}};
    await wait(()=>sessions.messagePromptReady(project.id,record.id));
    const result=await sessions.send(project.id,record.id,{message:'hello'});assert.equal(result.ok,true);
    await sessions.interrupt(project.id,record.id);
    await wait(()=>sessions.status(project.id,record.id).data?.state==='interrupted');
    const handoff='Continue the previous task.\n'+Array(30).fill('Public handoff context for the next agent.').join('\n');
    assert.equal((await sessions.send(project.id,record.id,{message:handoff},true,true,true)).ok,true);
    await sessions.interrupt(project.id,record.id);
    await wait(()=>sessions.status(project.id,record.id).data?.state==='interrupted');
    const counts=JSON.parse(fs.readFileSync(path.join(dshDirectory(directory,record),'counts.json'),'utf8'));
    assert.deepEqual(counts,{enters:2,cancels:2});
    const file=path.join(dshDirectory(directory,record),'options.json'),options=JSON.parse(fs.readFileSync(file,'utf8'));options.ready=false;fs.writeFileSync(file,JSON.stringify(options));
    await assert.rejects(sessions.send(project.id,record.id,{message:'do not submit'}),/finish native setup/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dshDirectory(directory,record),'counts.json'),'utf8')),counts);
    const reports:unknown[]=[];programStatusReader(value=>reports.push(value),()=>{},'dsh')('\x1b]7501;state=working:app=codex\x1b\\');assert.equal(reports.length,0);
    const bound=sessions.require(project.id,record.id),binding=path.join(dshDirectory(directory,bound),'binding.json');
    fs.writeFileSync(binding,JSON.stringify({token:bound.statusToken,id:bound.providerThreadId,cwd:directory,saved:false}));
    sessions.closeSession(project.id,record.id);
    const source={provider:'dsh' as const,threadId:bound.providerThreadId!,cwd:directory,title:'DSH send'};
    await assert.rejects(sessions.resumeHistory(project.id,'worktree',directory,source),/has not saved this empty session/);
    fs.writeFileSync(binding,JSON.stringify({token:bound.statusToken,id:bound.providerThreadId,cwd:directory,saved:true}));
    const resumed=await sessions.resumeHistory(project.id,'worktree',directory,source);
    await wait(()=>sessions.messagePromptReady(project.id,resumed.id));
    assert.equal(resumed.id,record.id);assert.equal(resumed.providerThreadId,source.threadId);
    assert.equal(fs.existsSync(path.join(dshDirectory(directory,resumed),'counts.json')),false,'resume never replays the previous message');
    const destination=path.join(directory,'destination');fs.mkdirSync(destination);
    await assert.rejects(sessions.resumeHistory(project.id,'destination',destination,source),/running in another worktree/);
    sessions.closeSession(project.id,resumed.id);
    const continued=await sessions.resumeHistory(project.id,'destination',destination,source);
    await wait(()=>sessions.messagePromptReady(project.id,continued.id));
    assert.notEqual(continued.id,record.id);assert.notEqual(continued.providerThreadId,source.threadId);
    assert.equal(continued.cwd,destination);assert.equal(continued.worktreeId,'destination');
    assert.deepEqual(continued.dshContinuation,{threadId:source.threadId,cwd:directory});
    const original=store.sessions(project.id).find(row=>row.id===record.id)!;
    assert.equal(original.cwd,directory,'original registry entry stays in source checkout');
    assert.equal(original.providerThreadId,source.threadId);assert.equal(original.closed,true);
    assert.equal(fs.existsSync(path.join(dshDirectory(directory,continued),'counts.json')),false,'continuation submits no input');
    const before=sessions.require(project.id,continued.id),target={beforeSeq:0,beforeMessageId:'native-user',message:'Edit this message',current:()=>false};
    await assert.rejects(sessions.rewind(project.id,continued.id,target,before.statusToken),/refresh before rewinding/);
    assert.equal(sessions.page(project.id,continued.id).live,true,'stale rewind never stops the process');
    const rewound=await sessions.rewind(project.id,continued.id,{...target,current:()=>true},before.statusToken);
    assert.equal(rewound.message,'Edit this message');
    const after=sessions.require(project.id,continued.id);
    assert.notEqual(after.providerThreadId,before.providerThreadId);assert.notEqual(after.statusToken,before.statusToken);
    assert.equal(after.dshContinuation?.beforeSeq,0);assert.equal(after.dshContinuation?.threadId,before.providerThreadId);
    assert.equal(fs.existsSync(path.join(dshDirectory(directory,after),'counts.json')),false,'rewind never submits the returned draft');
  }finally{sessions.close();store.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
