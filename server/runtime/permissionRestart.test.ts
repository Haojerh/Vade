import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AdeStore} from './store.js';
import {AdeSessions} from './sessions.js';

test('native permissions change in the same owned process without submitting a message',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vade-native-access-')),store=new AdeStore(directory);
  const project=store.register(directory,'Permission','folder');
  const launches=path.join(directory,'launches.jsonl'),inputs=path.join(directory,'inputs.log');
  const script=`const fs=require('fs');fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(1))+String.fromCharCode(10));process.stdin.setRawMode?.(true);const e=String.fromCharCode(27);function draw(changed){process.stdout.write(e+'[2J'+e+'[H> '+String.fromCharCode(13,10)+(changed?'⏵⏵ accept edits on (shift+tab to cycle)':'⏵⏵ bypass permissions on (shift+tab to cycle)')+e+'[1;3H');}process.stdin.on('data',data=>{fs.appendFileSync(${JSON.stringify(inputs)},data);if(data.toString()===e+'[Z')draw(true);});draw(false);`;
  const sessions=new AdeSessions(store,()=>({executable:process.execPath,args:['-e',script,'--']}),undefined,undefined,()=>{});
  (sessions as any).chatControls.read=async()=>({provider:'claude',transport:'terminal',models:[],current:{},controls:{model:false,effort:false,fastMode:false,fastToggle:false,serviceTier:false,providerPicker:false}});
  try{
    const record=await sessions.launch(project.id,'worktree',directory,'claude');
    const deadline=Date.now()+5000;
    while(!(sessions as any).live.get(record.id)?.screen?.composerEmpty()){
      if(Date.now()>deadline)throw Error('Prompt fixture timed out');await new Promise(resolve=>setTimeout(resolve,20));
    }
    await assert.rejects(sessions.setChatOption(project.id,record.id,{key:'permission',value:'anything'},{}),/advertised native permission/);
    (sessions as any).sending.add(record.id);
    await assert.rejects(sessions.setChatOption(project.id,record.id,{key:'permission',value:'acceptEdits'},{}),/already being sent/);
    (sessions as any).sending.delete(record.id);
    const result=await sessions.setChatOption(project.id,record.id,{key:'permission',value:'acceptEdits'},{});
    assert.equal(result.current.permission,'acceptEdits');assert.equal(result.permissionsRequireRestart,false);
    assert.equal((await sessions.chatOptions(project.id,record.id,{})).current.permission,'acceptEdits','picker refresh retains the confirmed native mode');
    const current=sessions.require(project.id,record.id);
    assert.equal(current.providerThreadId,record.providerThreadId);assert.equal(current.statusToken,record.statusToken);
    assert.equal(fs.readFileSync(launches,'utf8').trim().split('\n').length,1);
    assert.equal(fs.readFileSync(inputs,'utf8'),'\x1b[Z');
    (sessions as any).chatControls.apply=async(options:any,request:any)=>({...options,current:{...options.current,model:request.value}});
    assert.equal((await sessions.setChatOption(project.id,record.id,{key:'model',value:'native-model'},{})).current.model,'native-model','Claude model changes also accept the optional-footer-free composer');
    assert.equal(store.db.prepare("SELECT value FROM preferences WHERE key='agents'").get(),undefined);
  }finally{sessions.close();store.close();await fs.promises.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
