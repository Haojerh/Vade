import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderChatControls } from '../chat/controls/providerChatControls.js';

test('Claude effort confirmation accepts the native saved-default acknowledgement and rejects stale output',async()=>{
  const options={provider:'claude',transport:'terminal',models:[{id:'model',label:'Model',efforts:[{value:'low',label:'Low'},{value:'high',label:'High'}]}],current:{model:'model',effort:'high'},controls:{model:true,effort:true,fastMode:false,fastToggle:false,serviceTier:false,providerPicker:false}} as AgentChatOptions;
  let output='Set effort level to low (old acknowledgement)\n',typed='';
  const io={screen:()=>'',output:()=>output,write:async(value:string)=>{typed+=value;if(value==='\r')output+='\r\n  ⎿ Set effort level to `low` (saved as your default for new sessions): Quick implementation\r\n';},waitFor:async(predicate:(screen:string)=>boolean)=>{assert.equal(predicate(''),true);return '';}};
  const result=await new ProviderChatControls().apply(options,{key:'effort',value:'low'},io);
  assert.equal(result.current.effort,'low');assert.equal(typed,'/effort low\r');
  await assert.rejects(new ProviderChatControls().apply(options,{key:'effort',value:'low'},{...io,write:async()=>{},waitFor:async predicate=>{assert.equal(predicate(''),false);throw Error('No new acknowledgement');}}),/No new acknowledgement/);
  const native=await new ProviderChatControls().apply(options,{key:'effort',value:'low'},{...io,output:()=>'',write:async()=>{},settingConfirmed:()=>true});
  assert.equal(native.current.effort,'low','native confirmation survives wrapped or absent terminal acknowledgement text');
});
test('Claude confirmation reads the rendered screen when the raw stream splits the acknowledgement',async()=>{
  const options={provider:'claude',transport:'terminal',models:[{id:'model',label:'Model',efforts:[{value:'low',label:'Low'},{value:'high',label:'High'}]}],current:{model:'model',effort:'high'},controls:{model:true,effort:true,fastMode:false,fastToggle:false,serviceTier:false,providerPicker:false}} as AgentChatOptions;
  // Ink writes positioned fragments, so the byte stream never contains the sentence.
  let output='',screen='',typed='';
  const io={screen:()=>screen,output:()=>output,write:async(value:string)=>{
    typed+=value;
    if(value!=='\r')return;
    output+='Set effort level to \u001b[1mlo\u001b[22m\u001b[3Gw\r\n';
    screen='> /effort low\n  ⎿  Set effort level to low (saved as your default for new sessions): Quick implementation\n';
  },waitFor:async(predicate:(screen:string)=>boolean)=>{assert.equal(predicate(screen),true);return screen;}};
  const result=await new ProviderChatControls().apply(options,{key:'effort',value:'low'},io);
  assert.equal(result.current.effort,'low');
  // An older acknowledgement still visible above this command's echo cannot confirm it.
  const staleScreen='> /effort low\n  ⎿  Set effort level to low (saved as your default for new sessions): Quick\n\n> /effort low\n';
  const stale={...io,screen:()=>staleScreen,output:()=>'',write:async()=>{},waitFor:async(predicate:(screen:string)=>boolean)=>{assert.equal(predicate(staleScreen),false,'an earlier acknowledgement is not fresh evidence');throw Error('No fresh acknowledgement');}};
  await assert.rejects(new ProviderChatControls().apply(options,{key:'effort',value:'low'},stale),/No fresh acknowledgement/);
});

test('Claude model confirmation accepts a rendered acknowledgement naming the chosen model',async()=>{
  const options={provider:'claude',transport:'terminal',models:[{id:'model-a',label:'Model A',efforts:[]}],current:{},controls:{model:true,effort:false,fastMode:false,fastToggle:false,serviceTier:false,providerPicker:false}} as AgentChatOptions;
  let screen='',output='';
  const io={screen:()=>screen,output:()=>output,write:async(value:string)=>{if(value!=='\r')return;output='';screen='> /model model-a\n  ⎿  Set model to Model A\n';},waitFor:async(predicate:(screen:string)=>boolean)=>{assert.equal(predicate(screen),true);return screen;}};
  const result=await new ProviderChatControls().apply(options,{key:'model',value:'model-a'},io);
  assert.equal(result.current.model,'model-a');
});

import type { AgentChatOptions } from '../../../shared/contracts.js';
import type { ChatControlIO } from '../chat/controls/chatControlTypes.js';
import { AntigravityChatControls } from '../../providers/antigravity/antigravityChatControls.js';
import { WorkflowModels, codeBuddyWorkflowCatalog } from '../workflow/workflowModels.js';
import { OpenCodeChatControls } from '../../providers/opencode/openCodeChatControls.js';
import { TerminalScreen } from '../sessions/terminalScreen.js';
import { codeBuddyRecordedSettings } from '../chat/conversation.js';
import type { SessionRecord } from '../store.js';
import { AdeSessions } from '../sessions/sessions.js';
import { CodeBuddyChatControls } from '../../providers/codebuddy/codeBuddyChatControls.js';
import fsNative from 'node:fs';
import osNative from 'node:os';
import pathNative from 'node:path';
import { installOpenCodePlugin } from '../../providers/opencode/openCodeSessions.js';
import { readAgentStatus } from '../sessions/statusHooks.js';
import { AgentWorkClock } from '../sessions/agentWorkClock.js';

// Freebuff caches its per-account catalog under ADE's data directory. Keep the suite off
// the host's real cache so these assertions describe the bundled fallback deterministically.
process.env.ADE_DATA_DIR ??= fsNative.mkdtempSync(pathNative.join(osNative.tmpdir(), 'vade-freebuff-data-'));

