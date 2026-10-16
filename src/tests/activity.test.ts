import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeGitHubItem, observeGitHubItems, readUnreadHistory, saveUnreadHistory } from '../features/github/githubUnread';
import { latestAgentMessage } from '../features/workflow/conversation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LatestMessageCard } from '../features/workflow/LatestMessageCard';
import { normalizeProvider, ProviderIcon } from '../components/providers/ProviderIcon';
import { ORCA_PROVIDER_IMAGES } from '../components/providers/OrcaProviderAssets';
import { compareWorkflowNodes } from '../features/workflow/workflowOrder';
import { GitHubPanel } from '../features/github/GitHubPanel';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { DEFAULT_VISIBLE_SECTIONS, NodeDetails } from '../features/workflow/NodeDetails';
import { buildGitHubPrompt } from '../features/workflow/WorkflowGraph';
import type { Node, NodeDetails as NodeDetailsType } from '../../shared/contracts';

test('workflow layout order remains stable when upstream activity reorders nodes', () => {
  const main = { id: 'main', kind: 'worktree', path: 'C:\\project', state: 'idle' } as Node;
  const child = { id: 'child', kind: 'worktree', path: 'C:/workspaces/project/test', state: 'working' } as Node;
  const ids = (nodes: Node[]) => [...nodes].sort(compareWorkflowNodes).map((node) => node.id);
  assert.deepEqual(ids([main, child]), ids([{ ...child, state: 'completed' }, { ...main, state: 'working' }]));
  const a = { id: 'agent-a', kind: 'agent' } as Node;
  const b = { id: 'agent-b', kind: 'agent' } as Node;
  assert.deepEqual(ids([b, a]), ids([a, b]));
});

test('GitHub notifications baseline existing items and retain unread arrivals until acknowledged', () => {
  const baseline = observeGitHubItems(undefined, ['old']);
  assert.equal(baseline.unread.size, 0);
  const updated = observeGitHubItems(baseline, ['new', 'old']);
  assert.deepEqual([...updated.unread], ['new']);
  assert.deepEqual([...observeGitHubItems(updated, ['new', 'old']).unread], ['new']);
  const acknowledged = { ...updated, unread: new Set<string>() };
  assert.equal(observeGitHubItems(acknowledged, ['new']).unread.size, 0);
  assert.equal(observeGitHubItems(acknowledged, ['old', 'new']).unread.size, 0);
  assert.deepEqual([...observeGitHubItems(acknowledged, ['newer', 'new']).unread], ['newer']);
  assert.equal(observeGitHubItems(undefined, ['different-branch']).unread.size, 0);
});

test('latest agent preview excludes user turns and blank replies', () => {
  assert.equal(latestAgentMessage([]), null);
  assert.equal(latestAgentMessage([{ id: 'u', role: 'user', text: 'question', at: null }]), null);
  const latest = { id: 'a2', role: 'agent' as const, text: 'latest public reply', at: null };
  assert.deepEqual(latestAgentMessage([
    { id: 'a1', role: 'agent', text: 'old reply', at: null }, latest,
    { id: 'u', role: 'user', text: 'new question', at: null },
    { id: 'empty', role: 'agent', text: ' ', at: null },
  ]), latest);
});

test('acknowledging a notification clears only that item and subsequent polls keep it read', () => {
  const baseline = observeGitHubItems(undefined, ['old']);
  const arrivals = observeGitHubItems(baseline, ['first', 'second', 'old']);
  const readFirst = acknowledgeGitHubItem(arrivals, 'first');
  assert.deepEqual([...readFirst.unread], ['second']);
  assert.deepEqual([...observeGitHubItems(readFirst, ['first', 'second', 'old']).unread], ['second']);
  assert.equal(arrivals.unread.size, 2);
});

test('notifications survive reloads, preserve reads, and isolate repository scopes', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const baseline = observeGitHubItems(undefined, ['old']);
  saveUnreadHistory('repo:commits:main', observeGitHubItems(baseline, ['first', 'second', 'old']), storage);
  const restored = readUnreadHistory('repo:commits:main', storage)!;
  assert.deepEqual([...restored.unread], ['first', 'second']);
  saveUnreadHistory('repo:commits:main', acknowledgeGitHubItem(restored, 'first'), storage);
  const reloaded = observeGitHubItems(readUnreadHistory('repo:commits:main', storage), ['first', 'second', 'third']);
  assert.deepEqual([...reloaded.unread], ['second', 'third']);
  assert.equal(readUnreadHistory('other-repo:commits:main', storage), undefined);
  assert.equal(readUnreadHistory('repo:commits:branch', storage), undefined);
});

test('invalid or unavailable notification storage falls back safely', () => {
  assert.equal(readUnreadHistory('key', { getItem: () => '{broken' }), undefined);
  assert.equal(readUnreadHistory('key', { getItem: () => JSON.stringify({ version: 1, seen: [5], unread: [] }) }), undefined);
  assert.doesNotThrow(() => saveUnreadHistory('key', { seen: new Set(), unread: new Set() }, {
    setItem: () => { throw new Error('Storage unavailable'); },
  }));
});

