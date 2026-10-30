import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { AdeStore, type SessionRecord } from '../store.js';
import { AdeGit } from '../workspace/git.js';
import { SessionHandoffs } from '../chat/sessionHandoff.js';
import { GIT_PATH } from '../../integrations/cli.js';
import type { AdeConversations } from '../chat/conversation.js';
import type { OrganizationRuntime } from '../workflow/organization.js';
import type { AdeSessions } from '../sessions/sessions.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vade-handoff-'));
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync(GIT_PATH, args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture'); git('add', '.'); git('commit', '-m', 'initial');
  const store = new AdeStore(path.join(directory, 'data'));
  const project = store.register(repo, 'Fixture');
  const sourceTree = path.join(directory, 'source'), targetTree = path.join(directory, 'target');
  git('worktree', 'add', '-b', 'source', '--', sourceTree, 'HEAD');
  git('worktree', 'add', '-b', 'target', '--', targetTree, 'HEAD');
  const source: SessionRecord = {
    id: 'source-session', projectId: project.id, worktreeId: '', cwd: sourceTree, provider: 'codex',
    title: 'Source', createdAt: new Date().toISOString(), closed: false, providerThreadId: 'source-thread', statusToken: 'source-token',
  };
  const sessions = new Map<string, SessionRecord>([[source.id, source]]);
  const launchCalls: { worktreeId: string; cwd: string }[] = [];
  const sessionRuntime = {
    require: (projectId: string, id: string) => store.sessions(projectId).find(record => record.id === id) ?? sessions.get(id)!,
    page: () => ({ live: false }),
    status: () => ({ data: { state: 'idle' } }),
    handoffPromptReady: () => true,
    launch: async (projectId: string, worktreeId: string, cwd: string, provider: SessionRecord['provider']) => {
      launchCalls.push({ worktreeId, cwd });
      const record: SessionRecord = { id: 'target-session', projectId, worktreeId, cwd, provider, title: 'Target', createdAt: new Date().toISOString(), closed: false, statusToken: crypto.randomUUID() };
      sessions.set(record.id, record); store.saveSession(record); return record;
    },
    send: async () => ({ ok: true as const, message: 'sent' }),
  } as unknown as AdeSessions;
  const conversations = { read: async () => ({ data: { sourceIdentity: 'source-identity', messages: [{ id: 'message', role: 'user', text: 'Continue this task', at: null }], nextCursor: null, limited: false, truncated: false, warnings: [] }, meta: { availability: 'ready' } }) } as unknown as AdeConversations;
  const organization = { runs: () => [] } as unknown as OrganizationRuntime;
  const adeGit = new AdeGit(store);
  const handoffs = new SessionHandoffs(store, adeGit, sessionRuntime, conversations, organization);
  return { directory, store, project, adeGit, handoffs, source, sourceTree, targetTree, launchCalls, git, close: () => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('handoff launches in the selected worktree and preserves source provenance', async () => {
  const f = fixture();
  try {
    const trees = await f.adeGit.worktrees(f.project);
    f.source.worktreeId = trees.find(tree => path.resolve(tree.path) === path.resolve(f.sourceTree))!.id;
    f.store.saveSession(f.source);
    const target = trees.find(tree => path.resolve(tree.path) === path.resolve(f.targetTree))!;
    const result = await f.handoffs.start(f.project.id, f.source.id, { agentId: 'claude', context: 'focused', worktreeId: target.id });
    assert.deepEqual(f.launchCalls, [{ worktreeId: target.id, cwd: target.path }]);
    const launched = f.store.sessions(f.project.id).find(record => record.id === result.nodeId)!;
    assert.equal(launched.worktreeId, target.id);
    assert.equal(launched.handoff?.sourceId, f.source.id);
    assert.equal(launched.handoff?.sourceWorktreeId, f.source.worktreeId);
    assert.equal(launched.handoff?.sourceCwd, f.source.cwd);
    assert.equal(launched.handoff?.sourceLaunchToken, f.source.statusToken);
  } finally { f.close(); }
});

test('handoff rejects an unknown destination worktree', async () => {
  const f = fixture();
  try {
    const trees = await f.adeGit.worktrees(f.project);
    f.source.worktreeId = trees.find(tree => path.resolve(tree.path) === path.resolve(f.sourceTree))!.id;
    f.store.saveSession(f.source);
    await assert.rejects(f.handoffs.start(f.project.id, f.source.id, { agentId: 'claude', context: 'focused', worktreeId: 'wt-000000000000000000000000' }), /Worktree does not belong/);
    assert.equal(f.launchCalls.length, 0);
  } finally { f.close(); }
});

test('handoff rejects a locked destination worktree', async () => {
  const f = fixture();
  try {
    const trees = await f.adeGit.worktrees(f.project);
    f.source.worktreeId = trees.find(tree => path.resolve(tree.path) === path.resolve(f.sourceTree))!.id;
    f.store.saveSession(f.source);
    const target = trees.find(tree => path.resolve(tree.path) === path.resolve(f.targetTree))!;
    f.git('worktree', 'lock', f.targetTree);
    await assert.rejects(f.handoffs.start(f.project.id, f.source.id, { agentId: 'claude', context: 'focused', worktreeId: target.id }), /worktree is locked/);
    assert.equal(f.launchCalls.length, 0);
  } finally { f.close(); }
});
