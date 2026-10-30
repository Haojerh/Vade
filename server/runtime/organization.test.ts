import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { createServer } from '../http/api.js';
import type { LocalRuntime } from './localRuntime.js';
import type { OrganizationConfig, SendMessageRequest } from '../../shared/contracts.js';
import { AdeStore, type SessionRecord } from './store.js';
import { AdeGit } from './git.js';
import type { AdeSessions } from './sessions.js';
import { OrganizationRuntime } from './organization.js';
import { validateOrganization } from './workflowConfig.js';
import { CliError, GIT_PATH } from '../integrations/cli.js';

const config = (): OrganizationConfig => ({ version: 1, enabled: true, isolatedWorktrees: false, nodes: ['implement', 'review'].map((id, index) => ({ id, title: id, prompt: `${id} the task`, provider: 'codex', model: null, effort: null, x: 100 + index * 300, y: 100 })), edges: [{ source: 'implement', target: 'review' }] });
function fixture(gitProject = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-workflow-'));
  const repo = path.join(directory, 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync(GIT_PATH, args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  if (gitProject) { git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); fs.writeFileSync(path.join(repo, 'initial.txt'), 'initial'); git('add', '.'); git('commit', '-m', 'initial'); }
  const store = new AdeStore(path.join(directory, 'data')), project = store.register(repo, 'Fixture', gitProject ? 'git' : 'folder'), adeGit = new AdeGit(store);
  const sent: { id: string; message: string }[] = [], live = new Set<string>(), stopped: string[] = [];
  const sendCalls: { projectId: string; id: string; request: SendMessageRequest; internalWorkflow?: boolean }[] = [];
  let sendError: Error | null = null;
  const sessions = {
    require: (projectId: string, id: string) => { const value = store.sessions(projectId).find(row => row.id === id && !row.closed); if (!value) throw new Error('No session'); return value; },
    send: async (projectId: string, id: string, request: SendMessageRequest, internalWorkflow?: boolean) => { sendCalls.push({ projectId, id, request, internalWorkflow }); if (sendError) throw sendError; sent.push({ id, message: request.message }); return { ok: true as const, message: 'sent' }; },
    page: (_projectId: string, id: string) => ({ live: live.has(id) }),
    status: () => ({ data: { state: 'idle' } }),
    messagePromptReady: () => true,
    launch: async (projectId: string, worktreeId: string, cwd: string, provider: SessionRecord['provider'], title: string, _shell: unknown, workflowLaunch: SessionRecord['workflowLaunch']) => { const record: SessionRecord = { id: crypto.randomUUID(), projectId, worktreeId, cwd, provider, title, closed: false, createdAt: new Date().toISOString(), statusToken: crypto.randomUUID(), workflowLaunch }; store.saveSession(record); live.add(record.id); return record; },
    stopWorkflowWorker: async (_projectId: string, id: string) => { stopped.push(id); live.delete(id); },
    closeSession: (projectId: string, id: string) => { const record = store.sessions(projectId).find(row => row.id === id)!; store.saveSession({ ...record, closed: true }); live.delete(id); },
  } as unknown as AdeSessions;
  const runtime = new OrganizationRuntime(store, adeGit, sessions); runtime.setPort(4317); runtime.setup.install();
  runtime.setup.skillsDirectory = path.join(directory, 'home', '.agents', 'skills');
  for (const [name, source] of [['vade-cli', 'cli-SKILL.md'], ['vade-orchestration', 'SKILL.md']]) {
    const target = path.join(runtime.setup.skillsDirectory, name); fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(runtime.setup.source(source), path.join(target, 'SKILL.md'));
  }
  async function start(value = config()) {
    const tree = (await adeGit.worktrees(project))[0];
    const record: SessionRecord = { id: crypto.randomUUID(), projectId: project.id, worktreeId: tree.id, cwd: repo, provider: 'codex', title: 'Contacted agent', closed: false, createdAt: new Date().toISOString(), statusToken: crypto.randomUUID() }; store.saveSession(record); live.add(record.id);
    await runtime.configure(value); await runtime.send(project.id, record.id, { message: 'Implement two suitable features', workflowConfirmed: true });
    return { record, run: runtime.runs()[0] };
  }
  function call(sessionId: string, action: string, data: object = {}) {
    const identity = JSON.parse(fs.readFileSync(runtime.setup.file(`identities/${sessionId}.json`), 'utf8'));
    return runtime.control(identity.token, { action, runId: identity.runId, sessionId, ...data }) as Promise<any>;
  }
  return { directory, repo, store, project, adeGit, runtime, sent, sendCalls, stopped, start, call, live, setSendError: (error: Error | null) => { sendError = error; }, close: () => { runtime.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('completed workflow cleanup preserves coordinator and refuses unmerged worktrees', async () => {
  const f = fixture(true);
  try {
    const { record, run } = await f.start({ ...config(), closeWorkersOnCompletion: true, removeWorktreesOnCompletion: true });
    const tree = await f.adeGit.create(f.project, { name: 'cleanup-worker', baseBranch: run.baseSha ?? 'HEAD', setup: 'skip' });
    const worker = { ...record, id: crypto.randomUUID(), worktreeId: tree.id, cwd: tree.path };
    f.store.saveSession(worker);
    execFileSync(GIT_PATH, ['-C', tree.path, 'commit', '--allow-empty', '-m', 'unmerged'], { windowsHide: true });
    run.state = 'completed'; run.steps[0].sessionId = worker.id;
    run.streams = [{ id: 'feature', title: 'Feature', nodes: [run.steps[0].nodeId], worktreeId: tree.id, integrated: true }];
    await (f.runtime as any).cleanupCompleted(run);
    assert.equal(f.store.sessions(f.project.id).find(row => row.id === worker.id)?.closed, true);
    assert.equal(f.store.sessions(f.project.id).find(row => row.id === record.id)?.closed, false);
    assert.ok(await f.adeGit.requireWorktree(f.project, tree.id));
    assert.match(run.error!, /Worktree retained/);
    execFileSync(GIT_PATH, ['merge', '--ff-only', tree.branch!], { cwd: f.repo, windowsHide: true });
    await (f.runtime as any).cleanupCompleted(run);
    await assert.rejects(f.adeGit.requireWorktree(f.project, tree.id));
  } finally { f.close(); }
});

test('workflow configuration rejects cycles, malformed nodes and extra command fields', () => {
  const value = config(); assert.deepEqual(validateOrganization(value), value);
  assert.deepEqual(validateOrganization({ ...value, orchestratorPosition: { x: 240, y: 180 } }).orchestratorPosition, { x: 240, y: 180 });
  assert.throws(() => validateOrganization({ ...value, orchestratorPosition: { x: -1, y: 10 } }), /orchestrator position/);
  assert.throws(() => validateOrganization({ ...value, edges: [...value.edges, { source: 'review', target: 'implement' }] }), /cycle/);
  assert.throws(() => validateOrganization({ ...value, nodes: [value.nodes[0], value.nodes[0]] }), /unique/);
  assert.throws(() => validateOrganization({ ...value, command: 'arbitrary' } as any), /Unexpected/);
  assert.throws(() => validateOrganization({ ...value, nodes: [] }), /Connections|at least/);
});

test('disabled workflow preserves ordinary delivery and setup gates activation', async () => {
  const f = fixture(); try {
    fs.unlinkSync(f.runtime.setup.file('SKILL.md'));
    await assert.rejects(f.runtime.configure(config()), /Install/);
    await f.runtime.send(f.project.id, 'unchanged-session', { message: 'ordinary' });
    assert.deepEqual(f.sent, [{ id: 'unchanged-session', message: 'ordinary' }]); assert.equal(f.runtime.runs().length, 0);
  } finally { f.close(); }
});

test('enabled workflow requires explicit confirmation before starting or sending', async () => {
  const f = fixture(); try {
    await f.runtime.configure(config());
    await assert.rejects(f.runtime.send(f.project.id, 'not-yet-resolved', { message: 'Spawn workers' }), /Workflow enabled, confirm/);
    assert.equal(f.runtime.runs().length, 0); assert.equal(f.sent.length, 0);
    const { run } = await f.start(); assert.equal(run.mode, 'configured'); assert.equal(f.sent.length, 1);
  } finally { f.close(); }
});

test('session CLI defines an ad hoc team without enabling or using the saved graph', async () => {
  const f = fixture(); try {
    const tree = (await f.adeGit.worktrees(f.project))[0];
    const record: SessionRecord = { id: crypto.randomUUID(), projectId: f.project.id, worktreeId: tree.id, cwd: f.repo, provider: 'codex', title: 'Contacted agent', closed: false, createdAt: new Date().toISOString(), statusToken: crypto.randomUUID() };
    f.store.saveSession(record); f.live.add(record.id);
    const env = f.runtime.cliEnvironment(record), identity = JSON.parse(fs.readFileSync(env.VADE_IDENTITY_FILE, 'utf8'));
    const call = (action: string, data: object = {}) => f.runtime.control(identity.token, { action, sessionId: record.id, ...data }) as Promise<any>;
    const original = f.runtime.config();
    assert.equal((await call('context')).workflowEnabled, false);
    f.runtime.models.list = async () => [{ id: 'catalog/model', label: 'Observed model', efforts: ['high'] }];
    assert.equal((await call('models', { provider: 'kilo' })).models[0].id, 'catalog/model');
    const nodes = ['frontend', 'backend'].map(id => ({ id, title: id, prompt: `Implement ${id}`, provider: 'kilo', model: 'catalog/model', effort: 'high' }));
    await assert.rejects(call('begin', { request: 'Build app', nodes: [{ ...nodes[0], model: 'invented' }] }), /available model/);
    const started = await call('begin', { request: 'Build app', nodes, edges: [] });
    assert.equal(started.role, 'orchestrator'); assert.equal(started.run.mode, 'adhoc'); assert.equal(started.run.orchestratorId, record.id);
    assert.deepEqual(started.run.config.nodes.map((node: any) => node.id), ['frontend', 'backend']);
    assert.deepEqual(f.runtime.config(), original); assert.equal(f.sent.length, 0);
    await assert.rejects(call('begin', { request: 'Nested', nodes }), /belongs to workflow/);
    await call('plan', { nodes: ['frontend', 'backend'], reason: 'Two app components in shared checkout', streams: [] });
    await call('dispatch', { nodeId: 'frontend', task: 'Implement frontend' });
    const worker = f.store.sessions(f.project.id).find(row => row.id !== record.id)!;
    assert.equal(worker.provider, 'kilo'); assert.equal(worker.workflowLaunch?.model, 'catalog/model');
    const activeTeam = f.runtime.runs();
    await f.runtime.send(f.project.id, record.id, { message: 'Coordinate with the existing team.' });
    await f.runtime.send(f.project.id, worker.id, { message: 'Keep this task accessible.' });
    assert.deepEqual(f.runtime.runs(), activeTeam);
    await assert.rejects(call('dispatch', { nodeId: 'backend', task: 'Implement backend' }), /one worker/);
    await f.runtime.cancel(started.run.id);
    assert.equal((await call('context')).role, 'agent');
    await f.runtime.configure(config());
    await assert.rejects(call('begin', { request: 'Build app', nodes }), /Workflow enabled, confirm/);
    assert.equal(f.runtime.config().enabled, true);
    const renewed = f.runtime.cliEnvironment(record);
    assert.equal(renewed.VADE_IDENTITY_FILE, env.VADE_IDENTITY_FILE);
    await assert.rejects(call('context'), /identity/);
    const current = JSON.parse(fs.readFileSync(renewed.VADE_IDENTITY_FILE, 'utf8'));
    f.store.saveSession({ ...record, statusToken: 'resumed-launch' });
    await assert.rejects(f.runtime.control(current.token, { action: 'context', sessionId: record.id }), /expired/);
  } finally { f.close(); }
});

test('active workflow coordinators and workers receive ordinary follow-ups without changing the run', async () => {
  const f = fixture();
  try {
    const { record, run } = await f.start();
    await f.call(record.id, 'plan', { nodes: ['implement'], reason: 'Implement this task', streams: [] });
    await f.call(record.id, 'dispatch', { nodeId: 'implement', task: 'Implement this task' });
    const worker = f.runtime.runs()[0].steps.find(step => step.nodeId === 'implement')!.sessionId!;
    const before = f.runtime.runs();
    const locks = (f.runtime as any).locks as Set<string>;
    locks.add(record.id);
    await assert.rejects(f.runtime.send(f.project.id, record.id, { message: 'Too early' }), /initial assignment/);
    locks.delete(record.id);
    const request = { message: 'Please keep the existing API compatible.', attachments: [{ name: 'notes.txt', mimeType: 'text/plain', dataBase64: 'bm90ZXM=' }] };
    await f.runtime.send(f.project.id, record.id, request);
    assert.deepEqual(f.sendCalls.at(-1), { projectId: f.project.id, id: record.id, request, internalWorkflow: undefined });
    await f.runtime.send(f.project.id, worker, { message: 'Also check the empty state.', workflowConfirmed: true });
    assert.equal(f.sendCalls.at(-1)!.id, worker);
    assert.equal(f.sendCalls.at(-1)!.internalWorkflow, undefined);
    assert.deepEqual(f.runtime.runs(), before);
    await assert.rejects(f.runtime.send(f.project.id, 'another-session', { message: 'Start something else' }), /Workflow enabled, confirm/);
    const attempts = f.sendCalls.length;
    f.setSendError(new Error('Delivery not confirmed; inspect Terminal'));
    await assert.rejects(f.runtime.send(f.project.id, worker, { message: 'A follow-up sent once' }), /Delivery not confirmed/);
    assert.equal(f.sendCalls.length, attempts + 1);
    assert.deepEqual(f.runtime.runs(), before);
    f.setSendError(null);
    await f.runtime.configure({ ...config(), enabled: false });
    await f.runtime.send(f.project.id, record.id, { message: 'Continue the current run.' });
    assert.deepEqual(f.runtime.runs(), before);
    assert.equal(f.runtime.runs()[0].id, run.id);
  } finally { f.close(); }
});

test('cancelled and failed workflow members continue ordinary chat without creating nested runs', async () => {
  for (const outcome of ['cancelled', 'failed'] as const) {
    const f = fixture();
    try {
      const { record, run } = await f.start();
      await f.call(record.id, 'plan', { nodes: ['implement'], reason: 'Implement this task', streams: [] });
      await f.call(record.id, 'dispatch', { nodeId: 'implement', task: 'Implement this task' });
      const worker = f.runtime.runs().find(value => value.id === run.id)!.steps.find(step => step.nodeId === 'implement')!.sessionId!;
      await f.runtime.send(f.project.id, record.id, { message: 'ordinary follow-up' });
      assert.equal(f.sent.at(-1)!.message, 'ordinary follow-up');
      if (outcome === 'cancelled') await f.runtime.cancel(run.id);
      else {
        await f.call(worker, 'result', { outcome: 'failed', summary: 'Explicit worker failure' });
        await f.call(record.id, 'finish', { outcome: 'failed', summary: 'Workflow failed' });
      }
      assert.equal(f.runtime.runs().find(value => value.id === run.id)!.state, outcome);
      fs.unlinkSync(f.runtime.setup.file('SKILL.md'));
      const before = f.sent.length;
      await f.runtime.send(f.project.id, record.id, { message: 'Continue with me' });
      await f.runtime.send(f.project.id, worker, { message: 'Explain the failure' });
      assert.deepEqual(f.sent.slice(before), [{ id: record.id, message: 'Continue with me' }, { id: worker, message: 'Explain the failure' }]);
      assert.equal(f.runtime.runs().length, 1);
    } finally { f.close(); }
  }
});

test('completed coordinator starts a fresh confirmed workflow while its former workers remain ordinary chats', async () => {
  const f=fixture();try{
    const {record,run}=await f.start();
    await f.call(record.id,'plan',{nodes:['implement'],reason:'Implement',streams:[]});
    await f.call(record.id,'dispatch',{nodeId:'implement',task:'Implement'});
    const worker=f.runtime.runs()[0].steps[0].sessionId!;
    await f.call(worker,'result',{outcome:'completed',summary:'Done'});
    await f.call(record.id,'finish',{outcome:'completed',summary:'Finished'});
    const sent=f.sent.length;
    await assert.rejects(f.runtime.send(f.project.id,record.id,{message:'Build the next feature'}),/Workflow enabled, confirm/);
    assert.equal(f.sent.length,sent);
    await f.runtime.send(f.project.id,worker,{message:'Explain the implementation'});
    assert.equal(f.runtime.runs().length,1);
    await f.runtime.send(f.project.id,record.id,{message:'Build the next feature',workflowConfirmed:true});
    assert.equal(f.runtime.runs().length,2);
    const next=f.runtime.runs().find(value=>value.id!==run.id)!;
    assert.equal(next.orchestratorId,record.id);assert.equal(next.originalRequest,'Build the next feature');
    await f.runtime.send(f.project.id,record.id,{message:'Keep it small'});
    assert.equal(f.runtime.runs().length,2,'Active coordinator follow-ups must not launch another run');
  }finally{f.close();}
});

test('workflow setup verifies both standard-directory skills and rejects stale CLI awareness', async () => {
  const f = fixture(); try {
    assert.equal(f.runtime.setup.status().ready, true);
    const skill = path.join(f.runtime.setup.skillsDirectory, 'vade-cli', 'SKILL.md');
    fs.writeFileSync(skill, 'outdated skill');
    assert.equal(f.runtime.setup.status().cliSkill, false);
    assert.equal(f.runtime.setup.status().skill, true);
    await assert.rejects(f.runtime.configure(config()), /Install/);
    fs.copyFileSync(f.runtime.setup.source('cli-SKILL.md'), skill);
    assert.equal(f.runtime.setup.status().ready, true);
  } finally { f.close(); }
});

test('fan-in review waits for both frontend and backend explicit results', async () => {
  const f = fixture(); try {
    const graph = config();
    graph.nodes = ['frontend', 'backend', 'review'].map((id, index) => ({ ...graph.nodes[0], id, title: id, x: index * 260 }));
    graph.edges = [{ source: 'frontend', target: 'review' }, { source: 'backend', target: 'review' }];
    const { record } = await f.start(graph);
    await f.call(record.id, 'plan', { nodes: ['frontend', 'backend', 'review'], reason: 'Review both implementations', streams: [] });
    await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review both' }), /not ready/);
    for (const nodeId of ['frontend', 'backend']) {
      await f.call(record.id, 'dispatch', { nodeId, task: `implement ${nodeId}` });
      const step = f.runtime.runs()[0].steps.find(step => step.nodeId === nodeId)!;
      await f.call(step.sessionId!, 'result', { outcome: 'completed', summary: `${nodeId} ready` });
      if (nodeId === 'frontend') await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review both' }), /not ready/);
    }
    await f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review both' });
    assert.match(f.sent.at(-1)!.message, /frontend ready/);
    assert.match(f.sent.at(-1)!.message, /backend ready/);
  } finally { f.close(); }
});

test('contacted agent orchestrates; dependency reports, leases, mailboxes and final results are enforced', async () => {
  const f = fixture(); try {
    const { record, run } = await f.start(); assert.equal(run.orchestratorId, record.id); assert.match(f.sent[0].message, /You are the orchestrator/);
    await assert.rejects(f.runtime.control('invalid', { action: 'context', runId: run.id, sessionId: record.id }), /identity/);
    await assert.rejects(f.call(record.id, 'plan', { nodes: ['review'], reason: 'skip required predecessor', streams: [] }), /every predecessor/);
    await f.call(record.id, 'plan', { nodes: ['implement', 'review'], reason: 'Implementation then review', streams: [] });
    await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review' }), /not ready/);
    await f.call(record.id, 'dispatch', { nodeId: 'implement', task: 'implement' });
    const worker = f.runtime.runs()[0].steps[0].sessionId!; assert.equal(f.store.sessions(f.project.id).find(row => row.id === worker)?.title, 'implement');
    f.live.delete(worker); // A process exiting is not a task result.
    await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review' }), /not ready/);
    await assert.rejects(f.call(worker, 'dispatch', { nodeId: 'review', task: 'review' }), /orchestrator/);
    await f.call(worker, 'message', { to: 'review', text: 'Review this change after I report' });
    await f.call(worker, 'result', { outcome: 'completed', summary: 'Implementation ready' });
    await f.call(worker, 'result', { outcome: 'completed', summary: 'Implementation ready' });
    await assert.rejects(f.call(worker, 'result', { outcome: 'failed', summary: 'different' }), /settled/);
    await f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review exact changes' });
    const reviewer = f.runtime.runs()[0].steps[1].sessionId!;
    assert.ok(f.stopped.includes(worker)); assert.match(f.sent.at(-1)!.message, /Implementation ready/);
    assert.equal((await f.call(reviewer, 'context')).run.messages[0].text, 'Review this change after I report');
    await assert.rejects(f.call(reviewer, 'message', { to: 'implement', text: 'bypass graph' }), /direct graph successors/);
    await assert.rejects(f.call(record.id, 'finish', { outcome: 'completed', summary: 'too early' }), /must complete/);
    await f.call(reviewer, 'result', { outcome: 'completed', summary: 'Review passed' });
    await f.call(record.id, 'finish', { outcome: 'completed', summary: 'Implemented and reviewed' });
    assert.equal(f.runtime.runs()[0].state, 'completed');
    const inbox = JSON.parse(String(f.store.db.prepare('SELECT data FROM turn_results WHERE id = ?').get(`workflow-${run.id}`)?.data));
    assert.equal(inbox.source, 'agent'); assert.equal(inbox.nodeId, record.id); assert.equal(inbox.outcome, 'completed');
    assert.equal(fs.existsSync(f.runtime.setup.file(`identities/${worker}.json`)), false);
  } finally { f.close(); }
});

test('shared work is serialized and a relaunched participant keeps its lease', async () => {
  const f = fixture(); try {
    const value = config(); value.edges = [];
    const { record } = await f.start(value);
    await f.call(record.id, 'plan', { nodes: ['implement', 'review'], reason: 'Independent but shared checkout', streams: [] });
    await f.call(record.id, 'dispatch', { nodeId: 'implement', task: 'implement' });
    await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'review', task: 'review' }), /one worker/);
    const worker = f.store.sessions(f.project.id).find(row => row.id !== record.id)!;
    // A recovered or resumed terminal is the same assignment: the lease follows the session.
    f.store.saveSession({ ...worker, statusToken: 'new-launch' });
    await f.call(worker.id, 'result', { outcome: 'completed', summary: 'recovered worker reported' });
    assert.equal(f.runtime.runs()[0].steps.find(step => step.nodeId === 'implement')?.state, 'completed');
    // A stopped terminal never inherits the assignment, even after another relaunch.
    f.live.delete(worker.id);
    f.store.saveSession({ ...worker, statusToken: 'third-launch' });
    await assert.rejects(f.call(worker.id, 'result', { outcome: 'failed', summary: 'stopped' }), /lease ended/);
    await f.runtime.cancel(f.runtime.runs()[0].id); assert.equal(f.runtime.runs()[0].state, 'cancelled');
  } finally { f.close(); }
});

test('uncertain assignment delivery cannot be replayed', async () => {
  const f = fixture(); try {
    const { record } = await f.start(); await f.call(record.id, 'plan', { nodes: ['implement'], reason: 'Only implementation needed', streams: [] });
    f.setSendError(new CliError('CLI_FAILED', 'Delivery may be partial'));
    await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'implement', task: 'implement' }), /partial/);
    f.setSendError(null); await assert.rejects(f.call(record.id, 'dispatch', { nodeId: 'implement' }), /uncertain/);
    assert.equal(f.runtime.runs()[0].steps[0].delivery, 'uncertain');
  } finally { f.close(); }
});

