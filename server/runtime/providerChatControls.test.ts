import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderChatControls } from './providerChatControls.js';
import type { AgentChatOptions } from '../../shared/contracts.js';
import type { ChatControlIO } from './chatControlTypes.js';
import { AntigravityChatControls } from './antigravityChatControls.js';
import { WorkflowModels } from './workflowModels.js';

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
