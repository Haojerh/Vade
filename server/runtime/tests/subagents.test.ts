import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { discoverSubagents, readSubagentTranscript, resetSubagentDiscoveryCache } from '../chat/subagents.js';
import type { SessionRecord } from '../store.js';

function record(provider: SessionRecord['provider'], threadId: string, cwd = process.cwd()): SessionRecord {
  return { id: `${provider}-node`, projectId: 'p', worktreeId: 'w', cwd, provider, title: provider, createdAt: new Date().toISOString(), closed: false, providerThreadId: threadId };
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); }
  finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetSubagentDiscoveryCache();
  }
}

function write(file: string, rows: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('Codex child rollouts are discovered by parent thread and read as their own transcript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-codex-'));
  try {
    const parent = '01a168b6-9008-7501-bff4-8fef6fc0adb2';
    const child = '01a17ddd-e176-7f61-add8-339fd12323ee';
    const childFile = path.join(root, 'sessions', '2026', '10', '27', `rollout-2026-10-27T22-57-35-${child}.jsonl`);
    write(childFile, [
      { timestamp: '2026-10-27T14:57:35.855Z', type: 'session_meta', payload: { id: child, parent_thread_id: parent, agent_nickname: 'Leibniz', agent_path: '/root/chat_navigation', timestamp: '2026-10-27T14:57:35.732Z',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } } },
      { timestamp: '2026-10-27T14:57:36.000Z', type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: '2026-10-27T14:57:40.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'msg-child', content: [{ type: 'output_text', text: 'child inspected the navigation code' }] } },
    ]);
    await withEnv({ CODEX_HOME: root }, async () => {
      const section = await discoverSubagents(record('codex', parent));
      assert.equal(section.meta.availability, 'ready');
      assert.equal(section.data?.length, 1);
      assert.equal(section.data![0].label, 'Leibniz');
      assert.equal(section.data![0].role, '/root/chat_navigation');
      assert.equal(section.data![0].state, 'working');
      assert.equal(section.data![0].transcript, 'available');
      assert.match(String(section.data![0].preview), /inspected the navigation/);

      const page = await readSubagentTranscript(record('codex', parent), section.data![0].id, { direction: 'older', limit: 20 });
      assert.equal(page.conversation.meta.availability, 'ready');
      assert.equal(page.conversation.data?.messages.length, 1);
      assert.equal(page.conversation.data!.messages[0].role, 'agent');
      assert.match(page.conversation.data!.messages[0].text, /inspected the navigation code/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude live child transcripts are read from the per-session subagents tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-claude-'));
  try {
    const parent = '4f209f41-4b57-409e-8234-e32071831eab';
    const project = path.join(root, 'projects', 'C--demo');
    write(path.join(project, `${parent}.jsonl`), [{ type: 'user', sessionId: parent, uuid: 'u1', cwd: 'C:\\demo', message: { role: 'user', content: [{ type: 'text', text: 'parent prompt' }] } }]);
    write(path.join(project, parent, 'subagents', 'agent-a1b2.jsonl'), [
      { type: 'assistant', sessionId: parent, agentId: 'a1b2', isSidechain: true, uuid: 'c1', timestamp: '2026-10-30T08:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'child answer from sidechain' }] } },
    ]);
    await withEnv({ CLAUDE_CONFIG_DIR: root }, async () => {
      const section = await discoverSubagents(record('claude', parent, 'C:\\demo'));
      assert.equal(section.data?.length, 1);
      assert.equal(section.data![0].state, 'working');
      const page = await readSubagentTranscript(record('claude', parent, 'C:\\demo'), section.data![0].id, { direction: 'older', limit: 20 });
      assert.equal(page.conversation.data?.messages.length, 1);
      assert.match(page.conversation.data!.messages[0].text, /child answer from sidechain/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CodeBuddy agent- sessions are linked through their recorded parent session id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-codebuddy-'));
  try {
    const parent = 'd1bb0f5c-4911-4415-becb-a94360897881';
    const project = path.join(root, 'projects', 'C--demo');
    write(path.join(project, `${parent}.jsonl`), [{ type: 'message', sessionId: parent, role: 'user', id: 'u1', content: [] }]);
    write(path.join(project, 'agent-c9.jsonl'), [
      { type: 'session-meta', id: 'agent-c9', sessionId: 'c9', timestamp: 1793001177779, meta: { parentSessionId: parent, agentName: 'reviewer' } },
      { type: 'message', sessionId: 'c9', role: 'assistant', id: 'a1', timestamp: 1793001180000, content: [{ type: 'output_text', text: 'child reviewed the patch' }] },
    ]);
    await withEnv({ CODEBUDDY_CONFIG_DIR: root }, async () => {
      const section = await discoverSubagents(record('codebuddy', parent, 'C:\\demo'));
      assert.equal(section.data?.length, 1);
      assert.equal(section.data![0].label, 'reviewer');
      assert.equal(section.data![0].transcript, 'available');
      const page = await readSubagentTranscript(record('codebuddy', parent, 'C:\\demo'), section.data![0].id, { direction: 'older', limit: 20 });
      assert.equal(page.conversation.data?.messages.length, 1);
      assert.match(page.conversation.data!.messages[0].text, /reviewed the patch/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('OpenCode child sessions come from session.parent_id and keep their own messages', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-opencode-'));
  try {
    const file = path.join(root, 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('ses_parent0000000000000000000', null, 'parent', root, 1000, 2000);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('ses_child00000000000000000000', 'ses_parent0000000000000000000', 'Explore auth system code (@explore subagent)', root, 1500, 2500);
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_child00000000000000000000', 1500, JSON.stringify({ role: 'assistant', time: { created: 1500, completed: 1600 } }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p1', 'ses_child00000000000000000000', 'm1', 1500, JSON.stringify({ type: 'text', text: 'child explored the auth system' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('p2', 'ses_child00000000000000000000', 'm1', 1510, JSON.stringify({ type: 'tool', callID: 'call-1', tool: 'grep', state: { input: { pattern: 'auth' }, time: { start: 1510 } } }));
    db.close();
    await withEnv({ OPENCODE_DB: file }, async () => {
      const section = await discoverSubagents(record('opencode', 'ses_parent0000000000000000000', root));
      assert.equal(section.data?.length, 1, section.meta.issue?.message);
      assert.equal(section.data![0].state, 'completed');
      assert.equal(section.data![0].transcript, 'available');
      const page = await readSubagentTranscript(record('opencode', 'ses_parent0000000000000000000', root), section.data![0].id, { direction: 'older', limit: 20 });
      assert.equal(page.conversation.data?.messages.length, 1);
      assert.match(page.conversation.data!.messages[0].text, /explored the auth system/);
      assert.equal(page.tools.length, 1, 'recorded child tool calls are projected separately from turns');
      assert.match(page.tools[0].label, /grep/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DSH child sessions are linked by parentSession and stay explicitly unavailable for chat', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-dsh-'));
  try {
    const cwd = 'C:\\demo';
    const parent = 'parent-session';
    const directory = path.join(root, 'sessions', '--C-demo--', 'child-session');
    fs.mkdirSync(directory, { recursive: true });
    const header = JSON.stringify({ id: 'child-session', parentSession: parent, origin: 'subagent', cwd, title: 'Explore', createdAt: 1793000000000 });
    fs.writeFileSync(path.join(directory, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header + '\n' + JSON.stringify({ seq: 1 }) + '\n')));
    await withEnv({ DSH_HOME: root }, async () => {
      const section = await discoverSubagents(record('dsh', parent, cwd));
      assert.equal(section.data?.length, 1);
      assert.equal(section.data![0].label, 'Explore');
      assert.equal(section.data![0].transcript, 'unavailable');
      const page = await readSubagentTranscript(record('dsh', parent, cwd), section.data![0].id, { direction: 'older', limit: 20 });
      assert.equal(page.conversation.meta.availability, 'unavailable');
      assert.ok(page.conversation.meta.issue?.message);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Antigravity child agents are discovered from parent transcript and read as their own transcript', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-agy-'));
  try {
    const parent = '69667087-525f-4e58-b7e1-0f3d4b4f2f51';
    const child = '1a311559-66a7-4199-a744-ba44301316f6';
    const parentFile = path.join(root, 'brain', parent, '.system_generated', 'logs', 'transcript.jsonl');
    write(parentFile, [
      { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-15T14:35:13Z',
        tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Browser Tester', TypeName: 'browser', Prompt: 'Verify UI' } }] },
      { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-10-15T14:35:23Z',
        content: `Created the following subagents:\n{\n  "conversationId": "${child}",\n  "workspaceUris": ["file:///C:/demo"]\n}` },
    ]);
    const childMsg = path.join(root, 'brain', child, '.system_generated', 'messages', 'msg-1.json');
    fs.mkdirSync(path.dirname(childMsg), { recursive: true });
    fs.writeFileSync(childMsg, JSON.stringify({
      id: 'msg-1', recipient: child, sender: parent,
      renderDetails: { messageTitle: 'Message from Parent Agent' },
      content: 'Verify UI',
      sourceMetadata: { tool: { conversationId: parent, toolCall: { name: 'invoke_subagent', argumentsJson: JSON.stringify({ Subagents: [{ Role: 'Browser Tester', TypeName: 'browser', Prompt: 'Verify UI' }] }) } } }
    }));
    const childFile = path.join(root, 'brain', child, '.system_generated', 'logs', 'transcript.jsonl');
    write(childFile, [
      { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: '2026-10-15T14:35:29Z',
        content: '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-15T14:35:24Z sender=' + parent + ' content=Verify UI\n</SYSTEM_MESSAGE>' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-15T14:35:30Z',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:\\demo\\PLAN.md' } }] },
      { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-10-15T14:35:40Z',
        content: 'Child finished verification successfully.' },
    ]);
    await withEnv({ GEMINI_APPDATA_DIR: root }, async () => {
      const section = await discoverSubagents(record('antigravity', parent));
      assert.equal(section.meta.availability, 'ready');
      assert.equal(section.data?.length, 1);
      assert.equal(section.data![0].label, 'Browser Tester');
      assert.equal(section.data![0].role, 'browser');
      assert.equal(section.data![0].state, 'completed');
      assert.equal(section.data![0].transcript, 'available');
      assert.match(String(section.data![0].preview), /finished verification/);

      const page = await readSubagentTranscript(record('antigravity', parent), section.data![0].id, { direction: 'older', limit: 20 });
      assert.equal(page.conversation.meta.availability, 'ready');
      assert.equal(page.conversation.data?.messages.length, 2);
      assert.equal(page.conversation.data!.messages[0].role, 'user');
      assert.match(page.conversation.data!.messages[0].text, /Verify UI/);
      assert.equal(page.conversation.data!.messages[1].role, 'agent');
      assert.match(page.conversation.data!.messages[1].text, /Child finished verification/);
      assert.equal(page.tools.length, 1);
      assert.match(page.tools[0].label, /Read: C:\\demo\\PLAN.md/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Antigravity returns empty when no child agents are recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-subagent-agy-empty-'));
  try {
    const parent = '69667087-525f-4e58-b7e1-0f3d4b4f2f51';
    const parentFile = path.join(root, 'brain', parent, '.system_generated', 'logs', 'transcript.jsonl');
    write(parentFile, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-10-15T14:35:13Z', content: 'hello' }
    ]);
    await withEnv({ GEMINI_APPDATA_DIR: root }, async () => {
      const section = await discoverSubagents(record('antigravity', parent));
      assert.equal(section.meta.availability, 'empty');
      assert.deepEqual(section.data, []);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
