import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { publicTranscriptRecord, transcriptSettings, readOpenCodePage, readOpenCodeModel } from './transcripts.js';
import { resolveCoordinatorConversation, globalSourceMaps } from '../integrations/orca.js';

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
