import test from 'node:test';import assert from 'node:assert/strict';import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {ConversationHistory,conversationTimeline} from '../features/workflow/ConversationHistory';import {groupConversationTimeline,type ConversationTimelineEntry} from '../features/workflow/toolGroups';
import {groupSettledRounds,roundLabel,readRoundExpansion,persistRoundExpansion} from '../features/workflow/conversationRounds';import type {ConversationMessage,ConversationPage,ConversationRound,ToolActivity} from '../../shared/contracts';
const iso=(seconds:number)=>new Date(Date.UTC(2026,9,28,12,0,seconds)).toISOString();
const message=(id:string,role:'user'|'agent',seconds:number,text=id):ConversationMessage=>({id,role,at:iso(seconds),text});
const round:ConversationRound={id:'round',startedAt:iso(1),endedAt:iso(35),workedMs:34000,partial:false,outcome:'completed',measurement:'observed-work'};
const tools:ToolActivity[]=[{id:'tool',at:iso(15),label:'Run: npm test',detail:'Recorded call'}];
const messages=[message('user','user',0),message('progress','agent',10),message('answer','agent',30),message('next','user',40)];
const entries=()=>groupConversationTimeline(conversationTimeline(messages,tools,false));

test('only settled rounds fold activity; final assistant prose stays visible even with trailing tools',()=>{
  assert.deepEqual(groupSettledRounds(entries(),[]),entries(),'silence alone never finishes work');
  assert.deepEqual(groupSettledRounds(entries().slice(0,-1),[round],true),entries().slice(0,-1),'an active continuation stays expanded');
  const result=groupSettledRounds(entries(),[round]),group=result.find(entry=>entry.kind==='round');
  assert.ok(group?.kind==='round');assert.deepEqual(group.activities.map(entry=>entry.id),['progress','tool']);
  assert.deepEqual(result.filter(entry=>entry.kind==='message').map(entry=>entry.id),['user','answer','next']);
  const trailing=groupSettledRounds(groupConversationTimeline(conversationTimeline(messages,[{...tools[0],at:iso(32)}],false)),[round]);
  assert.ok(trailing.some(entry=>entry.kind==='message'&&entry.id==='answer'));
});

test('round expansion preferences survive reads and are scoped and bounded',()=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'localStorage');let stored='{}';
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>stored,setItem:(_key:string,value:string)=>{stored=value;}}});
  try{
    persistRoundExpansion('project:source:round',true);assert.equal(readRoundExpansion('project:source:round'),true);assert.equal(readRoundExpansion('project:other:round'),false);
    persistRoundExpansion('project:source:round',false);assert.equal(readRoundExpansion('project:source:round'),false);
    for(let i=0;i<220;i++)persistRoundExpansion('round-'+i,true);assert.equal(Object.keys(JSON.parse(stored)).length,200);
  }finally{if(prior)Object.defineProperty(globalThis,'localStorage',prior);else Reflect.deleteProperty(globalThis,'localStorage');}
});

test('collapsed rendering hides earlier activity and preserves final answer and durable notices',()=>{
  const page={source:'transcript',sourceIdentity:'source',provider:'claude',messages:[...messages.slice(0,2),{...message('notice','agent',20),kind:'compaction'},...messages.slice(2)],rounds:[round],cursor:null,nextCursor:null,limited:false,truncated:false,warnings:[]} as ConversationPage;
  const html=renderToStaticMarkup(createElement(ConversationHistory,{projectId:'p',nodeId:'n',runId:null,page,tools}));
  assert.match(html,/Worked for 34s/);assert.match(html,/aria-expanded="false"/);assert.match(html,/>answer</);assert.doesNotMatch(html,/>progress</);assert.doesNotMatch(html,/npm test/);assert.match(html,/Context compacted/);
  assert.equal(roundLabel({...round,outcome:'interrupted'}),'Interrupted after 34s');
});

test('steering prompts stay visible above the settled round and before the final answer',()=>{
  const nativeRound={...round,messageIds:['user','progress','steer','answer']};
  const steeringMessages=[message('user','user',0,'Initial request'),message('progress','agent',10,'Intermediate narration'),message('steer','user',20,'Steering request'),message('answer','agent',30,'Final answer'),message('next','user',40,'Next request')];
  const grouped=groupSettledRounds(groupConversationTimeline(conversationTimeline(steeringMessages,tools,false)),[nativeRound]);
  const order=grouped.map(entry=>entry.kind==='round'?'round':entry.kind==='message'?entry.id:entry.kind==='round-activity'?`activity:${entry.id}`:`tools:${entry.id}`);
  assert.ok(order.indexOf('user')<order.indexOf('steer'));
  assert.ok(order.indexOf('steer')<order.indexOf('round'));
  assert.ok(order.indexOf('round')<order.indexOf('answer'));
  const page={source:'transcript',sourceIdentity:'source',provider:'codex',messages:steeringMessages,rounds:[nativeRound],cursor:null,nextCursor:null,limited:false,truncated:false,warnings:[]} as ConversationPage;
  const html=renderToStaticMarkup(createElement(ConversationHistory,{projectId:'p',nodeId:'n',runId:null,page,tools}));
  assert.ok(html.indexOf('Initial request')<html.indexOf('Steering request'));
  assert.ok(html.indexOf('Steering request')<html.indexOf('Worked for 34s'));
  assert.ok(html.indexOf('Worked for 34s')<html.indexOf('Final answer'));
  assert.doesNotMatch(html,/Intermediate narration|npm test/);
});

test('queued user messages and incomplete history do not invent round ownership',()=>{
  const queued=groupConversationTimeline(conversationTimeline([message('first','user',2),message('steer','user',5),message('answer','agent',30)],tools,false));
  assert.ok(!groupSettledRounds(queued,[round]).some(entry=>entry.kind==='round'));
  const partial=entries().filter(entry=>entry.id!=='user');assert.ok(!groupSettledRounds(partial,[round]).some(entry=>entry.kind==='round'));
  const late:ConversationTimelineEntry={kind:'tools',id:'late',at:iso(36),tools:[{...tools[0],id:'late',at:iso(36)}]};
  const result=groupSettledRounds([...entries().slice(0,-1),late,entries().at(-1)!],[round]);assert.ok(result.some(entry=>entry.id==='late'&&entry.kind==='tools'),'unsettled trailing activity remains outside the fold');
});