test('native OpenCode status drop-ins preserve configuration and publish exact-session working time', async () => {
  const directory = fsNative.mkdtempSync(pathNative.join(osNative.tmpdir(), 'vade-native-status-'));
  const keys = ['ADE_STATUS_FILE','ADE_STATUS_TOKEN','ADE_STATUS_SESSION','ADE_STATUS_PROVIDER','ADE_STATUS_CWD','ADE_STATUS_SOURCE_CWD','ADE_OPENCODE_PLUGIN_API'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    fsNative.mkdirSync(pathNative.join(directory,'status'));
    for (const provider of ['opencode','kilo','opencode2'] as const) {
      const config = pathNative.join(directory,provider), plugins = pathNative.join(config,'plugins');
      fsNative.mkdirSync(plugins,{recursive:true}); fsNative.writeFileSync(pathNative.join(plugins,'user.js'),'user plugin');
      const settings = pathNative.join(config,'opencode.json'); fsNative.writeFileSync(settings,'{"permission":"ask"}');
      const env = { OPENCODE_CONFIG_DIR: config, KILO_CONFIG_DIR: config, OPENCODE_CONFIG_CONTENT:'{"plugin":["existing"]}' };
      installOpenCodePlugin(provider,env); installOpenCodePlugin(provider,env);
      assert.equal(fsNative.readFileSync(pathNative.join(plugins,'user.js'),'utf8'),'user plugin');
      assert.equal(fsNative.readFileSync(settings,'utf8'),'{"permission":"ask"}');
      assert.equal(env.OPENCODE_CONFIG_CONTENT,'{"plugin":["existing"]}');
      const record = {id:provider,projectId:'project',provider,cwd:directory,statusToken:'current-token',providerThreadId:'ses_exact',createdAt:new Date().toISOString(),closed:false,worktreeId:'tree',title:provider} as SessionRecord;
      const nativeDirectory=provider==='kilo'?pathNative.join(directory,'original-checkout'):directory;
      Object.assign(process.env,{ADE_STATUS_FILE:pathNative.join(directory,'status',provider+'.json'),ADE_STATUS_TOKEN:record.statusToken,ADE_STATUS_SESSION:record.providerThreadId,ADE_STATUS_PROVIDER:provider,ADE_STATUS_CWD:directory,ADE_STATUS_SOURCE_CWD:provider==='kilo'?nativeDirectory:'',ADE_OPENCODE_PLUGIN_API:provider==='opencode2'?'v2':'v1'});
      const source = fsNative.readFileSync(pathNative.join(plugins,'vade-agent-status.js'),'utf8');
      const module = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#'+provider);
      const factory=typeof module.default==='function'?module.default:module.default.server;
      assert.deepEqual(await factory({directory:pathNative.join(directory,'unrelated')}),{});
      const hooks = await factory({directory:nativeDirectory});
      assert.equal(readAgentStatus(directory,record,true).data?.state,'idle');
      const event = (type:string,properties:unknown)=>hooks.event({event:{type,properties}});
      await event('session.status',{sessionID:'ses_other',status:{type:'busy'}});
      assert.equal(readAgentStatus(directory,record,true).data?.state,'idle');
      await event('session.status',{sessionID:'ses_exact',status:{type:'busy'}});
      const clock = new AgentWorkClock(), working = readAgentStatus(directory,record,true);
      assert.equal(working.data?.state,'working'); assert.ok(clock.observe(record,working)?.activeSince);
      await event('session.error',{sessionID:'ses_exact',error:{name:'MessageAbortedError'}});
      const interrupted=readAgentStatus(directory,record,true);
      assert.equal(interrupted.data?.state,'interrupted'); assert.ok(clock.observe(record,interrupted)?.endedAt);
      await event('session.status',{sessionID:'ses_exact',status:{type:'busy'}});
      await event('session.idle',{sessionID:'ses_exact'});
      const completed=readAgentStatus(directory,record,true);
      assert.equal(completed.data?.state,'completed'); assert.ok(clock.observe(record,completed)?.endedAt);
      if(provider==='opencode2') {
        let admitted: ((properties:unknown)=>Promise<void>) | undefined;
        let finish!: () => void;
        const finishing = new Promise<void>(resolve => { finish=resolve; });
        const cleanup=await module.default.setup({session:{hook:async(_name:string,callback:any)=>{admitted=callback;return{dispose(){}};}},event:{subscribe:async function*(){await finishing;yield {type:'session.execution.succeeded',data:{sessionID:'ses_exact'}};}}});
        await admitted!({sessionID:'ses_exact'}); assert.equal(readAgentStatus(directory,record,true).data?.state,'working');
        finish(); for(let i=0;i<8;i++)await Promise.resolve();
        assert.equal(readAgentStatus(directory,record,true).data?.state,'completed');
        await cleanup();
      }
      fsNative.writeFileSync(pathNative.join(plugins,'vade-agent-status.js'),'unrelated file');
      assert.throws(()=>installOpenCodePlugin(provider,env),/unrelated/);
      assert.equal(fsNative.readFileSync(pathNative.join(plugins,'vade-agent-status.js'),'utf8'),'unrelated file');
    }
  } finally { for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];} fsNative.rmSync(directory,{recursive:true,force:true}); }
});
import { codeBuddyEffortAcknowledgement } from '../../providers/codebuddy/codeBuddySettings.js';

test('workflow CodeBuddy reads exact native model effort metadata without prompts, tools or persistence', async () => {
  const script = `
    const readline = require('node:readline');
    if (!process.argv.includes('--no-session-persistence') || !process.argv.includes('--strict-mcp-config') || !process.argv.includes('{"disableAllHooks":true}')) process.exit(2);
    const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
      else if (m.method === 'session/new' && m.params.cwd === process.cwd() && m.params.mcpServers.length === 0) send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{}});
      else if (m.id === 99 && m.error?.code === -32601) send({jsonrpc:'2.0',id:2,result:{models:{availableModels:[
        {modelId:'deepseek-v4.1-flash',name:'DeepSeek',_meta:{maxInputTokens:300000,effortOptions:[{value:'low'},{value:'high'},{value:'max'},{value:'invented'}],apiKey:'never expose'}},
        {modelId:'deepseek-v4.1-flash-sg',name:'DeepSeek',_meta:{effortOptions:[{value:'high'}]}},
        {modelId:'plain-model',name:'Plain'}, {modelId:'../bad',name:'Invalid'}
      ]}}});
      else process.exit(3);
    });`;
  const models = await codeBuddyWorkflowCatalog({ executable: process.execPath, args: ['-e', script, '--'] });
  assert.deepEqual(models, [
    {id:'deepseek-v4.1-flash',label:'deepseek-v4.1-flash',efforts:['low','high','max'],contextWindow:300000},
    {id:'deepseek-v4.1-flash-sg',label:'deepseek-v4.1-flash-sg',efforts:['high']},
    {id:'plain-model',label:'plain-model',efforts:[]},
  ]);
  assert.ok(!JSON.stringify(models).includes('never expose'));
});

test('workflow CodeBuddy fails closed when native metadata is unavailable', async () => {
  const script = `process.stdin.once('data', () => console.log(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-1,message:'private native error'}})));`;
  await assert.rejects(codeBuddyWorkflowCatalog({ executable: process.execPath, args: ['-e', script, '--'] }), /capabilities could not be read/);
});

test('workflow OpenCode family reuses native catalogs with model-specific variants', async t => {
  const calls: string[] = [];
  t.mock.method(OpenCodeChatControls.prototype, 'catalog', async (provider: 'opencode' | 'opencode2' | 'kilo') => {
    calls.push(provider);
    return [{ id: 'provider/reasoner', label: 'Reasoner', efforts: ['default', 'high'].map(value => ({ value, label: value })) }, { id: 'provider/plain', label: 'Plain', efforts: [] }];
  });
  const catalog = new WorkflowModels();
  for (const provider of ['opencode', 'opencode2', 'kilo'] as const) {
    assert.deepEqual((await catalog.list(provider))[0].efforts, ['default', 'high']);
    await catalog.validate({ provider, model: 'provider/reasoner', effort: 'high' });
    await assert.rejects(catalog.validate({ provider, model: 'provider/plain', effort: 'high' }), /supported effort/);
  }
  assert.deepEqual(calls, ['opencode', 'opencode2', 'kilo']);
});

test('new OpenCode effort initialization waits for the native prompt and uses the live settings fence', async () => {
  const sessions = Object.create(AdeSessions.prototype) as any;
  const record = { id: 'node', projectId: 'project', provider: 'opencode', statusToken: 'launch', workflowLaunch: { model: 'provider/reasoner', effort: 'high' } };
  const live = { live: true, inputRevision: 0, screen: { settled: async () => {}, openCodePromptReady: () => true } };
  const applied: unknown[] = [];
  Object.assign(sessions, { live: new Map([['node', live]]), shutdown: new AbortController(), require: () => record, setChatOption: async (...args: unknown[]) => { applied.push(args); } });
  await sessions.initializeOpenCodeVariant(record);
  assert.deepEqual(applied, [['project', 'node', { key: 'effort', value: 'high' }, { model: 'provider/reasoner' }]]);
  live.screen.settled = async () => { live.inputRevision++; };
  await assert.rejects(sessions.initializeOpenCodeVariant(record), /input changed/);
  assert.equal(applied.length, 1, 'Concurrent user input must prevent the setting command');
});

