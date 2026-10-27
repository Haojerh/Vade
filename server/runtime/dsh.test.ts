import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DSH_PLUGIN } from './dshPlugin.js';
import { dshBinding, dshDirectory, dshOptions, dshReady, dshResumable, applyDshOption } from './dsh.js';
import { readAgentStatus } from './statusHooks.js';
import { AdeConversations } from './conversation.js';
import { TerminalScreen } from './terminalScreen.js';
import type { SessionRecord } from './store.js';
import { AdeStore } from './store.js';
import { AdeSessions } from './sessions.js';
import { programStatusReader } from './programStatus.js';
import { mergeDshModels, WorkflowModels } from './workflowModels.js';

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
  return {directory,record,root,ctx,callbacks,session,emit,bind(){callbacks.get('session/created')?.(session);record.providerThreadId=dshBinding(directory,record)},close(){callbacks.get('dispose')?.();fs.rmSync(directory,{recursive:true,force:true})}};
}

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
    const id='11234567-1234-1234-1234-123456789abc',base={token:config.token,id,cwd:config.cwd};let enters=0,cancels=0;
    fs.writeFileSync(path.join(config.directory,'binding.json'),JSON.stringify(base));
    fs.writeFileSync(path.join(config.directory,'options.json'),JSON.stringify({...base,ready:true,current:{},models:[]}));
    const status=(state,event)=>{const value={...base,provider:'dsh',state,event,at:new Date().toISOString()};fs.writeFileSync(path.join(config.directory,'status.json'),JSON.stringify(value));fs.writeFileSync(config.statusFile,JSON.stringify(value))};
    const draw=text=>process.stdout.write('\x1b[2J\x1b[HDSH\r\n╭────────────────────────────────────────╮\r\n❯ '+text+'\r\n╰────────────────────────────────────────╯\r\nmodel · high\x1b[3;'+(3+text.length)+'H');
    process.stdin.setRawMode?.(true);status('idle','SessionStart');draw('');process.stdin.on('data',buffer=>{const text=buffer.toString();
      if(text.includes('\x1b[200~'))draw(text.replace('\x1b[200~','').replace('\x1b[201~',''));
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
    const counts=JSON.parse(fs.readFileSync(path.join(dshDirectory(directory,record),'counts.json'),'utf8'));
    assert.deepEqual(counts,{enters:1,cancels:1});
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
  }finally{sessions.close();store.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
