import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AdeStore,type SessionRecord} from './store.js';import {ConversationRounds,claudeNativeRounds,codexNativeRounds,mergeConversationRounds} from './conversationRounds.js';
import {publicMessage} from './conversation.js';
import type {AgentStatus,Section} from '../../shared/contracts.js';

test('settled chat rounds survive database reopen and stay exact-session scoped independently of Inbox',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-rounds-'));let store=new AdeStore(root);
  const record={id:'node',projectId:'project',provider:'claude',providerThreadId:'native',statusToken:'launch'} as SessionRecord;
  const status={data:{state:'interrupted',workTime:{startedAt:'2026-10-28T12:00:00Z',endedAt:'2026-10-28T12:00:34Z',activeSince:null,workedMs:34000,partial:false}},meta:{availability:'ready'}} as Section<AgentStatus>;
  try{
    let rounds=new ConversationRounds(store);rounds.observe(record,{...status,data:{...status.data!,state:'working'}});assert.equal(rounds.read(record).length,0);
    rounds.observe(record,status);rounds.observe(record,status);assert.equal(rounds.read(record).length,1);assert.equal(store.inboxItems().length,0);
    store.close();store=new AdeStore(root);rounds=new ConversationRounds(store);
    assert.equal(rounds.read(record)[0].workedMs,34000);assert.equal(rounds.read(record)[0].outcome,'interrupted');
    for(const override of [{projectId:'other'},{id:'other'},{providerThreadId:'other'}])assert.equal(rounds.read({...record,...override}).length,0);
    assert.equal(rounds.read({...record,statusToken:'new-launch'}).length,1,'resuming the same native conversation retains its history');
  }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('native durations restore settled historical rounds without fabricating outcomes or accepting child records',()=>{
  const row={type:'system',subtype:'turn_duration',sessionId:'native',uuid:'duration',timestamp:'2026-10-28T12:00:34Z',durationMs:34000};
  const native=claudeNativeRounds('native',[JSON.stringify(row)]);assert.equal(native[0].outcome,'ended');assert.equal(native[0].measurement,'native-duration');assert.equal(native[0].startedAt,'2026-10-28T12:00:00.000Z');
  for(const override of [{sessionId:'other'},{isSidechain:true},{durationMs:-1},{subtype:'local_command'}])assert.equal(claudeNativeRounds('native',[JSON.stringify({...row,...override})]).length,0);
  const observed={...native[0],id:'observed',measurement:'observed-work' as const,outcome:'interrupted' as const};assert.deepEqual(mergeConversationRounds([observed],native),[observed]);
  const events=[{type:'task_started',turn_id:'turn'},{type:'task_complete',turn_id:'turn'}].map((payload,index)=>JSON.stringify({type:'event_msg',timestamp:`2026-10-28T12:00:${index?'34':'00'}Z`,payload}));
  assert.equal(codexNativeRounds('native',events)[0].workedMs,34000);assert.equal(codexNativeRounds('native',events.slice(1)).length,0);
  assert.equal(codexNativeRounds('native',[events[0],events[1].replace('task_complete','turn_aborted')])[0].outcome,'ended','unconfirmed aborts are not labelled user interruptions');
});

test('Codex steering prompts remain owned by the one native turn they were sent into',()=>{
  const record={provider:'codex',providerThreadId:'native'} as SessionRecord;
  const row=(timestamp:string,type:string,payload:unknown)=>({timestamp,type,payload});
  const rows:any[]=[
    row('2026-10-28T12:00:00Z','event_msg',{type:'task_started',turn_id:'turn'}),
    row('2026-10-28T12:00:01Z','response_item',{type:'message',role:'user',id:'initial',content:[{type:'input_text',text:'Initial request'}]}),
    row('2026-10-28T12:00:10Z','response_item',{type:'message',role:'assistant',id:'progress',content:[{type:'output_text',text:'Working'}]}),
    row('2026-10-28T12:00:20Z','response_item',{type:'message',role:'user',id:'steering',content:[{type:'input_text',text:'Steering request'}]}),
    row('2026-10-28T12:00:30Z','response_item',{type:'message',role:'assistant',id:'answer',content:[{type:'output_text',text:'Finished'}]}),
    row('2026-10-28T12:00:34Z','event_msg',{type:'task_complete',turn_id:'turn'}),
  ],lines=rows.map(value=>JSON.stringify(value));
  const ids=rows.filter(value=>value.payload?.type==='message'&&value.payload.role==='user').map(value=>publicMessage(record,JSON.stringify(value),'source')!.id);
  const round=codexNativeRounds('native',lines,'source')[0];
  assert.equal(round.messageIds?.includes(ids[0]),true);
  assert.equal(round.messageIds?.includes(ids[1]),true);
});

test('Claude steering prompts remain owned through one native turn parent chain',()=>{
  const record={provider:'claude',providerThreadId:'native'} as SessionRecord;
  const row=(uuid:string,parentUuid:string|null,timestamp:string,type:string,message?:unknown,extra:Record<string,unknown>={})=>({uuid,parentUuid,timestamp,type,sessionId:'native',cwd:process.cwd(),...(message?{message}:{}),...extra});
  const rows=[
    row('user-1',null,'2026-10-28T12:00:00Z','user',{role:'user',content:[{type:'text',text:'Initial request'}]}),
    row('progress','user-1','2026-10-28T12:00:10Z','assistant',{role:'assistant',content:[{type:'text',text:'Working'}]}),
    row('user-2','progress','2026-10-28T12:00:20Z','user',{role:'user',content:[{type:'text',text:'Steering request'}]}),
    row('answer','user-2','2026-10-28T12:00:30Z','assistant',{role:'assistant',content:[{type:'text',text:'Finished'}]}),
    row('duration','answer','2026-10-28T12:00:34Z','system',undefined,{subtype:'turn_duration',durationMs:34000}),
  ],lines=rows.map(value=>JSON.stringify(value));
  const ids=rows.filter(value=>value.type==='user').map(value=>publicMessage(record,JSON.stringify(value),'source')!.id);
  const round=claudeNativeRounds('native',lines,'source')[0];
  assert.equal(round.messageIds?.includes(ids[0]),true);
  assert.equal(round.messageIds?.includes(ids[1]),true);
});