test('native prompt readiness bounds Kilo sidebar columns and recognizes the current CodeBuddy footer', async () => {
  const screen = new TerminalScreen(() => {}, () => {});
  try {
    screen.resize(148, 32);
    screen.write('\x1b[?1049h\x1b[2J\x1b[23;1H  ┃\x1b[23;110HModel Steps Cost\x1b[24;1H  ┃\x1b[24;110HNemotron 3 Ultra\x1b[25;1H  ┃\x1b[26;1H  ┃  Code auto · Native model Kilo Gateway\x1b[26;110Hproject:main\x1b[27;1H  ╹' + '▀'.repeat(100) + '\x1b[24;5H');
    await screen.settled(); assert.equal(screen.openCodePromptReady(), true);
    screen.write('\x1b[24;5Hdraft\x1b[24;5H'); await screen.settled(); assert.equal(screen.openCodePromptReady(), false);
    screen.write('\x1b[?1049l\x1b[2J\x1b[20;1H─────────────────\x1b[21;1H>  \x1b[22;1H─────────────────\x1b[23;1H⏵⏵ bypass permissions on (meta+m to cycle)  ← for agents\x1b[21;3H');
    await screen.settled(); assert.equal(screen.codeBuddyPromptReady(), true);
    screen.write('\x1b[21;3Hexisting draft\x1b[21;3H'); await screen.settled(); assert.equal(screen.codeBuddyPromptReady(), false);
    screen.write('\x1b[2J\x1b[HSelect effort\x1b[21;1H>  \x1b[23;1H← for agents\x1b[21;3H');
    await screen.settled(); assert.equal(screen.codeBuddyPromptReady(), false);
  } finally { screen.dispose(); }
});

test('CodeBuddy sends once from the current agents footer before hook status is available', async () => {
  const screen=new TerminalScreen(()=>{},()=>{}),sessions=Object.create(AdeSessions.prototype) as any;
  const record={provider:'codebuddy',id:'node',projectId:'project',cwd:process.cwd()},live={live:true,screen,inputRevision:0,start:0,buffer:''},writes:string[]=[];
  const draw=(draft='')=>{const data='\x1b[2J\x1b[20;1H─────────────────\x1b[21;1H> '+draft+'\x1b[22;1H─────────────────\x1b[23;1H⏵⏵ bypass permissions on (meta+m to cycle)  ← for agents\x1b[21;'+(draft.length+3)+'H';live.buffer+=data;screen.write(data);};
  Object.assign(sessions,{live:new Map([['node',live]]),sending:new Set(),store:{directory:process.cwd(),sessions:()=>[]},require:()=>record,status:()=>({data:null,meta:{availability:'unavailable'}}),command:async(_:unknown,message:{data:string})=>{writes.push(message.data);if(message.data.startsWith('\x1b[200~'))draw('hello');if(message.data==='\r')draw();}});
  try{draw();await screen.settled();await sessions.send('project','node',{message:'hello'});assert.deepEqual(writes,['\x1b[200~hello\x1b[201~','\r']);}finally{screen.dispose();}
});

test('OpenCode family accepts its observed empty prompt before lifecycle hooks and preserves setup and draft guards', async () => {
  for (const provider of ['opencode', 'opencode2', 'kilo'] as const) {
    const screen = new TerminalScreen(() => {}, () => {}), sessions = Object.create(AdeSessions.prototype) as any;
    const record = { provider, id: 'node', projectId: 'project', cwd: process.cwd() };
    const live = { live: true, screen, inputRevision: 0, start: 0, buffer: '' }, writes: string[] = [];
    let status: any = { data: null, meta: { availability: 'unavailable' } };
    const render = async (draft = '', footer = 'Build auto · DeepSeek V4.1 Flash Free OpenCode') => {
      screen.write('\x1b[?1049h\x1b[2J\x1b[18;1H┃\x1b[19;1H┃  ' + draft + '\x1b[20;1H┃\x1b[21;1H┃ ' + footer + '\x1b[22;1H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[19;4H');
      await screen.settled();
    };
    Object.assign(sessions, { live: new Map([['node', live]]), sending: new Set(), store: { directory: process.cwd(), sessions: () => [] }, require: () => record,
      status: () => status, command: async (_: unknown, message: { data: string }) => { writes.push(message.data); } });
    try {
      await render(); assert.equal(screen.openCodePromptReady(), true, provider);
      await sessions.send('project', 'node', { message: 'hi' });
      assert.deepEqual(writes, ['\x1b[200~hi\x1b[201~', '\r']);
      assert.equal(sessions.handoffPromptReady('project', 'node'), true, provider);
      status = { data: { state: 'unknown' }, meta: { availability: 'ready' } };
      await sessions.send('project', 'node', { message: 'next', requireIdle: true });
      assert.deepEqual(writes.slice(2), ['\x1b[200~next\x1b[201~', '\r']);
      const count = writes.length;
      for (const state of ['waiting', 'blocked', 'working']) {
        status = { data: { state }, meta: { availability: 'ready' } };
        await assert.rejects(sessions.send('project', 'node', { message: 'queued', requireIdle: true }), /empty, idle/);
      }
      status = { data: { state: 'waiting' }, meta: { availability: 'ready' } };
      await assert.rejects(sessions.send('project', 'node', { message: 'must not approve' }), /needs input/);
      status = { data: null, meta: { availability: 'unavailable' } };
      await render('existing draft'); assert.equal(screen.openCodePromptReady(), false);
      await assert.rejects(sessions.send('project', 'node', { message: 'must not overwrite' }), /empty agent prompt/);
      await render('', 'Shell command'); assert.equal(screen.openCodePromptReady(), false);
      await assert.rejects(sessions.send('project', 'node', { message: 'must not run shell' }), /empty agent prompt/);
      screen.write('\x1b[2J\x1b[HSign in to continue\x1b[19;4H'); await screen.settled();
      await assert.rejects(sessions.send('project', 'node', { message: 'must not answer setup' }), /empty agent prompt/);
      await render(); live.live = false;
      await assert.rejects(sessions.send('project', 'node', { message: 'stopped' }), /stopped/);
      assert.equal(writes.length, count, 'Blocked cases must never write input');
    } finally { screen.dispose(); }
  }
});

test('Codex waits for the rendered paste capsule, sends Enter once and refuses a folder trust prompt', async () => {
  const screen = new TerminalScreen(() => {}, () => {}), sessions = Object.create(AdeSessions.prototype) as any;
  const record = { provider: 'codex', id: 'node', projectId: 'project', cwd: process.cwd() };
  const live = { live: true, screen, inputRevision: 0, start: 0, buffer: '' }, writes: string[] = [];
  const render = (text: string) => { live.buffer += text; screen.write(text); };
  const prompt = 'x'.repeat(1855);
  Object.assign(sessions, { live: new Map([['node', live]]), sending: new Set(), store: { directory: process.cwd(), sessions: () => [] }, require: () => record,
    status: () => ({ data: {state:'idle'}, meta: {availability:'ready'} }), command: async (_: unknown, message: {data: string}) => {
      writes.push(message.data);
      if (message.data.startsWith('\x1b[200~')) setTimeout(() => render('\x1b[2J\x1b[H> [Pasted Content 1855 chars]'), 450);
      if (message.data === '\r') { assert.equal(screen.codexComposerHasText(prompt), true); render('\x1b[2J\x1b[H> \x1b[2mAsk Codex\x1b[0m\x1b[3G'); }
    } });
  try {
    render('\x1b[2J\x1b[H> \x1b[2mAsk Codex\x1b[0m\x1b[3G'); await screen.settled();
    await sessions.send('project','node',{message:prompt},true,true,true);
    assert.deepEqual(writes, ['\x1b[200~' + prompt + '\x1b[201~', '\r']);
    render('\x1b[2J\x1b[HDo you trust this folder?\r\n> 1. Yes, trust folder'); await screen.settled();
    await assert.rejects(sessions.send('project','node',{message:'assignment'},true,true,true), /empty, idle/);
    assert.equal(writes.length, 2, 'Trust setup must receive no assignment or approval input');
  } finally { screen.dispose(); }
});

