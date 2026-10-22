import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer } from '../http/api.js';
import { GIT_PATH, defaultCommandRunner, type CommandRunner } from '../integrations/cli.js';
import { AdeStore } from './store.js';
import { LocalRuntime } from './localRuntime.js';
import { AdeSessions } from './sessions.js';
import { addProject } from './projects.js';
import { listProjectFolders } from './projectFolders.js';
import { AdeGit } from './git.js';
import { codexThread } from './codexThread.js';
import { WebSocket } from 'ws';
import { installAgyHook, readAgyBinding, agyBindingFile } from './agyBinding.js';
import { installStatusHooks, readAgentStatus, statusFile } from './statusHooks.js';
import { AdeConversations } from './conversation.js';
import { LocalConnections } from './connections.js';
import { DatabaseSync } from 'node:sqlite';
import { TerminalScreen } from './terminalScreen.js';
import { agyConversationSaved } from './agyBinding.js';

test('terminal screen resolves redraws and answers queries once without polluting previews', async () => {
  const replies: string[] = []; let parsed = () => {};
  const screen = new TerminalScreen(data => replies.push(data), () => parsed());
  const write = (data: string) => new Promise<void>(resolve => { parsed = resolve; screen.write(data); });
  try {
    await write('PS > nmpm run\r\x1b[2KPS > node --version\r\nv22.0.0\r\nPS > ');
    assert.equal(screen.text(), 'PS > node --version\nv22.0.0\nPS >');
    await write('\x1b[c\x1b]10;?\x1b\\\x1b]11;?\x07');
    assert.equal(replies.length, 3);
    assert.ok(replies.every(reply => reply.startsWith('\x1b')));
    assert.ok(!screen.text()?.includes('rgb:'));
    screen.text(); screen.text(); assert.equal(replies.length, 3);
  } finally { screen.dispose(); }
});

test('Antigravity recovery requires a saved exact conversation and preserves unbound tabs', async () => {
  const f = fixture(); const previous = process.env.GEMINI_APPDATA_DIR;
  try {
    process.env.GEMINI_APPDATA_DIR = path.join(f.directory, 'agy');
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const id = '11234567-1234-1234-1234-123456789abc';
    const record = { id: '21234567-1234-1234-1234-123456789abc', projectId: project.id, worktreeId: tree.id, cwd: tree.path, provider: 'antigravity' as const, title: 'Empty', createdAt: new Date().toISOString(), closed: false };
    f.runtime.store.saveSession(record);
    assert.equal(f.runtime.sessions.page(project.id, record.id).resumable, false);
    const details = await f.runtime.details(project.id, record.id);
    assert.match(details.session?.reason ?? '', /first turn/);
    assert.equal(f.runtime.sessions.require(project.id, record.id).closed, false);
    f.runtime.store.saveSession({ ...record, providerThreadId: id });
    await assert.rejects(f.runtime.sessions.resume(project.id, record.id), /has not saved/);
    assert.equal(agyConversationSaved({ ...record, providerThreadId: id }), false);
    const root = path.join(process.env.GEMINI_APPDATA_DIR, 'conversations'); fs.mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(path.join(root, id + '.db'));
    db.exec('CREATE TABLE trajectory_meta(cascade_id TEXT)');
    db.prepare('INSERT INTO trajectory_meta VALUES (?)').run('foreign-id');
    assert.equal(agyConversationSaved({ ...record, providerThreadId: id }), false);
    db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(id); db.close();
    assert.equal(f.runtime.sessions.page(project.id, record.id).resumable, true);
    assert.equal(f.runtime.sessions.page(project.id, record.id).recoverable, true);
  } finally { if (previous === undefined) delete process.env.GEMINI_APPDATA_DIR; else process.env.GEMINI_APPDATA_DIR = previous; f.close(); }
});
import { antigravityPromptReady, programStatusReader, TerminalTurnStatus } from './programStatus.js';

test('Codex quota notices do not start a turn or overwrite a terminal outcome', () => {
  const turn = new TerminalTurnStatus();
  let status = turn.observe({ state: 'idle', source: 'provider-terminal', event: 'OSC7501:idle' });
  const read = programStatusReader(observed => { status = turn.observe(observed); }, () => {});
  const warning = '⚠ Heads up, you have less than 50% of your 5h limit left. Run /status for a breakdown.';
  read(warning + '\r\n' + warning);
  assert.equal(status.state, 'idle');
  read('\x1b]7501;state=working:app=codex\x07');
  read('\x1b]7501;state=idle:app=codex\x07');
  assert.equal(status.state, 'completed');
  read(warning.slice(0, 30)); read(warning.slice(30));
  assert.equal(status.state, 'completed');
});

test('Codex and Claude terminal outcomes distinguish untouched idle, ended turns, failure and confirmed interruption', () => {
  for (const provider of ['codex', 'claude'] as const) {
    const tracker = new TerminalTurnStatus(), states: string[] = [];
    const read = programStatusReader(status => states.push(tracker.observe(status, 1100).state), () => {}, provider);
    const report = (state: string) => read(`\x1b]7501;state=${state}:app=${provider === 'claude' ? 'claude-code' : 'codex'}\x1b\\`);
    report('idle'); report('working'); report('idle'); report('idle');
    assert.deepEqual(states, ['idle', 'working', 'completed', 'completed']);
    report('working'); report('error'); report('idle');
    assert.deepEqual(states.slice(-2), ['failed', 'failed']);
    report('working'); tracker.input('\x1b', 1000);
    assert.equal(states.at(-1), 'working', 'Escape alone must not declare an interrupted turn');
    report('idle'); report('idle');
    assert.deepEqual(states.slice(-2), ['interrupted', 'interrupted']);
    report('working'); report('done');
    assert.equal(states.at(-1), 'completed');
  }
});

test('Codex structured terminal status handles split frames and excludes child, foreign, malformed and textual reports', () => {
  const states: string[] = [];
  let queries = 0;
  const read = programStatusReader(status => states.push(status.state), () => { queries++; });
  read('working done error are ordinary output');
  read('\x1b]75'); read('01;state=working:app=codex\x1b'); read('\\');
  read('\x1b]7501;state=blocked:kind=permission:app=codex\x07');
  read('\x1b]7501;state=done:app=codex:id=child\x07\x1b]7501;state=error:app=other\x07');
  read('\x1b]7501;state=working:state=done:app=codex\x07');
  read('\x1b]7501;?\x1b\\');
  read('\x1b]7501;state=idle:app=codex\x1b\\');
  read('\x1b]7501;state=working:bad=' + 'x'.repeat(5000));
  read('\x1b]7501;state=done:app=codex\x07');
  assert.deepEqual(states, ['working', 'waiting', 'idle', 'completed']);
  assert.equal(queries, 1);
});

