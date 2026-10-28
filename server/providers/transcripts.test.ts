import { test } from 'node:test';

import assert from 'node:assert/strict';

import fs from 'node:fs';

import os from 'node:os';

import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { publicTranscriptRecord, transcriptSettings } from './shared.js';

import { readOpenCodePage, readOpenCodeModel } from './opencode.js';
import {readOpenCodeV2Page} from './openCodeV2.js';



import { readAntigravityToolActivity } from './antigravity.js';

import { transcriptToolActivity, databaseToolActivity, toolLabel, toolActivityFromCall, toolEditPreview } from './toolActivity.js';
import { publicMessage } from '../runtime/conversation.js';
import type { SessionRecord } from '../runtime/store.js';

test('recorded const patch arguments expose bounded edits across tool wrappers without evaluating code', () => {
  const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-before\n+after\n*** End Patch';
  const code = `const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`;
  for (const input of [code, {code}]) {
    const item = toolActivityFromCall('s','call','exec',input,null)!;
    assert.equal(item.label,'Edit: a.ts');
    assert.deepEqual(item.edits?.[0].lines,[{kind:'remove',text:'before'},{kind:'add',text:'after'}]);
  }
  assert.deepEqual(toolEditPreview({code:'const patch = readSecret(); await tools.apply_patch(patch);'}),[]);
  assert.deepEqual(toolEditPreview({code:`const patch = ${JSON.stringify(patch)}; patch = unknown; await tools.apply_patch(patch);`}),[]);
});

test('workflow workers expose assignment task data while keeping private protocol instructions out of public chat', () => {
  const assignment = '[Vade workflow assignment; protocol 1.0.0]\nYou are worker node backend: Backend.\nPRIVATE_RUNTIME_INSTRUCTIONS\nRole:\nBuild the API\nTask:\nImplement accounts\nOriginal user request:\nCreate a webapp\nPredecessor results (full results via context):\n[]\nReport through the private CLI.';
  for (const provider of ['codex','claude','codebuddy'] as const) {
    const record = {provider,providerThreadId:'s'} as SessionRecord;
    const row = provider==='codex' ? {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:assignment}]}}
      : provider==='claude' ? {type:'user',sessionId:'s',message:{role:'user',content:[{type:'text',text:assignment}]}}
      : {type:'message',role:'user',sessionId:'s',content:[{type:'text',text:assignment}]};
    const text = publicMessage(record,JSON.stringify(row),'s')?.text;
    assert.equal(text,'Workflow assignment\n\nRole:\nBuild the API\n\nTask:\nImplement accounts\n\nOriginal user request:\nCreate a webapp');
    assert.ok(!text.includes('PRIVATE_RUNTIME_INSTRUCTIONS')); assert.ok(!text.includes('private CLI'));
  }
});

test('edit previews normalize provider argument formats and stay bounded', () => {
  for (const [name, input] of [
    ['Edit', { file_path: 'a.ts', old_string: 'before', new_string: 'after' }],
    ['edit', { path: 'a.ts', oldText: 'before', newText: 'after' }],
    ['edit', { filePath: 'a.ts', oldString: 'before', newString: 'after' }],
    ['replace_file_content', { TargetFile: 'a.ts', StartLine: 12, TargetContent: 'before', ReplacementContent: 'after' }],
  ] as const) {
    const item = toolActivityFromCall('session', 'edit', name, input, null)!;
    assert.deepEqual(item.edits?.[0].lines, [{ kind: 'remove', text: 'before' }, { kind: 'add', text: 'after' }]);
  }
  const patch = '*** Begin Patch\n*** Update File: a.ts\n@@ function main\n-before\n+after\n*** End Patch';
  for (const input of [patch, { patchText: patch }, { code: `await tools.apply_patch(${JSON.stringify(patch)});` }]) {
    const preview = toolEditPreview(input)[0];
    assert.equal(preview.path, 'a.ts');
    assert.equal(preview.location, '@@ function main');
    assert.equal(preview.lines[1].text, 'after');
  }
  const large = toolEditPreview({ filePath: 'a.ts', oldString: 'a'.repeat(40000), newString: Array(100).fill('b').join('\n') })[0];
  assert.equal(large.truncated, true);
  assert.ok(large.lines.length <= 16 && large.lines.every((line) => line.text.length <= 200));
  assert.deepEqual(toolEditPreview({ file_path: 'a.ts' }), []);
  const kilo = toolActivityFromCall('kilo', 'edit', 'apply_diff', { path: 'a.ts', diff: '<<<<<<< SEARCH\n:start_line:8\n-------\nbefore\n=======\nafter\n>>>>>>> REPLACE' }, null)!;
  assert.equal(kilo.edits?.[0].location, 'Line 8');
  assert.deepEqual(kilo.edits?.[0].lines, [{ kind: 'remove', text: 'before' }, { kind: 'add', text: 'after' }]);
  assert.equal(toolActivityFromCall('session', 'read', 'Read', { file_path: 'a.ts', content: 'read contents' }, null)?.edits, undefined);
});

