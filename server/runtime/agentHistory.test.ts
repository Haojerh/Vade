import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { AgentHistory } from './agentHistory.js';
import { AdeStore } from './store.js';
import { LocalRuntime } from './localRuntime.js';
import { AdeSessions } from './sessions.js';
import { createServer } from '../http/api.js';

const ids = ['01234567-1234-1234-1234-123456789abc', '11234567-1234-1234-1234-123456789abc', '21234567-1234-1234-1234-123456789abc'];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-history-'));
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'GEMINI_APPDATA_DIR', 'XDG_DATA_HOME', 'OPENCODE_DB', 'KILO_DB'] as const;
  const saved = keys.map(key => process.env[key]);
  process.env.CODEX_HOME = path.join(directory, 'codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude');
  process.env.CODEBUDDY_CONFIG_DIR = path.join(directory, 'codebuddy');
  process.env.GEMINI_APPDATA_DIR = path.join(directory, 'agy');
  process.env.XDG_DATA_HOME = path.join(directory, 'xdg-data');
  process.env.OPENCODE_DB = path.join(directory, 'opencode.db');
  process.env.KILO_DB = path.join(directory, 'kilo.db');
  const store = new AdeStore(path.join(directory, 'data'));
  const source = path.join(directory, 'source'), target = path.join(directory, 'target'); fs.mkdirSync(source); fs.mkdirSync(target);
  const project = store.register(source, 'Source project', 'folder'), other = store.register(target, 'Target project', 'folder');
  const write = (file: string, rows: object[]) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join('')); };
  const codexFile = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${ids[0]}.jsonl`);
  const at = '2026-10-22T01:02:03Z';
  write(codexFile, [
    { type: 'session_meta', payload: { id: ids[0], cwd: source } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Build the dashboard' }] } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'Dashboard ready' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'secret', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE THINKING' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'SECRET TOOL RESULT' } },
    { type: 'turn_context', payload: { model: 'observed-model' } },
  ]);
  write(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'source', `${ids[1]}.jsonl`), [
    { type: 'user', sessionId: ids[1], cwd: source, timestamp: at, uuid: 'cu1', message: { role: 'user', content: 'Fix the layout' } },
    { type: 'assistant', sessionId: ids[1], timestamp: at, uuid: 'ca1', message: { role: 'assistant', model: 'observed-claude', content: [{ type: 'text', text: 'Layout fixed' }] } },
  ]);
  write(path.join(process.env.GEMINI_APPDATA_DIR, 'brain', ids[2], '.system_generated', 'logs', 'transcript.jsonl'), [
    { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Check the build', created_at: at },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Build checked', created_at: at },
  ]);
  fs.mkdirSync(path.join(process.env.GEMINI_APPDATA_DIR, 'conversations'), { recursive: true });
  const db = new DatabaseSync(path.join(process.env.GEMINI_APPDATA_DIR, 'conversations', `${ids[2]}.db`)); db.exec('CREATE TABLE trajectory_meta (cascade_id TEXT)'); db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(ids[2]); db.close();
  write(path.join(process.env.GEMINI_APPDATA_DIR, 'history.jsonl'), [{ conversationId: ids[2], workspace: source }]);
  return { directory, store, project, other, source, target, codexFile, write, async close(closeStore = true) { if (closeStore) store.close(); for (const [index, key] of keys.entries()) { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; } await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

test('provider history indexes public messages, exact identities, scopes and project totals', async () => {
  const f = fixture();
  try {
    const history = new AgentHistory(f.store); await history.refresh();
    const list = (scope: 'workspace' | 'project' | 'all', search = '') => history.list({ scope, projectId: f.project.id, paths: [f.source], workspace: f.source, search, offset: 0 }, () => false);
    const all = list('all'); assert.equal(all.total, 3); assert.equal(all.groups[0].total, 3); assert.equal(all.groups[0].name, 'Source project');
    assert.equal(list('workspace').total, 3); assert.equal(list('project').total, 3);
    assert.equal(list('all', 'Dashboard ready').total, 1);
    assert.equal(list('all', 'Dashboard ready').groups[0].projectTotal, 3);
    assert.equal(list('all', 'PRIVATE THINKING').total, 0); assert.equal(list('all', 'SECRET TOOL RESULT').total, 0);
    const codex = all.sessions.find(row => row.provider === 'codex')!;
    assert.equal(codex.messageCount, 2); assert.equal(codex.title, 'Build the dashboard'); assert.equal(codex.lastMessage, 'Dashboard ready'); assert.equal(codex.model, 'observed-model');
    assert.equal(all.sessions.find(row => row.provider === 'antigravity')!.messageCount, 2);
    assert.equal(all.sessions.find(row => row.provider === 'claude')!.messageCount, 2);
    assert.ok(!JSON.stringify(all).includes('threadId')); assert.ok(!JSON.stringify(all).includes('file"'));
    assert.equal((await history.get(codex.id)).threadId, ids[0]);
    f.write(f.codexFile, [{ type: 'session_meta', payload: { id: ids[1], cwd: f.source } }]);
    await assert.rejects(history.get(codex.id), /identity changed/);
  } finally { await f.close(); }
});

test('history pagination keeps exact totals and long sessions retain their newest public message', async () => {
  const f = fixture();
  try {
    const prefix = fs.readFileSync(f.codexFile, 'utf8');
    fs.writeFileSync(f.codexFile, prefix + JSON.stringify({ type: 'tool', data: 'x'.repeat(5 * 1024 * 1024) }) + '\n' + JSON.stringify({ type: 'response_item', timestamp: '2026-10-22T02:00:00Z', payload: { type: 'message', id: 'latest', role: 'assistant', content: [{ type: 'output_text', text: 'Newest public answer' }] } }) + '\n');
    for (let index = 0; index < 55; index++) {
      const id = `31234567-1234-1234-1234-${String(index).padStart(12,'0')}`;
      f.write(path.join(process.env.CODEX_HOME!, 'sessions', `${id}.jsonl`), [{ type: 'session_meta', payload: { id, cwd: f.source } }]);
    }
    const history = new AgentHistory(f.store); await history.refresh();
    const options = { scope: 'all' as const, paths: [], search: '', offset: 0 };
    const first = history.list(options, () => false), second = history.list({ ...options, offset: 50 }, () => false);
    assert.equal(first.total, 58); assert.equal(first.sessions.length, 50); assert.equal(first.nextOffset, 50); assert.equal(second.sessions.length, 8); assert.equal(second.nextOffset, null);
    const codex = [...first.sessions, ...second.sessions].find(row => row.title === 'Build the dashboard')!;
    assert.equal(codex.limited, true); assert.equal(codex.lastMessage, 'Newest public answer');
  } finally { await f.close(); }
});

test('history API fences target worktrees and resumes each provider once in the chosen folder', async () => {
  const f = fixture(), runtime = new LocalRuntime(f.store);
  const bound: string[] = [];
  const script = `process.stdout.write('HISTORY_READY '+JSON.stringify(process.argv)+'\\n');process.stdin.on('data',()=>process.exit(0));`;
  const sessions = new AdeSessions(f.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), async (_resolved, cwd, _title, id, _signal, source) => { bound.push(cwd + ':' + source); return id!; }, () => {}, () => {}, () => true);
  Object.defineProperty(runtime, 'sessions', { value: sessions });
  const server = createServer({ localRuntime: runtime }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (projectId: string, body: object) => fetch(`${base}/api/projects/${projectId}/resume-history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wait = async (condition: () => boolean) => { const end = Date.now() + 10000; while (!condition()) { if (Date.now() > end) throw new Error('History PTY timeout'); await new Promise(resolve => setTimeout(resolve, 25)); } };
  try {
    const sourceTree = (await runtime.git.worktrees(f.project))[0], targetTree = (await runtime.git.worktrees(f.other))[0];
    const response = await fetch(`${base}/api/agent-history?scope=all`); assert.equal(response.status, 200);
    const history = await response.json(); assert.equal(history.total, 3);
    assert.equal((await fetch(`${base}/api/agent-history?scope=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/api/agent-history?scope=workspace&projectId=${f.project.id}&worktreeId=${targetTree.id}`)).status, 404);
    assert.equal((await post(f.other.id, { sessionId: history.sessions[0].id, worktreeId: sourceTree.id })).status, 404);
    assert.equal((await post(f.other.id, { sessionId: history.sessions[0].id, worktreeId: targetTree.id, command: 'arbitrary' })).status, 400);
    assert.equal((await post(f.other.id, { sessionId: 'f'.repeat(40), worktreeId: targetTree.id })).status, 400);
    assert.equal((await fetch(`${base}/api/projects/${f.other.id}/resume-history`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ sessionId: history.sessions[0].id, worktreeId: targetTree.id }) })).status, 403);
    for (const row of history.sessions) {
      const resumed = await post(f.other.id, { sessionId: row.id, worktreeId: targetTree.id }); assert.equal(resumed.status, 200);
      const { nodeId } = await resumed.json(), record = sessions.require(f.other.id, nodeId);
      assert.equal(record.cwd, f.target); assert.equal(record.sourceCwd, f.source);
      assert.equal(record.providerThreadId, ids[['codex','claude','antigravity'].indexOf(row.provider)]);
      await wait(() => sessions.page(f.other.id, nodeId).data.includes('HISTORY_READY'));
      const output = sessions.page(f.other.id, nodeId).data;
      assert.ok(output.includes(record.providerThreadId!));
      if (row.provider === 'codex') { assert.ok(output.includes('--cd')); assert.ok(bound.includes(f.target + ':' + f.source)); }
      const duplicate = await post(f.other.id, { sessionId: row.id, worktreeId: targetTree.id }); assert.equal((await duplicate.json()).nodeId, nodeId);
      assert.equal((await post(f.project.id, { sessionId: row.id, worktreeId: sourceTree.id })).status, 400);
      await sessions.input(f.other.id, nodeId, 'exit\r'); await wait(() => !sessions.page(f.other.id, nodeId).live);
      const moved = await post(f.project.id, { sessionId: row.id, worktreeId: sourceTree.id }); assert.equal(moved.status, 200); assert.equal((await moved.json()).nodeId, nodeId);
      assert.equal(f.store.sessions(f.other.id).some(record => record.id === nodeId), false);
      await sessions.input(f.project.id, nodeId, 'exit\r'); await wait(() => !sessions.page(f.project.id, nodeId).live);
      sessions.closeSession(f.project.id, nodeId);
      const reopened = await post(f.other.id, { sessionId: row.id, worktreeId: targetTree.id }); assert.equal(reopened.status, 200); assert.equal((await reopened.json()).nodeId, nodeId);
      await sessions.input(f.other.id, nodeId, 'exit\r'); await wait(() => !sessions.page(f.other.id, nodeId).live);
    }
  } finally {
    runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(false);
  }
});
