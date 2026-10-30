import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {codeBuddyBranch} from '../../providers/codebuddy/codeBuddyBranch.js';
test('CodeBuddy native rewind hides discarded descendants without modifying native history',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ade-codebuddy-branch-'));try{
  const file=path.join(root,'native.jsonl');
  const first={type:'message',id:'user-1',sessionId:'native',role:'user',content:[]};
  const kept={type:'message',id:'agent-1',parentId:'user-1',sessionId:'native',role:'assistant',content:[]};
  const removed={type:'message',id:'user-2',parentId:'agent-1',sessionId:'native',role:'user',content:[]};
  const rows=[first,kept,removed,{type:'function_call',id:'discarded-tool',parentId:'user-2',sessionId:'native'},{type:'resend-fork-notice',id:'native-rewind',parentId:'agent-1',providerData:{resendForkNotice:true}}];
  const original=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';fs.writeFileSync(file,original);
  const branch=codeBuddyBranch(file,'native');assert.equal(branch.epoch,'native-rewind');
  assert.equal(branch.allows(JSON.stringify(first)),true);assert.equal(branch.allows(JSON.stringify(kept)),true);assert.equal(branch.allows(JSON.stringify(removed)),false);assert.equal(branch.allows(JSON.stringify(rows[3])),false);
  assert.equal(fs.readFileSync(file,'utf8'),original);
  const next={type:'message',id:'user-new',parentId:'agent-1',sessionId:'native',role:'user',content:[]};fs.appendFileSync(file,JSON.stringify(next)+'\n');
  const continued=codeBuddyBranch(file,'native');assert.equal(continued.epoch,'native-rewind');assert.equal(continued.allows(JSON.stringify(next)),true);assert.equal(continued.allows(JSON.stringify(removed)),false);
  fs.appendFileSync(file,JSON.stringify({type:'resend-fork-notice',id:'rewind-to-start',parentId:null,providerData:{resendForkNotice:true}})+'\n');
  assert.equal(codeBuddyBranch(file,'native').allows(JSON.stringify(first)),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
