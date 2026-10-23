import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderChatControls } from './providerChatControls.js';
import type { AgentChatOptions } from '../../shared/contracts.js';
import type { ChatControlIO } from './chatControlTypes.js';
import { AntigravityChatControls } from './antigravityChatControls.js';
import { WorkflowModels } from './workflowModels.js';
import { OpenCodeChatControls } from './openCodeChatControls.js';
import { TerminalScreen } from './terminalScreen.js';
import { codeBuddyRecordedSettings } from './conversation.js';
import type { SessionRecord } from './store.js';
import { AdeSessions } from './sessions.js';

test('CodeBuddy sends from an empty native prompt with unknown lifecycle status and refuses waiting or drafts', async () => {
  const terminal = new TerminalScreen(() => {}, () => {});
  const sessions = Object.create(AdeSessions.prototype) as any;
  const record = { provider: 'codebuddy' };
  const live = { live: true, screen: terminal, inputRevision: 0 };
  let state = 'unknown'; const writes: string[] = [];
  Object.assign(sessions, { live: new Map([['node', live]]), sending: new Set(), store: { directory: process.cwd() }, require: () => record,
    status: () => ({ meta: { availability: state === 'unknown' ? 'unavailable' : 'ready' }, data: { state } }), command: async (_: unknown, message: { data: string }) => { writes.push(message.data); } });
  try {
    terminal.write('\x1b[2J\x1b[H> \x1b[999m\r\n? for shortcuts'); await terminal.settled();
    await sessions.send('project', 'node', { message: 'hello' });
    assert.deepEqual(writes, ['\x1b[200~hello\x1b[201~', '\r']);
    writes.length = 0; state = 'waiting';
    await assert.rejects(sessions.send('project', 'node', { message: 'hello' }), /needs input/);
    assert.deepEqual(writes, []);
    state = 'unknown'; terminal.write('\x1b[1;1H\x1b[2K> \x1b[999mtyped draft\r\n? for shortcuts'); await terminal.settled();
    await assert.rejects(sessions.send('project', 'node', { message: 'hello' }), /not ready/);
    assert.deepEqual(writes, []);
  } finally { terminal.dispose(); }
});

test('CodeBuddy command evidence restores model and effort across view and runtime remounts', () => {
  const record = { providerThreadId: 'exact-session', cwd: process.cwd() } as SessionRecord;
  const row = (output: string, sessionId = record.providerThreadId) => JSON.stringify({ type: 'message', role: 'user', sessionId, cwd: record.cwd, providerData: { skipRun: true, model: 'hy3' }, content: [{ type: 'input_text', text: `<local-command-stdout>${output}</local-command-stdout>` }] });
  const lines = [row('Available models:\n - Hy3 (hy3) ← current\n - Deepseek-V4.1-Flash (deepseek-v4.1-flash)\nTo switch model: /model'), row('Switched model to Deepseek-V4.1-Flash.'), row('Model reasoning effort set to high.'), row('Switched model to Hy3.', 'foreign-session')];
  assert.deepEqual(codeBuddyRecordedSettings(lines, record), { model: 'deepseek-v4.1-flash', effort: 'high' });
  assert.equal(codeBuddyRecordedSettings([...lines, row('Model reasoning effort set to medium.')], record).effort, 'medium');
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
