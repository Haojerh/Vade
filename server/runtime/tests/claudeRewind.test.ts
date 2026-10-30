import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {forkClaudeBefore} from '../../providers/claude/claudeRewind.js';
const session='11111111-2222-4333-8444-555555555555',first='11111111-2222-4333-8444-555555555551',reply='11111111-2222-4333-8444-555555555552',target='11111111-2222-4333-8444-555555555553';
test('Claude storage-only native fork discards the selected turn, remaps IDs and preserves the original bytes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-claude-rewind-'));try{
  const file=path.join(root,session+'.jsonl');const rows=[
   {type:'user',sessionId:session,cwd:root,uuid:first,parentUuid:null,message:{role:'user',content:[{type:'text',text:'Retain this'}]}},
   {type:'assistant',sessionId:session,cwd:root,uuid:reply,parentUuid:first,message:{role:'assistant',model:'native-model',content:[{type:'text',text:'Retain reply'}]}},
   {type:'user',sessionId:session,cwd:root,uuid:target,parentUuid:reply,message:{role:'user',content:[{type:'text',text:'Discard me'}]}},
  ];const original=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';fs.writeFileSync(file,original);
  const id=await forkClaudeBefore(file,session,target,()=>true);assert.ok(id&&id!==session);
  assert.equal(fs.readFileSync(file,'utf8'),original);
  const fork=fs.readFileSync(path.join(root,id+'.jsonl'),'utf8');
  assert.match(fork,/Retain this/);assert.match(fork,/Retain reply/);assert.doesNotMatch(fork,/Discard me/);
  assert.doesNotMatch(fork,new RegExp(target));
  assert.equal(await forkClaudeBefore(file,session,first,()=>true),undefined);
  await assert.rejects(forkClaudeBefore(file,session,target,()=>false),/changed/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
