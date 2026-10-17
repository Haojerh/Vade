import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publicTranscriptRecord, transcriptSettings, readOpenCodePage, readOpenCodeModel, findOpenCodeSession, findClaudeTranscript } from './transcripts.js';
import { resolveCoordinatorConversation, resolveAntigravityConversation, globalSourceMaps } from '../integrations/orca.js';

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
