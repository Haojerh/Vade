import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publicTranscriptRecord, transcriptSettings } from './shared.js';
import { readOpenCodePage, readOpenCodeModel, findOpenCodeSession, findExactOpenCodePaneSession } from './opencode.js';
import { findClaudeTranscript } from './claude.js';
import { findCodexTranscript } from './codex.js';
import { resolveAntigravityConversation, readAntigravityToolActivity } from './antigravity.js';
import { collectToolActivity } from '../integrations/orca/liveActivity.js';
import { enrichAgentModelsAndEffort } from '../integrations/orca/graphWorkers.js';
import { resolveCoordinatorConversation } from '../integrations/orca/nodeDetails.js';
import { globalSourceMaps } from '../integrations/orca/state.js';
import { transcriptToolActivity, databaseToolActivity, toolLabel } from './toolActivity.js';

test('hookless Kilo tool activity uses a unique exact terminal title and directory even when model is already known', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-kilo-pane-'));
  const file = path.join(dir, 'kilo.db');
  const previousDb = process.env.KILO_DB, previousApp = process.env.ORCA_APPDATA_DIR;
  process.env.KILO_DB = file;
  process.env.ORCA_APPDATA_DIR = dir;
  const db = new DatabaseSync(file);
  const node = { id: 'kilo-exact-pane', kind: 'agent', agentType: 'kilo', label: 'Custom display name', path: dir, worktreeId: 'wt', model: 'observed-model' } as any;
  try {
    db.exec('CREATE TABLE session(id TEXT,title TEXT,directory TEXT); CREATE TABLE part(id TEXT,session_id TEXT,data TEXT)');
    const insert = db.prepare('INSERT INTO session VALUES(?,?,?)');
    insert.run('ses_exact', 'Testing tools', dir);
    insert.run('ses_similar', 'Testing tools extended', dir);
    insert.run('ses_elsewhere', 'Testing tools', dir + '-elsewhere');
    db.prepare('INSERT INTO part VALUES(?,?,?)').run('p1', 'ses_exact', JSON.stringify({ type: 'tool', callID: 'call-1', tool: 'bash', state: { input: { command: 'npm test' }, time: { start: Date.now() } } }));
    const allowed = (candidate: string) => candidate === file;
    assert.equal(findExactOpenCodePaneSession('kilo', 'Kilo CLI | Testing tools', dir, allowed)?.sessionId, 'ses_exact');
    assert.equal(findExactOpenCodePaneSession('kilocode', 'Kilo Code | Testing tools', dir, allowed)?.sessionId, 'ses_exact');
    assert.equal(findExactOpenCodePaneSession('kilo', 'Testing tools', dir, allowed), null);
    assert.equal(findExactOpenCodePaneSession('kilo', 'Kilo CLI | Testing', dir, allowed), null);
    assert.equal(findExactOpenCodePaneSession('kilo', 'Kilo CLI | Testing tools...', dir, allowed), null);
    assert.equal(findExactOpenCodePaneSession('kilo', 'Kilo CLI | Testing tools', dir + '-wrong', allowed), null);
    assert.equal(findExactOpenCodePaneSession('kilo', 'Kilo CLI | Testing tools', dir, () => false), null);
    globalSourceMaps.nodeSourceMap.set(node.id, { handle: 'term-kilo', paneKey: 'pane-kilo', terminalTitle: 'Kilo CLI | Testing tools' });
    await enrichAgentModelsAndEffort([node]);
    assert.equal(node.model, 'observed-model');
    assert.equal(node.toolActivity.meta.availability, 'ready');
    assert.deepEqual(node.toolActivity.data.map((item: any) => item.label), ['Run: npm test']);
    await collectToolActivity(node, { source: 'kilocode', worktreeId: 'wt', providerSession: { key: 'session_id', id: 'ses_exact' } }, allowed);
    assert.equal(node.toolActivity.meta.availability, 'ready');
    insert.run('ses_duplicate', 'Testing tools', dir);
    assert.equal(findExactOpenCodePaneSession('kilo', 'Kilo CLI | Testing tools', dir, allowed), null);
    await collectToolActivity(node, null, allowed);
    assert.equal(node.toolActivity.meta.availability, 'unavailable');
  } finally {
    db.close(); globalSourceMaps.nodeSourceMap.delete(node.id);
    if (previousDb === undefined) delete process.env.KILO_DB; else process.env.KILO_DB = previousDb;
    if (previousApp === undefined) delete process.env.ORCA_APPDATA_DIR; else process.env.ORCA_APPDATA_DIR = previousApp;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('standalone Claude/Pi/OMP resolve exact pane transcripts and reject a changed session cursor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-provider-binding-'));
  const previous = process.env.ORCA_APPDATA_DIR;
  process.env.ORCA_APPDATA_DIR = dir;
  const hookDir = path.join(dir, 'orca', 'agent-hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  try {
    for (const provider of ['claude', 'pi', 'omp']) {
      const file = path.join(dir, provider + '.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: provider === 'claude' ? 'assistant' : 'message',
        uuid: 'public-reply', timestamp: '2026-10-16T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Public reply' }] } }) + '\n');
      const entry = { source: provider, worktreeId: 'exact-worktree', providerSession: { id: 'session-1', transcriptPath: file } };
      const write = () => fs.writeFileSync(path.join(hookDir, 'last-status.json'), JSON.stringify({ entries: { 'exact-pane': entry } }));
      write();
      const node = { id: 'exact-node', agentType: provider, worktreeId: 'exact-worktree', runId: null } as any;
      globalSourceMaps.nodeSourceMap.set(node.id, { paneKey: 'exact-pane' });
      const result = await resolveCoordinatorConversation('project', node, null, undefined, true);
      assert.equal(result.meta.availability, 'ready');
      assert.equal(result.data?.messages[0].text, 'Public reply');
      entry.providerSession.id = 'session-2'; write();
      await assert.rejects(() => resolveCoordinatorConversation('project', node, null, { cursor: result.data!.nextCursor }, true), /cross-bound/);
      entry.source = 'codex'; write();
      assert.equal((await resolveCoordinatorConversation('project', node, null, undefined, true)).meta.availability, 'unsupported');
    }
  } finally {
    globalSourceMaps.nodeSourceMap.delete('exact-node');
    if (previous === undefined) delete process.env.ORCA_APPDATA_DIR; else process.env.ORCA_APPDATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
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

test('Codex rollout traversal preserves dated directory priority and ignores unrelated years', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-codex-order-'));
  const previous = process.env.CODEX_HOME;
  const id = '11111111-2222-3333-4444-555555555555';
  try {
    process.env.CODEX_HOME = dir;
    for (const date of ['2025/12/31', '2026/01/01', '2026/10/17', '2026/10/18', 'archive/12/31']) {
      const folder = path.join(dir, 'sessions', date);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `rollout-${id}.jsonl`), '');
    }
    const newest = path.join(dir, 'sessions', '2026', '10', '18', `rollout-${id}.jsonl`);
    assert.equal(findCodexTranscript(id), newest);
    fs.writeFileSync(path.join(dir, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Exact thread' }));
    assert.equal(findCodexTranscript('Exact thread'), newest);
    assert.equal(findCodexTranscript('missing thread'), null);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findOpenCodeSession locates resumed sessions by title and rejects generic label', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-opencode-find-'));
  const oldDb = process.env.OPENCODE_DB;
  const oldKilo = process.env.KILO_DB;
  const oldOrcaApp = process.env.ORCA_APPDATA_DIR;
  const file = path.join(dir, 'opencode.db');
  const kiloFile = path.join(dir, 'kilo.db');
  process.env.OPENCODE_DB = file;
  process.env.KILO_DB = kiloFile;
  process.env.ORCA_APPDATA_DIR = dir;
  const db = new DatabaseSync(file);
  const kdb = new DatabaseSync(kiloFile);
  try {
    db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT);');
    db.prepare('INSERT INTO session VALUES(?, ?, ?, ?)').run('ses_123', 'Draft Report Implementation', null, null);
    
    // Matched by clean title or OC prefix
    const found1 = findOpenCodeSession('opencode', 'OC | Draft Report Implementation');
    assert.deepEqual(found1, { dbPath: file, sessionId: 'ses_123' });

    const found2 = findOpenCodeSession('opencode', 'Draft Report Implementation...');
    assert.deepEqual(found2, { dbPath: file, sessionId: 'ses_123' });

    // Generic label must return null
    assert.equal(findOpenCodeSession('opencode', 'opencode'), null);
    assert.equal(findOpenCodeSession('opencode', 'Agent'), null);

    // Kilo sessions with Kilo CLI / Kilo Code / KC prefixes
    kdb.exec('CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT);');
    kdb.prepare('INSERT INTO session VALUES(?, ?, ?, ?)').run('ses_kilo_1', 'Greeting', 'C:/work/repo', JSON.stringify({ id: 'nvidia/nemotron-3.5-super-vl:free', providerID: 'kilo' }));
    kdb.prepare('INSERT INTO session VALUES(?, ?, ?, ?)').run('ses_kilo_2', 'Light chat', 'C:/work/repo', JSON.stringify({ id: 'nvidia/nemotron-3.5-super-vl:free', providerID: 'kilo' }));

    const foundKilo1 = findOpenCodeSession('kilo', 'Kilo CLI | Greeting');
    assert.deepEqual(foundKilo1, { dbPath: kiloFile, sessionId: 'ses_kilo_1' });

    const foundKilo2 = findOpenCodeSession('kilo', 'Kilo Code | Greeting');
    assert.deepEqual(foundKilo2, { dbPath: kiloFile, sessionId: 'ses_kilo_1' });

    const foundKilo3 = findOpenCodeSession('kilo', 'KC | Greeting');
    assert.deepEqual(foundKilo3, { dbPath: kiloFile, sessionId: 'ses_kilo_1' });

    // Custom tab title matching via terminal checkpoint
    const ptyId = 'test-pty-123';
    const thDir = path.join(dir, 'orca', 'terminal-history', encodeURIComponent(ptyId));
    fs.mkdirSync(thDir, { recursive: true });
    fs.writeFileSync(path.join(thDir, 'checkpoint.json'), JSON.stringify({
      snapshotAnsi: '\u001b[1mLight chat\u001b[22m - active kilo session',
    }));

    const foundByCp = findOpenCodeSession('kilo', 'custom-tab-label', null, { ptyId });
    assert.deepEqual(foundByCp, { dbPath: kiloFile, sessionId: 'ses_kilo_2' });

    // Model and effort read from session table
    const modelRes = readOpenCodeModel(kiloFile, 'ses_kilo_1');
    assert.deepEqual(modelRes, { model: 'nvidia/nemotron-3.5-super-vl:free', effort: null });
  } finally {
    db.close();
    kdb.close();
    if (oldDb) process.env.OPENCODE_DB = oldDb;
    else delete process.env.OPENCODE_DB;
    if (oldKilo) process.env.KILO_DB = oldKilo;
    else delete process.env.KILO_DB;
    if (oldOrcaApp) process.env.ORCA_APPDATA_DIR = oldOrcaApp;
    else delete process.env.ORCA_APPDATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idle Antigravity node in same worktree does not steal active Antigravity session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-idle-ag-'));
  const previous = process.env.ORCA_APPDATA_DIR;
  process.env.ORCA_APPDATA_DIR = dir;
  const hookDir = path.join(dir, 'orca', 'agent-hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  try {
    // Only pane-1 has an active Antigravity session hook
    const entry = {
      source: 'antigravity',
      worktreeId: 'shared-worktree',
      providerSession: { key: 'conversation_id', id: 'b00aa6db-3e66-4788-aa65-a568ef353e6c' },
    };
    fs.writeFileSync(path.join(hookDir, 'last-status.json'), JSON.stringify({
      entries: { 'pane-1': entry },
    }));

    // pane-2 is an idle tab in the SAME worktree
    const activeNode = { id: 'node-active', agentType: 'antigravity', worktreeId: 'shared-worktree', label: 'Active AG' } as any;
    const idleNode = { id: 'node-idle', agentType: 'antigravity', worktreeId: 'shared-worktree', label: 'antigravity' } as any;
    globalSourceMaps.nodeSourceMap.set(activeNode.id, { paneKey: 'pane-1' });
    globalSourceMaps.nodeSourceMap.set(idleNode.id, { paneKey: 'pane-2' });

    // Idle node must NOT match pane-1 or return ready conversation
    const idleRes = await resolveAntigravityConversation('project', idleNode, null);
    assert.equal(idleRes.meta.availability, 'unsupported');
    assert.equal(idleRes.meta.issue?.code, 'CONVERSATION_UNSUPPORTED');
    assert.equal(idleRes.data, null);
  } finally {
    globalSourceMaps.nodeSourceMap.delete('node-active');
    globalSourceMaps.nodeSourceMap.delete('node-idle');
    if (previous === undefined) delete process.env.ORCA_APPDATA_DIR;
    else process.env.ORCA_APPDATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
      field(29, call('replace_file_content', { TargetFile: 'new.ts', ReplacementContent: 'private edit content' }, 'edit-1'))]), Buffer.from('private diff'));
    insert.run(4, Buffer.from([255]), Buffer.from('malformed'));
    insert.run(5, Buffer.alloc(524289), Buffer.from('oversized'));
    insert.run(6, Buffer.concat([timestamp, field(7, 'private planner thinking')]), Buffer.from('private assistant turn'));
    const allowed = (file: string) => file.startsWith(dir + path.sep);
    const items = readAntigravityToolActivity(id, allowed);
    assert.deepEqual(items.map((item) => item.label), ['Run: npm test', 'Read: src/main.ts', 'Edit: new.ts']);
    assert.equal(items.every((item) => item.at === new Date(1792330000 * 1000).toISOString()), true);
    assert.equal(JSON.stringify(items).includes('private'), false);
    assert.deepEqual(readAntigravityToolActivity(id, allowed).map((item) => item.id), items.map((item) => item.id));
    assert.throws(() => readAntigravityToolActivity('../escape', allowed), /identity/);
    assert.throws(() => readAntigravityToolActivity(id, () => false), /outside allowed/);
    const node = { id: 'agy', agentType: 'antigravity', worktreeId: 'wt' } as any;
    await collectToolActivity(node, { source: 'antigravity', worktreeId: 'wt', providerSession: { key: 'conversation_id', id } }, allowed);
    assert.equal(node.toolActivity.meta.availability, 'ready');
    assert.equal(node.toolActivity.data.length, 3);
    await collectToolActivity(node, { source: 'antigravity', worktreeId: 'other-wt', providerSession: { key: 'conversation_id', id } }, allowed);
    assert.equal(node.toolActivity.meta.availability, 'unavailable');
    await collectToolActivity(node, { providerSession: { key: 'session_id', id } }, allowed);
    assert.equal(node.toolActivity.meta.availability, 'unavailable');
    db.prepare('UPDATE trajectory_meta SET cascade_id = ?').run('different-conversation');
    assert.throws(() => readAntigravityToolActivity(id, allowed), /identity changed/);
    await collectToolActivity(node, { providerSession: { key: 'conversation_id', id } }, allowed);
    assert.equal(node.toolActivity.meta.availability, 'unavailable');
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
