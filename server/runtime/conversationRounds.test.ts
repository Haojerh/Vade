import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AdeStore,type SessionRecord} from './store.js';import {ConversationRounds,claudeNativeRounds,codexNativeRounds,mergeConversationRounds} from './conversationRounds.js';
import {antigravityNativeRounds,codeBuddyNativeRounds,dshNativeRounds,openCodeNativeRounds,openCodeV2NativeRounds} from './conversationRounds.js';
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
  const savedEnded={...native[0],id:'saved',measurement:'observed-work' as const,outcome:'ended' as const},nativeInterrupted={...native[0],outcome:'interrupted' as const,messageIds:['native-user']};
  const corrected=mergeConversationRounds([savedEnded],[nativeInterrupted])[0];assert.equal(corrected.outcome,'interrupted');assert.deepEqual(corrected.messageIds,['native-user']);
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

test('Claude tool-use interruption settles without exposing its native marker',()=>{
  const record={provider:'claude',providerThreadId:'native'} as SessionRecord;
  const row=(uuid:string,parentUuid:string|null,timestamp:string,type:string,message?:unknown,extra:Record<string,unknown>={})=>({uuid,parentUuid,timestamp,type,sessionId:'native',cwd:process.cwd(),...(message?{message}:{}),...extra});
  const rows=[
    row('prompt',null,'2026-10-28T12:00:00Z','user',{role:'user',content:[{type:'text',text:'Initialize the repository'}]}),
    row('progress','prompt','2026-10-28T12:00:10Z','assistant',{role:'assistant',content:[{type:'text',text:'Checking Git'}]}),
    row('interrupt','progress','2026-10-28T12:00:14Z','user',{role:'user',content:[{type:'text',text:'[Request interrupted by user for tool use]'}]},{interruptedMessageId:'message-id'}),
  ],lines=rows.map(value=>JSON.stringify(value));
  const promptId=publicMessage(record,lines[0],'source')!.id;
  assert.equal(publicMessage(record,lines[2],'source'),null);
  const round=claudeNativeRounds('native',lines,'source')[0];
  assert.equal(round.outcome,'interrupted');assert.equal(round.workedMs,14000);
  assert.equal(round.messageIds?.includes(promptId),true);assert.equal(round.messageIds?.length,2);
});

test('Claude compaction inside one native turn keeps the original prompt grouped',()=>{
  const record={provider:'claude',providerThreadId:'native'} as SessionRecord;
  const row=(uuid:string,parentUuid:string|null,timestamp:string,type:string,message?:unknown,extra:Record<string,unknown>={})=>({uuid,parentUuid,timestamp,type,sessionId:'native',cwd:process.cwd(),...(message?{message}:{}),...extra});
  const rows=[
    row('prompt',null,'2026-10-28T12:00:00Z','user',{role:'user',content:[{type:'text',text:'Implement the endpoint'}]}),
    row('progress','prompt','2026-10-28T12:00:10Z','assistant',{role:'assistant',content:[{type:'text',text:'Implementing'}]}),
    row('compact',null,'2026-10-28T12:00:20Z','system',undefined,{subtype:'compact_boundary',logicalParentUuid:'progress'}),
    row('summary','compact','2026-10-28T12:00:21Z','user',{role:'user',content:[{type:'text',text:'Private summary'}]},{isCompactSummary:true}),
    row('answer','summary','2026-10-28T12:00:40Z','assistant',{role:'assistant',content:[{type:'text',text:'Implemented'}]}),
    row('duration','answer','2026-10-28T12:00:50Z','system',undefined,{subtype:'turn_duration',durationMs:50000}),
  ],lines=rows.map(value=>JSON.stringify(value));
  const promptId=publicMessage(record,lines[0],'source')!.id,answerId=publicMessage(record,lines[4],'source')!.id;
  const native=claudeNativeRounds('native',lines,'source');
  assert.equal(native.length,1);assert.equal(native[0].startedAt,'2026-10-28T12:00:00.000Z');
  assert.equal(native[0].messageIds?.includes(promptId),true);assert.equal(native[0].messageIds?.includes(answerId),true);
});