test('native cancellation confirmation requires recent active-turn input and the matching provider', () => {
  for (const provider of ['claude', 'antigravity'] as const) {
    const name = provider === 'claude' ? 'Claude' : 'Antigravity CLI';
    const line = `  Interrupted · What should ${name} do instead?`;
    const tracker = new TerminalTurnStatus();
    assert.equal(tracker.confirm(line, provider, 1000), null);
    tracker.input('\x1b', 1000, false);
    assert.equal(tracker.confirm(line, provider, 1100), null);
    tracker.input('\x1b', 1000, true);
    assert.equal(tracker.confirm(line, provider === 'claude' ? 'antigravity' : 'claude', 1100), null);
    assert.equal(tracker.confirm(line, provider, 7000), null);
    tracker.input('\x1b', 1000, true);
    assert.equal(tracker.confirm(line.slice(0, 20), provider, 1100), null);
    assert.equal(tracker.confirm(line.slice(20), provider, 1101)?.state, 'interrupted');
    assert.equal(tracker.confirm(line, provider, 1102), null);
  }
});

test('Antigravity native composer readiness is separate from unavailable lifecycle status', () => {
  assert.equal(antigravityPromptReady('Starting Antigravity'), false);
  assert.equal(antigravityPromptReady('\x1b[15;1H? for shortcuts\x1b[13;3H'), true);
  assert.equal(antigravityPromptReady('? for shortcuts\nesc to cancel'), false);
  assert.equal(antigravityPromptReady('esc to cancel\n? for shortcuts'), true);
});

