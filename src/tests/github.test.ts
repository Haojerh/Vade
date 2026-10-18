import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitHubPanel } from '../features/github/GitHubPanel';
import { mergeGitHubItems, retainGitHubHistory } from '../features/github/useGitHubPagination';
import { buildGitHubPrompt } from '../features/workflow/WorkflowGraph';
import type { GitHubData } from '../../shared/contracts';

test('GitHub refresh preserves the previous first-page boundary across all activity types', () => {
  const meta = { availability: 'ready' as const, observedAt: null, attemptedAt: '2026-10-16T00:00:00Z', stale: false, partial: true, issue: null };
  const commit = (number: number) => ({ sha: String(number), message: String(number), url: '', author: null, committedAt: null });
  const issue = (number: number) => ({ number, title: String(number), url: '', author: null, updatedAt: null, state: 'open' as const, labels: [] });
  const pr = (number: number) => ({ ...issue(number), draft: false, mergedAt: null, headRef: null, baseRef: null });
  const snapshot = (start: number): GitHubData => ({
    repository: null, auth: 'available', scope: { kind: 'general', nodeId: null, branch: null, commits: 'default-branch', pullRequests: 'repository', issues: 'repository' },
    commits: { data: Array.from({ length: 20 }, (_, i) => commit(start - i)), meta },
    pullRequests: { data: Array.from({ length: 20 }, (_, i) => pr(start - i)), meta },
    issues: { data: Array.from({ length: 20 }, (_, i) => issue(start - i)), meta },
  });
  let cached = retainGitHubHistory({ commits: [], prs: [], issues: [] }, snapshot(40));
  cached = {
    commits: mergeGitHubItems(cached.commits, snapshot(20).commits.data!),
    prs: mergeGitHubItems(cached.prs, snapshot(20).pullRequests.data!),
    issues: mergeGitHubItems(cached.issues, snapshot(20).issues.data!),
  };
  cached = retainGitHubHistory(cached, snapshot(41));
  assert.deepEqual(cached.commits.map((item) => item.sha), Array.from({ length: 41 }, (_, i) => String(41 - i)));
  for (const items of [cached.prs, cached.issues]) {
    assert.deepEqual(items.map((item) => item.number), Array.from({ length: 41 }, (_, i) => 41 - i));
  }
  const updated = snapshot(42);
  updated.pullRequests.data![1].title = 'Updated PR';
  cached = retainGitHubHistory(cached, updated);
  assert.equal(cached.prs[1].title, 'Updated PR');
  assert.equal(cached.prs.length, 42);
  const stale = snapshot(50);
  stale.commits.meta = { ...meta, stale: true };
  assert.deepEqual(retainGitHubHistory(cached, stale).commits, cached.commits);
});

test('GitHub pagination deduplicates page boundaries and prefers refreshed item values', () => {
  const item = (sha: string, message: string) => ({ sha, message, url: '', author: null, committedAt: null });
  const first = [item('new', 'new'), item('boundary', 'updated')];
  const result = mergeGitHubItems(first, [item('boundary', 'old'), item('older', 'older')]);
  assert.deepEqual(result.map((entry) => entry.sha), ['new', 'boundary', 'older']);
  assert.equal(result[1].message, 'updated');
});

test('GitHubPanel displays no github connected message for folder projects', () => {
  const html = renderToStaticMarkup(createElement(GitHubPanel, {
    projectId: 'proj_folder',
    projectKind: 'folder',
    data: null,
    loading: false,
    error: null,
    query: { scope: 'general' },
    onRefresh: () => {},
  }));
  assert.ok(html.includes('No GitHub connected for project'));
  assert.ok(html.includes('github-folder-empty-state'));
  assert.ok(!html.includes('github-tabs-nav'));
  assert.ok(!html.includes('github-scope-selector'));
});

test('repository and embedded worktree history have distinct accessible IDs and no scope picker', () => {
  const shared = { projectId: 'project', data: null, loading: false, error: null, onRefresh: () => {} };
  const html = renderToStaticMarkup(createElement('div', null,
    createElement(GitHubPanel, shared),
    createElement(GitHubPanel, { ...shared, embedded: true, query: { scope: 'worktree', nodeId: 'worktree' } }),
  ));
  assert.ok(!html.includes('History Scope'));
  assert.ok(html.includes('Branch Activity'));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal((html.match(/>Issues/g) ?? []).length, 1);
});

test('buildGitHubPrompt formats detailed review instructions for PRs and issues', () => {
  const prPrompt = buildGitHubPrompt({
    type: 'pr',
    number: 42,
    title: 'Fix race condition in subscription',
    url: 'https://github.com/org/repo/pull/42',
    headRef: 'fix-race',
    baseRef: 'main',
    author: 'alice',
    draft: false,
  });
  assert.ok(prPrompt.includes('Pull Request #42: "Fix race condition in subscription"'));
  assert.ok(prPrompt.includes('https://github.com/org/repo/pull/42'));
  assert.ok(prPrompt.includes('Branch: `fix-race` -> `main`'));
  assert.ok(prPrompt.includes('Author: @alice'));
  assert.ok(prPrompt.includes('Status: Ready for review'));

  const issuePrompt = buildGitHubPrompt({
    type: 'issue',
    number: 99,
    title: 'Memory leak in worker watcher',
    url: 'https://github.com/org/repo/issues/99',
    author: 'bob',
    labels: ['bug', 'performance'],
  });
  assert.ok(issuePrompt.includes('Issue #99: "Memory leak in worker watcher"'));
  assert.ok(issuePrompt.includes('https://github.com/org/repo/issues/99'));
  assert.ok(issuePrompt.includes('Reported by: @bob'));
  assert.ok(issuePrompt.includes('Labels: bug, performance'));
});