test('DSH persists exact turn boundaries and owns steering prompts without exposing private rows',()=>{
  const source='source',row=(timestamp:string,type:string,payload:Record<string,unknown>)=>({timestamp,type,payload});
  const rows=[
    {timestamp:'2026-10-28T12:00:00Z',type:'turn_started',turnId:'turn'},
    row('2026-10-28T12:00:01Z','response_item',{type:'message',role:'user',id:'initial',content:[{type:'input_text',text:'Initial'}]}),
    row('2026-10-28T12:00:10Z','response_item',{type:'message',role:'assistant',id:'progress',content:[{type:'output_text',text:'Progress'}]}),
    row('2026-10-28T12:00:20Z','response_item',{type:'message',role:'user',id:'steer',content:[{type:'input_text',text:'Steer'}]}),
    row('2026-10-28T12:00:30Z','response_item',{type:'message',role:'assistant',id:'answer',content:[{type:'output_text',text:'Answer'}]}),
    {timestamp:'2026-10-28T12:00:34Z',type:'turn_ended',turnId:'turn',reason:{kind:'completed'}},
  ];
  const record={provider:'dsh',providerThreadId:'native'} as SessionRecord;
  const ids=rows.flatMap(value=>{const message=publicMessage(record,JSON.stringify(value),source);return message?[message.id]:[]});
  const round=dshNativeRounds('native',rows.map(value=>JSON.stringify(value)),source)[0];
  assert.equal(round.outcome,'completed');assert.equal(round.workedMs,34000);assert.deepEqual(round.messageIds,ids);
  assert.equal(dshNativeRounds('native',rows.slice(0,-1).map(value=>JSON.stringify(value)),source).length,0,'an open turn never settles');
  const interrupted=rows.map(value=>JSON.stringify(value)).slice();interrupted[interrupted.length-1]=JSON.stringify({timestamp:'2026-10-28T12:00:34Z',type:'turn_ended',turnId:'turn',reason:{kind:'aborted',reason:{kind:'user'}}});
  assert.equal(dshNativeRounds('native',interrupted,source)[0].outcome,'interrupted');
});

test('CodeBuddy settles only request groups whose last public answer has no later tool call',()=>{
  const source='source',record={provider:'codebuddy',providerThreadId:'native'} as SessionRecord;
  const row=(id:string,timestamp:number,type:string,role:string|undefined,request:string,text:string,status?:string,error?:string,skipRun=false)=>({
    id,parentId:null,timestamp,type,role,content:role?[{type:role==='user'?'input_text':'output_text',text}]:undefined,
    status,providerData:{conversationRequestId:request,...(skipRun?{skipRun:true}:{}),...(error?{error:{message:error}}:{})},sessionId:'native',
  });
  const rows=[
    row('u1',1793000000000,'message','user','request-1','Initial'),
    row('p1',1793000010000,'message','assistant','request-1','Progress','completed'),
    row('call1',1793000011000,'function_call',undefined,'request-1','',undefined),
    row('a1',1793000030000,'message','assistant','request-1','Answer','completed'),
    row('u2',1793000040000,'message','user','request-2','Second'),
    row('p2',1793000050000,'message','assistant','request-2','Still working','completed'),
    row('call2',1793000051000,'function_call',undefined,'request-2','',undefined),
    row('u3',1793000060000,'message','user','request-3','Stop'),
    row('a3',1793000064000,'message','assistant','request-3','Interrupted by user','incomplete','Interrupted by user',true),
  ].map(value=>JSON.stringify(value));
  const ids=new Set(rows.flatMap(line=>{const message=publicMessage(record,line,source);return message?[message.id]:[]}));
  assert.equal(publicMessage(record,rows.at(-1)!,source),null);
  const rounds=codeBuddyNativeRounds('native',rows,source);
  assert.equal(rounds.length,2);
  assert.equal(rounds[0].outcome,'completed');assert.equal(rounds[0].workedMs,30000);
  assert.equal(rounds[0].messageIds?.every(id=>ids.has(id)),true);assert.equal(rounds[0].messageIds?.length,3);
  assert.equal(rounds[1].outcome,'interrupted');assert.equal(rounds[1].workedMs,4000);
});

