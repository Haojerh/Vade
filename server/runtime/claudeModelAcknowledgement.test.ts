import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {claudeLocalCommandModel} from '../providers/shared.js';
import {ProviderChatControls} from './providerChatControls.js';
import {AdeConversations,claudeSettingConfirmation} from './conversation.js';import type {SessionRecord} from './store.js';

const label='GLM-5.3-Flash · WorkBuddy AI';
const acknowledgement={type:'system',subtype:'local_command',commandRun:{command:'model',args:''},content:'<local-command-stdout>Kept model as `'+label+'`</local-command-stdout>'};

test('Claude controls confirm fresh native records despite missing TUI text and exclude stale, foreign or rejected selections',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-claude-confirm-')),previous=process.env.CLAUDE_CONFIG_DIR;
  try{
    const id='11111111-2222-4333-8444-555555555555',cwd=path.join(root,'work'),project=path.join(root,'projects','encoded');fs.mkdirSync(cwd);fs.mkdirSync(project,{recursive:true});process.env.CLAUDE_CONFIG_DIR=root;
    const file=path.join(project,id+'.jsonl'),record={provider:'claude',providerThreadId:id,cwd} as SessionRecord;
    const row={...acknowledgement,sessionId:id,cwd,timestamp:new Date().toISOString(),commandRun:{command:'model',args:'native-model'},content:'<local-command-stdout>\u001b[1mSet model to\u001b[22m `'+label+'`</local-command-stdout>'};
    fs.writeFileSync(file,JSON.stringify(row)+'\n');const confirm=claudeSettingConfirmation(record,{key:'model',value:'native-model'},label)!;
    assert.equal(confirm(),false,'historical acknowledgement never confirms');
    const append=(override:Record<string,unknown>)=>fs.appendFileSync(file,JSON.stringify({...row,timestamp:new Date().toISOString(),...override})+'\n');
    for(const override of [{sessionId:'foreign'},{cwd:root},{isSidechain:true},{timestamp:'2000-01-01T00:00:00Z'},{commandRun:{command:'model',args:'other'}},{content:'<local-command-stdout>Kept model as `Other model`</local-command-stdout>'}]){append(override);assert.equal(confirm(),false);}
    append({});assert.equal(confirm(),true);
    const effort=claudeSettingConfirmation(record,{key:'effort',value:'low'})!;
    append({commandRun:{command:'effort',args:'low'},content:'<local-command-stdout>\u001b[1mSet effort level to low\u001b[22m (saved as your default for new sessions): Quick</local-command-stdout>'});assert.equal(effort(),true);
    fs.renameSync(file,file+'.old');fs.writeFileSync(file,JSON.stringify(row)+'\n');assert.equal(confirm(),false,'replacement refuses stale file witnesses');
  }finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('Claude setting confirmation accepts a fresh row whose timestamp is rounded to the operation second',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-claude-confirm-second-')),previous=process.env.CLAUDE_CONFIG_DIR;
  try{
    const id='11111111-2222-4333-8444-555555555555',cwd=path.join(root,'work'),project=path.join(root,'projects','encoded');fs.mkdirSync(cwd);fs.mkdirSync(project,{recursive:true});process.env.CLAUDE_CONFIG_DIR=root;
    const file=path.join(project,id+'.jsonl'),record={provider:'claude',providerThreadId:id,cwd} as SessionRecord;
    fs.writeFileSync(file,JSON.stringify({type:'user',sessionId:id,cwd,uuid:'existing',timestamp:'2026-10-28T12:00:00Z',message:{role:'user',content:[{type:'text',text:'Existing prompt'}]}})+'\n');const confirm=claudeSettingConfirmation(record,{key:'effort',value:'high'})!;
    const rounded=new Date(Math.floor(Date.now()/1000)*1000).toISOString();
    fs.appendFileSync(file,JSON.stringify({type:'system',subtype:'local_command',sessionId:id,cwd,timestamp:rounded,commandRun:{command:'effort',args:'high'},content:'<local-command-stdout>Set effort level to high</local-command-stdout>'})+'\n');
    assert.equal(confirm(),true);
  }finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('Claude native kept-model acknowledgements provide metadata while public prose and private rows do not',()=>{
  assert.equal(claudeLocalCommandModel(acknowledgement),label);
  assert.equal(claudeLocalCommandModel({...acknowledgement,commandRun:{command:'other'}}),undefined);
  assert.equal(claudeLocalCommandModel({...acknowledgement,isSidechain:true}),undefined);
  assert.equal(claudeLocalCommandModel({...acknowledgement,isMeta:true}),undefined);
  assert.equal(claudeLocalCommandModel({type:'assistant',message:{role:'assistant',content:[{type:'text',text:acknowledgement.content}]}}),undefined);
  assert.equal(claudeLocalCommandModel({type:'user',message:{role:'user',content:[{type:'text',text:'Kept model as `fake`'}]}}),undefined);
});

test('a reported native display label resolves to its catalog ID even when the label contains spaces',async()=>{
  const controls=new ProviderChatControls();
  controls.catalog=async()=>[{id:'native-glm',label,efforts:[]}];
  const options=await controls.read('claude',{model:label},'',process.cwd());
  assert.equal(options.current.model,'native-glm');
  assert.equal((await controls.read('claude',{model:'Unmatched reported label'},'',process.cwd())).current.model,undefined);
});

test('returning from native /model keeps the latest exact-session selection without leaking command rows into Chat',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-claude-model-')),previous=process.env.CLAUDE_CONFIG_DIR;
  try{
    const id='11111111-2222-4333-8444-555555555555',cwd=path.join(root,'work');fs.mkdirSync(cwd);
    const project=path.join(root,'projects','encoded');fs.mkdirSync(project,{recursive:true});
    fs.writeFileSync(path.join(project,id+'.jsonl'),[
      {type:'assistant',sessionId:id,cwd,uuid:'old',message:{role:'assistant',model:'old-model',content:[{type:'text',text:'Hello'}]}},
      {...acknowledgement,sessionId:id,cwd,uuid:'kept'},
      {...acknowledgement,sessionId:'foreign',cwd,uuid:'foreign',content:'<local-command-stdout>Kept model as `foreign-model`</local-command-stdout>'},
      {...acknowledgement,sessionId:id,cwd,isSidechain:true,uuid:'private',content:'<local-command-stdout>Kept model as `subagent-model`</local-command-stdout>'},
    ].map(row=>JSON.stringify(row)).join('\n')+'\n');
    process.env.CLAUDE_CONFIG_DIR=root;
    const conversations=new AdeConversations(path.join(root,'ade')),record={projectId:'p',id:'n',provider:'claude',providerThreadId:id,cwd,sourceCwd:cwd} as SessionRecord;
    assert.equal((await conversations.metadata(record)).model,label);
    const page=(await conversations.read(record)).data!;
    assert.deepEqual(page.messages.map(message=>message.text),['Hello']);
  }finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}
});
