import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../http/api.js';
import { GIT_PATH, defaultCommandRunner, type CommandRunner } from '../../integrations/cli.js';
import { AdeStore, type SessionRecord } from '../store.js';
import { LocalRuntime } from '../localRuntime.js';
import { AdeSessions, resolveAgent, agentCatalog } from '../sessions/sessions.js';
import { addProject } from '../workspace/projects.js';
import { listProjectFolders } from '../workspace/projectFolders.js';
import { AdeGit } from '../workspace/git.js';
import { codexThread } from '../../providers/codex/codexThread.js';
import { WebSocket } from 'ws';
import { installAgyHook, readAgyBinding, agyBindingFile } from '../../providers/antigravity/agyBinding.js';
import { installStatusHooks, readAgentStatus, statusFile } from '../sessions/statusHooks.js';
import { AdeConversations } from '../chat/conversation.js';
import { projectShortcuts, runProjectShortcut, saveProjectShortcuts } from '../workspace/projectShortcuts.js';

test('OpenCode detection supports the current scoped package and both native command aliases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-opencode-detect-'));
  const previous = process.env.PATH;
  const bin = path.join(directory, 'node_modules', '@opencode', 'cli', 'bin'); fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  fs.writeFileSync(executable, 'fixture; not executed');
  try {
    process.env.PATH = directory;
    for (const provider of ['opencode', 'opencode2'] as const) assert.deepEqual(resolveAgent(provider), { executable, args: [] });
    assert.ok(agentCatalog().installed.some(row => row.id === 'opencode'));
    assert.ok(agentCatalog().installed.some(row => row.id === 'opencode2'));
    fs.unlinkSync(executable);
    assert.equal(resolveAgent('opencode'), null); assert.equal(resolveAgent('opencode2'), null);
    fs.mkdirSync(executable);
    assert.equal(resolveAgent('opencode2'), null, 'A directory cannot establish an installed CLI');
  } finally { process.env.PATH = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('CodeBuddy permission hooks show approval only while the native widget is actually visible', async () => {
  const f=fixture();try{
    const project=await f.runtime.git.register(f.repo),tree=(await f.runtime.git.worktrees(project))[0];
    const record:SessionRecord={id:'approval-node',projectId:project.id,worktreeId:tree.id,cwd:tree.path,provider:'codebuddy',providerThreadId:'11234567-1234-1234-1234-123456789abc',statusToken:'owned-launch',title:'CodeBuddy',closed:false,createdAt:new Date().toISOString()};
    f.runtime.store.saveSession(record);
    const screen=new TerminalScreen(()=>{},()=>{}),live={live:true,screen,turnStatus:new TerminalTurnStatus()};
    (f.runtime.sessions as any).live.set(record.id,live);
    fs.mkdirSync(path.dirname(statusFile(f.runtime.store.directory,record.id)),{recursive:true});
    fs.writeFileSync(statusFile(f.runtime.store.directory,record.id),JSON.stringify({token:record.statusToken,provider:record.provider,id:record.providerThreadId,state:'waiting',event:'PermissionRequest',attention:'approval',at:new Date().toISOString()}));
    screen.write('Working on the task');await screen.settled();
    assert.equal(f.runtime.sessions.status(project.id,record.id).data?.state,'working');
    screen.write('\x1b[2J\x1b[HPowerShell command\r\nnpm test\r\nDo you want to proceed?\r\n> 1. Yes\r\n  2. Yes, and do not ask again for session\r\n  3. No, adjust the command');await screen.settled();
    assert.equal(f.runtime.sessions.status(project.id,record.id).data?.attention,'approval');
    screen.write('\x1b[2J\x1b[HWorking on the task');await screen.settled();
    for(let i=0;i<10;i++)assert.equal(f.runtime.sessions.status(project.id,record.id).data?.state,'working');
    assert.equal(f.runtime.store.inboxItems().length,0);
  }finally{f.close();}
});

test('Antigravity interruption survives late hooks and redraw probes without creating extra Inbox turns', async () => {
  const f=fixture();try{
    const project=await f.runtime.git.register(f.repo),tree=(await f.runtime.git.worktrees(project))[0];
    const record:SessionRecord={id:'interruption-node',projectId:project.id,worktreeId:tree.id,cwd:tree.path,provider:'antigravity',providerThreadId:'11234567-1234-1234-1234-123456789abc',statusToken:'owned-launch',title:'Antigravity',closed:false,createdAt:new Date().toISOString()};
    f.runtime.store.saveSession(record);
    const screen=new TerminalScreen(()=>{},()=>{}),live:any={live:true,screen,turnStatus:new TerminalTurnStatus()};
    (f.runtime.sessions as any).live.set(record.id,live);
    const base=Date.now()-1000;
    const publish=(state:string,event:string,offset:number)=>{fs.mkdirSync(path.dirname(statusFile(f.runtime.store.directory,record.id)),{recursive:true});fs.writeFileSync(statusFile(f.runtime.store.directory,record.id),JSON.stringify({token:record.statusToken,provider:record.provider,id:record.providerThreadId,state,event,toolCall:{name:'run_command',summary:'npm test'},at:new Date(base+offset).toISOString()}));};
    publish('working','PreInvocation',0);f.runtime.sessions.status(project.id,record.id);
    live.programStatus={data:{state:'interrupted',source:'provider-terminal',event:'native-interrupt-confirmation'},meta:{availability:'ready',stale:false,observedAt:new Date(base+100).toISOString()}};
    publish('working','PreToolUse',200);
    for(let i=0;i<13;i++){
      assert.equal(f.runtime.sessions.status(project.id,record.id).data?.state,'interrupted');
      (f.runtime.sessions as any).attentionStatus(record,live.lastHook);
    }
    assert.equal(f.runtime.store.db.prepare('SELECT count(*) n FROM turn_results').get()?.n,1);
    publish('working','PreInvocation',300);assert.equal(f.runtime.sessions.status(project.id,record.id).data?.state,'working');
    publish('completed','Stop',400);assert.equal(f.runtime.sessions.status(project.id,record.id).data?.state,'completed');
    assert.equal(f.runtime.store.inboxItems().length,2,'A genuinely new invocation must retain its own outcome');
  }finally{f.close();}
});

test('Inbox collapses historical duplicates of an exact turn observation without deleting rows or merging separate turns',()=>{
  const f=fixture();try{
    const project=f.runtime.store.register(f.repo);
    const item={projectId:project.id,projectName:project.name,nodeId:'node',entityId:'node',runId:null,title:'Agent',source:'turn',outcome:'interrupted',at:'2026-10-26T08:13:08.318Z'};
    for(let i=0;i<9;i++)f.runtime.store.db.prepare('INSERT INTO turn_results VALUES(?,?,?)').run(`duplicate-${i}`,item.at,JSON.stringify({...item,id:`duplicate-${i}`}));
    const other={...item,id:'another-turn',at:'2026-10-26T08:14:00.000Z'};
    f.runtime.store.db.prepare('INSERT INTO turn_results VALUES(?,?,?)').run(other.id,other.at,JSON.stringify(other));
    assert.deepEqual(f.runtime.store.inboxItems().map(item=>item.id),['another-turn','duplicate-0']);
    assert.equal(f.runtime.store.db.prepare('SELECT count(*) n FROM turn_results').get()?.n,10);
  }finally{f.close();}
});

test('folder inventory detects git init without changing project identity or agent bindings', async () => {
  const f = fixture();
  try {
    const folder = path.join(f.directory, 'plain workspace'); fs.mkdirSync(folder);
    const project = f.runtime.store.register(folder, 'My workspace', 'folder');
    assert.equal(project.kind, 'folder');
    const tree = (await f.runtime.git.worktrees(project))[0];
    const agent: SessionRecord = { id: 'saved-agent', projectId: project.id, worktreeId: tree.id, cwd: folder, provider: 'codex', title: 'My agent', closed: true, createdAt: new Date().toISOString() };
    f.runtime.store.saveSession(agent);
    f.runtime.store.rename(tree.id, 'My checkout');
    execFileSync(GIT_PATH, ['init'], { cwd: folder, windowsHide: true, stdio: 'ignore' });
    const [first, second] = await Promise.all([f.runtime.git.projects(), f.runtime.git.projects()]);
    const updated = first.find(row => row.id === project.id)!;
    assert.deepEqual(second, first);
    assert.equal(updated.kind, 'git'); assert.equal(updated.name, 'My workspace');
    assert.deepEqual(updated.paths, project.paths); assert.deepEqual(updated.repoIds, [project.id]);
    assert.equal((await f.runtime.git.worktrees(updated))[0].id, tree.id);
    assert.deepEqual(f.runtime.store.sessions(project.id), [agent]);
    assert.equal(f.runtime.store.title(tree.id, ''), 'My checkout');
    assert.equal((await f.runtime.git.register(folder)).id, project.id);
    assert.equal(f.runtime.store.projects().length, 1);
    assert.ok(f.calls.every(args => ['rev-parse', 'worktree'].includes(args[0])), 'Detection must never mutate Git');
  } finally { f.close(); }
});

test('folder detection ignores nested, inherited and invalid repository markers', async () => {
  const f = fixture();
  try {
    const nested = path.join(f.directory, 'container'); fs.mkdirSync(nested);
    const child = path.join(nested, 'repo'); fs.mkdirSync(child);
    const project = f.runtime.store.register(nested, undefined, 'folder');
    execFileSync(GIT_PATH, ['init'], { cwd: child, windowsHide: true, stdio: 'ignore' });
    const inherited = path.join(f.repo, 'child folder'); fs.mkdirSync(inherited);
    const registered = f.runtime.store.register(inherited, 'Existing folder', 'folder');
    const invalid = path.join(f.directory, 'invalid'); fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, '.git'), 'not a repository');
    const broken = f.runtime.store.register(invalid, undefined, 'folder');
    await f.runtime.git.projects();
    for (const item of [project, registered, broken]) assert.equal(f.runtime.store.project(item.id).kind, 'folder');
  } finally { f.close(); }
});

