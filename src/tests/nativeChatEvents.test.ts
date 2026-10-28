import test from 'node:test';import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {publicMessage,codexRecordedUserAnchors} from '../../server/runtime/conversation';import type {SessionRecord} from '../../server/runtime/store';import type {Node,ConversationPage} from '../../shared/contracts';
import {AgentWorkTime} from '../features/workflow/AgentWorkTime';import {ConversationHistory} from '../features/workflow/ConversationHistory';import {ConversationToolGroup} from '../features/workflow/toolGroups';

test('Codex rewind binds recorded UserMessage events rather than incompatible response IDs',()=>{
 const user=(id:string)=>({type:'response_item',payload:{type:'message',role:'user',id,content:[{type:'input_text',text:'same text'}]}});
 const start={type:'event_msg',payload:{type:'task_started',turn_id:'turn'}};
 const end={type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{type:'UserMessage',id:'11111111-2222-4333-8444-555555555555'}}};
 const rows=[start,user('msg_response'),end].map(row=>JSON.stringify(row));
 const message=publicMessage({provider:'codex'} as SessionRecord,rows[1],'source')!;
 assert.equal(codexRecordedUserAnchors(rows,'source').get(message.id)?.nativeId,end.payload.item.id);
 assert.equal(codexRecordedUserAnchors(rows.slice(1),'source').size,0,'truncated turn has no binding');
 assert.equal(codexRecordedUserAnchors([start,user('msg_one'),user('msg_two'),end].map(row=>JSON.stringify(row)),'source').size,0,'ambiguous drafts are refused');
 assert.equal(codexRecordedUserAnchors([start,user('msg_one'),{...end,payload:{...end.payload,turn_id:'foreign'}}].map(row=>JSON.stringify(row)),'source').size,0);
});

test('only explicit native compaction records create a boundary, without exposing the summary',()=>{
 for(const [provider,row] of [['codex',{type:'compacted',replacement_history:[{text:'private summary'}]}],['claude',{type:'system',subtype:'compact_boundary',sessionId:'native',content:'private summary'}],['codebuddy',{type:'message',providerData:{isSummary:true,compactionId:'native-compaction'},content:'private summary'}]] as const){
  const record={provider,providerThreadId:'native'} as SessionRecord;
  const message=publicMessage(record,JSON.stringify(row),'source');assert.equal(message?.kind,'compaction');assert.equal(message?.text,'Context compacted');assert.doesNotMatch(JSON.stringify(message),/private summary/);
  assert.equal(publicMessage(record,JSON.stringify({...row,isSidechain:true}),'source'),null);
 }
 const prose=publicMessage({provider:'codex'} as SessionRecord,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',id:'prose',content:[{type:'output_text',text:'Context compacted'}]}}),'source');assert.equal(prose?.kind,undefined);
 const clear=publicMessage({provider:'codebuddy'} as SessionRecord,JSON.stringify({type:'message',role:'system',providerData:{isSessionSeparator:true},content:''}),'source');assert.equal(clear?.kind,undefined,'a native clear is not mislabeled as compaction');
});

test('CodeBuddy manual compaction accepts the native internal boundary while hiding cb_summary content',()=>{
 const row={type:'message',role:'user',id:'cmp_native',providerData:{skipRun:false,compactType:'user-command',compactionId:'cmp_native',
   isCompacted:true,isCompactInternal:true,isSummary:false,compactionSeq:1,compactionKind:'manual',compactionTrigger:'manual',contextTokens:95088},
   content:[{type:'input_text',text:'<cb_summary>PRIVATE SUMMARY</cb_summary>'}]};
 const message=publicMessage({provider:'codebuddy',providerThreadId:'native'} as SessionRecord,JSON.stringify(row),'source');
 assert.equal(message?.kind,'compaction');assert.equal(message?.text,'Context compacted');assert.doesNotMatch(JSON.stringify(message),/cb_summary|PRIVATE SUMMARY/);
 const recovery={...row,providerData:{...row.providerData,isCompactRecovery:true}};
 assert.equal(publicMessage({provider:'codebuddy',providerThreadId:'native'} as SessionRecord,JSON.stringify(recovery),'source'),null);
});

test('confirmed interruption time takes precedence over partial observed-work wording',()=>{
 const node={state:'interrupted',agentStatus:{data:{workTime:{workedMs:34000,partial:true,activeSince:null,endedAt:'2026-10-28T00:00:34Z'}}}} as Node;
 const html=renderToStaticMarkup(createElement(AgentWorkTime,{node}));assert.match(html,/Interrupted after <time>34s<\/time>/);assert.doesNotMatch(html,/Observed work|paused/);
});

test('Antigravity exposes completed native checkpoints without asserting compaction or revealing summaries',()=>{
 const row={type:'CHECKPOINT',source:'SYSTEM',status:'DONE',step_index:256,created_at:'2026-10-28T14:00:00Z',content:'PRIVATE SUMMARY'};
 const record={provider:'antigravity'} as SessionRecord;
 const message=publicMessage(record,JSON.stringify(row),'source');
 assert.equal(message?.text,'Context checkpoint');assert.equal(message?.kind,'compaction');
 assert.doesNotMatch(JSON.stringify(message),/PRIVATE SUMMARY/);
 for(const status of ['ERROR','RUNNING'])assert.equal(publicMessage(record,JSON.stringify({...row,status}),'source'),null);
});

test('compaction renders as a divider and tool group chevrons follow their summaries',()=>{
 const page={sourceIdentity:'source',source:'transcript',provider:'claude',cursor:null,nextCursor:null,limited:false,truncated:false,warnings:[],messages:[{id:'boundary',kind:'compaction',role:'agent',text:'Context compacted',at:null}]} as ConversationPage;
 const html=renderToStaticMarkup(createElement(ConversationHistory,{projectId:'p',nodeId:'n',runId:null,page}));assert.match(html,/role="separator" aria-label="Context compacted"/);assert.doesNotMatch(html,/aria-label="Agent response"/);
 const group=renderToStaticMarkup(createElement(ConversationToolGroup,{tools:[{id:'tool',at:null,label:'Run: npm test',detail:'recorded command'}]}));assert.ok(group.indexOf('conversation-tool-group-summary')<group.indexOf('disclosure-chevron'));
});