test('tool metadata adapters cover Claude, Codex, Pi, OMP and omit output and thinking', () => {
  for (const provider of ['claude', 'pi', 'omp']) {
    const record = { timestamp: '2026-10-18T01:00:00Z', message: { role: 'assistant', content: [
      { type: provider === 'claude' ? 'tool_use' : 'toolCall', id: 'call-1', name: 'Read', input: { file_path: 'index.html' } },
      { type: 'thinking', thinking: 'private' }, { type: 'tool_result', content: 'private output' },
    ] } };
    const items = transcriptToolActivity(provider, 'session', JSON.stringify(record));
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Read: index.html');
    assert.equal(transcriptToolActivity(provider, 'other', JSON.stringify(record))[0].id === items[0].id, false);
    assert.deepEqual(transcriptToolActivity(provider, 'session', JSON.stringify({ ...record, sessionId: 'other' })), []);
    assert.equal(JSON.stringify(items).includes('private'), false);
  }
  const call = { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }) } };
  assert.equal(transcriptToolActivity('codex', 's', JSON.stringify(call))[0].label, 'Run: npm test');
  assert.deepEqual(transcriptToolActivity('codex', 's', JSON.stringify({ ...call, payload: { ...call.payload, type: 'function_call_output' } })), []);
  assert.equal(toolLabel('apply_patch', '*** Begin Patch\n*** Update File: server.ts\nsecret diff'), 'Edit: server.ts');
  assert.equal(toolLabel('exec', 'text(await tools.exec_command({cmd:"npm test",max_output_tokens:200}));'), 'Run: npm test');
  assert.equal(toolLabel('exec', { code: 'text(await tools.exec_command({"cmd":"git status --short"}));' }), 'Run: git status --short');
  assert.equal(toolLabel('exec', "text(await tools.exec_command({cmd:'npm run build'}));"), 'Run: npm run build');
  const longCommand = 'echo ' + 'x'.repeat(400);
  const longCall = transcriptToolActivity('codex', 's', JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call', call_id: 'long', name: 'exec_command', arguments: JSON.stringify({ cmd: longCommand }),
  } }))[0];
  assert.equal(longCall.detail, `Run: ${longCommand}`);
  assert.ok(longCall.label.length < longCall.detail!.length);
  assert.equal(toolLabel('exec', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: server.ts\\nsecret diff"));'), 'Edit: server.ts');
  assert.equal(toolLabel('Edit', { file_path: 'server.ts', old_string: 'secret', new_string: 'private' }), 'Edit: server.ts');
});

test('OpenCode and Kilo tool parts expose bounded exact-session metadata without results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-tool-parts-'));
  const file = path.join(dir, 'tools.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE part(id TEXT, session_id TEXT, data TEXT)');
    for (const session of ['exact', 'other']) db.prepare('INSERT INTO part VALUES(?,?,?)').run('p1', session,
      JSON.stringify({ type: 'tool', callID: 'c1', tool: 'edit', state: { input: { filePath: 'server.ts' }, output: 'private result', time: { start: 1000 } } }));
    const items = databaseToolActivity(file, 'exact');
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Edit: server.ts');
    assert.equal(JSON.stringify(items).includes('private'), false);
    assert.deepEqual(databaseToolActivity(file, 'missing'), []);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude, Pi and OMP expose public text and omit tools, thinking and injected turns', () => {
  for (const provider of ['claude', 'pi', 'omp']) {
    const type = provider === 'claude' ? 'assistant' : 'message';
    const record = { type, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'private' }, { type: 'tool_use', input: 'private' }, { type: 'text', text: 'Public reply' },
    ] } };
    assert.deepEqual(publicTranscriptRecord(JSON.stringify(record), provider).payload.content, [{ type: 'text', text: 'Public reply' }]);
    assert.equal(publicTranscriptRecord(JSON.stringify({ type, message: { role: 'toolResult', content: 'tool secret' } }), provider), null);
    assert.equal(publicTranscriptRecord(JSON.stringify({ type: provider === 'claude' ? 'user' : 'message', isMeta: true,
      message: { role: 'user', content: 'injected' } }), provider), null);
  }
});