test('project shortcuts validate commands, persist by project and stage once in a new owned shell', async () => {
  const f = fixture();
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const marker = path.join(f.directory, 'shortcut-ran.txt');
    const command = process.platform === 'win32' ? `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value done` : `printf done > '${marker.replaceAll("'", "'\\''")}'`;
    const shortcut = { id: 'dev', label: 'Dev server', action: 'terminal' as const, command, appendEnter: false, agent: 'codex' as const };
    saveProjectShortcuts(f.runtime.store, project.id, [shortcut]);
    assert.deepEqual(projectShortcuts(f.runtime.store, project.id), [shortcut]);
    assert.throws(() => saveProjectShortcuts(f.runtime.store, project.id, [shortcut, shortcut]), /Invalid/);
    assert.throws(() => saveProjectShortcuts(f.runtime.store, project.id, [{ ...shortcut, command: '\x1b[31m' }]), /Invalid/);
    const result = await runProjectShortcut(f.runtime, project.id, shortcut.id, tree.id);
    assert.equal(result.staged, true);
    assert.equal(f.runtime.sessions.require(project.id, result.nodeId).cwd, tree.path);
    assert.equal(fs.existsSync(marker), false, 'Append Enter off must not execute the command');
    await f.runtime.sessions.input(project.id, result.nodeId, '\r');
    const deadline = Date.now() + 4000;
    let markerContent = '';
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(marker)) {
          markerContent = fs.readFileSync(marker, 'utf8').trim();
          if (markerContent === 'done') break;
        }
      } catch (error) {
        if (error && (error as { code?: string }).code !== 'EBUSY') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(markerContent, 'done');
    saveProjectShortcuts(f.runtime.store, project.id, []);
    assert.equal(f.runtime.sessions.page(project.id, result.nodeId).live, true, 'Removing shortcut leaves its process running');
    await assert.rejects(runProjectShortcut(f.runtime, project.id, shortcut.id, tree.id), /no longer exists/);
  } finally { f.runtime.close(); await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
import { LocalConnections } from '../system/connections.js';
import { DatabaseSync } from 'node:sqlite';
import { TerminalScreen } from '../sessions/terminalScreen.js';
import { agyConversationSaved } from '../../providers/antigravity/agyBinding.js';
import { permissionArgs, readAgentPreferences, saveAgentPreferences } from '../system/agentPreferences.js';
import { processTreeMemory, ResourceReader } from '../system/resources.js';
import { terminalInteraction } from '../sessions/interaction.js';

test('agent preferences persist fixed modes and reject unsupported Auto and command injection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-preferences-'));
  let store = new AdeStore(directory);
  try {
    const value = readAgentPreferences(store);
    assert.equal(value.providers.codex.mode, 'yolo');
    value.providers.codex.mode = 'auto'; value.providers.claude.mode = 'manual';
    saveAgentPreferences(store, value); store.close(); store = new AdeStore(directory);
    assert.deepEqual(readAgentPreferences(store), value);
    assert.deepEqual(permissionArgs.codex.auto, ['--approve-for-me']);
    assert.deepEqual(permissionArgs.claude.manual, ['--permission-mode', 'default']);
    assert.throws(() => saveAgentPreferences(store, { ...value, providers: { ...value.providers, antigravity: { enabled: true, mode: 'auto' } } }), /not supported/);
    assert.throws(() => saveAgentPreferences(store, { ...value, providers: { ...value.providers, codex: { enabled: false, mode: 'auto' } } }), /default agent/);
    assert.throws(() => saveAgentPreferences(store, { ...value, command: 'arbitrary' } as any), /Invalid agent/);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('resource trees include terminals and agent descendants once and exclude unrelated processes', async () => {
  assert.deepEqual(processTreeMemory([
    { pid: 1, parent: 0, bytes: 10 }, { pid: 2, parent: 1, bytes: 20 }, { pid: 3, parent: 2, bytes: 30 }, { pid: 4, parent: 0, bytes: 1000 },
  ], [1, 2, 1]), { memoryBytes: 60, processCount: 3 });
  const value = await new ResourceReader().read([], null);
  assert.ok(value.memoryBytes > 0);
  assert.ok(['backend-tree', 'backend'].includes(value.scope));
  if (value.scope === 'backend-tree') assert.ok(value.processCount! >= 1);
});

test('RAM summaries avoid detailed process metadata and share cached scans', async t => {
  const reader = new ResourceReader(), calls: boolean[] = [];
  t.mock.method(reader as any, 'collect', async (detailed = true) => {
    calls.push(detailed);
    return [{ pid: process.pid, parent: 0, bytes: 1234, ...(detailed ? { name: 'Fixture', commandLine: 'owned', cpuSeconds: 1 } : {}) }];
  });
  const [first, second] = await Promise.all([reader.read([], null), reader.read([], null)]);
  assert.equal(first.memoryBytes, 1234); assert.equal(second.memoryBytes, 1234);
  assert.deepEqual(calls, [false]);
  const details = await reader.details([], null);
  assert.equal(details.groups[0].processes[0].name, 'Fixture');
  assert.deepEqual(calls, [false, true]);
  await reader.snapshot(); await reader.snapshot(false, false);
  assert.deepEqual(calls, [false, true], 'Fresh detailed data can serve either view without another scan');
});

test('rendered prompt parsing is bounded, excludes multi-select and distinguishes approvals', () => {
  assert.equal(terminalInteraction('ordinary output\n1. One\n2. Two', 'codex', 'token'), null);
  assert.equal(terminalInteraction('Which one?\n1. One\n2. Two\nSpace to select', 'claude', 'token'), null);
  assert.equal(terminalInteraction('Which one?\n1. One\n2. Two', 'terminal', 'token'), null);
  const prompt = terminalInteraction('Would you like to run this command?\n$ node --version\n› 1. Yes, proceed\n  2. No, cancel', 'codex', 'token');
  assert.equal(prompt?.kind, 'approval');
  assert.equal(prompt?.detail, '$ node --version');
  assert.equal(prompt?.options[1].id, '2');
  assert.notEqual(prompt?.id, terminalInteraction('Would you like to run this command?\n$ node --version\n› 1. Yes, proceed\n  2. No, cancel', 'codex', 'new-launch')?.id);
  assert.equal(terminalInteraction('Would you like to run this command?\n› 1. Yes, proceed\n  2. No, cancel', 'codex', 'token'), null, 'no blind approvals without command context');
});

test('all agents expose waiting questions, fence Chat answers and persist exact turn Inbox results', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-interaction-'));
  const runtime = new LocalRuntime(new AdeStore(directory));
  const id = '31234567-1234-1234-1234-123456789abc';
    const script = String.raw`const fs=require('node:fs');const provider=process.env.ADE_STATUS_PROVIDER,id=process.env.ADE_STATUS_SESSION||'31234567-1234-1234-1234-123456789abc';
    if(process.env.ADE_BINDING_FILE){fs.mkdirSync(require('node:path').dirname(process.env.ADE_BINDING_FILE),{recursive:true});fs.writeFileSync(process.env.ADE_BINDING_FILE,JSON.stringify({token:process.env.ADE_BINDING_TOKEN,id}));}
    function status(state,event,attention,toolCall){fs.writeFileSync(process.env.ADE_STATUS_FILE,JSON.stringify({token:process.env.ADE_STATUS_TOKEN,provider,id,state,event,attention,toolCall,at:new Date().toISOString()}));}
    fs.writeFileSync(process.env.ADE_STATUS_FILE+'.args',JSON.stringify(process.argv.slice(1)));
    process.stdin.setRawMode?.(true);status('waiting','PreToolUse','question');process.stdout.write('\x1b[2J\x1b[HWhich implementation should I use?\r\n1. Small change\r\n2. Full rewrite\r\n');
    process.stdin.on('data',data=>{if(data.toString()==='SHOW_APPROVAL'){status('working','PreToolUse',undefined,{name:'run_command',summary:'node --version'});process.stdout.write('\x1b[2J\x1b[HDo you want to proceed?\r\n$ node --version\r\n1. Yes, proceed\r\n2. No, cancel\r\nEnter to confirm, Esc to cancel');}if(data.toString()==='2'){fs.writeFileSync(process.env.ADE_STATUS_FILE+'.answer',data);status('working','PostToolUse');process.stdout.write('\x1b[2J\x1b[HContinuing');setTimeout(()=>status('completed','Stop'),150);}});`;
  const sessions = new AdeSessions(runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), async () => id, () => {}, () => {});
  Object.defineProperty(runtime, 'sessions', { value: sessions });
  const server = createServer({ localRuntime: runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const until = async (condition: () => boolean) => { const end = Date.now() + 8000; while (!condition()) { if (Date.now() > end) throw new Error('Interaction fixture timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
  try {
    const project = runtime.store.register(directory, 'Interactive project', 'folder'), tree = (await runtime.git.worktrees(project))[0];
    const preferences = readAgentPreferences(runtime.store);
    preferences.providers.codex.mode = 'auto'; preferences.providers.claude.mode = 'manual'; preferences.providers.antigravity.mode = 'manual';
    const savePreferences = (value: unknown) => fetch(base + '/api/agents/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal((await savePreferences({ ...preferences, command: 'arbitrary' })).status, 400);
    assert.equal((await savePreferences(preferences)).status, 200);
    assert.equal((await (await fetch(base + '/api/agents/settings')).json()).providers.codex.mode, 'auto');
    saveAgentPreferences(runtime.store, { ...preferences, providers: { ...preferences.providers, claude: { enabled: false, mode: 'manual' } } });
    await assert.rejects(sessions.launch(project.id, tree.id, tree.path, 'claude'), /disabled/);
    saveAgentPreferences(runtime.store, preferences);
    for (const provider of ['codex', 'claude', 'antigravity'] as const) {
      const record = await sessions.launch(project.id, tree.id, tree.path, provider);
      await until(() => Boolean(sessions.interaction(project.id, record.id))).catch(error => { throw new Error(`${provider}: ${error.message}; ${JSON.stringify(sessions.status(project.id, record.id))}; ${JSON.stringify(sessions.preview(project.id, record.id))}`); });
      const prompt = sessions.interaction(project.id, record.id)!;
      const args = JSON.parse(fs.readFileSync(statusFile(directory, record.id) + '.args', 'utf8'));
      const expected = permissionArgs[provider][preferences.providers[provider].mode]!;
      if (expected.length) assert.deepEqual(args.slice(-expected.length), expected);
      else assert.deepEqual(args, []);
      assert.equal(prompt.kind, 'question');
      assert.equal(sessions.status(project.id, record.id).data?.attention, 'question');
      const url = `${base}/api/projects/${project.id}/nodes/${record.id}/interaction`;
      const post = (value: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      assert.equal((await post({ promptId: 'stale', optionId: '2' })).status, 400);
      assert.equal((await post({ promptId: prompt.id, optionId: 'exec arbitrary command' })).status, 400);
      await sessions.input(project.id, record.id, '\x1b[B');
      assert.equal((await post({ promptId: prompt.id, optionId: '2' })).status, 400, 'terminal input invalidates stale cards');
      const fresh = sessions.interaction(project.id, record.id)!;
      assert.equal((await post({ promptId: fresh.id, optionId: '2' })).status, 200);
      assert.equal((await post({ promptId: fresh.id, optionId: '2' })).status, 400, 'never deliver an answer twice');
      await until(() => sessions.status(project.id, record.id).data?.state === 'completed');
      assert.equal(fs.readFileSync(statusFile(directory, record.id) + '.answer', 'utf8'), '2');
      const inbox = await (await fetch(base + '/api/inbox')).json();
      const items = inbox.data.items.filter((item: any) => item.nodeId === record.id && item.source === 'turn');
      assert.equal(items.length, 1); assert.equal(items[0].outcome, 'completed'); assert.equal(items[0].source, 'turn');
      assert.equal((await (await fetch(base + '/api/inbox')).json()).data.items.length, inbox.data.items.length);
      const publish = (state: string, event: string) => {
        const current = sessions.require(project.id, record.id);
        fs.writeFileSync(statusFile(directory, record.id), JSON.stringify({ token: current.statusToken, provider, id: current.providerThreadId, state, event, at: new Date().toISOString() }));
        return sessions.status(project.id, record.id);
      };
      publish('working', provider === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit');
      publish('interrupted', provider === 'codex' ? 'Interrupt' : 'Stop');
      publish('working', provider === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit');
      publish('failed', 'Stop');
      const results = (await (await fetch(base + '/api/inbox')).json()).data.items.filter((item: any) => item.nodeId === record.id && item.source === 'turn');
      assert.deepEqual(new Set(results.map((item: any) => item.outcome)), new Set(['completed', 'interrupted', 'failed']));
      if (provider === 'antigravity') {
        await sessions.input(project.id, record.id, 'SHOW_APPROVAL');
        await until(() => sessions.interaction(project.id, record.id)?.kind === 'approval');
        const approval = sessions.interaction(project.id, record.id)!;
        assert.equal(approval.detail, 'node --version');
        assert.equal(sessions.status(project.id, record.id).data?.attention, 'approval');
        await sessions.answer(project.id, record.id, { promptId: approval.id, optionId: '2' });
        await until(() => sessions.status(project.id, record.id).data?.state === 'completed');
      }
    }
    assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS n FROM turn_results').get()?.n, 10);
    const closed = runtime.store.sessions(project.id).at(-1)!;
    sessions.closeSession(project.id, closed.id);
    const archived = (await (await fetch(base + '/api/inbox')).json()).data.items.filter((item: any) => item.entityId === closed.id);
    assert.ok(archived.length > 0 && archived.every((item: any) => item.nodeId === null), 'archived results remain readable without broken agent links');
  } finally {
    runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

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
import { antigravityPromptReady, programStatusReader, TerminalTurnStatus } from '../sessions/programStatus.js';

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
    const script = "const fs=require('node:fs');let pending='';process.stdin.setRawMode(true);process.stdin.on('data',d=>{fs.appendFileSync(__LOG_FILE__,JSON.stringify(d.toString())+'\\n');pending+=d.toString();const match=pending.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/);if(match){setTimeout(()=>process.stdout.write('\\x1b[2J\\x1b[H> [Pasted Content '+Array.from(match[1]).length+' chars]'),450);pending='';}if(d.includes('\\r'))process.stdout.write('\\x1b[2J\\x1b[H? for shortcuts\\r\\n> \\x1b[2mAsk Codex\\x1b[0m\\x1b[10G');});process.stdout.write('READY\\r\\n? for shortcuts\\r\\n> \\x1b[2mAsk Codex\\x1b[0m\\x1b[10G');".replace('__LOG_FILE__', JSON.stringify(log));
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
      state = 'working';
      await assert.rejects(sessions.send(project.id, record.id, { message: 'queued task', requireIdle: true }), /empty, idle/);
      assert.equal(captured(), '');
      state = 'idle';
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
      if (provider === 'antigravity') await until(() => antigravityPromptReady(sessions.preview(project.id, record.id).output ?? ''));
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
      if (!agy) assert.equal(await reader.metadata(record), metadata, 'unchanged exact-session metadata is reused');
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
          const initialEvents=new TextDecoder().decode((await stream.read()).value);
          assert.match(initialEvents,/event: conversation/);
          assert.match(initialEvents,/event: node-status/,'node status is published independently of public conversation rows');
          let notify!: () => void;
          const changed = new Promise<void>(resolve => { notify = resolve; });
          const stopWatching = reader.watch(record, notify);
          fs.appendFileSync(file, JSON.stringify(turn(46)) + '\n');
          let watchTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([changed, new Promise<never>((_resolve, reject) => { watchTimeout = setTimeout(() => reject(new Error('Exact transcript watcher did not observe append')), 1500); })]);
          } finally { clearTimeout(watchTimeout); stopWatching(); }
          assert.equal((await reader.metadata(record)).preview, 'public 46', 'transcript changes invalidate metadata cache');
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
    run('claude', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'node --version', secret: 'must-not-store' } });
    assert.equal(readAgentStatus(directory, record, true).data?.attention, 'approval');
    assert.deepEqual(readAgentStatus(directory, record, true).data?.toolCall, { name: 'Bash', summary: 'node --version' });
    assert.ok(!fs.readFileSync(statusFile(directory, record.id), 'utf8').includes('must-not-store'));
    run('claude', 'PreToolUse', { tool_name: 'AskUserQuestion' });
    assert.equal(readAgentStatus(directory, record, true).data?.attention, 'question');
    run('claude', 'Notification', { notification_type: 'idle_prompt' });
    assert.equal(readAgentStatus(directory, record, true).data?.attention, 'question', 'idle notifications cannot replace an outstanding question');
    run('claude','Stop');
    const completed=fs.readFileSync(statusFile(directory,record.id),'utf8');
    run('claude','Notification',{notification_type:'idle_prompt'});
    assert.equal(fs.readFileSync(statusFile(directory,record.id),'utf8'),completed,'idle notifications preserve the terminal outcome');
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

test('Claude legacy idle notifications clear only at an empty native composer, without inventing completion',async()=>{
  const sessions=Object.create(AdeSessions.prototype) as any,screen=new TerminalScreen(()=>{},()=>{});
  const record={provider:'claude',id:'node'} as SessionRecord;
  const status={data:{state:'waiting',source:'provider-hook',event:'Notification'},meta:{availability:'ready',observedAt:new Date().toISOString()}};
  Object.assign(sessions,{sending:new Set(),live:new Map([['node',{live:true,screen}]])});
  try{
    screen.write('\x1b[2J\x1b[H❯ \x1b[1;3H');await screen.settled();
    const result=sessions.attentionStatus(record,status);assert.equal(result.data.state,'idle');assert.equal(result.data.event,'native-idle-prompt');
    for(const attention of ['question','approval','auth'])assert.equal(sessions.attentionStatus(record,{...status,data:{...status.data,attention}}).data.state,'waiting');
    sessions.sending.add('node');assert.equal(sessions.attentionStatus(record,status).data.state,'waiting');sessions.sending.clear();
    screen.write('\x1b[2J\x1b[H❯ draft\x1b[1;8H');await screen.settled();assert.equal(sessions.attentionStatus(record,status).data.state,'waiting');
    screen.write('\x1b[2J\x1b[HDo you want to proceed?\r\n❯ 1. Yes\x1b[2;4H');await screen.settled();assert.equal(sessions.attentionStatus(record,status).data.state,'waiting');
  }finally{screen.dispose();}
});

test('Codex image chips are counted only in the current composer row', async () => {
  const screen = new TerminalScreen(() => {}, () => {});
  try {
    screen.write('\x1b[2J\x1b[H\u203a \x1b[1;3H'); await screen.settled();
    assert.equal(screen.codexComposerImageCount(), 0);
    // A converted paste renders one chip per attached image.
    screen.write('\x1b[2J\x1b[H\u203a [Image #1] [Image #2] fix it\x1b[1;28H'); await screen.settled();
    assert.equal(screen.codexComposerImageCount(), 2);
    // A transcript row above the composer is not a pending attachment.
    screen.write('\x1b[2J\x1b[H\u203a [Image #9] old turn\r\n\u203a draft\x1b[2;8H'); await screen.settled();
    assert.equal(screen.codexComposerImageCount(), 0);
  } finally { screen.dispose(); }
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

test('project onboarding browses folders, registers plain workspaces and creates repositories without overwriting', async t => {
  const f = fixture();
  // The host's temporary directory may itself be inside a checkout (for example,
  // a home-directory dotfiles repository). Hide only those ancestor markers so
  // this fixture has a genuinely plain workspace without changing host files.
  const ancestorMarkers = new Set<string>();
  for (let directory = path.dirname(f.directory);; directory = path.dirname(directory)) {
    ancestorMarkers.add(path.join(directory, '.git'));
    if (path.dirname(directory) === directory) break;
  }
  const existsSync = fs.existsSync;
  t.mock.method(fs, 'existsSync', (file: fs.PathLike) =>
    typeof file === 'string' && ancestorMarkers.has(file) ? false : existsSync(file));
  try {
    const nested = path.join(f.repo, 'nested'); fs.mkdirSync(nested);
    const checkout = await addProject(f.runtime.git, { path: nested });
    assert.equal(checkout.kind, 'git');
    assert.equal(checkout.paths[0], fs.realpathSync(f.repo), 'Folders inside a checkout still resolve to its repository root');
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

for (const freshLaunch of [false, true]) test(`Codex ${freshLaunch ? 'launch' : 'resume'} initialization does not create a working turn or Inbox result`, async () => {
  const f = fixture();
  const script = String.raw`const report=s=>process.stdout.write('\x1b]7501;state='+s+':app=codex\x1b\\');report('working');setTimeout(()=>{report('idle');setTimeout(()=>{report('working');process.stdout.write('Weekly limit: 23% left');setTimeout(()=>{report('idle');process.stdout.write('RESTORED');},100);},100);},200);process.stdin.on('data',d=>{if(d.includes('work'))report('working');if(d.includes('done'))report('idle')});`;
  const id = '11234567-1234-1234-1234-123456789abc';
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), async () => id, () => {}, () => {});
  Object.defineProperty(f.runtime, 'sessions', { value: sessions });
  const notifications: string[] = [];
  const unsubscribe = sessions.subscribeResults(item => { notifications.push(item.id); assert.equal(item.outcome, 'completed'); });
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 6000; while (!condition()) { if (Date.now() > deadline) throw new Error('Resume fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const record = { id: crypto.randomUUID(), projectId: project.id, worktreeId: tree.id, cwd: tree.path, provider: 'codex' as const, title: 'Resumed', closed: false, createdAt: new Date().toISOString(), providerThreadId: id };
    f.runtime.store.saveSession(record);
    const states: string[] = [];
    sessions.subscribeStatus(project.id, () => { const state = sessions.status(project.id, record.id).data?.state; if (state) states.push(state); });
    await sessions.resume(project.id, record.id);
    await until(() => sessions.page(project.id, record.id).data.includes('RESTORED'));
    assert.equal(sessions.status(project.id, record.id).data?.state, 'idle');
    assert.ok(!states.includes('working')); assert.ok(!states.includes('completed'));
    assert.equal(f.runtime.store.db.prepare('SELECT count(*) AS total FROM turn_results').get()?.total, 0);
    assert.equal(notifications.length, 0, 'Restored history must not notify');
    await sessions.input(project.id, record.id, 'work\r'); await until(() => sessions.status(project.id, record.id).data?.state === 'working');
    await sessions.input(project.id, record.id, 'done\r'); await until(() => sessions.status(project.id, record.id).data?.state === 'completed');
    assert.equal(f.runtime.store.db.prepare('SELECT count(*) AS total FROM turn_results').get()?.total, 1);
    assert.equal(notifications.length, 1, 'A fresh completed turn notifies once');
    sessions.status(project.id, record.id); sessions.status(project.id, record.id);
    assert.equal(notifications.length, 1, 'Repeated status reads must not duplicate notifications');
    unsubscribe();
    await sessions.input(project.id, record.id, 'work\r'); await until(() => sessions.status(project.id, record.id).data?.state === 'working');
    await sessions.input(project.id, record.id, 'done\r'); await until(() => sessions.status(project.id, record.id).data?.state === 'completed');
    assert.equal(notifications.length, 1, 'Unsubscribed listeners must not receive later turns');
  } finally { f.runtime.close(); await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
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
    assert.equal((await fetch(base + projectRoute + `/nodes/${nodeId}/rewind`)).status,405);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/rewind`,{messageId:'message',sourceIdentity:'source',revision:'revision',beforeSeq:0})).status,400);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/rewind`,{messageId:'../../native',sourceIdentity:'source',revision:'revision'})).status,400);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/rewind?unexpected=stale`,{messageId:'message',sourceIdentity:'source',revision:'revision'})).status,400);
    assert.equal((await fetch(base + projectRoute + '/snapshot?runId=foreign')).status, 404);
    assert.equal((await fetch(base + projectRoute + '/snapshot?x=y')).status, 400);
    assert.equal((await fetch(base + projectRoute + '/snapshot?runId=x&runId=y')).status, 400);
    assert.equal((await fetch(base + projectRoute + '/worktrees')).status, 405);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/create-agent`, { command: 'powershell' })).status, 400);
    assert.equal((await post(projectRoute + `/nodes/${nodeId}/terminal-input`, { data: 'test' })).status, 404);
    assert.equal((await fetch(base + projectRoute + `/nodes/${nodeId}/terminal?cursor=-1`)).status, 400);
    assert.equal((await fetch(base + projectRoute + '/commit-graph?nodeId=foreign')).status, 404);
    const catalog = await (await fetch(base + '/api/agents/catalog')).json();
    assert.deepEqual(catalog.available.map((item: { id: string }) => item.id), ['codex', 'claude', 'antigravity', 'codebuddy', 'opencode', 'opencode2', 'kilo', 'dsh', 'freebuff', 'terminal']);
    assert.ok(catalog.installed.every((item: { command: string }) => ['codex', 'claude', 'agy', 'codebuddy', 'opencode', 'opencode2', 'kilo', 'dsh-tui', 'freebuff', 'terminal'].includes(item.command)));
    assert.ok(['ready', 'unavailable'].includes((await (await fetch(base + '/api/usage')).json()).meta.availability));
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
    assert.ok(['backend', 'backend-tree'].includes(resources.scope)); assert.ok(resources.memoryBytes > 0);
    assert.equal((await post('/api/provider-accounts/codex', { label: 'bad', command: 'arbitrary' })).status, 400);
    assert.equal((await post('/api/provider-accounts/codex/select', { accountId: '../outside' })).status, 400);
    assert.equal((await fetch(base + '/api/provider-accounts/claude')).status, 200);
    assert.equal((await post('/api/provider-accounts/claude/select', { accountId: 'system' })).status, 200);
    assert.equal((await fetch(base + '/api/health', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/projects/folders')).status, 200);
    assert.equal((await fetch(base + projectRoute, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })).status, 403);
    f.runtime.store.saveSession({ id: 'test-session', projectId: project.id, worktreeId: nodeId, cwd: f.repo, provider: 'codex', title: 'Test', createdAt: new Date().toISOString(), closed: false });
    const handoffWorktrees = await fetch(base + projectRoute + '/nodes/test-session/handoff');
    assert.equal(handoffWorktrees.status, 200);
    const destinations = await handoffWorktrees.json();
    assert.equal(destinations.length, 1);
    assert.equal(destinations[0].id, nodeId);
    assert.equal(destinations[0].current, true);
    assert.equal(destinations[0].locked, false);
    assert.equal((await fetch(base + projectRoute + '/nodes/test-session/handoff?path=foreign')).status, 400);
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

test('notification HTTP state syncs validated scopes and persists additive reads', async () => {
  const f = fixture();
  const server = createServer({ localRuntime: f.runtime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (value: unknown) => fetch(base + '/api/notifications/state', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const read = (scopes: unknown) => fetch(base + '/api/notifications/state?' + new URLSearchParams({ scopes: JSON.stringify(scopes) }));
  try {
    assert.equal((await post({ scope: 'inbox', action: 'observe', ids: ['one'], path: 'escape' })).status, 400);
    assert.equal((await post({ scope: 'preferences', action: 'observe', ids: ['one'] })).status, 400);
    assert.equal((await post({ scope: 'github:repo::prs', action: 'acknowledge', ids: ['bad\nid'] })).status, 400);
    assert.equal((await post({ scope: 'github:repo::prs', action: 'observe', ids: ['old'] })).status, 200);
    assert.equal((await post({ scope: 'github:repo::prs', action: 'observe', ids: ['new', 'old'] })).status, 200);
    assert.equal((await post({ scope: 'github:repo::prs', action: 'acknowledge', ids: ['new'] })).status, 200);
    assert.equal((await post({ scope: 'commit:repo', action: 'observe', ids: ['sha'] })).status, 200);
    const response = await read(['github:repo::prs', 'commit:repo', 'inbox']);
    assert.equal(response.status, 200);
    const states = (await response.json()).states;
    assert.deepEqual(states['github:repo::prs'].unreadIds, []);
    assert.deepEqual(states['github:repo::prs'].readIds, ['new']);
    assert.deepEqual(states['commit:repo'].seenIds, ['sha']);
    assert.deepEqual(states.inbox.seenIds, []);
    assert.equal((await read([])).status, 400);
    assert.equal((await read(Array.from({ length: 33 }, (_, index) => `github:${index}`))).status, 400);
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


test('fresh native questions notify once and stay separate from completed turn results', async () => {
  const f = fixture();
  const sessions = f.runtime.sessions as any;
  let recordId: string | undefined;
  try {
    const project = await f.runtime.git.register(f.repo), tree = (await f.runtime.git.worktrees(project))[0];
    const record: SessionRecord = { id: crypto.randomUUID(), projectId: project.id, worktreeId: tree.id, cwd: tree.path, provider: 'claude', title: 'Question agent', closed: false, createdAt: new Date().toISOString(), statusToken: 'owned-launch' };
    recordId = record.id; f.runtime.store.saveSession(record);
    sessions.live.set(record.id, { live: true });
    const notifications: string[] = [];
    sessions.subscribeAttention((item: any) => { notifications.push(item.id); assert.equal(item.source, 'attention'); assert.equal(item.outcome, 'waiting'); });
    const observe = (state: string, at: string, attention?: string) => sessions.observeResult(record, { data: { state, source: 'provider-hook', event: state, attention }, meta: { availability: 'ready', observedAt: at } });
    observe('working', '2026-10-23T10:00:00Z');
    observe('waiting', '2026-10-23T10:00:01Z', 'question');
    observe('waiting', '2026-10-23T10:00:02Z', 'question');
    assert.equal(notifications.length, 1);
    assert.equal(f.runtime.store.db.prepare('SELECT count(*) AS n FROM inbox_attention').get()?.n, 1);
    assert.equal(f.runtime.store.db.prepare('SELECT count(*) AS n FROM turn_results').get()?.n, 0);
    observe('working', '2026-10-23T10:00:03Z');
    observe('waiting', '2026-10-23T10:00:04Z', 'approval');
    assert.equal(notifications.length, 1);
    observe('working', '2026-10-23T10:00:05Z');
    observe('waiting', '2026-10-23T10:00:06Z', 'question');
    assert.equal(notifications.length, 2);
    sessions.resultTurns.delete(record.id);
    observe('waiting', '2026-10-23T10:00:07Z', 'question');
    assert.equal(notifications.length, 2, 'Restored waiting evidence must not emit fresh notifications');
  } finally { if (recordId) sessions.live.delete(recordId); f.close(); }
});

test('terminal checkpoints restore an idle alternate-screen TUI and preserve the live output cursor', async () => {
  let parsed = () => {}; const screen = new TerminalScreen(() => {}, () => parsed());
  const write = (data: string) => new Promise<void>(resolve => { parsed = resolve; screen.write(data); });
  let restoredParsed = () => {}; const restored = new TerminalScreen(() => {}, () => restoredParsed());
  try {
    const initial = '\x1b[?1049h\x1b[2J\x1b[HAntigravity ready\r\n> ';
    await write(initial);
    const checkpoint = screen.checkpoint()!;
    assert.equal(checkpoint.cursor, initial.length);
    assert.ok(checkpoint.data.includes('Antigravity ready'));
    restored.resize(checkpoint.cols, checkpoint.rows);
    await new Promise<void>(resolve => { restoredParsed = resolve; restored.write(checkpoint.data); });
    assert.equal(restored.text(), screen.text());
    await write('hello');
    assert.equal(screen.checkpoint()!.cursor, initial.length + 5);
  } finally { screen.dispose(); restored.dispose(); }
});

test('chat controls distinguish native placeholders, typed drafts and Antigravity mode hints', async () => {
  let parsed = () => {}; const screen = new TerminalScreen(() => {}, () => parsed());
  const write = (data: string) => new Promise<void>(resolve => { parsed = resolve; screen.write(data); });
  try {
    await write('\x1b[2J\x1b[H› \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[2C');
    assert.equal(screen.composerEmpty(), true);
    await write('\x1b[2J\x1b[H' + ' '.repeat(100) + '\u203a \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[2C');
    assert.equal(screen.composerEmpty(), true, 'Codex redraw after a full-width blank spacer remains empty');
    await write('\x1b[2K\r› hello draft');
    assert.equal(screen.composerEmpty(), false);
    await write('\x1b[2K\r> Accept-edits mode: file edits auto-approved (shift+tab to cycle)\r\x1b[2C');
    assert.equal(screen.composerEmpty(), false);
    assert.equal(screen.composerEmpty(true), true);
    await write('\x1b[2K\r> typed draft\r\x1b[2C');
    assert.equal(screen.composerEmpty(true), false);
  } finally { screen.dispose(); }
});

test('compaction types the provider command once, requires a fresh acknowledgement and stays fenced', async () => {
  const f = fixture();
  const log = path.join(f.directory, 'compact-input.log');
  // A minimal Claude-like prompt: `> ` is the empty native composer, and only the
  // provider's own acknowledgement text is emitted after the command.
  const script = String.raw`const fs=require('node:fs');
process.stdout.write('\x1b[2J\x1b[Hclaude ready\r\n> ');
process.stdin.on('data',data=>{const text=data.toString();
  try{fs.appendFileSync(${JSON.stringify(log)},text);}catch{}
  if(text.includes('/compact'))process.stdout.write('\r\n  Compacting conversation…');});`;
  const sessions = new AdeSessions(f.runtime.store, () => ({ executable: process.execPath, args: ['-e', script, '--'] }), async () => '11234567-1234-1234-1234-123456789abc', undefined, () => {});
  const deadline = async (condition: () => boolean) => {
    const until = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > until) throw new Error('PTY did not reach the expected state');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  try {
    const project = await f.runtime.git.register(f.repo);
    const tree = (await f.runtime.git.worktrees(project))[0];
    const record = await sessions.launch(project.id, tree.id, tree.path, 'claude');
    await deadline(() => sessions.page(project.id, record.id).data.includes('claude ready'));
    await deadline(() => sessions.preview(project.id, record.id).output?.trimEnd().endsWith('>') === true);
    const result = await sessions.compact(project.id, record.id);
    assert.equal(result.ok, true);
    assert.match(result.message ?? '', /Compaction started/);
    // The exact native command was typed once, followed by a single submission
    // (the PTY line discipline reports the Enter as CRLF).
    await deadline(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('\r'));
    assert.equal(fs.readFileSync(log, 'utf8').replace(/\r\n/g, '\r'), '/compact\r');
    // A provider without a verified command is rejected before any input is written;
    // the capability table itself is covered by providerCompaction.test.ts.
    // A typed draft blocks compaction instead of being overwritten.
    await sessions.input(project.id, record.id, 'draft');
    await deadline(() => sessions.preview(project.id, record.id).output?.includes('draft') === true);
    await assert.rejects(() => sessions.compact(project.id, record.id), /Clear the draft|empty agent prompt/);
    assert.equal(fs.readFileSync(log, 'utf8').replace(/\r\n/g, '\r'), '/compact\r', 'a refused compaction writes nothing');
  } finally { sessions.close(); f.runtime.close(); await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