test('Codex ignored Enter reports uncertain delivery without retrying', async t => {
  const screen = new TerminalScreen(() => {}, () => {}), sessions = Object.create(AdeSessions.prototype) as any;
  const live = { live:true, screen, inputRevision:0, start:0, buffer:'' }, writes:string[]=[];
  let now = 0;
  Object.assign(sessions, {live:new Map([['node',live]]),sending:new Set(),store:{directory:process.cwd()},require:()=>({provider:'codex'}),
    status:()=>({data:{state:'idle'},meta:{availability:'ready'}}),command:async (_:unknown,message:{data:string})=>{
      writes.push(message.data);
      if(message.data.startsWith('\x1b[200~')) { const text='\x1b[2J\x1b[H> hello'; live.buffer+=text;screen.write(text); }
      if(message.data==='\r') t.mock.method(Date,'now',()=>now+=1000);
    }});
  try {
    screen.write('\x1b[2J\x1b[H> \x1b[2mAsk Codex\x1b[0m\x1b[3G'); await screen.settled();
    await assert.rejects(sessions.send('project','node',{message:'hello'}),/Delivery may be partial/);
    assert.equal(writes.filter(value=>value==='\r').length,1);
    assert.equal(writes.length,2);
  } finally {screen.dispose();}
});

test('Codex retries Enter once only after a fresh stable redraw proves the exact idle draft remains', async t => {
  const screen=new TerminalScreen(()=>{},()=>{}),sessions=Object.create(AdeSessions.prototype) as any;
  const live={live:true,screen,inputRevision:0,start:0,buffer:''},writes:string[]=[];
  let now=0,enters=0;
  const render=(text:string)=>{live.buffer+=text;screen.write(text);};
  Object.assign(sessions,{live:new Map([['node',live]]),sending:new Set(),store:{directory:process.cwd()},require:()=>({provider:'codex'}),
    status:()=>({data:{state:'idle'},meta:{availability:'ready',stale:false}}),command:async (_:unknown,message:{data:string})=>{
      writes.push(message.data);
      if(message.data.startsWith('\x1b[200~'))render('\x1b[2J\x1b[H> hello');
      if(message.data==='\r'){
        enters++;
        if(enters===1){t.mock.method(Date,'now',()=>now+=200);render('\x1b[2J\x1b[H> hello');}
        else render('\x1b[2J\x1b[H> \x1b[2mAsk Codex\x1b[0m\x1b[3G');
      }
    }});
  try{
    render('\x1b[2J\x1b[H> \x1b[2mAsk Codex\x1b[0m\x1b[3G');await screen.settled();
    assert.equal((await sessions.send('project','node',{message:'hello'})).ok,true);
    assert.equal(enters,2);assert.equal(writes.filter(value=>value.startsWith('\x1b[200~')).length,1,'Retry must never paste the assignment again');
  }finally{screen.dispose();}
});

test('Codex never retries Enter for a changed draft, busy terminal or uncertain write', async t => {
  for(const mode of ['changed','busy','write-error']){
    const screen=new TerminalScreen(()=>{},()=>{}),sessions=Object.create(AdeSessions.prototype) as any;
    const live={live:true,screen,inputRevision:0,start:0,buffer:''},writes:string[]=[];
    let now=0,state='idle';
    const render=(text:string)=>{live.buffer+=text;screen.write(text);};
    Object.assign(sessions,{live:new Map([['node',live]]),sending:new Set(),store:{directory:process.cwd()},require:()=>({provider:'codex'}),
      status:()=>({data:{state},meta:{availability:'ready',stale:false}}),command:async (_:unknown,message:{data:string})=>{
        writes.push(message.data);
        if(message.data.startsWith('\x1b[200~'))render('\x1b[2J\x1b[H> hello');
        if(message.data==='\r'){
          if(mode==='write-error')throw new Error('PTY acknowledgement lost');
          if(mode==='busy')state='working';
          render('\x1b[2J\x1b[H> '+(mode==='changed'?'different message':'hello'));
          t.mock.method(Date,'now',()=>now+=1000);
        }
      }});
    try{
      render('\x1b[2J\x1b[H> \x1b[2mAsk Codex\x1b[0m\x1b[3G');await screen.settled();
      await assert.rejects(sessions.send('project','node',{message:'hello'}),/Delivery may be partial/);
      assert.equal(writes.filter(value=>value==='\r').length,1,mode);
      assert.equal(writes.length,2,mode);
    }finally{screen.dispose();t.mock.restoreAll();}
  }
});

test('CodeBuddy sends from an empty native prompt with unknown lifecycle status and refuses waiting or drafts', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  const sessions = Object.create(AdeSessions.prototype) as any;
  const record = { provider: 'codebuddy' };
  const live = { live: true, screen: terminal, inputRevision: 0, start: 0, buffer: '' };
  let state = 'unknown'; const writes: string[] = [];
  Object.assign(sessions, { live: new Map([['node', live]]), sending: new Set(), store: { directory: process.cwd() }, require: () => record,
    status: () => ({ meta: { availability: state === 'unknown' ? 'unavailable' : 'ready' }, data: { state } }), command: async (_: unknown, message: { data: string }) => {
      writes.push(message.data);
      if (message.data.startsWith('\x1b[200~')) {
        // Native paste processing can finish after the old fixed 300 ms delay.
        setTimeout(() => { live.buffer += 'rendered paste'; terminal.write('\x1b[2J\x1b[H> hello\x1b[999m'); }, 450);
      }
      if (message.data === '\r') {
        assert.ok(terminal.codeBuddyComposerHasText('hello'), 'Enter must follow the rendered paste');
        live.buffer += 'empty composer'; terminal.write('\x1b[2J\x1b[H> \x1b[999m\r\n? for shortcuts');
      }
    } });
  try {
    terminal.write('\x1b[2J\x1b[H> \x1b[999m\r\n? for shortcuts'); await terminal.settled();
    sessions.store.sessions = () => [];
    await sessions.send('project', 'node', { message: 'hello', requireIdle: true });
    assert.deepEqual(writes, ['\x1b[200~hello\x1b[201~', '\r']);
    writes.length = 0; state = 'waiting';
    await assert.rejects(sessions.send('project', 'node', { message: 'hello' }), /needs input/);
    assert.deepEqual(writes, []);
    state = 'unknown'; terminal.write('\x1b[1;1H\x1b[2K> \x1b[999mtyped draft\r\n? for shortcuts'); await terminal.settled();
    await assert.rejects(sessions.send('project', 'node', { message: 'hello' }), /not ready/);
    assert.deepEqual(writes, []);
  } finally { terminal.dispose(); }
});

test('CodeBuddy unconfirmed submission sends Enter only once and never reports success', async t => {
  const terminal = new TerminalScreen(() => {}, () => {});
  const sessions = Object.create(AdeSessions.prototype) as any;
  const live = { live: true, screen: terminal, inputRevision: 0, start: 0, buffer: '' };
  const writes: string[] = [];
  let clock = 0;
  t.mock.method(Date, 'now', () => clock += 6000);
  Object.assign(sessions, { live: new Map([['node', live]]), sending: new Set(), store: { directory: process.cwd() }, require: () => ({ provider: 'codebuddy' }),
    status: () => ({ meta: { availability: 'unavailable' }, data: { state: 'unknown' } }),
    command: async (_: unknown, message: { data: string }) => {
      writes.push(message.data);
      if (message.data.startsWith('\x1b[200~')) { live.buffer += 'rendered paste'; terminal.write('\x1b[2J\x1b[H> hello\x1b[999m'); }
    } });
  try {
    terminal.write('\x1b[2J\x1b[H> \x1b[999m\r\n? for shortcuts'); await terminal.settled();
    await assert.rejects(sessions.send('project', 'node', { message: 'hello' }), /Delivery may be partial/);
    assert.equal(writes.filter(value => value === '\r').length, 1);
    assert.equal(writes.filter(value => value.startsWith('\x1b[200~')).length, 1);
  } finally { terminal.dispose(); }
});