test('native trust readiness blocks dispatch before delivery and explicit retry reuses the same worker', async t => {
  const f = fixture(); try {
    const { record } = await f.start();
    await f.call(record.id,'plan',{nodes:['implement'],reason:'Implement',streams:[]});
    const send = (f.runtime as any).sessions.send;
    const calls: unknown[][] = [];
    t.mock.method((f.runtime as any).sessions,'send',async (...args: unknown[]) => { calls.push(args); return send(...args); });
    f.setSendError(new CliError('RUNTIME_UNAVAILABLE','Leave an empty, idle agent prompt before sending this task'));
    await assert.rejects(f.call(record.id,'dispatch',{nodeId:'implement',task:'Implement'}),/empty, idle/);
    const blocked=f.runtime.runs()[0], id=blocked.steps[0].sessionId;
    assert.equal(blocked.state,'blocked'); assert.equal(blocked.steps[0].delivery,'not-sent');
    assert.match(blocked.error!,/sign-in\/trust/);
    assert.deepEqual(calls[0].slice(3),[true,true,true],'Workflow assignments must require an empty idle native prompt');
    f.setSendError(null);
    await f.call(record.id,'dispatch',{nodeId:'implement'});
    assert.equal(f.runtime.runs()[0].steps[0].sessionId,id);
    assert.equal(f.runtime.runs()[0].steps[0].delivery,'submitted');
  } finally {f.close();}
});