test('Chat sends text and validated attachments to all three owned terminals with ordered paste and a single submit', async () => {
  for (const provider of ['codex', 'claude', 'antigravity'] as const) {
    const f = fixture(), log = path.join(f.directory, 'input.jsonl');
    const script = `const fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(d.toString())+'\\n'));process.stdout.write('READY\\n? for shortcuts');`;
    const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), async () => '11234567-1234-1234-1234-123456789abc', () => {}, () => {});
    Object.defineProperty(f.runtime, 'sessions', { value: sessions });
    let state = 'idle';
    Object.defineProperty(sessions, 'status', { value: (projectId: string, id: string) => {
      sessions.require(projectId, id);
      return { data: state === 'unknown' ? null : { state, source: 'provider-hook', event: 'SessionStart' }, meta: { availability: state === 'unknown' ? 'unavailable' : 'ready' } };
    } });
    const until = async (condition: () => boolean) => { const end = Date.now() + 5000; while (!condition()) { if (Date.now() > end) throw new Error('Chat fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
    const captured = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).join('') : '';
    const server = createServer({ localRuntime: f.runtime });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
      const record = await sessions.launch(project.id, tree.id, tree.path, provider);
      await until(() => sessions.page(project.id, record.id).data.includes('READY'));
      const attachments = [{ name: '../notes.txt', mimeType: 'text/plain', dataBase64: Buffer.from('attachment fixture').toString('base64') },
        { name: 'pixel.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=' }];
      await assert.rejects(sessions.send(project.id, record.id, { message: 'bad\x1b[201~\r' }), /control codes/);
      state = 'waiting';
      await assert.rejects(sessions.send(project.id, record.id, { message: 'must not approve' }), /needs input/);
      assert.equal(captured(), ''); state = 'idle';
      const sending = sessions.send(project.id, record.id, { message: 'first line\nsecond line', attachments });
      await assert.rejects(sessions.send(project.id, record.id, { message: 'duplicate' }), /already being sent/);
      assert.throws(() => sessions.input(project.id, record.id, 'interleave'), /being staged/);
      assert.equal((await sending).ok, true);
      await until(() => captured().endsWith('\r'));
      const input = captured();
      assert.equal((input.match(/\r/g) ?? []).length, 1);
      assert.ok(input.includes('\x1b[200~') && input.includes('first line\nsecond line\x1b[201~'));
      assert.equal((input.match(/@/g) ?? []).length, provider === 'antigravity' ? 2 : 1);
      const stored = fs.readdirSync(path.join(f.runtime.store.directory, 'attachments'));
      assert.equal(stored.length, 2);
      assert.equal(fs.readFileSync(path.join(f.runtime.store.directory, 'attachments', stored.find(name => name.endsWith('.txt'))!), 'utf8'), 'attachment fixture');
      const route = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}/nodes/${record.id}/message`;
      const post = (value: unknown) => fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      assert.equal((await post({ message: 'hello', path: 'C:/forged' })).status, 400);
      assert.equal((await post({ message: '', attachments: [attachments[0]] })).status, 200);
      state = 'working';
      assert.equal((await post({ message: 'follow-up while working' })).status, 200);
      state = 'unknown';
      assert.equal((await post({ message: 'first prompt before hooks' })).status, provider === 'antigravity' ? 200 : 500);
      state = 'idle';
      assert.equal((await post({ message: 'hello', attachments: [{ ...attachments[1], mimeType: 'image/jpeg' }] })).status, 400);
      const beforePartial = captured().length;
      const partial = sessions.send(project.id, record.id, { message: 'keep draft on failure' });
      const rejected = assert.rejects(partial, /Delivery may be partial/);
      await until(() => captured().length > beforePartial); state = 'waiting'; await rejected;
      assert.ok(!captured().slice(beforePartial).includes('\r'), 'never submit into a permission prompt');
    } finally {
      f.runtime.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

test('standalone history reads exact Codex, Claude and Antigravity sessions with isolated pagination and public turns only', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-history-'));
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_APPDATA_DIR'] as const;
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = path.join(directory, key);
  try {
    for (const provider of ['codex', 'claude', 'antigravity'] as const) {
      const id = '11234567-1234-1234-1234-123456789abc';
      const record = { id: `ade-${provider}`, projectId: 'p', worktreeId: 'w', cwd: directory, provider, title: provider, createdAt: '', closed: false, providerThreadId: id };
      const agy = provider === 'antigravity';
      const file = provider === 'codex' ? path.join(process.env.CODEX_HOME!, 'sessions', '2026', '10', '21', `rollout-${id}.jsonl`)
        : provider === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'workspace', `${id}.jsonl`)
        : path.join(process.env.GEMINI_APPDATA_DIR!, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (agy) {
        const dbFile = path.join(process.env.GEMINI_APPDATA_DIR!, 'conversations', `${id}.db`);
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        const db = new DatabaseSync(dbFile);
        try {
          db.exec('CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)');
          db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(id);
          const field = (n: number, value: string | Buffer): Buffer => {
            const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([n * 8 + 2, bytes.length]), bytes]);
          };
          // The two-byte protobuf tag for planner model field 28.
          const model = Buffer.from('gemini-observed-high');
          db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(field(3, Buffer.concat([Buffer.from([226, 1, model.length]), model])));
          db.prepare('INSERT INTO steps VALUES (1, ?)').run(field(4, Buffer.concat([field(1, 'tool-exact'), field(2, 'read_file'), field(3, '{"path":"observed.txt"}')])));
        } finally { db.close(); }
      }
      const turn = (n: number) => agy ? { source: n % 2 ? 'MODEL' : 'USER_EXPLICIT', type: n % 2 ? 'PLANNER_RESPONSE' : 'USER_INPUT', content: `public ${n}`, step_index: n }
        : provider === 'codex' ? { type: 'response_item', payload: { type: 'message', id: `turn-${n}`, role: n % 2 ? 'assistant' : 'user', content: [{ type: 'output_text', text: `public ${n}` }] } }
        : { type: n % 2 ? 'assistant' : 'user', uuid: `turn-${n}`, sessionId: id, cwd: directory, message: { role: n % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `public ${n}` }] } };
      const header = provider === 'codex' ? [{ type: 'session_meta', payload: { id, cwd: directory } }] : [];
      const privateRows = agy ? [{ source: 'TOOL', type: 'PLANNER_RESPONSE', content: 'secret tool output' }, { source: 'MODEL', type: 'THINKING', content: 'secret thinking' }]
        : provider === 'codex' ? [{ type: 'response_item', payload: { role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'secret thinking' }] } }]
        : [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thinking' }] } }, { type: 'user', isMeta: true, message: { role: 'user', content: 'secret injected' } }];
      fs.writeFileSync(file, [...header, ...Array.from({ length: 45 }, (_, n) => turn(n)), ...privateRows].map(row => JSON.stringify(row) + '\n').join(''));
      const reader = new AdeConversations();
      if (!agy) {
        const settings = provider === 'codex' ? { type: 'turn_context', payload: { model: 'observed-model', effort: 'high' } }
          : { sessionId: id, message: { role: 'assistant', model: 'observed-model', effort: 'high', content: [] } };
        const tool = provider === 'codex' ? { type: 'response_item', payload: { type: 'function_call', call_id: 'tool-exact', name: 'read_file', arguments: '{"path":"observed.txt"}' } }
          : { sessionId: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-exact', name: 'read_file', input: { path: 'observed.txt' } }] } };
        fs.appendFileSync(file, [settings, { type: 'tool_output', content: 'x'.repeat(600000) }, tool].map(row => JSON.stringify(row) + '\n').join(''));
      }
      const metadata = await reader.metadata(record);
      assert.equal(metadata.preview, 'public 44', 'card preview excludes thinking, tool calls and tool output');
      assert.equal(metadata.model, agy ? 'gemini-observed' : 'observed-model');
      assert.equal(metadata.effort, 'high');
      assert.equal(metadata.toolActivity.data?.length, 1);
      assert.equal(metadata.toolActivity.data?.[0].label, 'Read: observed.txt');
      assert.deepEqual((await reader.metadata(record)).toolActivity.data, metadata.toolActivity.data, 'stable observed tool IDs');
      if (!agy) assert.equal((await reader.metadata({ ...record, cwd: path.dirname(directory) })).model, null);
      const newest = await reader.read(record, { direction: 'older' });
      assert.equal(newest.data?.messages.length, 20, provider);
      assert.equal(newest.data?.messages[0].text, 'public 25');
      assert.equal(newest.data?.messages.at(-1)?.text, 'public 44');
      assert.ok(!JSON.stringify(newest).includes('secret'));
      assert.ok(!JSON.stringify(newest).includes(directory.replaceAll('\\', '\\\\')));
      const older = await reader.read(record, { direction: 'older', cursor: newest.data!.nextCursor });
      assert.equal(older.data?.messages[0].text, 'public 5');
      await assert.rejects(reader.read({ ...record, id: 'other-agent' }, { direction: 'older', cursor: newest.data!.nextCursor }), /cursor/);
      await assert.rejects(reader.read(record, { cursor: newest.data!.nextCursor }), /direction/);
      const live = await reader.read(record);
      fs.appendFileSync(file, JSON.stringify(turn(45)) + '\n');
      const delta = await reader.read(record, { cursor: live.data!.nextCursor });
      assert.deepEqual(delta.data?.messages.map(message => message.text), ['public 45']);
      const idle = await reader.read(record, { cursor: delta.data!.nextCursor });
      assert.deepEqual(idle.data?.messages, []);
      assert.equal(idle.data?.nextCursor, delta.data?.nextCursor);
      if (provider === 'claude') {
        const runtime = new LocalRuntime(new AdeStore(path.join(directory, 'stream-store')));
        const project = runtime.store.register(directory, 'History stream', 'folder');
        const tree = (await runtime.git.worktrees(project))[0];
        runtime.store.saveSession({ ...record, projectId: project.id, worktreeId: tree.id });
        const observed = (await runtime.snapshot(project.id)).graph.data?.nodes.find(node => node.id === record.id);
        assert.equal(observed?.chatAvailable, true);
        assert.equal(observed?.preview, 'public 45');
        assert.equal(observed?.model, 'observed-model');
        assert.equal(observed?.effort, 'high');
        assert.equal(observed?.toolActivity?.data?.length, 1);
        const server = createServer({ localRuntime: runtime });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 6000);
        try {
          const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}/nodes/${record.id}/events`;
          const response = await fetch(url, { signal: abort.signal });
          assert.equal(response.status, 200);
          const stream = response.body!.getReader();
          assert.match(new TextDecoder().decode((await stream.read()).value), /event: conversation/);
          fs.appendFileSync(file, JSON.stringify(turn(46)) + '\n');
          let update = '';
          while (!update.includes('public 46')) update += new TextDecoder().decode((await stream.read()).value);
          assert.ok(!update.includes('secret'));
        } finally {
          clearTimeout(timeout); abort.abort(); runtime.close(); server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }
      if (!agy) assert.equal((await reader.read({ ...record, cwd: path.dirname(directory) }, { direction: 'older' })).data, null);
      else {
        const db = new DatabaseSync(path.join(process.env.GEMINI_APPDATA_DIR!, 'conversations', `${id}.db`));
        try { db.exec('DELETE FROM trajectory_meta'); } finally { db.close(); }
        assert.equal((await reader.read(record)).data, null);
        assert.equal((await reader.metadata(record)).toolActivity.meta.availability, 'unavailable');
      }
    }
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('provider status hooks preserve settings and bind observed events to the exact live session', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-status-test-'));
  try {
    const configFile = path.join(directory, 'settings.json');
    fs.writeFileSync(configFile, JSON.stringify({ theme: 'keep', hooks: { Stop: [{ matcher: 'keep', hooks: [{ type: 'command', command: 'user-hook' }, { type: 'command', command: 'old/ade-status-hook.cjs' }] }] } }));
    const record = { id: '01234567-1234-1234-1234-123456789abc', projectId: 'p', worktreeId: 'w', cwd: directory, provider: 'claude' as const, title: 'Claude', createdAt: '', closed: false, statusToken: 'fresh-launch', providerThreadId: '11234567-1234-1234-1234-123456789abc' };
    installStatusHooks(directory, 'claude', process.execPath, configFile);
    const first = fs.readFileSync(configFile, 'utf8');
    installStatusHooks(directory, 'claude', process.execPath, configFile);
    assert.equal(fs.readFileSync(configFile, 'utf8'), first);
    const config = JSON.parse(first);
    assert.equal(config.theme, 'keep');
    assert.deepEqual(config.hooks.Stop[0], { matcher: 'keep', hooks: [{ type: 'command', command: 'user-hook' }] });
    if (process.platform === 'win32') {
      // Exercise the generated batch entry point, including paths with spaces and piped stdin.
      const wrapper = path.join(directory, 'ade-status-claude-UserPromptSubmit.cmd');
      const result = spawnSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${wrapper}""`], {
        input: JSON.stringify({ session_id: record.providerThreadId, cwd: directory, hook_event_name: 'UserPromptSubmit' }),
        env: { ...process.env, ADE_STATUS_FILE: statusFile(directory, record.id), ADE_STATUS_TOKEN: record.statusToken, ADE_STATUS_PROVIDER: 'claude', ADE_STATUS_CWD: directory, ADE_STATUS_SESSION: record.providerThreadId },
        windowsHide: true, windowsVerbatimArguments: true, timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr?.toString());
      assert.equal(readAgentStatus(directory, record, true).data?.state, 'working');
    }
    const run = (provider: string, event: string, extra: object = {}) => execFileSync(process.execPath, [path.join(directory, 'ade-status-hook.cjs'), provider, event], {
      input: JSON.stringify({ session_id: record.providerThreadId, cwd: directory, hook_event_name: event, prompt: 'private prompt', ...extra }),
      env: { ...process.env, ADE_STATUS_FILE: statusFile(directory, record.id), ADE_STATUS_TOKEN: record.statusToken, ADE_STATUS_PROVIDER: provider, ADE_STATUS_CWD: directory, ADE_STATUS_SESSION: record.providerThreadId }, encoding: 'utf8',
    });
    for (const [event, state] of [['SessionStart', 'idle'], ['UserPromptSubmit', 'working'], ['PermissionRequest', 'waiting'], ['Stop', 'completed'], ['StopFailure', 'failed']]) {
      run('claude', event);
      assert.equal(readAgentStatus(directory, record, true).data?.state, state);
    }
    run('claude', 'PostToolUse', { tool_result: 'error failed' });
    assert.equal(readAgentStatus(directory, record, true).data?.state, 'working');
    const saved = fs.readFileSync(statusFile(directory, record.id), 'utf8');
    assert.ok(!saved.includes('private prompt') && !saved.includes('tool_result'));
    for (const extra of [{ session_id: '21234567-1234-1234-1234-123456789abc' }, { cwd: path.dirname(directory) }, { agent_id: 'child' }]) {
      run('claude', 'Stop', extra);
      assert.equal(fs.readFileSync(statusFile(directory, record.id), 'utf8'), saved);
    }
    assert.equal(readAgentStatus(directory, { ...record, statusToken: 'next-launch' }, true).data, null);
    assert.equal(readAgentStatus(directory, record, false).meta.stale, true);
    assert.equal(readAgentStatus(directory, record, false).meta.availability, 'unavailable');
    run('codex', 'UserPromptSubmit');
    assert.equal(readAgentStatus(directory, { ...record, provider: 'codex' }, true).data?.state, 'working');
    const agy = { ...record, provider: 'antigravity' as const };
    const payload = { conversationId: record.providerThreadId, workspacePaths: [directory] };
    assert.equal(JSON.parse(run('antigravity', 'PreToolUse', { ...payload, toolCall: { name: 'ask_question' } })).decision, 'ask');
    assert.equal(readAgentStatus(directory, agy, true).data?.state, 'waiting');
    for (const [fullyIdle, terminationReason, expected] of [[false, 'error', 'working'], [true, 'model_stop', 'completed'], [true, 'error', 'failed'], [true, 'user_cancelled', 'interrupted']] as const) {
      assert.equal(JSON.parse(run('antigravity', 'Stop', { ...payload, fullyIdle, terminationReason })).decision, '');
      assert.equal(readAgentStatus(directory, agy, true).data?.state, expected);
    }
    run('antigravity', 'PreInvocation', payload);
    run('antigravity', 'Stop', { ...payload, fullyIdle: false, terminationReason: 'NO_TOOL_CALL' });
    assert.equal(readAgentStatus(directory, agy, true).data?.state, 'working');
    run('antigravity', 'Stop', { ...payload, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' });
    assert.equal(readAgentStatus(directory, agy, true).data?.state, 'completed');
    for (const event of ['PostInvocation', 'PostToolUse', 'PreToolUse']) {
      run('antigravity', event, payload);
      assert.equal(readAgentStatus(directory, agy, true).data?.state, 'completed', 'late bookkeeping must not restart a finished turn');
    }
    run('antigravity', 'PreInvocation', payload);
    assert.equal(readAgentStatus(directory, agy, true).data?.state, 'working');
    run('claude', 'Stop', { is_interrupt: true });
    assert.equal(readAgentStatus(directory, record, true).data?.state, 'interrupted');
    run('claude', 'StopFailure');
    assert.equal(readAgentStatus(directory, record, true).data?.state, 'failed');
    run('codex', 'Interrupt');
    assert.equal(readAgentStatus(directory, { ...record, provider: 'codex' }, true).data?.state, 'interrupted');
    fs.writeFileSync(configFile, '{invalid');
    assert.throws(() => installStatusHooks(directory, 'claude', process.execPath, configFile), /preserved/);
    assert.equal(fs.readFileSync(configFile, 'utf8'), '{invalid');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Antigravity identity hook preserves user hooks and captures only its authenticated session ID', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-hook-test-'));
  try {
    const configFile = path.join(directory, 'hooks.json');
    fs.writeFileSync(configFile, JSON.stringify({ existing: { Stop: [{ command: 'keep' }] } }));
    installAgyHook(directory, process.execPath, configFile);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.deepEqual(config.existing, { Stop: [{ command: 'keep' }] });
    assert.deepEqual(Object.keys(config['ade-session-identity']), ['SessionStart', 'PreInvocation', 'PostInvocation']);
    const record = { id: '01234567-1234-1234-1234-123456789abc', projectId: 'project', worktreeId: 'tree', cwd: directory, provider: 'antigravity' as const, title: 'Agy', createdAt: '', closed: false, bindingToken: 'only-this-process' };
    const file = agyBindingFile(directory, record);
    const providerId = '11234567-1234-1234-1234-123456789abc';
    execFileSync(process.execPath, [path.join(directory, 'agy-identity-hook.cjs')], { input: JSON.stringify({ conversationId: providerId, workspacePaths: [directory], prompt: 'never retain this', tool_input: { command: 'private' } }), env: { ...process.env, ADE_BINDING_FILE: file, ADE_BINDING_TOKEN: record.bindingToken, ADE_BINDING_CWD: directory } });
    assert.equal(readAgyBinding(directory, record), providerId);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { id: providerId, token: record.bindingToken });
    assert.equal(readAgyBinding(directory, { ...record, bindingToken: 'other' }), undefined);
    fs.writeFileSync(file, JSON.stringify({ id: '--continue', token: record.bindingToken }));
    assert.equal(readAgyBinding(directory, record), undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('terminal sockets stream on PTY events, require render credit and reject foreign origins', async () => {
  const f = fixture();
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', "process.stdin.on('data',d=>{process.stdout.write('ECHO:'+d);if(d.includes('exit-ade'))process.exit(0)})", '--'] }), undefined, undefined, () => {});
  Object.defineProperty(f.runtime, 'sessions', { value: sessions });
  const server = createServer({ localRuntime: f.runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let socket: WebSocket | undefined;
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const session = await sessions.launch(project.id, tree.id, tree.path, 'claude');
    assert.match(session.providerThreadId!, /^[0-9a-f-]{36}$/);
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project.id}/nodes/${session.id}/terminal-stream`;
    await new Promise<void>((resolve, reject) => {
      const denied = new WebSocket(url, { origin: 'https://evil.example' });
      denied.on('error', () => {});
      denied.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); denied.terminate(); resolve(); });
      denied.on('open', () => { denied.terminate(); reject(new Error('Foreign origin accepted')); });
    });
    socket = new WebSocket(url, { origin: 'http://127.0.0.1:4317' });
    const messages: any[] = [];
    let acknowledge = false;
    socket.on('message', data => {
      const message = JSON.parse(data.toString()); messages.push(message);
      if (acknowledge && message.type === 'output') socket!.send(JSON.stringify({ type: 'ack', cursor: message.page.cursor }));
    });
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 6000;
      while (!condition()) { if (Date.now() > deadline) throw new Error('Terminal stream timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
    };
    await until(() => messages.length > 0);
    socket.send(JSON.stringify({ type: 'input', data: 'smooth-stream\r' }));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(messages.length, 1, 'output must wait for renderer credit');
    acknowledge = true;
    socket.send(JSON.stringify({ type: 'ack', cursor: messages[0].page.cursor }));
    await until(() => messages.map(message => message.page?.data ?? '').join('').includes('smooth-stream'));
    assert.ok(messages.every(message => !message.page || message.page.data.length <= 65536));
    socket.terminate();
    await sessions.input(project.id, session.id, 'exit-ade\r');
    await until(() => !sessions.page(project.id, session.id).live);
    assert.equal((await f.runtime.snapshot(project.id)).graph.data?.nodes.find(node => node.id === session.id)?.liveness, 'exited');
    let statusChanges = 0;
    const unsubscribe = sessions.subscribeStatus(project.id, () => { statusChanges++; });
    const resumed = await sessions.resume(project.id, session.id);
    assert.equal(resumed.providerThreadId, session.providerThreadId);
    assert.ok(statusChanges > 0, 'resume must notify project snapshot subscribers immediately');
    assert.equal((await f.runtime.snapshot(project.id)).graph.data?.nodes.find(node => node.id === session.id)?.liveness, 'live');
    const beforeHook = statusChanges;
    fs.writeFileSync(statusFile(f.runtime.store.directory, resumed.id), JSON.stringify({ token: resumed.statusToken, provider: resumed.provider, id: resumed.providerThreadId, state: 'waiting', event: 'PermissionRequest', at: new Date().toISOString() }));
    await until(() => statusChanges > beforeHook);
    const observedNode = (await f.runtime.snapshot(project.id)).graph.data?.nodes.find(node => node.id === resumed.id);
    assert.equal(observedNode?.state, 'waiting');
    assert.equal(observedNode?.taskOutcome, null);
    unsubscribe();
    await sessions.input(project.id, session.id, 'exit-ade\r');
    await until(() => !sessions.page(project.id, session.id).live);
  } finally {
    socket?.terminate(); f.runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('all providers skip tool approvals on new and exact-session resumed terminals', async () => {
  const f = fixture();
  const id = '11234567-1234-1234-1234-123456789abc';
  const script = `process.stdout.write('ARGS:'+JSON.stringify(process.argv.slice(1))+'\\n');process.stdin.on('data',()=>process.exit(0));`;
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }),
    async () => id, () => {}, () => {}, () => true);
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('Launch arguments fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    for (const provider of ['codex', 'claude', 'antigravity'] as const) {
      const record = await sessions.launch(project.id, tree.id, tree.path, provider);
      const flag = provider === 'codex' ? '--dangerously-bypass-approvals-and-sandbox' : '--dangerously-skip-permissions';
      const expectArgs = async (identityArgs: string[]) => {
        await until(() => sessions.page(project.id, record.id).data.includes('ARGS:'));
        const output = sessions.page(project.id, record.id).data;
        const args = JSON.parse(output.match(/ARGS:(\[[^\r\n]*\])/)![1]);
        assert.deepEqual(args, [...identityArgs, flag]);
      };
      await expectArgs(provider === 'codex' ? ['resume', id] : provider === 'claude' ? ['--session-id', record.providerThreadId!] : []);
      await sessions.input(project.id, record.id, 'exit\r');
      await until(() => !sessions.page(project.id, record.id).live);
      // Antigravity normally obtains this exact binding from its identity hook.
      if (provider === 'antigravity') f.runtime.store.saveSession({ ...sessions.require(project.id, record.id), providerThreadId: id });
      const resumed = await sessions.resume(project.id, record.id);
      await expectArgs(provider === 'codex' ? ['resume', id] : [provider === 'claude' ? '--resume' : '--conversation', resumed.providerThreadId!]);
      await sessions.input(project.id, record.id, 'exit\r');
      await until(() => !sessions.page(project.id, record.id).live);
    }
  } finally {
    sessions.close(); f.runtime.close();
    await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Antigravity persists its observed hook identity and resumes only that conversation', async () => {
  const f = fixture();
  const id = '11234567-1234-1234-1234-123456789abc';
  const script = `const fs=require('node:fs');fs.writeFileSync(process.env.ADE_BINDING_FILE,JSON.stringify({token:process.env.ADE_BINDING_TOKEN,id:'${id}'}));process.stdout.write(JSON.stringify(process.argv)+'\\n');process.stdin.on('data',()=>process.exit(0));`;
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), undefined,
    (directory, node) => installAgyHook(directory, node, path.join(directory, 'fixture-hooks.json')), () => {}, () => true);
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('Antigravity fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const record = await sessions.launch(project.id, tree.id, tree.path, 'agy');
    await until(() => sessions.require(project.id, record.id).providerThreadId === id);
    await sessions.input(project.id, record.id, 'exit\r');
    await until(() => !sessions.page(project.id, record.id).live);
    const resumed = await sessions.resume(project.id, record.id);
    assert.equal(resumed.providerThreadId, id);
    await until(() => sessions.page(project.id, record.id).data.includes('--conversation'));
    assert.ok(sessions.page(project.id, record.id).data.includes(id));
    await sessions.input(project.id, record.id, 'exit\r');
    await until(() => !sessions.page(project.id, record.id).live);
  } finally {
    sessions.close(); f.runtime.close();
    await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Codex binding uses fixed RPC, persists new identity and rejects mismatched metadata', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-codex-binding-'));
  const script = path.join(directory, 'rpc.cjs');
  const log = path.join(directory, 'methods.jsonl');
  const id = '01234567-1234-1234-1234-123456789abc';
  fs.writeFileSync(script, `
    const fs = require('node:fs');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const message = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
      if (message.id === undefined) return;
      const cwd = process.argv.includes('--bad-cwd') ? process.cwd() + '/other' : process.cwd();
      const result = message.method === 'thread/start' || message.method === 'thread/read'
        ? {thread:{id:${JSON.stringify(id)},cwd,ephemeral:false}} : {};
      process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
    });
  `);
  const resolved = { executable: process.execPath, args: [script] };
  try {
    assert.equal(await codexThread(resolved, directory, 'My agent'), id);
    const first = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(first.map(message => message.method), ['initialize', 'initialized', 'thread/start', 'thread/name/set']);
    assert.deepEqual(first[2].params, { cwd: directory });
    assert.equal(await codexThread(resolved, directory, 'My agent', id), id);
    await assert.rejects(codexThread(resolved, directory, 'My agent', '11234567-1234-1234-1234-123456789abc'), /binding failed/);
    await assert.rejects(codexThread(resolved, directory, 'My agent', '--last'), /binding failed/);
    await assert.rejects(codexThread({ ...resolved, args: [script, '--bad-cwd'] }, directory, 'My agent', id), /binding failed/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(codexThread(resolved, directory, 'My agent', undefined, controller.signal), /shutting down/);
  } finally { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-runtime-test-'));
  const repo = path.join(directory, 'repository with spaces'); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync(GIT_PATH, args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init');
  git('-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid', 'commit', '--allow-empty', '-m', 'Initial');
  const calls: string[][] = [];
  const runner: CommandRunner = async (executable, args, options) => {
    assert.equal(executable, GIT_PATH, 'Standalone collection must never invoke Orca');
    calls.push(args);
    return defaultCommandRunner(executable, args, options);
  };
  const runtime = new LocalRuntime(new AdeStore(path.join(directory, 'data')), runner, new LocalConnections(runner, { credentials: async () => [null, null], resolve: () => null }));
  return { directory, repo, git, runtime, calls, close() { runtime.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('owned shell terminals expose command and output previews without agent conversations or outcomes', async () => {
  const f = fixture();
  try {
    const project = await f.runtime.git.register(f.repo);
    const tree = (await f.runtime.git.worktrees(project))[0];
    const record = await f.runtime.sessions.launch(project.id, tree.id, tree.path, 'terminal');
    await f.runtime.sessions.input(project.id, record.id, process.platform === 'win32' ? "Write-Output 'ADE terminal preview'\r" : "printf 'ADE terminal preview\\n'\r");
    const deadline = Date.now() + 10000;
    let preview;
    do { await new Promise(resolve => setTimeout(resolve, 100)); preview = f.runtime.sessions.preview(project.id, record.id); } while (!preview.command?.includes('ADE terminal preview') && Date.now() < deadline);
    assert.ok(preview.command?.includes('ADE terminal preview'));
    assert.ok(preview.output?.includes('ADE terminal preview'));
    const details = await f.runtime.details(project.id, record.id);
    assert.equal(details.node.kind, 'terminal');
    assert.equal(details.session?.chat, false);
    assert.equal(details.conversation.meta.availability, 'unsupported');
    assert.equal(details.node.agentStatus?.data, null);
    await assert.rejects(f.runtime.sessions.resume(project.id, record.id), /already running/);
    await f.runtime.sessions.input(project.id, record.id, 'exit\r');
    const stoppedBy = Date.now() + 6000;
    while (f.runtime.sessions.page(project.id, record.id).live && Date.now() < stoppedBy) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.runtime.sessions.page(project.id, record.id).live, false);
    assert.equal(f.runtime.sessions.page(project.id, record.id).recoverable, true);
    const reopened = await f.runtime.sessions.resume(project.id, record.id);
    assert.equal(reopened.id, record.id); assert.equal(reopened.cwd, tree.path);
    assert.equal(f.runtime.sessions.preview(project.id, record.id).command, null);
    assert.equal(f.runtime.sessions.page(project.id, record.id).recoverable, false);
    f.runtime.sessions.closeSession(project.id, record.id);
    await new Promise(resolve => setTimeout(resolve, 1200));
  } finally { f.close(); }
});

test('standalone projects persist, deduplicate and expose real Git worktrees without Orca', async () => {
  const f = fixture();
  try {
    const project = await f.runtime.git.register(f.repo);
    assert.equal((await f.runtime.git.register(f.repo)).id, project.id);
    const initial = await f.runtime.snapshot(project.id);
    assert.equal(initial.graph.meta.availability, 'ready');
    assert.equal(initial.graph.data?.nodes.length, 1);
    assert.equal(initial.graph.data?.nodes[0].workspaceStatus, 'main checkout');
    assert.equal(initial.graph.data?.progress.percent, null);
    assert.deepEqual(initial.graph.data?.runs, []);
    const tree = await f.runtime.git.create(project, { name: 'feature-ade', setup: 'skip' });
    assert.equal(tree.branch, 'feature-ade');
    assert.equal((await f.runtime.snapshot(project.id)).graph.data?.nodes.length, 2);
    const details = await f.runtime.details(project.id, tree.id);
    assert.equal(details.node.path, tree.path);
    const history = await f.runtime.git.history(project, tree.id);
    assert.equal(history.data?.commits[0].message, 'Initial');
    const reopened = new AdeStore(f.runtime.store.directory);
    try { assert.equal(reopened.project(project.id).paths[0], fs.realpathSync(f.repo)); }
    finally { reopened.close(); }
    await f.runtime.git.remove(project, tree.id);
    assert.equal((await f.runtime.git.worktrees(project)).length, 1);
  } finally { f.close(); }
});

test('worktree actions reject injection, cross-project nodes, dirty deletion and main deletion', async () => {
  const f = fixture();
  try {
    const project = await f.runtime.git.register(f.repo);
    for (const name of ['../escape', '--force', 'hello;whoami', 'a..b']) await assert.rejects(f.runtime.git.create(project, { name }));
    await assert.rejects(f.runtime.git.create(project, { name: 'valid', baseBranch: '--help' }));
    await assert.rejects(f.runtime.git.create(project, { name: 'valid', from: { kind: 'pr', value: '1' } }));
    await assert.rejects(f.runtime.git.requireWorktree(project, 'foreign-node'));
    const main = (await f.runtime.git.worktrees(project))[0];
    await assert.rejects(f.runtime.git.remove(project, main.id), /main or a locked/);
    const tree = await f.runtime.git.create(project, { name: 'dirty-check' });
    fs.writeFileSync(path.join(tree.path, 'valuable.txt'), 'keep');
    await assert.rejects(f.runtime.git.remove(project, tree.id));
    assert.equal(fs.readFileSync(path.join(tree.path, 'valuable.txt'), 'utf8'), 'keep');
    fs.unlinkSync(path.join(tree.path, 'valuable.txt'));
    await f.runtime.git.remove(project, tree.id);
    await assert.rejects(f.runtime.sessions.launch(project.id, main.id, main.path, 'codex; whoami'), /custom commands/);
    assert.throws(() => f.runtime.sessions.page(project.id, 'unknown'), /does not belong/);
    assert.throws(() => f.runtime.sessions.input('foreign-project', 'unknown', 'text'), /not registered/);
  } finally { f.close(); }
});

test('standalone snapshot retains last successful data when Git becomes unavailable', async () => {
  const f = fixture();
  try {
    const project = await f.runtime.git.register(f.repo);
    const good = await f.runtime.snapshot(project.id);
    const renamed = f.repo + '-moved'; fs.renameSync(f.repo, renamed);
    try {
      const stale = await f.runtime.snapshot(project.id);
      assert.equal(stale.graph.meta.availability, 'unavailable');
      assert.equal(stale.graph.meta.stale, true);
      assert.deepEqual(stale.graph.data, good.graph.data);
      assert.equal(stale.graph.meta.observedAt, good.graph.meta.observedAt);
    } finally { fs.renameSync(renamed, f.repo); }
  } finally { f.close(); }
});

test('project onboarding browses folders, registers plain workspaces and creates repositories without overwriting', async () => {
  const f = fixture();
  try {
    const plain = path.join(f.directory, 'plain folder'); fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'keep.txt'), 'keep');
    const listing = listProjectFolders(f.directory);
    assert.ok(listing.folders.some(folder => folder.path === plain));
    assert.equal(listProjectFolders(plain).folders.length, 0);
    assert.throws(() => listProjectFolders('relative/path'), /absolute local/);
    assert.throws(() => listProjectFolders(path.join(plain, 'keep.txt')), /cannot be opened/);
    const folder = await addProject(f.runtime.git, { path: plain });
    assert.equal(folder.kind, 'folder');
    assert.equal((await f.runtime.snapshot(folder.id)).graph.data?.nodes[0].workspaceStatus, 'folder workspace');
    assert.equal((await f.runtime.git.history(folder)).meta.availability, 'unsupported');
    await assert.rejects(f.runtime.git.create(folder, { name: 'invalid' }), /Git project/);
    const created = await addProject(f.runtime.git, { mode: 'create', path: f.directory, name: 'new project' });
    assert.equal(created.kind, 'git');
    assert.ok(fs.existsSync(path.join(created.paths[0], '.git')));
    await assert.rejects(addProject(f.runtime.git, { mode: 'create', path: f.directory, name: 'plain folder' }), /already exists/);
    await assert.rejects(addProject(f.runtime.git, { mode: 'create', path: f.directory, name: '../escape' }), /valid folder name/);
    await assert.rejects(addProject(f.runtime.git, { mode: 'create', path: f.directory } as any), /project name/);
    assert.equal(fs.readFileSync(path.join(plain, 'keep.txt'), 'utf8'), 'keep');
  } finally { f.close(); }
});

test('clone rejects unsafe transports and credentials and passes only fixed HTTPS arguments', async () => {
  const f = fixture();
  try {
    for (const url of ['file:///tmp/repo', 'ext::whoami', '--upload-pack=evil', 'https://user:secret@example.com/repo.git', 'https://example.com/repo.git?token=secret']) {
      await assert.rejects(addProject(f.runtime.git, { mode: 'clone', path: f.directory, name: 'clone-target', url }));
    }
    const before = f.calls.length;
    let cloneCall: string[] = [];
    const git = new AdeGit(f.runtime.store, async (executable, args, options) => {
      if (args[0] === 'clone') {
        cloneCall = args;
        assert.equal(options?.env?.GIT_TERMINAL_PROMPT, '0');
        assert.equal(options?.timeoutMs, 120000);
        execFileSync(GIT_PATH, ['init', '--', args.at(-1)!], { windowsHide: true, stdio: 'ignore' });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return f.runtime.git.runner(executable, args, options);
    });
    const project = await addProject(git, { mode: 'clone', path: f.directory, name: 'clone-target', url: 'https://github.com/example/repo.git' });
    assert.equal(project.kind, 'git');
    assert.deepEqual(cloneCall.slice(0, -1), ['clone', '--quiet', '--no-recurse-submodules', '--', 'https://github.com/example/repo.git']);
    assert.equal(f.calls.slice(0, before).some(args => args[0] === 'clone'), false);
  } finally { f.close(); }
});

test('hookless Codex root status updates the dashboard immediately and resets on exact-session resume', async () => {
  const f = fixture();
  const script = String.raw`const report=s=>process.stdout.write('\x1b]7501;state='+s+':app=codex\x1b\\');report('idle');process.stdin.on('data',d=>{if(d.includes('work'))report('working');if(d.includes('done'))report('idle');if(d.includes('exit'))process.exit(0)});`;
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), async () => '11234567-1234-1234-1234-123456789abc', () => {}, () => {});
  Object.defineProperty(f.runtime, 'sessions', { value: sessions });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!condition()) { if (Date.now() > deadline) throw new Error('Codex status fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    let changes = 0;
    sessions.subscribeStatus(project.id, () => { changes++; });
    const record = await sessions.launch(project.id, tree.id, tree.path, 'codex');
    await until(() => sessions.status(project.id, record.id).data?.state === 'idle');
    const before = changes;
    await sessions.input(project.id, record.id, 'work\r');
    await until(() => sessions.status(project.id, record.id).data?.state === 'working');
    assert.ok(changes > before);
    assert.equal((await f.runtime.snapshot(project.id)).graph.data?.nodes.find(node => node.id === record.id)?.state, 'working');
    await sessions.input(project.id, record.id, 'done\r');
    await until(() => sessions.status(project.id, record.id).data?.state === 'completed');
    await sessions.input(project.id, record.id, 'exit\r');
    await until(() => !sessions.page(project.id, record.id).live);
    assert.equal((await f.runtime.snapshot(project.id)).graph.data?.nodes.find(node => node.id === record.id)?.state, 'unknown');
    await sessions.resume(project.id, record.id);
    await until(() => sessions.status(project.id, record.id).data?.state === 'idle');
    assert.equal(sessions.status(project.id, record.id).data?.source, 'provider-terminal');
  } finally {
    f.runtime.close();
    await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('owned PTYs round-trip input, bound output, track exit separately and enforce project identity', async () => {
  const f = fixture();
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath,
    args: ['-e', "process.stdout.write('ADE_PTY_READY\\n');process.stdin.on('data',d=>{process.stdout.write('ADE_ECHO:'+d);if(d.includes('exit-ade'))process.exit(0)})", '--'] }), async (_resolved, _cwd, _title, id) => id ?? '01234567-1234-1234-1234-123456789abc', undefined, () => {});
  const deadline = async (condition: () => boolean) => {
    const until = Date.now() + 8000;
    while (!condition()) {
      if (Date.now() > until) throw new Error('PTY did not reach the expected state');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  try {
    const project = await f.runtime.git.register(f.repo);
    const tree = (await f.runtime.git.worktrees(project))[0];
    const session = await sessions.launch(project.id, tree.id, tree.path, 'codex');
    await deadline(() => sessions.page(project.id, session.id).data.includes('ADE_PTY_READY'));
    assert.equal(sessions.page(project.id, session.id).live, true);
    assert.throws(() => sessions.input(project.id, session.id, 'x'.repeat(16385)), /16384/);
    assert.throws(() => sessions.resize(project.id, session.id, 10000, 20), /dimensions/);
    await sessions.resize(project.id, session.id, 90, 24);
    await sessions.input(project.id, session.id, 'hello-ade\r');
    await deadline(() => sessions.page(project.id, session.id).data.includes('ADE_ECHO:hello-ade'));
    const page = sessions.page(project.id, session.id);
    assert.equal(sessions.page(project.id, session.id, page.cursor).data, '');
    await sessions.input(project.id, session.id, 'exit-ade\r');
    await deadline(() => !sessions.page(project.id, session.id).live);
    assert.equal(sessions.page(project.id, session.id).exitCode, 0);
    assert.throws(() => sessions.input(project.id, session.id, 'again'), /no longer running/);
    assert.equal(sessions.page(project.id, session.id).resumable, true);
    assert.equal((await sessions.resume(project.id, session.id)).providerThreadId, session.providerThreadId);
    assert.equal(sessions.page(project.id, session.id).live, true);
    await assert.rejects(sessions.resume(project.id, session.id), /already running/);
    await sessions.input(project.id, session.id, 'exit-ade\r');
    await deadline(() => !sessions.page(project.id, session.id).live);
    assert.equal(f.runtime.store.sessions(project.id).length, 1);
    const restarted = new AdeSessions(f.runtime.store);
    try { assert.equal(restarted.page(project.id, session.id).resumable, true); }
    finally { restarted.close(); }
    sessions.closeSession(project.id, session.id);
    assert.throws(() => sessions.page(project.id, session.id), /does not belong/);
  } finally { sessions.close(); f.close(); }
});

test('standalone API owns onboarding and validates origins, methods, bodies and query scope', async () => {
  const f = fixture();
  const server = createServer({ localRuntime: f.runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, value: unknown) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const prereqs = await (await fetch(base + '/api/prerequisites')).json();
    assert.equal(prereqs.runtime, 'ade'); assert.equal(prereqs.ready, true); assert.equal(prereqs.orcaApp, false);
    assert.equal((await fetch(base + '/api/projects', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/projects', { method: 'POST', body: 'path=x' })).status, 400);
    assert.equal((await post('/api/projects', { path: f.repo, command: 'whoami' })).status, 400);
    const registered = await post('/api/projects', { path: f.repo }); assert.equal(registered.status, 201);
    const { project } = await registered.json();
    assert.equal((await (await fetch(base + '/api/projects')).json()).data.projects[0].id, project.id);
    const projectRoute = `/api/projects/${project.id}`;
    const snapshot = await (await fetch(base + projectRoute + '/snapshot')).json();
    const nodeId = snapshot.graph.data.nodes[0].id;
    assert.equal((await fetch(base + projectRoute + `/nodes/${nodeId}?limit=20&direction=older`)).status, 200);
    assert.equal((await fetch(base + projectRoute + '/snapshot?runId=foreign')).status, 404);
    assert.equal((await fetch(base + projectRoute + '/snapshot?x=y')).status, 400);
    assert.equal((await fetch(base + projectRoute + '/snapshot?runId=x&runId=y')).status, 400);
    assert.equal((await fetch(base + projectRoute + '/worktrees')).status, 405);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/create-agent`, { command: 'powershell' })).status, 400);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/terminal-input`, { data: 'test' })).status, 404);
    assert.equal((await fetch(base + projectRoute + `/nodes/${nodeId}/terminal?cursor=-1`)).status, 400);
    assert.equal((await fetch(base + projectRoute + '/commit-graph?nodeId=foreign')).status, 404);
    const catalog = await (await fetch(base + '/api/agents/catalog')).json();
    assert.deepEqual(catalog.available.map((item: { id: string }) => item.id), ['codex', 'claude', 'antigravity', 'terminal']);
    assert.ok(catalog.installed.every((item: { command: string }) => ['codex', 'claude', 'agy', 'terminal'].includes(item.command)));
    assert.equal((await (await fetch(base + '/api/usage')).json()).meta.availability, 'unavailable');
    const refreshes: boolean[] = [];
    const readUsage = f.runtime.connectionsService.usage.bind(f.runtime.connectionsService);
    f.runtime.connectionsService.usage = force => { refreshes.push(Boolean(force)); return readUsage(force); };
    assert.equal((await fetch(base + '/api/usage?refresh=1')).status, 200);
    assert.deepEqual(refreshes, [true]);
    assert.equal((await fetch(base + '/api/usage?refresh=anything')).status, 400);
    assert.equal((await fetch(base + '/api/usage?refresh=1&refresh=1')).status, 400);
    assert.equal((await fetch(base + '/api/resources?command=anything')).status, 400);
    assert.equal((await post('/api/connections', {})).status, 405);
    const resources = await (await fetch(base + '/api/resources')).json();
    assert.equal(resources.scope, 'backend'); assert.ok(resources.memoryBytes > 0);
    assert.equal((await post('/api/provider-accounts/codex', { label: 'bad', command: 'arbitrary' })).status, 400);
    assert.equal((await post('/api/provider-accounts/codex/select', { accountId: '../outside' })).status, 400);
    assert.equal((await fetch(base + '/api/provider-accounts/claude')).status, 200);
    assert.equal((await post('/api/provider-accounts/claude/select', { accountId: 'system' })).status, 200);
    assert.equal((await fetch(base + '/api/health', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/projects/folders')).status, 200);
    assert.equal((await fetch(base + projectRoute, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })).status, 403);
    f.runtime.store.saveSession({ id: 'test-session', projectId: project.id, worktreeId: nodeId, cwd: f.repo, provider: 'codex', title: 'Test', createdAt: new Date().toISOString(), closed: false });
    assert.equal((await fetch(base + projectRoute + '/nodes/test-session/resume')).status, 405);
    assert.equal((await post(projectRoute + '/nodes/test-session/resume', { threadId: 'forged' })).status, 400);
    assert.equal((await post(projectRoute + '/nodes/test-session/resume', {})).status, 400);
    assert.equal((await post(projectRoute + '/nodes/foreign/resume', {})).status, 404);
    assert.equal((await fetch(base + projectRoute, { method: 'DELETE' })).status, 400);
    assert.equal(f.runtime.store.project(project.id).id, project.id);
    const session = f.runtime.store.sessions(project.id)[0];
    f.runtime.store.saveSession({ ...session, closed: true });
    assert.equal((await fetch(base + projectRoute + '?unexpected=true', { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(base + projectRoute, { method: 'DELETE' })).status, 200);
    assert.deepEqual(f.runtime.store.projects(), []);
    assert.deepEqual(f.runtime.store.sessions(project.id), []);
    assert.ok(fs.existsSync(path.join(f.repo, '.git')));
    assert.equal((await fetch(base + projectRoute, { method: 'DELETE' })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); f.close();
  }
});

test('terminal launches pass the chosen fixed shell, persist it for reopen and reject shells on agents', async () => {
  const f = fixture();
  const seen: Array<string | undefined> = [];
  const sessions = new AdeSessions(f.runtime.store, (_provider, shell) => { seen.push(shell); return { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)', '--'] }; }, async () => '11234567-1234-1234-1234-123456789abc', () => {}, () => {});
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const record = await sessions.launch(project.id, tree.id, tree.path, 'terminal', 'Shell', 'cmd');
    assert.equal(record.shell, 'cmd');
    assert.equal(f.runtime.store.sessions(project.id).find(item => item.id === record.id)?.shell, 'cmd');
    await assert.rejects(() => sessions.launch(project.id, tree.id, tree.path, 'claude', undefined, 'cmd'), /only to Terminal/);
    await assert.rejects(() => sessions.launch(project.id, tree.id, tree.path, 'terminal', undefined, 'zsh' as never), /only to Terminal/);
    assert.deepEqual(seen, ['cmd']);
    sessions.closeSession(project.id, record.id);
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally { sessions.close(); f.close(); }
});