test('Codex interruption bookkeeping is omitted without hiding ordinary turn-aborted text', () => {
  const claudeNotice=(text:string)=>JSON.stringify({type:'user',sessionId:'session',message:{role:'user',content:[{type:'text',text}]}});
  assert.equal(publicMessage({provider:'claude',providerThreadId:'session'} as SessionRecord,claudeNotice('[Request interrupted by user]'),'source'),null);
  assert.equal(publicMessage({provider:'claude',providerThreadId:'session'} as SessionRecord,claudeNotice('Please explain [Request interrupted by user]'),'source')?.text,'Please explain [Request interrupted by user]');
  const interrupted = '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>';
  assert.equal(publicMessage({ provider: 'codex', providerThreadId: 'session' } as SessionRecord,
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'interrupt', content: [{ type: 'input_text', text: interrupted }] } }), 'session'), null);
  for (const ordinary of [
    'Please explain what <turn_aborted> means.',
    '<turn_aborted> is a marker in the transcript.',
    '<turn_aborted>\nThis is my own note.\n</turn_aborted>',
  ]) {
    assert.equal(publicMessage({ provider: 'codex', providerThreadId: 'session' } as SessionRecord,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'ordinary', content: [{ type: 'input_text', text: ordinary }] } }), 'session')?.text, ordinary);
  }
  assert.equal(publicMessage({ provider: 'claude', providerThreadId: 'session' } as SessionRecord,
    JSON.stringify({ type: 'user', sessionId: 'session', message: { role: 'user', content: [{ type: 'text', text: interrupted }] } }), 'session')?.text, interrupted);
});

test('effective transcript settings include Claude effort and Pi/OMP changes but exclude synthetic errors', () => {
  assert.deepEqual(transcriptSettings({ message: { role: 'assistant', model: 'claude-opus-5-5' }, effort: 'medium' }),
    { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(transcriptSettings({ message: { role: 'assistant', model: '<synthetic>' }, isApiErrorMessage: true }), {});
  assert.deepEqual(transcriptSettings({ type: 'thinking_level_change', thinkingLevel: 'high' }), { effort: 'high' });
  assert.deepEqual(transcriptSettings({ type: 'model_change', modelId: 'new-model' }), { model: 'new-model' });
  for (const text of ['<command-name>/model</command-name>', '<local-command-stdout>Set model</local-command-stdout>']) {
    assert.equal(publicTranscriptRecord(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }), 'claude'), null);
  }
});

