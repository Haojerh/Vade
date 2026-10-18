import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectWorktree, renameWorktree, validateCreateWorktree } from './worktrees.js';
import { hashId } from './orca.js';
import { validateOrcaArgs, type CommandRunner } from './cli.js';
import { collectCommitGraph, COMMIT_GRAPH_ARGS, parseCommitGraph } from './commitGraph.js';
import { createServer } from '../http/api.js';
import type { AddressInfo } from 'node:net';

const projectId = hashId('proj', 'project-test');
const wtId = 'repo-test::C:/test';
const nodeId = hashId('node', wtId);
function fixture() {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner: CommandRunner = async (_exe, args, options) => {
    calls.push({ args, cwd: options?.cwd });
    let result: unknown = {};
    if (args[0] === 'project' && args[1] === 'list') result = { projects: [{ id: 'project-test', displayName: 'Test', kind: 'git', sourceRepoIds: ['repo-test'] }] };
    if (args[0] === 'project' && args[1] === 'setups') result = { setups: [{ projectId: 'project-test', repoId: 'repo-test', path: 'C:/test', hostId: 'local' }] };
    if (args[0] === 'worktree' && args[1] === 'ps') result = { worktrees: [{ repoId: 'repo-test', worktreeId: wtId, path: 'C:/test' }, { repoId: 'other', worktreeId: 'other::C:/other', path: 'C:/other' }] };
    if (args[0] === 'log') return { stdout: ['a'.repeat(40), 'b'.repeat(40), 'Subject', 'Author', '2026-10-18T00:00:00Z', 'HEAD -> main'].join('\0') + '\n', stderr: '', exitCode: 0 };
    return { stdout: JSON.stringify({ ok: true, result }), stderr: '', exitCode: 0 };
  };
  return { calls, runner };
}

test('worktree create derives repository and only passes bounded fixed arguments', async () => {
  const { calls, runner } = fixture();
  await createProjectWorktree(projectId, { name: 'fix-login', from: { kind: 'pr', value: '123' }, agentId: 'codex', setup: 'skip' }, runner);
  const args = calls.find(c => c.args[0] === 'worktree' && c.args[1] === 'create')!.args;
  assert.deepEqual(args, ['worktree', 'create', '--repo', 'id:repo-test', '--name', 'fix-login', '--no-parent', '--pr', '123', '--agent', 'codex', '--setup', 'skip', '--json']);
  assert.doesNotThrow(() => validateOrcaArgs(args));
  assert.throws(() => validateOrcaArgs([...args.slice(0, -1), '--command', 'echo bad', '--json']));
});

test('rename uses exact project worktree and cannot mutate another project', async () => {
  const { calls, runner } = fixture();
  await renameWorktree(projectId, nodeId, 'My Work', runner);
  assert.deepEqual(calls.at(-1)?.args, ['worktree', 'set', '--worktree', `id:${wtId}`, '--display-name', 'My Work', '--json']);
  await assert.rejects(renameWorktree(projectId, hashId('node', 'other::C:/other'), 'Wrong', runner), /does not belong/);
  await renameWorktree(projectId, nodeId, '', runner);
  assert.equal(calls.at(-1)?.args[5], '');
  assert.throws(() => validateOrcaArgs(['worktree', 'set', '--worktree', `id:${wtId}`, '--workspace-status', 'completed', '--json']));
});

test('worktree creation rejects flag injection, paths, control characters, arbitrary agents and fields', () => {
  for (const body of [null, { name: '../escape' }, { name: '--json' }, { name: 'valid', baseBranch: '--help' }, { name: 'a\nb' }, { name: 'valid', agentId: 'echo test' }, { name: 'valid', from: { kind: 'pr', value: '0' } }, { name: 'valid', repo: 'other' }]) assert.throws(() => validateCreateWorktree(body));
  assert.throws(() => validateOrcaArgs(['worktree', 'create', '--repo', 'id:r', '--name', 'n', '--no-parent', '--setup', 'skip', '--setup', 'run', '--json']));
});

test('local history has fixed bounded arguments and derives cwd from project or worktree', async () => {
  const { calls, runner } = fixture();
  const section = await collectCommitGraph(projectId, undefined, runner);
  assert.equal(section.meta.availability, 'ready');
  assert.deepEqual(calls.at(-1), { args: COMMIT_GRAPH_ARGS, cwd: 'C:/test' });
  await collectCommitGraph(projectId, nodeId, runner);
  assert.equal(calls.at(-1)?.args.includes('--all'), false);
  await assert.rejects(collectCommitGraph(projectId, hashId('node', 'other::C:/other'), runner), /does not belong/);
  assert.throws(() => parseCommitGraph('invalid\0bad'));
});

test('HTTP actions enforce origins, bounded JSON and project ownership', async () => {
  const { calls, runner } = fixture();
  const server = createServer({ runner });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}`;
  const post = (url: string, body: unknown, origin = 'http://127.0.0.1:5173') => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(`${base}/worktrees`, { name: 'valid' }, 'https://example.com')).status, 403);
    assert.equal((await post(`${base}/worktrees`, { name: 'valid', command: 'whoami' })).status, 400);
    assert.equal((await post(`${base}/worktrees`, { name: 'valid' })).status, 200);
    assert.equal((await post(`${base}/nodes/${nodeId}/rename-worktree`, { title: 'New name' })).status, 200);
    assert.equal((await post(`${base}/nodes/${hashId('node', 'other::C:/other')}/rename-worktree`, { title: 'Wrong' })).status, 404);
    assert.equal((await post(`${base}/nodes/${nodeId}/rename-worktree`, { title: '\u0000bad' })).status, 400);
    assert.equal((await fetch(`${base}/commit-graph?nodeId=${nodeId}`)).status, 200);
    assert.equal((await fetch(`${base}/commit-graph?path=C:/other`)).status, 400);
    assert.equal((await post(`${base}/commit-graph`, {})).status, 405);
    assert.equal(calls.filter(c => c.args[1] === 'create').length, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('history caps commits and reports upstream failures explicitly', async () => {
  const record = ['a'.repeat(40), 'b'.repeat(40), 'Subject', 'Author', '2026-10-18T00:00:00Z', 'main'].join('\0');
  const data = parseCommitGraph(Array(201).fill(record).join('\n'));
  assert.equal(data.commits.length, 200);
  assert.equal(data.truncated, true);
  const { runner } = fixture();
  const failing: CommandRunner = (exe, args, options) => args[0] === 'log' ? Promise.resolve({ stdout: '', stderr: 'failed', exitCode: 1 }) : runner(exe, args, options);
  const section = await collectCommitGraph(projectId, undefined, failing);
  assert.equal(section.data, null);
  assert.equal(section.meta.availability, 'unavailable');
  assert.equal(section.meta.issue?.code, 'CLI_FAILED');
});
