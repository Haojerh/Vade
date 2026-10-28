import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {publicMessage,AdeConversations} from './conversation.js';
import {readStagedUserImage,stagedUserImages} from './stagedConversationImages.js';
import type {SessionRecord} from './store.js';
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(40,1)]);
const name='0a049702-e9c8-495e-85f7-0dea1b449f89.png';
const row=(provider:string,text:string,extra:Record<string,unknown>={})=>JSON.stringify(provider==='codex'?{type:'response_item',payload:{type:'message',role:'user',id:'u',content:[{type:'input_text',text}]},...extra}:{type:'user',sessionId:'native',cwd:'/work',uuid:'u',message:{role:'user',content:[{type:'text',text}]},...extra});

for(const provider of ['codex','claude'])test(`${provider} plain staged image path becomes an image preview and preserves the actual prompt`,()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-staged-images-'));
  try{
    const file=path.join(root,name);fs.writeFileSync(file,png);
    const line=row(provider,file.replaceAll('\\','/')+'\nbeautiful for this?');
    const record={provider,providerThreadId:'native'} as SessionRecord;
    const message=publicMessage(record,line,'src',10,undefined,root)!;
    assert.equal(message.text,'beautiful for this?');assert.equal(message.images?.length,1);
    assert.equal(message.images![0].bytes,png.length);assert.ok(!JSON.stringify(message).includes(root));
    assert.deepEqual(readStagedUserImage(provider,line,root,0),{mimeType:'image/png',bytes:png});
    assert.equal(publicMessage(record,line,'src',10,{remaining:0},root)?.images,undefined);
    assert.equal(publicMessage(record,line,'src',10,{remaining:0},root)?.text,file.replaceAll('\\','/')+'\nbeautiful for this?');
    assert.equal(publicMessage(record,row(provider,'"'+file+'"'),'src',10,undefined,root)?.text,'');
    assert.equal(publicMessage(record,line,'src',10,undefined,root)?.images?.[0].id.includes('src'),false);
    assert.notEqual(publicMessage(record,line,'other-source',10,undefined,root)?.images?.[0].id,message.images![0].id);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('staged previews reject external paths, traversal, mentions, non-user and private records',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-staged-reject-'));fs.writeFileSync(path.join(root,name),png);
  try{
    for(const value of [path.join(os.tmpdir(),name),root+'/../'+name,root+'/nested/'+name,'@'+path.join(root,name),'Please read '+path.join(root,name),root+'/arbitrary.png'])assert.equal(stagedUserImages('codex',row('codex',value),root,'src',1).images.length,0,value);
    for(const flags of [{isSidechain:true},{isMeta:true},{isSynthetic:true}])assert.equal(publicMessage({provider:'claude',providerThreadId:'native'} as SessionRecord,row('claude',path.join(root,name),flags),'src',1,undefined,root),null);
    const agent=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:path.join(root,name)}]}});
    assert.equal(publicMessage({provider:'codex'} as SessionRecord,agent,'src',1,undefined,root)?.images,undefined);
    fs.writeFileSync(path.join(root,name),'<svg>not a supported image</svg>');
    assert.equal(stagedUserImages('codex',row('codex',path.join(root,name)),root,'src',1).images.length,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('staged image route stays bound to the native session, recorded reference and content digest',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-staged-bound-')),previous=process.env.CLAUDE_CONFIG_DIR;
  try{
    const id='11111111-2222-4333-8444-555555555555',cwd=path.join(root,'work'),directory=path.join(root,'ade'),attachments=path.join(directory,'attachments');
    fs.mkdirSync(cwd);fs.mkdirSync(attachments,{recursive:true});fs.mkdirSync(path.join(root,'projects','workspace'),{recursive:true});
    const image=path.join(attachments,name);fs.writeFileSync(image,png);
    const transcript=path.join(root,'projects','workspace',id+'.jsonl');
    const line=JSON.stringify({type:'user',sessionId:id,cwd,uuid:'u',message:{role:'user',content:[{type:'text',text:image+'\nlook at this'}]}});
    fs.writeFileSync(transcript,line+'\n');process.env.CLAUDE_CONFIG_DIR=root;
    const conversations=new AdeConversations(directory),record={projectId:'p',id:'n',provider:'claude',providerThreadId:id,cwd,sourceCwd:cwd} as SessionRecord;
    const page=(await conversations.read(record)).data!;assert.equal(page.messages[0].text,'look at this');
    const token=page.messages[0].images![0].id;
    assert.deepEqual(conversations.image(record,page.sourceIdentity,token),{mimeType:'image/png',bytes:png});
    assert.throws(()=>conversations.image({...record,id:'other'},page.sourceIdentity,token),/changed/);
    fs.writeFileSync(image,Buffer.concat([png,Buffer.from('replacement')]));
    assert.throws(()=>conversations.image(record,page.sourceIdentity,token),/changed/);
    fs.unlinkSync(image);assert.throws(()=>conversations.image(record,page.sourceIdentity,token),/changed|public session/);
  }finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;fs.rmSync(root,{recursive:true,force:true});}
});