test('OpenCode reads exact session model, effort and public parts; cursors check for newer messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-opencode-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(message_id TEXT,session_id TEXT,data TEXT);');
    const insert = (id: string, session: string, text: string) => {
      db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(id, session, Date.now(), JSON.stringify({ role: 'assistant', modelID: 'model-used', variant: 'high' }));
      for (const part of [{ type: 'text', text }, { type: 'reasoning', text: 'private' }, { type: 'text', synthetic: true, text: 'injected' }]) {
        db.prepare('INSERT INTO part VALUES(?,?,?)').run(id, session, JSON.stringify(part));
      }
    };
    insert('1', 'exact', 'first'); insert('2', 'other', 'wrong session'); insert('3', 'exact', 'latest');
    assert.deepEqual(readOpenCodeModel(file, 'exact'), { model: 'model-used', effort: 'high' });
    const first = readOpenCodePage(file, 'exact', null, 1);
    assert.equal(JSON.parse(first.lines[0]).payload.content[0].text, 'latest');
    assert.equal(first.hasMore, false);
    assert.equal(first.limited, true);
    insert('4', 'exact', 'new arrival');
    const next = readOpenCodePage(file, 'exact', first.nextByteOffset, 20);
    assert.equal(next.lines.length, 1);
    assert.deepEqual(JSON.parse(next.lines[0]).payload.content, [{ type: 'text', text: 'new arrival' }]);
    assert.equal(readOpenCodePage(file, 'missing', null, 20).lines.length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode older pages walk full exact-session history 20 turns at a time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-opencode-older-'));
  const file = path.join(dir, 'history.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(message_id TEXT,session_id TEXT,data TEXT);');
    for (let index = 1; index <= 45; index++) {
      db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(String(index), 'exact', index, JSON.stringify({ role: 'assistant' }));
      db.prepare('INSERT INTO part VALUES(?,?,?)').run(String(index), 'exact', JSON.stringify({ type: 'text', text: `Turn ${index}` }));
    }
    let offset: number | null = null;
    let all: string[] = [];
    for (let index = 0; index < 3; index++) {
      const page = readOpenCodePage(file, 'exact', offset, 20, 'older');
      assert.equal(page.lines.length, index === 2 ? 5 : 20);
      all = [...page.lines.map(line => JSON.parse(line).payload.content[0].text), ...all];
      offset = page.nextByteOffset;
      assert.equal(page.hasMore, index < 2);
    }
    assert.deepEqual(all, Array.from({ length: 45 }, (_, index) => `Turn ${index + 1}`));
    assert.equal(readOpenCodePage(file, 'unrelated', null, 20, 'older').lines.length, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode scan directions skip private parts and enforce the same part limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-opencode-scan-'));
  const file = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(message_id TEXT,session_id TEXT,data TEXT);');
    const message = db.prepare('INSERT INTO message VALUES(?,?,?,?)');
    const part = db.prepare('INSERT INTO part VALUES(?,?,?)');
    for (let i = 1; i <= 60; i++) {
      message.run(String(i), 'exact', i, JSON.stringify({ role: 'assistant' }));
      part.run(String(i), 'exact', JSON.stringify({ type: i === 30 ? 'text' : 'reasoning', text: String(i) }));
    }
    for (const offset of [null, 0]) {
      const page = readOpenCodePage(file, 'exact', offset, 2);
      assert.deepEqual(page.lines.map((line) => JSON.parse(line).payload.content), [[{ type: 'text', text: '30' }]]);
      assert.equal(page.nextByteOffset, 60);
      assert.equal(page.totalScanned, 60);
    }
    for (let i = 0; i < 1000; i++) part.run('30', 'exact', JSON.stringify({ type: 'text', text: 'extra' }));
    for (const offset of [null, 0]) {
      assert.throws(() => readOpenCodePage(file, 'exact', offset, 2), /exceeds part limit/);
    }
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Antigravity reads exact-session protobuf tool metadata without output or reasoning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-ag-tools-'));
  const previous = process.env.ANTIGRAVITY_APPDATA_DIR;
  const previousGemini = process.env.GEMINI_APPDATA_DIR;
  delete process.env.GEMINI_APPDATA_DIR;
  process.env.ANTIGRAVITY_APPDATA_DIR = dir;
  const id = 'exact-ag-session';
  fs.mkdirSync(path.join(dir, 'conversations'));
  const db = new DatabaseSync(path.join(dir, 'conversations', `${id}.db`));
  const varint = (value: number) => {
    const bytes: number[] = [];
    do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
    return Buffer.from(bytes);
  };
  const field = (number: number, value: string | Buffer | number): Buffer => {
    if (typeof value === 'number') return Buffer.concat([varint(number * 8), varint(value)]);
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  };
  const call = (name: string, args: object, callId: string) => Buffer.concat([
    field(1, callId), field(2, name), field(3, JSON.stringify(args)), field(6, 'private signature'),
  ]);
  try {
    db.exec('CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB,step_payload BLOB)');
    db.prepare('INSERT INTO trajectory_meta VALUES(?)').run(id);
    const insert = db.prepare('INSERT INTO steps VALUES(?,?,?)');
    const timestamp = field(1, field(1, 1792330000));
    insert.run(1, Buffer.concat([timestamp, field(4, call('run_command', { CommandLine: 'npm test' }, 'run-1'))]), Buffer.from('private command output'));
    insert.run(2, Buffer.concat([timestamp, field(4, call('view_file', { AbsolutePath: 'src/main.ts' }, 'read-1'))]), Buffer.from('private file contents'));
    insert.run(3, Buffer.concat([timestamp, field(4, call('replace_file_content', { TargetFile: 'old.ts' }, 'edit-1')),
      field(29, call('replace_file_content', { TargetFile: 'new.ts', TargetContent: 'old code', ReplacementContent: 'new code' }, 'edit-1'))]), Buffer.from('private diff'));
    insert.run(4, Buffer.from([255]), Buffer.from('malformed'));
    insert.run(5, Buffer.alloc(524289), Buffer.from('oversized'));
    insert.run(6, Buffer.concat([timestamp, field(7, 'private planner thinking')]), Buffer.from('private assistant turn'));
    const allowed = (file: string) => file.startsWith(dir + path.sep);
    const items = readAntigravityToolActivity(id, allowed);
    assert.deepEqual(items.map((item) => item.label), ['Run: npm test', 'Read: src/main.ts', 'Edit: new.ts']);
    assert.equal(items.every((item) => item.at === new Date(1792330000 * 1000).toISOString()), true);
    assert.equal(JSON.stringify(items).includes('private'), false);
    assert.deepEqual(items[2].edits?.[0].lines, [{ kind: 'remove', text: 'old code' }, { kind: 'add', text: 'new code' }]);
    assert.deepEqual(readAntigravityToolActivity(id, allowed).map((item) => item.id), items.map((item) => item.id));
    assert.throws(() => readAntigravityToolActivity('../escape', allowed), /identity/);
    assert.throws(() => readAntigravityToolActivity(id, () => false), /outside allowed/);
    db.prepare('UPDATE trajectory_meta SET cascade_id = ?').run('different-conversation');
    assert.throws(() => readAntigravityToolActivity(id, allowed), /identity changed/);
    db.prepare('UPDATE trajectory_meta SET cascade_id = ?').run(id);
    const large = Buffer.alloc(524288);
    for (let index = 10; index < 27; index++) insert.run(index, large, null);
    assert.throws(() => readAntigravityToolActivity(id, allowed), /byte limit/);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.ANTIGRAVITY_APPDATA_DIR; else process.env.ANTIGRAVITY_APPDATA_DIR = previous;
    if (previousGemini === undefined) delete process.env.GEMINI_APPDATA_DIR; else process.env.GEMINI_APPDATA_DIR = previousGemini;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import { databaseProviderActivity, transcriptProviderActivity } from './providerActivity.js';

import { claudeLocalCommandEffort } from './shared.js';

test('Claude manual effort acknowledgements refresh metadata while ordinary prose does not', () => {
  const record = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  assert.equal(claudeLocalCommandEffort(record('<local-command-stdout>Set effort level to low (this session only)</local-command-stdout>')), 'low');
  assert.equal(claudeLocalCommandEffort(record('<local-command-stdout>Effort level set to auto</local-command-stdout>')), 'auto');
  const native={type:'system',subtype:'local_command',commandRun:{command:'effort',args:'low'},content:'<local-command-stdout>Set effort level to `low` (saved as your default for new sessions): Quick implementation</local-command-stdout>'};
  assert.equal(claudeLocalCommandEffort(native),'low');
  assert.equal(claudeLocalCommandEffort({...native,isSidechain:true}),undefined);
  assert.equal(claudeLocalCommandEffort({...native,commandRun:{command:'model'}}),undefined);
  assert.equal(claudeLocalCommandEffort(record('Set effort level to low')), undefined);
  assert.equal(claudeLocalCommandEffort({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '<local-command-stdout>Set effort level to low</local-command-stdout>' }] } }), undefined);
});