test('Antigravity groups ordered user, progress and final responses only after trailing tools',()=>{
  const source='source';
  const rows=[
    {step_index:1,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-10-28T12:00:00Z',content:'<USER_REQUEST>\nInitial\n</USER_REQUEST>'},
    {step_index:2,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-10-28T12:00:01Z',content:'<USER_REQUEST>\nSteering\n</USER_REQUEST>'},
    {step_index:3,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-10-28T12:00:10Z',content:'Progress'},
    {step_index:4,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-10-28T12:00:20Z',content:'',tool_calls:[{name:'read_file'}]},
    {step_index:5,source:'MODEL',type:'GENERIC',status:'DONE',created_at:'2026-10-28T12:00:25Z',content:'Private tool output'},
    {step_index:6,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-10-28T12:00:30Z',content:'Answer'},
    {step_index:7,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-10-28T12:00:40Z',content:'<USER_REQUEST>\nNext\n</USER_REQUEST>'},
  ];
  const record={provider:'antigravity'} as SessionRecord;
  const ids=rows.flatMap(value=>{const message=publicMessage(record,JSON.stringify(value),source);return message?[message.id]:[]});
  const rounds=antigravityNativeRounds(rows.map(value=>JSON.stringify(value)),source);
  assert.equal(rounds.length,1);assert.equal(rounds[0].outcome,'ended');assert.equal(rounds[0].workedMs,30000);
  assert.deepEqual(rounds[0].messageIds,ids.slice(0,4));
  const withTrailingTool=[...rows.slice(0,6),{step_index:7,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-10-28T12:00:34Z',content:'',tool_calls:[{name:'run_command'}]}];
  assert.equal(antigravityNativeRounds(withTrailingTool.map(value=>JSON.stringify(value)),source).length,0);
});

test('Antigravity starts a new turn after a long inactive interruption without inventing a duration',()=>{
  const source='source';
  const rows=[
    {step_index:1,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-10-28T12:00:00Z',content:'<USER_REQUEST>\nInterrupted\n</USER_REQUEST>'},
    {step_index:2,source:'USER_EXPLICIT',type:'USER_INPUT',status:'DONE',created_at:'2026-10-28T12:31:00Z',content:'<USER_REQUEST>\nNext day\n</USER_REQUEST>'},
    {step_index:3,source:'SYSTEM',type:'SYSTEM_MESSAGE',status:'DONE',created_at:'2026-10-28T12:31:00Z',content:'System metadata'},
    {step_index:4,source:'MODEL',type:'PLANNER_RESPONSE',status:'DONE',created_at:'2026-10-28T12:31:01Z',content:'Answer'},
  ];
  const record={provider:'antigravity'} as SessionRecord;
  const messages=rows.flatMap(value=>{const message=publicMessage(record,JSON.stringify(value),source);return message?[message.id]:[]});
  const rounds=antigravityNativeRounds(rows.map(value=>JSON.stringify(value)),source);
  assert.equal(rounds.length,1);
  assert.equal(rounds[0].workedMs,1000);
  assert.deepEqual(rounds[0].messageIds,messages.slice(1));
});

test('OpenCode and Kilo v1 rounds use parent-linked terminal assistant metadata',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ade-round-opencode-v1-')),file=path.join(dir,'kilo.db'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(message_id TEXT,session_id TEXT,data TEXT);');
    const message=db.prepare('INSERT INTO message VALUES(?,?,?,?)'),part=db.prepare('INSERT INTO part VALUES(?,?,?)');
    const add=(id:string,at:number,data:any,text:string)=>{message.run(id,'native',at,JSON.stringify(data));if(text)part.run(id,'native',JSON.stringify({type:'text',text}));};
    add('u1',1793000000000,{role:'user',time:{created:1793000000000}},'Initial');
    add('p1',1793000010000,{role:'assistant',parentID:'u1',time:{created:1793000010000,completed:1793000011000},finish:'tool-calls'},'Progress');
    add('a1',1793000020000,{role:'assistant',parentID:'u1',time:{created:1793000020000,completed:1793000030000},finish:'stop'},'Answer');
    add('u2',1793000040000,{role:'user',time:{created:1793000040000}},'Second');
    add('p2',1793000050000,{role:'assistant',parentID:'u2',time:{created:1793000050000,completed:1793000051000},finish:'tool-calls'},'Still working');
    add('u3',1793000060000,{role:'user',time:{created:1793000060000}},'Abort');
    add('a3',1793000061000,{role:'assistant',parentID:'u3',time:{created:1793000061000,completed:1793000064000},error:{name:'MessageAbortedError'}},'');
    const rounds=openCodeNativeRounds(file,'native','source');
    assert.equal(rounds.length,2);assert.equal(rounds[0].outcome,'completed');assert.equal(rounds[0].workedMs,30000);assert.equal(rounds[0].messageIds?.length,3);
    assert.equal(rounds[1].outcome,'interrupted');assert.equal(rounds[1].workedMs,4000);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode v2 keeps an empty aborted assistant as interruption evidence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ade-round-opencode-v2-empty-abort-')),file=path.join(dir,'opencode.db'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT)');
    const insert=db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)');
    insert.run('u1','native',1,'user',1793000000000,JSON.stringify({text:'Stop',time:{created:1793000000000}}));
    insert.run('a1','native',2,'assistant',1793000001000,JSON.stringify({content:[],time:{created:1793000001000,completed:1793000004000},error:{name:'MessageAbortedError'}}));
    insert.run('idle1','native',3,'idle',1793000004000,JSON.stringify({outcome:'succeeded',time:{created:1793000004000}}));
    const rounds=openCodeV2NativeRounds(file,'native','source');
    assert.equal(rounds.length,1);assert.equal(rounds[0].outcome,'interrupted');assert.equal(rounds[0].workedMs,4000);assert.equal(rounds[0].messageIds?.length,1);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode v2 rounds use native idle outcomes and include steering prompts',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ade-round-opencode-v2-')),file=path.join(dir,'opencode.db'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT)');
    const insert=db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)');
    insert.run('u1','native',1,'user',1793000000000,JSON.stringify({text:'Initial',time:{created:1793000000000}}));
    insert.run('p1','native',2,'assistant',1793000010000,JSON.stringify({content:[{type:'text',text:'Progress'}],time:{created:1793000010000,completed:1793000011000},finish:'tool-calls'}));
    insert.run('u2','native',3,'user',1793000020000,JSON.stringify({text:'Steering',time:{created:1793000020000}}));
    insert.run('a1','native',4,'assistant',1793000030000,JSON.stringify({content:[{type:'text',text:'Answer'}],time:{created:1793000030000,completed:1793000033000},finish:'stop'}));
    insert.run('idle1','native',5,'idle',1793000034000,JSON.stringify({outcome:'succeeded',time:{created:1793000034000}}));
    insert.run('u3','native',6,'user',1793000040000,JSON.stringify({text:'Stop',time:{created:1793000040000}}));
    insert.run('a3','native',7,'assistant',1793000041000,JSON.stringify({content:[{type:'text',text:'Stopped'}],time:{created:1793000041000,completed:1793000044000},error:{name:'MessageAbortedError'}}));
    insert.run('idle3','native',8,'idle',1793000045000,JSON.stringify({outcome:'interrupted',time:{created:1793000045000}}));
    const rounds=openCodeV2NativeRounds(file,'native','source');
    assert.equal(rounds.length,2);assert.equal(rounds[0].outcome,'completed');assert.equal(rounds[0].workedMs,34000);assert.equal(rounds[0].messageIds?.length,4);
    assert.equal(rounds[1].outcome,'interrupted');assert.equal(rounds[1].workedMs,5000);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode v2 closes completed turns when historical idle rows are absent',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ade-round-opencode-v2-no-idle-')),file=path.join(dir,'opencode.db'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT)');
    const insert=db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)');
    insert.run('u1','native',1,'user',1793000000000,JSON.stringify({text:'Initial',time:{created:1793000000000}}));
    insert.run('p1','native',2,'assistant',1793000010000,JSON.stringify({content:[],time:{created:1793000010000,completed:1793000011000},finish:'tool-calls'}));
    insert.run('u2','native',3,'user',1793000020000,JSON.stringify({text:'Steering',time:{created:1793000020000}}));
    insert.run('a1','native',4,'assistant',1793000030000,JSON.stringify({content:[{type:'text',text:'First answer'}],time:{created:1793000030000,completed:1793000033000},finish:'stop'}));
    insert.run('u3','native',5,'user',1793000040000,JSON.stringify({text:'Second turn',time:{created:1793000040000}}));
    insert.run('a3','native',6,'assistant',1793000050000,JSON.stringify({content:[{type:'text',text:'Second answer'}],time:{created:1793000050000,completed:1793000051000},finish:'stop'}));
    const rounds=openCodeV2NativeRounds(file,'native','source');
    assert.equal(rounds.length,2);
    assert.equal(rounds[0].outcome,'completed');assert.equal(rounds[0].workedMs,33000);assert.equal(rounds[0].messageIds?.length,3);
    assert.equal(rounds[1].outcome,'completed');assert.equal(rounds[1].workedMs,11000);assert.equal(rounds[1].messageIds?.length,2);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('OpenCode v2 breaks stale inactive prompts when historical idle rows are absent',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ade-round-opencode-v2-stale-')),file=path.join(dir,'opencode.db'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE session_message(id TEXT,session_id TEXT,seq INTEGER,type TEXT,time_created INTEGER,data TEXT)');
    const insert=db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)');
    insert.run('u1','native',1,'user',1793000000000,JSON.stringify({text:'Interrupted',time:{created:1793000000000}}));
    insert.run('p1','native',2,'assistant',1793000001000,JSON.stringify({content:[],time:{created:1793000001000,completed:1793000002000},finish:'tool-calls'}));
    insert.run('u2','native',3,'user',1793001860000,JSON.stringify({text:'New turn',time:{created:1793001860000}}));
    insert.run('a2','native',4,'assistant',1793001861000,JSON.stringify({content:[{type:'text',text:'Answer'}],time:{created:1793001861000,completed:1793001862000},finish:'stop'}));
    const rounds=openCodeV2NativeRounds(file,'native','source');
    assert.equal(rounds.length,1);
    assert.equal(rounds[0].workedMs,2000);
    assert.equal(rounds[0].messageIds?.length,2);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