test('isolation rejects cross-stream dependencies and integrates independent committed changes', async () => {
  const f = fixture(true); try {
    const value = config(); value.isolatedWorktrees = true;
    const { record } = await f.start(value);
    const streams = [{ id: 'a', title: 'Feature A', nodes: ['implement'] }, { id: 'b', title: 'Feature B', nodes: ['review'] }];
    await assert.rejects(f.call(record.id, 'plan', { nodes: ['implement', 'review'], reason: 'Invalid split', streams }), /Dependent workstreams/);
    await f.runtime.cancel(f.runtime.runs()[0].id);
    value.edges = []; const next = await f.start(value);
    await f.call(next.record.id, 'plan', { nodes: ['implement', 'review'], reason: 'Two independent files', streams });
    for (const id of ['implement', 'review']) await f.call(next.record.id, 'dispatch', { nodeId: id, task: `Implement ${id}` });
    const run = f.runtime.runs()[0]; assert.equal(run.streams.length, 2);
    for (const step of run.steps) {
      const session = f.store.sessions(f.project.id).find(row => row.id === step.sessionId)!;
      fs.writeFileSync(path.join(session.cwd, `${step.nodeId}.txt`), step.nodeId);
      execFileSync(GIT_PATH, ['add', '.'], { cwd: session.cwd, windowsHide: true });
      execFileSync(GIT_PATH, ['commit', '-m', step.nodeId], { cwd: session.cwd, windowsHide: true });
      await f.call(session.id, 'result', { outcome: 'completed', summary: 'Committed independent change' });
    }
    await f.call(next.record.id, 'integrate');
    assert.equal(fs.readFileSync(path.join(f.repo, 'implement.txt'), 'utf8'), 'implement');
    assert.equal(fs.readFileSync(path.join(f.repo, 'review.txt'), 'utf8'), 'review');
    assert.ok(f.runtime.runs()[0].streams.every(stream => stream.integrated));
  } finally { f.close(); }
});