test('provider activity exposes errors and reasoning presence without private reasoning text', () => {
  for (const provider of ['codex', 'claude', 'codebuddy']) {
    const record = provider === 'codex' ? { type: 'response_item', payload: { type: 'reasoning', id: 'reason', summary: [{ text: 'PRIVATE THOUGHT' }] } }
      : provider === 'claude' ? { type: 'assistant', uuid: 'reason', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE THOUGHT' }] } }
        : { type: 'reasoning', id: 'reason', content: [{ text: 'PRIVATE THOUGHT' }] };
    const result = transcriptProviderActivity(provider, 'exact', [JSON.stringify({ ...record, sessionId: 'foreign' }), JSON.stringify({ ...record, sessionId: 'exact' })]);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'reasoning');
    assert.equal(result[0].state, 'recorded');
    assert.ok(!JSON.stringify(result).includes('PRIVATE THOUGHT'));
  }
  const errors = transcriptProviderActivity('claude', 'exact', [JSON.stringify({ sessionId: 'exact', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Bad Request: model unavailable' }] } })]);
  assert.equal(errors[0].kind, 'error');
  assert.match(errors[0].message!, /Bad Request/);
  const cleared = transcriptProviderActivity('claude', 'exact', [JSON.stringify({ isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Bad Request' }] } }), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'A successful reply' }] } })]);
  assert.equal(cleared.length, 0);
});

test('OpenCode and Kilo errors survive empty assistant messages; reasoning requires an unfinished latest part', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-provider-events-'));
  const file = path.join(dir, 'events.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT)');
    const message = db.prepare('INSERT INTO message VALUES (?,?,?,?)'), part = db.prepare('INSERT INTO part VALUES (?,?,?,?)');
    message.run('foreign', 'other', 1, JSON.stringify({ error: { data: { message: 'FOREIGN ERROR' } } }));
    message.run('failed', 'exact', 2, JSON.stringify({ role: 'assistant', error: { name: 'APIError', data: { message: 'Bad Request: model unavailable' } } }));
    message.run('reason', 'exact', 3, JSON.stringify({ role: 'assistant' }));
    part.run('p', 'exact', 'reason', JSON.stringify({ type: 'reasoning', text: 'PRIVATE THOUGHT', time: { start: 3 } }));
    const result = databaseProviderActivity(file, 'exact');
    assert.equal(result.length, 2); assert.match(result[0].message!, /Bad Request/); assert.equal(result[1].state, 'active');
    assert.ok(!JSON.stringify(result).includes('PRIVATE THOUGHT')); assert.ok(!JSON.stringify(result).includes('FOREIGN'));
    part.run('tool', 'exact', 'reason', JSON.stringify({ type: 'tool' }));
    assert.equal(databaseProviderActivity(file, 'exact')[1].state, 'recorded');
    message.run('success', 'exact', 4, JSON.stringify({ role: 'assistant', time: { completed: 5 } }));
    part.run('reply', 'exact', 'success', JSON.stringify({ type: 'text', text: 'A successful reply' }));
    assert.ok(databaseProviderActivity(file, 'exact').every(item => item.kind !== 'error'));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode v2 activity reads native errors and inline reasoning separately from conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-v2-events-')), file = path.join(dir, 'events.db');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
    const insert = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)');
    insert.run('compact', 'exact', 0, 'compaction', 0, JSON.stringify({status:'completed',summary:'PRIVATE COMPACTION SUMMARY'}));
    insert.run('failed', 'exact', -1, 'compaction', 0, JSON.stringify({status:'failed',summary:'PRIVATE FAILURE'}));
    const compact=readOpenCodeV2Page(file,'exact',null,20);
    assert.equal(compact.lines.length,1);assert.equal(publicMessage({provider:'opencode2'} as SessionRecord,compact.lines[0],'source')?.kind,'compaction');
    assert.doesNotMatch(compact.lines[0],/PRIVATE/);
    insert.run('err', 'exact', 1, 'assistant', 1, JSON.stringify({ error: { data: { message: 'Bad Request v2' } } }));
    insert.run('reason', 'exact', 2, 'assistant', 2, JSON.stringify({ content: [{ type: 'reasoning', text: 'PRIVATE THOUGHT', time: { start: 2, end: 3 } }] }));
    const result = databaseProviderActivity(file, 'exact', true);
    assert.match(result[0].message!, /Bad Request v2/); assert.equal(result[1].state, 'recorded');
    assert.ok(!JSON.stringify(result).includes('PRIVATE THOUGHT'));
    insert.run('success', 'exact', 3, 'assistant', 3, JSON.stringify({ content: [{ type: 'text', text: 'A successful reply' }] }));
    assert.ok(databaseProviderActivity(file, 'exact', true).every(item => item.kind !== 'error'));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