test('CodeBuddy command evidence restores model and effort across view and runtime remounts', () => {
  const record = { providerThreadId: 'exact-session', cwd: process.cwd() } as SessionRecord;
  const row = (output: string, sessionId = record.providerThreadId) => JSON.stringify({ type: 'message', role: 'user', sessionId, cwd: record.cwd, providerData: { skipRun: true, model: 'hy3' }, content: [{ type: 'input_text', text: `<local-command-stdout>${output}</local-command-stdout>` }] });
  const lines = [row('Available models:\n - Hy3 (hy3) ← current\n - Deepseek-V4.1-Flash (deepseek-v4.1-flash)\nTo switch model: /model'), row('Switched model to Deepseek-V4.1-Flash.'), row('Model reasoning effort set to high.'), row('Switched model to Hy3.', 'foreign-session')];
  assert.deepEqual(codeBuddyRecordedSettings(lines, record), { model: 'deepseek-v4.1-flash', effort: 'high' });
  assert.equal(codeBuddyRecordedSettings([...lines, row('Model reasoning effort set to medium.')], record).effort, 'medium');
});

test('CodeBuddy duplicate display names retain exact model IDs rather than mapping to the last alias', () => {
  const record = { providerThreadId: 'exact-session', cwd: process.cwd() } as SessionRecord;
  const normal = 'deepseek-v4.1-flash', regional = `${normal}-sg`;
  const row = (text: string, skipRun = true, sessionId = record.providerThreadId) => JSON.stringify({ type: 'message', role: 'user', sessionId, cwd: record.cwd,
    providerData: { skipRun }, content: [{ type: 'input_text', text }] });
  const output = (text: string) => row(`<local-command-stdout>${text}</local-command-stdout>`);
  const catalog = output(`Available models:\n - Deepseek-V4.1-Flash (${normal})\n - Deepseek-V4.1-Flash (${regional})\nTo switch model: /model`);
  for (const id of [normal, regional]) {
    const command = row(`<command-name>/model</command-name><command-args>${id}</command-args>`);
    assert.equal(codeBuddyRecordedSettings([catalog, command, output('Switched model to Deepseek-V4.1-Flash.')], record).model, id);
  }
  assert.equal(codeBuddyRecordedSettings([catalog, output('Switched model to Deepseek-V4.1-Flash.')], record).model, null);
  assert.equal(codeBuddyRecordedSettings([catalog, row(`<command-name>/model</command-name><command-args>${normal}</command-args>`, true, 'foreign'), output('Switched model to Deepseek-V4.1-Flash.')], record).model, null);
  assert.equal(codeBuddyRecordedSettings([catalog, row(`<command-name>/model</command-name><command-args>${normal}</command-args>`, false), output('Switched model to Deepseek-V4.1-Flash.')], record).model, null);
  assert.equal(codeBuddyRecordedSettings([catalog, output(`Available models:\n - Deepseek-V4.1-Flash (${normal}) ← current\n - Deepseek-V4.1-Flash (${regional})`)], record).model, normal);
});

test('CodeBuddy Ultracode is restored from exact native acknowledgements and survives ordinary model effort metadata', () => {
  const record = { providerThreadId: 'exact-session', cwd: process.cwd() } as SessionRecord;
  const row = (text: string) => JSON.stringify({ type: 'message', role: 'user', sessionId: record.providerThreadId, cwd: record.cwd,
    providerData: { skipRun: true }, content: [{ type: 'input_text', text: `<local-command-stdout>${text}</local-command-stdout>` }] });
  const enabled = '<system-reminder data-role="ultra_effort_enter">\n**ultracode mode enabled.**\n</system-reminder>';
  const disabled = '<system-reminder data-role="ultra_effort_exit">\n**ultracode mode disabled** (was `ultracode`, now `high`).\n</system-reminder>';
  const observed = JSON.stringify({ sessionId: record.providerThreadId, cwd: record.cwd, providerData: { model: 'hy3', effort: 'high' } });
  assert.equal(codeBuddyRecordedSettings([row(enabled), observed], record).effort, 'ultracode');
  assert.equal(codeBuddyRecordedSettings([row(enabled), observed, row(disabled)], record).effort, 'high');
  assert.equal(codeBuddyEffortAcknowledgement('`workflowEffortLevel` is already `ultracode`. No change.'), 'ultracode');
  assert.equal(codeBuddyEffortAcknowledgement('`/effort ultracode` is unavailable: Dynamic Workflows are disabled in this environment.'), undefined);
  assert.equal(codeBuddyEffortAcknowledgement('Some output mentions ultracode mode enabled.'), undefined);
});

test('CodeBuddy exposes only native advertised Ultracode and confirms its distinct enter and exit messages', async () => {
  const controls = new CodeBuddyChatControls();
  const options: AgentChatOptions = { provider: 'codebuddy', transport: 'terminal', models: [{ id: 'hy3', label: 'Hy3', efforts: [] }], current: { model: 'hy3' },
    controls: { model: true, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: true } };
  let screen = '>', output = '', input = '', advertise = true, acknowledge = true;
  const io: ChatControlIO = {
    screen: () => screen, output: () => output,
    write: async text => {
      if (text === '\x1b') { screen = '>'; return; }
      if (text !== '\r') { input += text; return; }
      if (input === '/effort') screen = `Effort\n low medium high${advertise ? ' ultracode' : ''}\nEsc to cancel`;
      if (input === '/effort ultracode' && acknowledge) output += '<system-reminder data-role="ultra_effort_enter">\n**ultracode mode enabled.**\n</system-reminder>';
      if (input === '/effort high') output += '<system-reminder data-role="ultra_effort_exit">\n**ultracode mode disabled** (was `ultracode`, now `high`).\n</system-reminder>';
      input = '';
    },
    waitFor: async predicate => { assert.ok(predicate(screen), 'fresh native acknowledgement required'); return screen; },
  };
  const discovered = await controls.inspectEfforts(options, io, 'launch');
  assert.deepEqual(discovered.models[0].efforts.map(choice => choice.value), ['low', 'medium', 'high', 'ultracode']);
  const enabled = await controls.apply(discovered, { key: 'effort', value: 'ultracode' }, io, 'launch');
  assert.equal(enabled.current.effort, 'ultracode');
  assert.equal((await controls.apply(enabled, { key: 'effort', value: 'high' }, io, 'launch')).current.effort, 'high');
  acknowledge = false;
  await assert.rejects(controls.apply(discovered, { key: 'effort', value: 'ultracode' }, io, 'launch'), /fresh native acknowledgement/);
  advertise = false;
  const ordinary = await controls.inspectEfforts(options, io, 'different-launch');
  assert.ok(!ordinary.models[0].efforts.some(choice => choice.value === 'ultracode'));
  await assert.rejects(controls.apply(ordinary, { key: 'effort', value: 'ultracode' }, io, 'different-launch'), /advertised/);
});

test('terminal checkpoints preserve more than 100 lines of command history', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  const restored = new TerminalScreen(() => {}, () => {});
  try {
    terminal.write(Array.from({ length: 250 }, (_, index) => `history-${index}`).join('\r\n'));
    await terminal.settled();
    const checkpoint = terminal.checkpoint()!;
    assert.ok(checkpoint.data.includes('history-0'));
    restored.write(checkpoint.data); await restored.settled();
    assert.equal(restored.checkpoint()!.data, checkpoint.data);
  } finally { terminal.dispose(); restored.dispose(); }
});