test('integration conflicts preserve the source and can continue after explicit conflict resolution', async () => {
  const f = fixture(true); try {
    const value = config(); value.edges = []; value.isolatedWorktrees = true;
    const { record } = await f.start(value);
    await f.call(record.id, 'plan', { nodes: ['implement', 'review'], reason: 'Independent workstreams with an unexpected file conflict', streams: [{ id: 'a', title: 'A', nodes: ['implement'] }, { id: 'b', title: 'B', nodes: ['review'] }] });
    for (const nodeId of ['implement', 'review']) {
      await f.call(record.id, 'dispatch', { nodeId, task: 'Change the fixture' });
      const step = f.runtime.runs()[0].steps.find(step => step.nodeId === nodeId)!;
      const session = f.store.sessions(f.project.id).find(row => row.id === step.sessionId)!;
      fs.writeFileSync(path.join(session.cwd, 'initial.txt'), nodeId);
      execFileSync(GIT_PATH, ['add', '.'], { cwd: session.cwd, windowsHide: true });
      execFileSync(GIT_PATH, ['commit', '-m', nodeId], { cwd: session.cwd, windowsHide: true });
      await f.call(session.id, 'result', { outcome: 'completed', summary: 'Committed' });
    }
    await assert.rejects(f.call(record.id, 'integrate'), /Git command failed|conflict|merge/i);
    assert.equal(fs.readFileSync(path.join(f.repo, 'initial.txt'), 'utf8'), 'initial');
    const run = f.runtime.runs()[0]; assert.equal(run.state, 'blocked'); assert.ok(run.integrationTreeId);
    const integration = await f.adeGit.requireWorktree(f.project, run.integrationTreeId!);
    assert.match(fs.readFileSync(path.join(integration.path, 'initial.txt'), 'utf8'), /<<<<<<< /);
    fs.writeFileSync(path.join(integration.path, 'initial.txt'), 'resolved');
    execFileSync(GIT_PATH, ['add', '.'], { cwd: integration.path, windowsHide: true });
    execFileSync(GIT_PATH, ['commit', '-m', 'Resolve conflict'], { cwd: integration.path, windowsHide: true });
    await f.call(record.id, 'integrate');
    assert.equal(fs.readFileSync(path.join(f.repo, 'initial.txt'), 'utf8'), 'resolved');
    assert.ok(f.runtime.runs()[0].streams.every(stream => stream.integrated));
  } finally { f.close(); }
});