test('latest message card formats Markdown and keeps local file references inert', () => {
  const html = renderToStaticMarkup(createElement(LatestMessageCard, {
    stale: false,
    message: { id: 'markdown', role: 'agent', at: null,
      text: '### Review complete\n\n**Fixed** the `source`.\n\n- First item\n- Second item\n\n[server/orca.ts](file:///C:/private/path.ts)\n\n[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>' },
  }));
  assert.ok(html.includes('<h3>Review complete</h3>'));
  assert.ok(html.includes('<strong>Fixed</strong>'));
  assert.ok(html.includes('<li>First item</li>'));
  assert.ok(html.includes('latest-message-card'));
  assert.ok(!html.includes('file:///'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('<script>'));
});

test('provider icons distinguish Gemini and Antigravity and cover Orca’s bundled catalog', () => {
  assert.equal(normalizeProvider('gemini').id, 'gemini');
  assert.equal(normalizeProvider('agy').id, 'antigravity');
  assert.equal(normalizeProvider('opencode-go').id, 'opencode-go');
  assert.equal(normalizeProvider('claude-agent-teams').id, 'claude');
  assert.equal(normalizeProvider('dsb').id, 'dsh');
  for (const provider of [...Object.keys(ORCA_PROVIDER_IMAGES), 'codex', 'claude', 'minimax', 'opencode-go', 'opencode', 'kilo', 'pi', 'omp', 'aider', 'copilot', 'droid']) {
    assert.notEqual(normalizeProvider(provider).id, 'unknown', provider);
    const html = renderToStaticMarkup(createElement(ProviderIcon, { provider }));
    assert.ok(!html.includes('>?</text>'), provider);
  }
  assert.equal(normalizeProvider('unrecognized-agent').id, 'unknown');
  const ag = renderToStaticMarkup(createElement(ProviderIcon, { provider: 'antigravity' }));
  assert.ok(ag.includes('providers/orca/antigravity.png'));
});

test('GitHubPanel displays no github connected message for folder projects', () => {
  const html = renderToStaticMarkup(createElement(GitHubPanel, {
    projectId: 'proj_folder',
    projectKind: 'folder',
    data: null,
    loading: false,
    error: null,
    query: { scope: 'general' },
    onScopeChange: () => {},
    availableWorktrees: [],
    onRefresh: () => {},
  }));
  assert.ok(html.includes('No GitHub connected for project'));
  assert.ok(html.includes('github-folder-empty-state'));
  assert.ok(!html.includes('github-tabs-nav'));
  assert.ok(!html.includes('github-scope-selector'));
});

test('DEFAULT_VISIBLE_SECTIONS has all sections visible by default', () => {
  assert.equal(DEFAULT_VISIBLE_SECTIONS.status, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.tasks, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.latest, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.tool, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.conversation, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.chatbox, true);
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

test('ProjectSelector renders settings controls in sidebar', () => {
  const html = renderToStaticMarkup(createElement(ProjectSelector, {
    inventorySection: null,
    loading: false,
    error: null,
    selectedProjectId: null,
    onSelectProject: () => {},
    snapshot: null,
    isLocallyStale: false,
    connectionMode: 'sse',
    theme: 'dark',
    onToggleTheme: () => {},
    cardStateColors: true,
    onToggleCardStateColors: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
    onToggleVisibleSection: () => {},
    onResetVisibleSections: () => {},
  }));
  assert.ok(html.includes('Dashboard settings'));
  assert.ok(html.includes('Settings'));
});

test('NodeDetails does not render settings button and respects visibleSections', () => {
  const node = { id: 'agent-1', kind: 'agent', label: 'Coder', state: 'working', liveness: 'live', taskIds: [] } as unknown as Node;
  const details = {
    node,
    currentTool: null,
    conversation: { meta: { availability: 'empty', stale: false, observedAt: null, attemptedAt: null, partial: false, issue: null }, data: { messages: [], cursor: null, nextCursor: null, source: 'test', sourceIdentity: null, provider: null, limited: false, hasMore: false, totalTurns: 0 } },
    tasks: [],
  } as unknown as NodeDetailsType;
  const html = renderToStaticMarkup(createElement(NodeDetails, {
    projectId: 'proj_1',
    details,
    loading: false,
    error: null,
    selectedNodeId: 'agent-1',
    onClose: () => {},
    onRefresh: () => {},
    onCheckNewerMessages: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));
  // Settings button is removed from NodeDetails (it is now on the sidebar settings)
  assert.equal(html.includes('node-details-settings-container'), false);
  assert.equal(html.includes('Node details section visibility settings'), false);
  assert.ok(html.includes('Status &amp; Workspace'));

  // When status section is disabled via visibleSections, it is omitted
  const htmlHidden = renderToStaticMarkup(createElement(NodeDetails, {
    projectId: 'proj_1',
    details,
    loading: false,
    error: null,
    selectedNodeId: 'agent-1',
    onClose: () => {},
    onRefresh: () => {},
    onCheckNewerMessages: () => {},
    visibleSections: { ...DEFAULT_VISIBLE_SECTIONS, status: false },
  }));
  assert.equal(htmlHidden.includes('Status &amp; Workspace'), false);
});