test('OpenCode family selects models in tall viewports after output tails reach their fixed limit', async () => {
  for (const provider of ['opencode', 'opencode2', 'kilo'] as const) {
    const terminal = new TerminalScreen(() => {}, () => {});
    terminal.resize(120, 60);
    let output = 'x'.repeat(65536), stage = 0, cursor = 65536;
    const render = async (data: string) => { cursor += data.length; output = (output + data).slice(-65536); terminal.write(data); await terminal.settled(); };
    try {
      const io: ChatControlIO = {
        screen: () => terminal.viewportText(), output: () => output, outputCursor: () => cursor,
        write: async data => {
          if (data.includes('/models') && stage === 0) await render('\x1b[58;1H\u2503 /models');
          else if (data === '\r' && stage === 0) { stage++; await render('\x1b[2J\x1b[10;1Hunderlying left\x1b[10;34HSelect model\x1b[10;83Hesc\x1b[10;90H\u2502 details\x1b[11;1Hunderlying left\x1b[11;34HSearch\x1b[11;94Hbackground right\x1b[12;34HOther provider'); assert.ok(!terminal.text()?.includes('Select model')); }
          else if (data.includes('Beam Free')) { stage++; await render('\x1b[11;34H\x1b[36mBeam Free\x1b[0m\x1b[12;1H\x1b[2K\x1b[12;34H' + (provider === 'kilo' ? 'Recent\x1b[13;34HBeam Free provider\x1b[14;34HRecommended\x1b[15;34HBeam Free provider' : 'Beam Free')); }
          else if (data === '\r' && stage === 2) { stage++; await render('\x1b[2J\x1b[HCode Beam Free provider'); }
        },
        waitFor: async predicate => { assert.equal(output.length, 65536); const screen = terminal.viewportText(); assert.ok(predicate(screen), screen); return screen; },
      };
      const result = await new OpenCodeChatControls().apply({ provider, transport: 'terminal', models: [{ id: 'provider/beam', label: 'Beam Free', efforts: [] }], current: {}, controls: { model: true, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false } }, { key: 'model', value: 'provider/beam' }, io);
      assert.equal(result.current.model, 'provider/beam');
      assert.equal(stage, 3);
    } finally { terminal.dispose(); }
  }
});

test('CodeBuddy uses its logical caret and accepts dim recommendations but rejects typed drafts', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  try {
    terminal.write('\x1b[2J\x1b[H> \x1b[999mE\x1b[2mxplore the ADE project structure together\x1b[0m\r\n? for shortcuts');
    await terminal.settled();
    assert.equal(terminal.composerEmpty(false, true), true);
    terminal.write('\x1b[1;1H\x1b[2K> \x1b[999mExplore typed draft\r\n? for shortcuts');
    await terminal.settled();
    assert.equal(terminal.composerEmpty(false, true), false);
  } finally { terminal.dispose(); }
});

test('CodeBuddy Windows recommendation remains empty without an SGR caret and after resize', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  const recommendation = '\x1b[2J\x1b[H> P\x1b[2mick up ADE runtime exploration\x1b[0m\x1b[1;85H\x1b[2m↵ send\x1b[0m\r\n? for shortcuts  ← for agents\x1b[1;3H';
  try {
    terminal.write(recommendation); await terminal.settled();
    assert.equal(terminal.composerEmpty(false, true), true);
    assert.equal(terminal.codeBuddyPromptReady(), true);
    terminal.resize(120, 40);
    terminal.write(recommendation); await terminal.settled();
    assert.equal(terminal.composerEmpty(false, true), true);
    assert.equal(terminal.codeBuddyComposerHasText('exploration'), false);
    terminal.write('\x1b[1;4H'); await terminal.settled();
    assert.equal(terminal.composerEmpty(false, true), false, 'caret after a typed character cannot be a placeholder');
    terminal.write('\x1b[2J\x1b[H> P'); await terminal.settled();
    assert.equal(terminal.composerEmpty(false, true), false);
  } finally { terminal.dispose(); }
});

test('CodeBuddy pasted draft evidence supports native capsules and rejects mismatching or historical text', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  try {
    terminal.write('\x1b[2J\x1b[H> [Pasted text #3: 3 lines]'); await terminal.settled();
    assert.equal(terminal.codeBuddyComposerHasText('Please implement this task: Test\n\ntest'), true);
    assert.equal(terminal.codeBuddyComposerHasText('one line'), false);
    terminal.write('\r\n? for shortcuts'); await terminal.settled();
    assert.equal(terminal.codeBuddyComposerHasText('Please implement this task: Test\n\ntest'), false);
    terminal.write('\x1b[2J\x1b[H> Please implement this task: Test\r\n\r\n  test'); await terminal.settled();
    assert.equal(terminal.codeBuddyComposerHasText('Please implement this task: Test\n\ntest'), true);
  } finally { terminal.dispose(); }
});

test('OpenCode family confirms low and Default effort in full viewports with saturated output tails', async () => {
  for (const provider of ['opencode', 'opencode2', 'kilo'] as const) for (const target of ['low', 'default']) {
    const terminal = new TerminalScreen(() => {}, () => {}); terminal.resize(120, 60);
    let stage = 0, cursor = 65536;
    const title = target === 'default' ? 'Default' : target;
    const render = async (text: string) => { cursor += text.length; terminal.write('\x1b[2J' + text); await terminal.settled(); };
    const footer = `\x1b[58;1HBuild Beam Free provider${target === 'default' ? '' : ' ' + target}`;
    const io: ChatControlIO = {
      screen: () => terminal.viewportText(), output: () => 'x'.repeat(65536), outputCursor: () => cursor,
      write: async data => {
        if (data.includes('/variants') && (stage === 0 || stage === 3)) await render('\x1b[58;1H\u2503 /variants');
        else if (data === '\r' && stage === 0) { stage = 1; await render('\x1b[8;1HSelect variant\r\nSearch\r\nDefault\r\nlow\r\n\u25cf high'); }
        else if (data.startsWith('\x1b[200~') && stage === 1) { stage = 2; await render(`\x1b[8;1HSelect variant\r\n${title}\r\n${title}`); }
        else if (data === '\r' && stage === 2) { stage = 3; await render(footer); }
        else if (data === '\r' && stage === 3) { stage = 4; await render(`\x1b[8;1HSelect variant\r\nSearch\r\n\u25cf ${title}\r\nhigh`); }
        else if (data === '\x1b' && stage === 4) { stage = 5; await render(footer); }
      },
      waitFor: async predicate => { assert.ok(predicate(terminal.viewportText()), terminal.viewportText()); return terminal.viewportText(); },
    };
    try {
      const result = await new OpenCodeChatControls().apply({ ...options, provider, models: [{ id: 'provider/beam', label: 'Beam Free', efforts: ['default', 'low', 'high'].map(value => ({ value, label: value })) }], current: { model: 'provider/beam', effort: 'high' } }, { key: 'effort', value: target }, io);
      assert.equal(stage, 5); assert.equal(result.current.effort, target);
    } finally { terminal.dispose(); }
  }
});

test('OpenCode family reads manually changed effort and native Default from the current footer', async t => {
  for (const provider of ['opencode', 'opencode2', 'kilo'] as const) {
    const controls = new OpenCodeChatControls();
    t.mock.method(controls as any, 'catalog', async () => [{ id: 'provider/beam', label: 'Beam Free', efforts: ['default', 'low', 'high'].map(value => ({ value, label: value })) }]);
    const changed = await controls.read(provider, process.cwd(), { model: 'provider/beam', effort: 'high' }, 'Build Beam Free provider \u00b7 low');
    assert.equal(changed.current.effort, 'low');
    const reset = await controls.read(provider, process.cwd(), { model: 'provider/beam', effort: 'high' }, 'Build Beam Free provider');
    assert.equal(reset.current.effort, 'default');
  }
});

const options: AgentChatOptions = { provider: 'codex', transport: 'terminal', models: [{ id: 'model-a', label: 'Model A', efforts: [{value:'low',label:'Low'},{value:'max',label:'Max'}], supportsFastMode: true, serviceTiers: [{value:'priority',label:'Fast'}] }], current: { model: 'model-a', effort: 'low', fastMode: false, serviceTier: 'default' }, controls: {model:true,effort:true,fastMode:true,fastToggle:false,providerPicker:false,serviceTier:false} };