test('runtime restart fails unfinished runs and never replays prompts', async () => {
  const f = fixture(); try {
    await f.start(); const count = f.sent.length;
    const restarted = new OrganizationRuntime(f.store, f.adeGit, {} as AdeSessions);
    assert.equal(restarted.runs()[0].state, 'failed'); assert.match(restarted.runs()[0].error!, /restarted/);
    assert.equal(f.sent.length, count); restarted.close();
  } finally { f.close(); }
});

test('workflow config HTTP saves cleanup options and rejects invalid or unknown fields', async () => {
  const f = fixture();
  const server = createServer({ localRuntime: { organization: f.runtime, streams: new Set<() => void>() } as LocalRuntime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow/config`;
  const post = (value: object) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const value = { ...config(), enabled: false, closeWorkersOnCompletion: true, removeWorktreesOnCompletion: true };
    const saved = await post(value);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), value);
    assert.deepEqual(await (await fetch(url)).json(), value);
    assert.equal((await post({ ...value, closeWorkersOnCompletion: 'yes' })).status, 400);
    assert.equal((await post({ ...value, closeWorkersOnCompletion: false })).status, 400);
    assert.equal((await post({ ...value, arbitrary: true })).status, 400);
    assert.deepEqual(await (await fetch(url)).json(), value);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test('installed CLI uses authenticated loopback control and never returns its capability secret', async () => {
  const f = fixture();
  const server = createServer({ localRuntime: { organization: f.runtime, streams: new Set<() => void>() } as LocalRuntime });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { record } = await f.start();
    const identityFile = f.runtime.setup.file(`identities/${record.id}.json`), identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    const result = await promisify(execFile)(process.execPath, [f.runtime.setup.file('vade.cjs'), '--identity', identityFile, 'context'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse(result.stdout).role, 'orchestrator'); assert.ok(!result.stdout.includes(identity.token));
    const post = (body: object, headers: Record<string, string> = {}) => fetch(`${base}/api/workflow/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ action: 'context', runId: identity.runId, sessionId: record.id })).status, 403);
    assert.equal((await post({ action: 'context', runId: identity.runId, sessionId: record.id }, { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post({ action: 'context', runId: identity.runId, sessionId: record.id, task: 'unexpected' }, { Authorization: `Bearer ${identity.token}` })).status, 400);
    const version = await promisify(execFile)(process.execPath, [f.runtime.setup.file('vade.cjs'), '--version'], { windowsHide: true });
    assert.match(version.stdout, /1\.0\.0/);
    await f.runtime.cancel(f.runtime.runs()[0].id);
    await f.runtime.configure({ ...config(), enabled: false });
    const env = { ...process.env, ...f.runtime.cliEnvironment(record) };
    const cli = (action: string, payload?: object) => promisify(execFile)(process.execPath,
      [f.runtime.setup.file('vade.cjs'), action, ...(payload ? [JSON.stringify(payload)] : [])], { env, windowsHide: true, timeout: 10000 });
    const bootstrap = await cli('context');
    assert.equal(JSON.parse(bootstrap.stdout).workflowEnabled, false);
    const started = await cli('begin', { request: 'Explicit team request', nodes: [{ id: 'worker', title: 'Worker', prompt: 'Implement requested task', provider: 'codex', model: null, effort: null }] });
    assert.equal(JSON.parse(started.stdout).run.mode, 'adhoc');
    const launchIdentity = JSON.parse(fs.readFileSync(env.VADE_IDENTITY_FILE!, 'utf8'));
    assert.ok(!started.stdout.includes(launchIdentity.token));
    assert.equal(JSON.parse((await cli('context')).stdout).role, 'orchestrator');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test('setup terminal stages the fixed installer without running it or registering a project', async () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.runtime.setup.file('vade.cjs'));
    const owner = await f.runtime.setup.prepareTerminal();
    const sessions = f.runtime.setup.terminalSessions(owner.projectId, owner.nodeId);
    assert.match(owner.command, /install\.cjs/);
    assert.equal(f.runtime.setup.status().cli, false, 'Opening Update must not run installation');
    assert.equal(f.store.projects().length, 1, 'Setup terminals do not appear as user projects');
    f.runtime.setup.closeTerminal('unrelated', 'unrelated');
    assert.ok(sessions.page(owner.projectId, owner.nodeId).live, 'Stale close cannot stop another setup terminal');
    f.runtime.setup.closeTerminal(owner.projectId, owner.nodeId);
    assert.throws(() => f.runtime.setup.terminalSessions(owner.projectId, owner.nodeId), /not active/);
  } finally { f.runtime.close(); f.store.close(); await fs.promises.rm(f.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
