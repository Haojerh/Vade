import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePermissionMode,withNativePermissions,applyNativePermission,NativePermissionConfirmationRequired} from '../chat/controls/nativePermissions.js';
import type {AgentChatOptions} from '../../../shared/contracts.js';
import type {ChatControlIO} from '../chat/controls/chatControlTypes.js';
const options=(provider:string)=>withNativePermissions({provider,transport:'terminal',models:[],current:{},controls:{model:false,effort:false,fastMode:false,fastToggle:false,serviceTier:false,providerPicker:false}},'',true);

test('native permission badges are provider-bound and tolerate blank viewport rows',()=>{
  assert.equal(nativePermissionMode('antigravity','? for shortcuts   auto · Gemini · medium\n'.padEnd(500,'\n')),'auto');
  assert.equal(nativePermissionMode('antigravity','? for shortcuts   accept-edits · Gemini · medium'),'acceptEdits');
  assert.equal(nativePermissionMode('codebuddy','⏵⏵ bypass permissions on (shift+tab to cycle)'),'yolo');
  assert.equal(nativePermissionMode('claude','⏸ plan + bypass (shift+tab to cycle)'),'plan');
  assert.equal(nativePermissionMode('claude','? for shortcuts'),undefined);
  assert.equal(nativePermissionMode('codex','⏵⏵ bypass permissions on'),undefined);
});

test('live native options do not require saved history or a restart',()=>{
  for(const provider of ['codex','claude','codebuddy','antigravity']){
    const value=options(provider);assert.ok(value.permissions?.length);assert.equal(value.permissionsRequireRestart,false);
  }
  assert.ok(options('codex').permissions?.some(row=>row.value==='read-only'));
  assert.equal(options('antigravity').permissions?.find(row=>row.value==='auto')?.label,'Auto');
  assert.equal(options('antigravity').permissions?.some(row=>row.value==='yolo'),false);
  assert.equal(options('opencode').permissions,undefined);
});

test('native cycles follow actual observed modes rather than a presumed order',async()=>{
  let screen='⏸ plan mode on',cursor=0;const writes:string[]=[];
  const io:ChatControlIO={screen:()=>screen,output:()=>'',outputCursor:()=>cursor,
    write:async data=>{writes.push(data);cursor++;screen=writes.length===1?'⏵⏵ auto mode on':'⏵⏵ accept edits on';},
    waitFor:async predicate=>{assert.ok(predicate(screen));return screen;}};
  const result=await applyNativePermission(options('claude'),{key:'permission',value:'acceptEdits'},io);
  assert.equal(result.current.permission,'acceptEdits');assert.deepEqual(writes,['\x1b[Z','\x1b[Z']);
});

test('a missing or uncertain native redraw is never retried',async()=>{
  const writes:string[]=[];const io:ChatControlIO={screen:()=>'',output:()=>'',outputCursor:()=>0,write:async data=>{writes.push(data);},waitFor:async()=>{throw Error('no fresh native evidence');}};
  await assert.rejects(applyNativePermission(options('codebuddy'),{key:'permission',value:'auto'},io),/no fresh native evidence/);
  assert.deepEqual(writes,['\x1b[Z']);
  await assert.rejects(applyNativePermission(options('codebuddy'),{key:'permission',value:'/arbitrary'},io),/advertised/);
  assert.equal(writes.length,1);
});

test('Codex chooses native rows and reopens the picker to verify the current marker',async()=>{
  let screen='',command='',selected='manual',current='manual';let cursor=0;const writes:string[]=[];
  const menu=()=>`Update Model Permissions\n${selected==='manual'?'›':' '} 1. Ask for approval ${current==='manual'?'(current)':''}  Read workspace\n${selected==='auto'?'›':' '} 2. Approve for me ${current==='auto'?'(current)':''}  Only ask for unsafe actions\n  3. Full Access  Use with caution\n  4. Read Only  Require approval`;
  const io:ChatControlIO={screen:()=>screen,output:()=>'',outputCursor:()=>cursor,promptEmpty:()=>screen==='› ',write:async data=>{
    writes.push(data);cursor++;
    if(data==='\x1b[B'){selected='auto';screen=menu();}
    else if(data==='\x1b'){screen='› ';}
    else if(data==='\r'){
      if(command==='/permissions'){command='';selected=current;screen=menu();}
      else{current=selected;screen='› ';}
    }else command+=data;
  },waitFor:async predicate=>{assert.ok(predicate(screen),screen);return screen;}};
  const result=await applyNativePermission(options('codex'),{key:'permission',value:'auto'},io);
  assert.equal(result.current.permission,'auto');assert.equal(current,'auto');
  assert.equal(writes.filter(value=>value==='\r').length,3);
  assert.equal(writes.at(-1),'\x1b');
});

test('Codex refuses a new permission command while its full-access confirmation is open',async()=>{
  const screen='Enable full access?\n> 1. Yes, continue anyway    Apply full access for this session\n  2. Cancel\n› ';
  const writes:string[]=[];
  const io:ChatControlIO={screen:()=>screen,output:()=>'',promptEmpty:()=>true,write:async data=>{writes.push(data);},waitFor:async predicate=>{predicate(screen);return screen;}};
  await assert.rejects(applyNativePermission(options('codex'),{key:'permission',value:'auto'},io),NativePermissionConfirmationRequired);
  assert.deepEqual(writes,[],'an empty background composer never licenses input into a warning dialog');
});

test('Codex reports a full-access confirmation immediately and never types another slash command into it',async()=>{
  let screen='',command='',cursor=0;const writes:string[]=[];
  const io:ChatControlIO={screen:()=>screen,output:()=>'',outputCursor:()=>cursor,promptEmpty:()=>true,write:async data=>{
    writes.push(data);cursor++;
    if(data==='\r'){
      if(command==='/permissions'){command='';screen='Update Model Permissions\n› 2. Approve for me (current)  Only ask for unsafe actions';}
      else screen='Enable full access?\n› 1. Yes, continue anyway   Apply full access for this session\n  2. Cancel\n› ';
    }else command+=data;
  },waitFor:async predicate=>{assert.ok(predicate(screen));return screen;}};
  await assert.rejects(applyNativePermission(options('codex'),{key:'permission',value:'auto'},io),NativePermissionConfirmationRequired);
  assert.equal(writes.join(''),'/permissions\r\r');
});

test('an explicit Full access selection confirms only its exact native warning once, then reads native current state',async()=>{
  let screen='Enable full access?\n› 1. Yes, continue anyway   Apply full access for this session\n  2. Cancel',command='',cursor=0;
  const writes:string[]=[];
  const io:ChatControlIO={screen:()=>screen,output:()=>'',outputCursor:()=>cursor,promptEmpty:()=>screen==='› ',write:async data=>{
    writes.push(data);cursor++;
    if(data==='\x1b')screen='› ';
    else if(data==='\r'){
      if(command==='/permissions'){screen='Update Model Permissions\n› 3. Full Access (current)  Use with caution';command='';}
      else screen='› ';
    }else command+=data;
  },waitFor:async predicate=>{assert.ok(predicate(screen),screen);return screen;}};
  assert.equal((await applyNativePermission(options('codex'),{key:'permission',value:'yolo'},io)).current.permission,'yolo');
  assert.equal(writes.join(''),'\r/permissions\r\x1b');
});