test('model catalogs return cached choices while sharing a background refresh', async t => {
  let now = 1000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const catalog = new WorkflowModels();
  const first = [{ id: 'old', label: 'Old', efforts: [] }];
  const second = [{ id: 'new', label: 'New', efforts: [] }];
  let finish!: (value: typeof first) => void;
  t.mock.method(catalog as any, 'discover', async () => {
    calls++;
    return calls === 1 ? first : new Promise<typeof first>(resolve => { finish = resolve; });
  });
  assert.deepEqual(await catalog.list('antigravity'), first);
  now += 61000;
  assert.deepEqual(await catalog.list('antigravity'), first);
  assert.deepEqual(await catalog.list('antigravity'), first);
  assert.equal(calls, 2, 'Concurrent reads must share one refresh');
  finish(second);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await catalog.list('antigravity'), second);
});

test('Antigravity uses only catalog effort variants and requires a fresh native acknowledgement', async () => {
  const rows = ['low','high'].map(effort => ({ id: `family-${effort}`, label: `Family (${effort === 'low' ? 'Low' : 'High'})`, efforts: ['low','high'], effortModels: { low:'family-low', high:'family-high' } }));
  const controls = new AntigravityChatControls({ list: async () => rows });
  const initial = await controls.read({}, '? for shortcuts       accept-edits · Family · low');
  assert.equal(initial.current.model, 'family-low');
  assert.equal(initial.controls.fastMode, false);
  let fresh = '', typed = '';
  const io: ChatControlIO = { screen: () => 'Effort set to high', output: () => fresh, write: async data => { if(data === '\r') fresh = 'Effort set to high'; else typed += data; }, waitFor: async predicate => { assert.ok(predicate('')); return ''; } };
  const changed = await controls.apply(initial, { key:'effort', value:'high' }, io);
  assert.equal(typed, '/effort high'); assert.equal(changed.current.model, 'family-high');
  typed = ''; await assert.rejects(controls.apply(initial, { key:'effort', value:'max' }, io), /offered/); assert.equal(typed, '');
  await assert.rejects(controls.apply(initial, { key:'model', value:'family-low\rmalicious' }, io), /offered/);
  fresh = ''; io.write = async () => {};
  await assert.rejects(controls.apply(initial, { key:'effort', value:'high' }, io), /assertion|false|truthy/i);
});
test('Codex native picker navigates advertised nested effort and uses session-only selection', async () => {
  let screen = 'Model A low · workspace', stage = 'prompt', index = 0, typed = '';
  const writes: string[] = [];
  const render = () => { screen = stage === 'model' ? 'Select Model and Effort\n› 1. Model A (current)  Description' : stage === 'effort' ? 'Select Reasoning Level for Model A\n' + ['Low (default)','Medium','High','Extra high','More reasoning…'].map((label,i)=>`${i===index?'›':' '} ${i+1}. ${label}  Description`).join('\n') + '\nenter default · s session · esc back' : stage === 'more' ? 'Select Reasoning Level for Model A\n› 1. Max  Description\n  2. Ultra  Description\nenter default · s session · esc back' : 'Model A max · workspace'; };
  const io: ChatControlIO = { screen:()=>screen, output:()=>'', waitFor:async predicate=>{ assert.ok(predicate(screen), screen); return screen; }, write:async data=>{
    writes.push(data);
    if (stage === 'prompt') { if (data === '\r') { assert.equal(typed,'/model'); stage='model'; render(); } else typed+=data; }
    else if(stage === 'model' && data === '\r') {stage='effort'; render();}
    else if(stage === 'effort' && data === '\x1b[B') {index++;render();}
    else if(stage === 'effort' && data === '\r') {assert.equal(index,4);stage='more';render();}
    else if(stage === 'more' && data === 's') {stage='done';render();}
    else assert.fail(`Unexpected native input ${JSON.stringify(data)}`);
  } };
  const result = await new ProviderChatControls().apply(options,{key:'effort',value:'max'},io);
  assert.equal(result.current.effort,'max'); assert.equal(result.unconfirmed,undefined); assert.equal(writes.at(-1),'s');
});
test('Codex speed selection is a no-op for the observed current value and uses only /fast to change', async () => {
  let output = '', typed = ''; const writes: string[] = [];
  const io: ChatControlIO = {screen:()=>output,output:()=>output,waitFor:async predicate=>{assert.ok(predicate(output));return output;},write:async data=>{writes.push(data);if(data==='\r')output='• Service tier set to priority';else typed+=data;}};
  const control = new ProviderChatControls();
  await control.apply(options,{key:'fastMode',value:'false'},io); assert.equal(writes.length,0);
  const result=await control.apply(options,{key:'fastMode',value:'true'},io);
  assert.equal(typed,'/fast'); assert.equal(result.current.fastMode,true); assert.equal(result.current.serviceTier,'priority');
});
test('Old speed acknowledgement cannot confirm a new operation', async () => {
  const io: ChatControlIO = {screen:()=> 'Service tier set to priority',output:()=>'',write:async()=>{},waitFor:async predicate=>{assert.equal(predicate('Service tier set to priority'),false);throw new Error('No fresh response');}};
  await assert.rejects(new ProviderChatControls().apply(options,{key:'fastMode',value:'true'},io),/No fresh response/);
});

test('Codex speed confirms a changed footer when incremental terminal redraws split the acknowledgement', async () => {
  let screen = 'Model A low fast \u00b7 workspace', output = '', typed = '';
  const io: ChatControlIO = {
    screen: () => screen, output: () => output,
    write: async data => {
      if (data === '\r') { screen = 'Model A low \u00b7 workspace'; output = 'Service tier set to de\x1b[1Cfault'; }
      else typed += data;
    },
    waitFor: async predicate => { assert.ok(predicate(screen)); return screen; },
  };
  const result = await new ProviderChatControls().apply({ ...options, current: { ...options.current, fastMode: true, serviceTier: 'priority' } }, { key: 'fastMode', value: 'false' }, io);
  assert.equal(typed, '/fast');
  assert.equal(result.current.fastMode, false);
  assert.equal(result.current.serviceTier, 'default');
});
test('Claude model acknowledgement must name the selected advertised model', async () => {
  let output='',typed='';
  const io: ChatControlIO = {screen:()=>output,output:()=>output,write:async data=>{if(data==='\r')output='Set model to Model A';else typed+=data;},waitFor:async predicate=>{assert.ok(predicate(output));return output;}};
  const result=await new ProviderChatControls().apply({...options,provider:'claude',current:{}},{key:'model',value:'model-a'},io);
  assert.equal(typed,'/model model-a');assert.equal(result.current.model,'model-a');assert.equal(result.current.effort,undefined);assert.equal(result.unconfirmed,undefined);
});
test('Codex current footer supplies observed settings before a first public turn',async()=>{
  const control=new ProviderChatControls();control.catalog=async()=>options.models;
  const result=await control.read('codex',{model:null,effort:null},'Model A max fast · workspace',process.cwd());
  assert.deepEqual(result.current,{model:'model-a',effort:'max',fastMode:true,serviceTier:'priority'});
  assert.equal(result.controls.fastMode,true);
});

test('Codex reads the current screen after asynchronous catalog discovery', async () => {
  const control = new ProviderChatControls(); let screen = '';
  control.catalog = async () => { screen = 'Model A low fast \u00b7 workspace'; return options.models; };
  const result = await control.read('codex', {}, () => screen, process.cwd());
  assert.equal(result.current.fastMode, true);
  assert.equal(result.current.model, 'model-a');
});

test('Codex manually changed effort overrides the prior recorded turn effort', async () => {
  const control = new ProviderChatControls(); control.catalog = async () => options.models;
  const result = await control.read('codex', { model: 'model-a', effort: 'max' }, 'Model A low \u00b7 workspace', process.cwd());
  assert.equal(result.current.effort, 'low');
});

test('manual Antigravity model changes override older transcript settings after catalog loading', async () => {
  let screen = '';
  const control = new AntigravityChatControls({ list: async () => {
    screen = 'accept-edits \u00b7 Family \u00b7 high';
    return ['low', 'high'].map(effort => ({ id: `family-${effort}`, label: `Family (${effort === 'low' ? 'Low' : 'High'})`, efforts: ['low', 'high'] }));
  } });
  const result = await control.read({ model: 'family-low', effort: 'low' }, () => screen);
  assert.equal(result.current.model, 'family-high');
  assert.equal(result.current.effort, 'high');
});

test('Freebuff recognizes its empty native composer, rejects drafts and open pickers', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  try {
    const frame = (composer: string) => `\x1b[2J\x1b[H\u256d\u2500\u2500\u2500\u2500\u256e\r\n\u2502      \u2502\r\n\u2502  ${composer}\r\n\u2502      \u2502\r\n\u2570\u2500\u2500\u2500\u2500\u256f\r\n DeepSeek V4.1 Flash 10/17 \u2022 high \u00b7 ~\\work \u00b7 /model to change \u00b7 Chat: New chat\r\n \u2190 for history \u00b7 ? for help`;
    terminal.write(frame('\u258d\u001b[2mEnter a coding task or / for commands\u001b[22m'));
    await terminal.settled();
    assert.equal(terminal.freebuffPromptReady(), true, 'the dim placeholder is an empty composer');
    terminal.write(frame('hello world\u258d'));
    await terminal.settled();
    assert.equal(terminal.freebuffPromptReady(), false, 'typed text before the cursor is a draft');
    terminal.write(frame('\u258d\u001b[2mEnter a coding task or / for commands\u001b[22m') + '\r\n \u2191\u2193 choose model \u00b7 Tab reasoning \u00b7 Enter select \u00b7 Esc cancel');
    await terminal.settled();
    assert.equal(terminal.freebuffPromptReady(), false, 'an open native picker is not an empty composer');
  } finally { terminal.dispose(); }
});

test('Freebuff reads its native status line and offers its own model catalog', async () => {
  const directory = fsNative.mkdtempSync(pathNative.join(osNative.tmpdir(), 'vade-freebuff-read-'));
  const previous = process.env.FREEBUFF_CONFIG_DIR;
  process.env.FREEBUFF_CONFIG_DIR = directory;
  try {
    const footer = ' DeepSeek V4.1 Flash 10/17 \u2022 high \u00b7 ~\\work \u00b7 /model to change \u00b7 Chat: New chat\n \u2190 for history \u00b7 ? for help';
    const options = await new ProviderChatControls().read('freebuff', { model: 'stale/recorded', effort: 'low' }, footer, directory);
    assert.equal(options.current.model, 'deepseek/deepseek-v4-flash');
    assert.equal(options.current.effort, 'high');
    assert.equal(options.controls.effort, true);
    assert.ok(options.models.some(model => model.id === 'z-ai/glm-5.3-flash'));
    assert.ok(options.models.some(model => model.id === 'openai/gpt-6.1-sol'));
    // A model without adjustable reasoning hides the reasoning control.
    const noEffort = await new ProviderChatControls().read('freebuff', {}, ' MiMo v2.6 Flash Fast \u00b7 ~\\work \u00b7 /model to change \u00b7 Chat: New chat', directory);
    assert.equal(noEffort.current.model, 'mimo/mimo-v2.5');
    assert.equal(noEffort.current.effort, undefined);
    assert.equal(noEffort.controls.effort, false);
    // No native footer and no stored preference is unknown, never a fabricated default.
    const unknown = await new ProviderChatControls().read('freebuff', {}, '', directory);
    assert.equal(unknown.current.model, undefined);
  } finally {
    if (previous === undefined) delete process.env.FREEBUFF_CONFIG_DIR; else process.env.FREEBUFF_CONFIG_DIR = previous;
    fsNative.rmSync(directory, { recursive: true, force: true });
  }
});

test('Freebuff selects a model and reasoning level in its own pickers and confirms from the footer', async () => {
  const directory = fsNative.mkdtempSync(pathNative.join(osNative.tmpdir(), 'vade-freebuff-picker-'));
  const previous = process.env.FREEBUFF_CONFIG_DIR;
  process.env.FREEBUFF_CONFIG_DIR = directory;
  try {
    const rows = [
      { label: 'DeepSeek V4.1 Flash 10/17', effort: 'high', id: 'deepseek/deepseek-v4-flash' },
      { label: 'GLM 5.3 Flash', effort: 'high', id: 'z-ai/glm-5.3-flash' },
      { label: 'GPT-6 Luna', effort: 'high', id: 'openai/gpt-6-luna' },
    ];
    const efforts = ['low', 'high', 'max'];
    let mode: 'composer' | 'model' | 'reasoning' = 'composer';
    let selected = 0, modelIndex = 0, effort = 'high', typed = '', command = '';
    const composer = () => ` \u256d\u2500\u2500\u256e\n \u2502  \u258dEnter a coding task or / for commands\n \u2570\u2500\u2500\u256f\n ${rows[modelIndex].label} \u2022 ${effort} \u00b7 ~\\work \u00b7 /model to change \u00b7 Chat: New chat\n`;
    const picker = () => [' \u2191\u2193 choose model \u00b7 Tab reasoning \u00b7 Enter select \u00b7 Esc cancel', ' OPTIMIZED \u00b7 Strongest price-to-performance models',
      ...rows.map((row, index) => ` \u2502 ${index === selected ? '\u203a' : ' '} ${row.label} \u2022 ${row.effort} \u00b7 Tagline \u00b7 Images`)].join('\n');
    const reasoning = () => [' \u2191\u2193 choose model \u00b7 Tab reasoning \u00b7 Enter select \u00b7 Esc cancel', `  ${rows[modelIndex].label} \u2022 Reasoning`, '  \u2191\u2193 choose \u00b7 Enter save \u00b7 Esc back',
      ...efforts.map((value, index) => `  ${index === selected ? '\u203a' : ' '} ${value}${value === rows[modelIndex].effort ? ' (default)' : ''}`)].join('\n');
    const screen = () => mode === 'model' ? picker() : mode === 'reasoning' ? reasoning() : composer();
    const io: ChatControlIO = {
      screen,
      output: () => '',
      write: async data => {
        if (data === '\r') {
          const submitted = command.trim();
          command = '';
          if (mode === 'composer') {
            if (submitted === '/reasoning') { mode = 'reasoning'; selected = Math.max(0, efforts.indexOf(effort)); }
            else { mode = 'model'; selected = modelIndex; }
          }
          else if (mode === 'model') { modelIndex = selected; effort = rows[selected].effort; mode = 'composer'; }
          else { effort = efforts[selected]; mode = 'composer'; }
          return;
        }
        if (data === '\x1b[B') selected = Math.min(rows.length - 1, selected + 1);
        else if (data === '\x1b[A') selected = Math.max(0, selected - 1);
        else if (data !== '\x1b') { typed += data; command += data; }
      },
      waitFor: async predicate => {
        for (let attempt = 0; attempt < 100; attempt++) { const value = screen(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
        throw Error('Freebuff picker did not reach the requested state');
      },
    };
    const options = await new ProviderChatControls().read('freebuff', {}, composer(), directory);
    const changed = await new ProviderChatControls().apply(options, { key: 'model', value: 'openai/gpt-6-luna' }, io);
    assert.equal(changed.current.model, 'openai/gpt-6-luna');
    assert.equal(changed.current.effort, 'high');
    assert.match(typed, /\/model/);
    const effortChanged = await new ProviderChatControls().apply({ ...changed, current: { ...changed.current, model: 'openai/gpt-6-luna' } }, { key: 'effort', value: 'low' }, io);
    assert.equal(effortChanged.current.effort, 'low');
    assert.match(typed, /\/reasoning/);
  } finally {
    if (previous === undefined) delete process.env.FREEBUFF_CONFIG_DIR; else process.env.FREEBUFF_CONFIG_DIR = previous;
    fsNative.rmSync(directory, { recursive: true, force: true });
  }
});

