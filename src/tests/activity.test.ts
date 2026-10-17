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
import { separateWorkflowBoxes } from '../features/workflow/workflowCollision';
import { GitHubPanel } from '../features/github/GitHubPanel';
import { mergeGitHubItems, retainGitHubHistory } from '../features/github/useGitHubPagination';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { DEFAULT_VISIBLE_SECTIONS, NodeDetails } from '../features/workflow/NodeDetails';
import { buildGitHubPrompt, WorkflowGraph } from '../features/workflow/WorkflowGraph';
import { validateMessageFiles, MessageAttachments } from '../features/workflow/MessageAttachments';
import { PrerequisitesGate } from '../components/ui/PrerequisitesGate';
import { ConfirmationDialog } from '../components/ui/ConfirmationDialog';
import { RenameDialog } from '../components/ui/RenameDialog';
import { AddAgentDialog } from '../components/ui/AddAgentDialog';
import { Icon } from '../components/ui/Icon';
import { useConfirmationState } from '../hooks/useConfirmationState';
import type { GitHubData, Node, Edge, NodeDetails as NodeDetailsType, PrerequisitesStatus } from '../../shared/contracts';

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

test('workflow collision layout separates dragged boxes and only moves later boxes on chat expansion', () => {
  const above = { id: 'above', x: 0, y: 0, width: 260, height: 100 };
  const chat = { id: 'chat', x: 0, y: 120, width: 260, height: 100 };
  const below = { id: 'below', x: 0, y: 240, width: 260, height: 100 };
  const normal = separateWorkflowBoxes([below, chat, above]);
  const expanded = separateWorkflowBoxes([above, { ...chat, height: 260 }, below]);
  assert.deepEqual(expanded[0], above);
  assert.equal(expanded[1].y, chat.y);
  assert.equal(expanded[2].y, 396);
  assert.deepEqual(separateWorkflowBoxes([above, chat, below]), normal);
  const overlapped = separateWorkflowBoxes([
    { ...above, x: -20, y: -10 }, { ...chat, y: 30 }, { ...below, y: 45 },
    { id: 'separate-column', x: 350, y: 0, width: 260, height: 200 },
  ]);
  for (let index = 0; index < overlapped.length; index++) {
    const a = overlapped[index];
    assert.ok(a.x >= 0 && a.y >= 0);
    for (const b of overlapped.slice(index + 1)) {
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  }
});

test('message attachments accept pasted files and enforce count, type, and size limits', () => {
  const image = new File(['test'], 'image.png', { type: 'image/png' });
  assert.equal(validateMessageFiles([image]), null);
  assert.match(validateMessageFiles(Array(9).fill(image))!, /8/);
  assert.match(validateMessageFiles([new File([], 'empty.png')])!, /non-empty/);
  assert.match(validateMessageFiles([new File(['test'], 'test.svg', { type: 'image/svg+xml' })])!, /PNG/);
  const markup = renderToStaticMarkup(createElement(MessageAttachments, {
    files: [image], onChange: () => {}, disabled: false, children: createElement('textarea'),
  }));
  assert.match(markup, /Remove image.png/);
  assert.ok(markup.indexOf('Attached files') < markup.indexOf('<textarea'));
  assert.match(markup, /Choose attachments/);
});

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

test('ProjectSelector renders expandable chevron toggle and all projects when expanded', () => {
  const inventory = {
    meta: { availability: 'ready', stale: false, observedAt: null, attemptedAt: null, partial: false, issue: null },
    data: {
      version: '0.1.0',
      projects: [
        { id: 'proj-1', name: 'Alpha Project', kind: 'git', paths: ['/path/to/alpha'] },
        { id: 'proj-2', name: 'Beta Project', kind: 'folder', paths: ['/path/to/beta'] },
        { id: 'proj-3', name: 'Gamma Project', kind: 'git', paths: ['/path/to/gamma'] },
      ],
    },
  } as unknown as any;

  const html = renderToStaticMarkup(createElement(ProjectSelector, {
    inventorySection: inventory,
    loading: false,
    error: null,
    selectedProjectId: 'proj-2',
    onSelectProject: () => {},
    snapshot: null,
    isLocallyStale: false,
    connectionMode: 'sse',
    theme: 'dark',
    onToggleTheme: () => {},
    cardStateColors: true,
    onToggleCardStateColors: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));

  // By default, expanded: shows all projects, chevron has is-expanded, button has aria-expanded="true"
  assert.ok(html.includes('rail-section-toggle-btn'));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes('rail-chevron-icon is-expanded'));
  assert.ok(html.includes('Alpha Project'));
  assert.ok(html.includes('Beta Project'));
  assert.ok(html.includes('Gamma Project'));
  assert.equal(html.includes('is-collapsed-hidden'), false);
});

test('ProjectSelector marks non-current projects as collapsed-hidden for smooth animation when collapsed', () => {
  const inventory = {
    meta: { availability: 'ready', stale: false, observedAt: null, attemptedAt: null, partial: false, issue: null },
    data: {
      version: '0.1.0',
      projects: [
        { id: 'proj-1', name: 'Alpha Project', kind: 'git', paths: ['/path/to/alpha'] },
        { id: 'proj-2', name: 'Beta Project', kind: 'folder', paths: ['/path/to/beta'] },
        { id: 'proj-3', name: 'Gamma Project', kind: 'git', paths: ['/path/to/gamma'] },
      ],
    },
  } as unknown as any;

  const store = new Map<string, string>();
  store.set('orca-projects-expanded', 'false');
  const originalLocalStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };

  try {
    const html = renderToStaticMarkup(createElement(ProjectSelector, {
      inventorySection: inventory,
      loading: false,
      error: null,
      selectedProjectId: 'proj-2',
      onSelectProject: () => {},
      snapshot: null,
      isLocallyStale: false,
      connectionMode: 'sse',
      theme: 'dark',
      onToggleTheme: () => {},
      cardStateColors: true,
      onToggleCardStateColors: () => {},
      visibleSections: DEFAULT_VISIBLE_SECTIONS,
    }));

    // When collapsed: button has aria-expanded="false", chevron is not rotated
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(!html.includes('rail-chevron-icon is-expanded'));

    const listHtml = html.slice(html.indexOf('id="rail-project-list"'));

    // Beta Project is current and visible (not is-collapsed-hidden)
    const betaIndex = listHtml.indexOf('Beta Project');
    const betaSnippet = listHtml.slice(Math.max(0, betaIndex - 250), betaIndex);
    assert.equal(betaSnippet.includes('is-collapsed-hidden'), false);

    // Alpha and Gamma are hidden via is-collapsed-hidden with aria-hidden
    const alphaIndex = listHtml.indexOf('Alpha Project');
    const alphaSnippet = listHtml.slice(Math.max(0, alphaIndex - 250), alphaIndex);
    assert.ok(alphaSnippet.includes('is-collapsed-hidden'));
    assert.ok(alphaSnippet.includes('aria-hidden="true"'));

    const gammaIndex = listHtml.indexOf('Gamma Project');
    const gammaSnippet = listHtml.slice(Math.max(0, gammaIndex - 250), gammaIndex);
    assert.ok(gammaSnippet.includes('is-collapsed-hidden'));
    assert.ok(gammaSnippet.includes('aria-hidden="true"'));

    // If selectedProjectId is null, falls back to first project (Alpha Project) as visible
    const htmlNoSelection = renderToStaticMarkup(createElement(ProjectSelector, {
      inventorySection: inventory,
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
    }));
    const listHtmlNoSelection = htmlNoSelection.slice(htmlNoSelection.indexOf('id="rail-project-list"'));

    const alphaNoSelectionIndex = listHtmlNoSelection.indexOf('Alpha Project');
    const alphaNoSelection = listHtmlNoSelection.slice(Math.max(0, alphaNoSelectionIndex - 250), alphaNoSelectionIndex);
    assert.equal(alphaNoSelection.includes('is-collapsed-hidden'), false);

    const betaNoSelectionIndex = listHtmlNoSelection.indexOf('Beta Project');
    const betaNoSelection = listHtmlNoSelection.slice(Math.max(0, betaNoSelectionIndex - 250), betaNoSelectionIndex);
    assert.ok(betaNoSelection.includes('is-collapsed-hidden'));
  } finally {
    if (originalLocalStorage !== undefined) {
      (globalThis as any).localStorage = originalLocalStorage;
    } else {
      delete (globalThis as any).localStorage;
    }
  }
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
    visibleSections: { ...DEFAULT_VISIBLE_SECTIONS, status: false },
  }));
  assert.equal(htmlHidden.includes('Status &amp; Workspace'), false);
});

test('PrerequisitesGate returns null when all prerequisites are ready', () => {
  const readyStatus: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: true,
    orcaCli: true,
    orchestrationSkill: true,
    orcaCliSkill: true,
    ready: true,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: readyStatus,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.equal(html, '');
});

test('PrerequisitesGate shows "Orca not downloaded" and link to https://www.onorca.dev/ when orcaApp is missing', () => {
  const missingApp: PrerequisitesStatus = {
    orcaApp: false,
    orcaAppOpen: false,
    orcaCli: false,
    orchestrationSkill: false,
    orcaCliSkill: false,
    ready: false,
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: missingApp,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Orca Prerequisites Required'));
  assert.ok(html.includes('Orca not downloaded'));
  assert.ok(html.includes('https://www.onorca.dev/'));
  assert.ok(html.includes('Download Orca'));
});

test('PrerequisitesGate shows app closed notice when installed but not open', () => {
  const appClosed: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: false,
    orcaCli: true,
    orchestrationSkill: true,
    orcaCliSkill: true,
    ready: false,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: appClosed,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Not Running'));
  assert.ok(html.includes('Installed (v1.4.224) - Closed'));
  assert.ok(html.includes('Orca desktop application is installed, but it is currently closed.'));
  assert.ok(html.includes('Please open the'));
  assert.ok(html.includes('data-testid="prereq-app-closed-notice"'));
});

test('PrerequisitesGate asks to download through Orca app when CLI or Orchestration skill is missing', () => {
  const missingCliAndSkill: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: true,
    orcaCli: false,
    orchestrationSkill: false,
    orcaCliSkill: true,
    ready: false,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: missingCliAndSkill,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  // Orca App is detected
  assert.ok(html.includes('Detected (v1.4.224)'));
  // CLI is missing and asks to download through Orca app
  assert.ok(html.includes('Orca-cli not downloaded'));
  assert.ok(html.includes('Open the Orca desktop app, go to'));
  assert.ok(html.includes('Settings &gt; CLI'));
  // Skill is missing and asks to install through Orca app
  assert.ok(html.includes('Orchestration skill not downloaded'));
  assert.ok(html.includes('Skills'));
});

test('PrerequisitesGate shows orca-cli skill missing and command to install', () => {
  const missingSkill: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: true,
    orcaCli: true,
    orchestrationSkill: true,
    orcaCliSkill: false,
    ready: false,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: missingSkill,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Orca CLI Agent Skill (orca-cli)'));
  assert.ok(html.includes('Orca-cli skill not installed'));
  assert.ok(html.includes('npx skills add https://github.com/stablyai/orca --skill orca-cli'));
});

test('PrerequisitesGate renders loading state when initially loading without data', () => {
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: null,
    loading: true,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Checking Orca Environment...'));
  assert.ok(html.includes('prereq-spinner'));
});

test('NodeDetails renders Close Agent Tab button for agent nodes', () => {
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
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));
  assert.ok(html.includes('Close Agent Tab'));
  assert.equal(html.includes('Delete Worktree'), false);
});

test('NodeDetails renders Delete Worktree button for worktree nodes', () => {
  const node = { id: 'wt-1', kind: 'worktree', label: 'Feature Branch', state: 'idle', liveness: 'live', taskIds: [] } as unknown as Node;
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
    selectedNodeId: 'wt-1',
    onClose: () => {},
    onRefresh: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));
  assert.ok(html.includes('Delete Worktree'));
  assert.equal(html.includes('Close Agent Tab'), false);
});

test('ConfirmationDialog renders open modal with title, description, and action buttons', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Delete Worktree?',
    description: 'Are you sure you want to delete worktree test-wt?',
    confirmLabel: 'Delete Worktree',
    confirmVariant: 'danger',
    isConfirming: false,
    error: null,
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('Delete Worktree?'));
  assert.ok(html.includes('Are you sure you want to delete worktree test-wt?'));
  assert.ok(html.includes('btn-danger'));
  assert.ok(html.includes('confirmation-dialog'));
  assert.equal(html.includes('is-closing'), false);
});

test('ConfirmationDialog renders with is-closing animation class during exit phase', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: true,
    title: 'Close Agent Tab?',
    description: 'Are you sure?',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('confirmation-dialog'));
  assert.ok(html.includes('is-closing'));
});

test('ConfirmationDialog displays error alert when error is provided', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Delete Worktree?',
    description: 'Are you sure?',
    error: 'Worktree is locked by git',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('panel-alert alert-error'));
  assert.ok(html.includes('Worktree is locked by git'));
});

test('ConfirmationDialog shows processing label and disables buttons when isConfirming is true', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Close Agent Tab?',
    description: 'Are you sure?',
    confirmLabel: 'Close Tab',
    isConfirming: true,
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('Processing…'));
  assert.ok(html.includes('disabled=""'));
});

test('ConfirmationDialog returns null when isOpen is false', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: false,
    isClosing: false,
    title: 'Delete Worktree?',
    description: 'Are you sure?',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.equal(html, '');
});

test('useConfirmationState initializes closed and reset() ensures closed state', () => {
  let hookResult: any;
  function TestComponent() {
    hookResult = useConfirmationState();
    return null;
  }
  renderToStaticMarkup(createElement(TestComponent));
  assert.equal(hookResult.present, false);
  assert.equal(hookResult.closing, false);
  assert.equal(hookResult.data, null);

  hookResult.close();
  assert.equal(hookResult.closing, false);

  hookResult.reset();
  assert.equal(hookResult.present, false);
  assert.equal(hookResult.closing, false);
  assert.equal(hookResult.data, null);
});

test('ConfirmationDialog renders standardized Reset layout dialog', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Reset layout?',
    description: 'Return cards and worktrees in this project to their default positions. Your saved layout will be cleared.',
    confirmLabel: 'Reset layout',
    confirmVariant: 'danger',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('Reset layout?'));
  assert.ok(html.includes('Your saved layout will be cleared.'));
  assert.ok(html.includes('btn-danger'));
});

test('NodeDetails displays loading state and avoids rendering stale data when details.node.id does not match selectedNodeId', () => {
  const staleDetails = {
    node: {
      id: 'node-codex-old',
      kind: 'agent',
      label: 'Codex Session',
      state: 'idle',
      liveness: 'live',
      agentType: 'codex',
    },
    tasks: [],
    activity: [],
    currentTool: null,
    conversation: {
      data: {
        messages: [{ id: 'm1', role: 'agent', text: 'Old codex reply', at: null }],
        cursor: null,
        nextCursor: null,
        limited: false,
        truncated: false,
        warnings: [],
      },
      meta: { availability: 'ready', observedAt: null, attemptedAt: '2026-10-17T00:00:00Z', stale: false, partial: false, issue: null },
    },
  } as unknown as NodeDetailsType;

  // Selected node is a different node (Antigravity), but details still contains the old Codex session
  const html = renderToStaticMarkup(createElement(NodeDetails, {
    projectId: 'proj',
    details: staleDetails,
    loading: true,
    error: null,
    selectedNodeId: 'node-antigravity-new',
    selectedNode: {
      id: 'node-antigravity-new',
      kind: 'agent',
      label: 'Antigravity Session',
      state: 'working',
      liveness: 'live',
      agentType: 'antigravity',
      worktreeId: 'wt-1',
      runId: null,
      branch: null,
      path: null,
      rawState: 'working',
      workspaceStatus: null,
      taskOutcome: null,
      model: null,
      effort: null,
      observedAt: null,
      lastActivityAt: null,
      stale: false,
      taskIds: [],
      preview: null,
      outputAvailable: true,
    },
    onClose: () => {},
    onRefresh: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));

  // Should render the fresh selectedNode's label in title, but NOT the stale conversation from old Codex
  assert.ok(html.includes('Antigravity Session'));
  assert.ok(!html.includes('Old codex reply'), 'Stale message from old node must not be rendered');
  assert.ok(html.includes('modal-loading-state'), 'Loading state must be shown while matching details are loading');
});

test('NodeDetails does not render skeleton loading state when matching details exist even during background loading', () => {
  const matchingDetails = {
    node: {
      id: 'agent-1',
      kind: 'agent',
      label: 'Antigravity Session',
      state: 'working',
      liveness: 'live',
      agentType: 'antigravity',
      worktreeId: 'wt-1',
      runId: null,
      branch: null,
      path: null,
      rawState: 'working',
      workspaceStatus: null,
      taskOutcome: null,
      model: null,
      effort: null,
      observedAt: null,
      lastActivityAt: null,
      stale: false,
      taskIds: [],
      preview: null,
      outputAvailable: true,
    },
    tasks: [],
    activity: [],
    currentTool: null,
    conversation: {
      data: {
        messages: [{ id: 'm1', role: 'agent', text: 'Hello', at: null }],
        cursor: null,
        nextCursor: null,
        limited: false,
        truncated: false,
        warnings: [],
      },
      meta: { availability: 'ready', observedAt: null, attemptedAt: '2026-10-17T00:00:00Z', stale: false, partial: false, issue: null },
    },
  } as unknown as NodeDetailsType;

  const html = renderToStaticMarkup(createElement(NodeDetails, {
    projectId: 'proj',
    details: matchingDetails,
    loading: true, // background refresh in progress
    error: null,
    selectedNodeId: 'agent-1',
    selectedNode: matchingDetails.node,
    onClose: () => {},
    onRefresh: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));

  // Must render content and must NOT render skeleton overlay to prevent layout flicker
  assert.ok(html.includes('Antigravity Session'));
  assert.ok(html.includes('Hello'));
  assert.ok(!html.includes('modal-loading-state'), 'Skeleton state must not be rendered when matching details already exist');
});

test('compareWorkflowNodes sorts nodes stably by lowercase label', () => {
  const nodeZ = { id: 'node-1', kind: 'agent', label: 'Zebra' } as Node;
  const nodeA = { id: 'node-2', kind: 'agent', label: 'Alpha' } as Node;
  const nodeM = { id: 'node-3', kind: 'agent', label: 'Mango' } as Node;

  const sorted = [nodeZ, nodeA, nodeM].sort(compareWorkflowNodes);
  assert.deepEqual(sorted.map((n) => n.label), ['Alpha', 'Mango', 'Zebra']);
});

test('NodeDetails suppresses CONVERSATION_UNSUPPORTED alert and shows empty hint for unstarted sessions', () => {
  const node = {
    id: 'node-unstarted',
    kind: 'agent',
    label: 'Fresh Agent Tab',
    state: 'idle',
    liveness: 'live',
    agentType: 'codex',
    worktreeId: 'wt-1',
    runId: null,
    branch: null,
    path: null,
    rawState: 'idle',
    workspaceStatus: null,
    taskOutcome: null,
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: true,
  } as unknown as Node;

  const html = renderToStaticMarkup(createElement(NodeDetails, {
    projectId: 'proj-1',
    selectedNodeId: 'node-unstarted',
    loading: false,
    error: null,
    details: {
      node,
      currentTool: null,
      tasks: [],
      conversation: {
        meta: {
          source: 'codex',
          availability: 'unsupported',
          stale: false,
          issue: {
            code: 'CONVERSATION_UNSUPPORTED',
            message: 'Agent transcript provenance not found or unsupported',
            retryable: false,
          },
        },
        data: {
          messages: [],
          nextCursor: null,
        },
      },
    } as unknown as NodeDetailsType,
    selectedNode: node,
    onClose: () => {},
    onRefresh: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));

  // Should NOT render the alert banner with CONVERSATION_UNSUPPORTED
  assert.ok(!html.includes('alert-error'), 'Error alert must be suppressed for unstarted sessions');
  assert.ok(!html.includes('[CONVERSATION_UNSUPPORTED]'), 'Error code must not be shown in alert');
  // Should render the clean empty hint
  assert.ok(html.includes('No conversation messages recorded for this session.'), 'Friendly empty hint must be shown');
  // Message composer should still be present
  assert.ok(html.includes('chatbox-textarea'), 'Message composer should be available to chat');
});

test('WorkflowGraph renders orchestrator in separate lane when orchestrationSeparated is true', () => {
  const orchNode: Node = {
    id: 'orch-1',
    kind: 'orchestrator',
    label: 'Lead Orchestrator',
    worktreeId: 'wt-1',
    runId: null,
    agentType: 'antigravity',
    branch: null,
    path: null,
    state: 'idle',
    rawState: 'connected',
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: true,
  };

  const wtNode: Node = {
    id: 'wt-1',
    kind: 'worktree',
    label: 'main',
    worktreeId: 'wt-1',
    runId: null,
    agentType: null,
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'idle',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: false,
  };

  const html = renderToStaticMarkup(createElement(WorkflowGraph, {
    projectId: 'proj-1',
    runId: null,
    loading: false,
    nodes: [orchNode, wtNode],
    edges: [],
    selectedNodeId: null,
    onSelectNode: () => {},
    isLocallyStale: false,
    orchestrationSeparated: true,
  }));

  assert.ok(html.includes('orchestrator-lane'), 'Orchestrator lane must be rendered');
  assert.ok(html.includes('1 Orchestrator • 1 Worktree'), 'Count badge must include orchestrator count');
  assert.ok(html.includes('Lead Orchestrator'));
});

test('WorkflowGraph moves orchestrator inside worktree and omits orchestrator lane when orchestrationSeparated is false', () => {
  const orchNode: Node = {
    id: 'orch-1',
    kind: 'orchestrator',
    label: 'Lead Orchestrator',
    worktreeId: 'wt-1',
    runId: null,
    agentType: 'antigravity',
    branch: null,
    path: null,
    state: 'idle',
    rawState: 'connected',
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: true,
  };

  const wtNode: Node = {
    id: 'wt-1',
    kind: 'worktree',
    label: 'main',
    worktreeId: 'wt-1',
    runId: null,
    agentType: null,
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'idle',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: false,
  };

  const html = renderToStaticMarkup(createElement(WorkflowGraph, {
    projectId: 'proj-1',
    runId: null,
    loading: false,
    nodes: [orchNode, wtNode],
    edges: [],
    selectedNodeId: null,
    onSelectNode: () => {},
    isLocallyStale: false,
    orchestrationSeparated: false,
  }));

  assert.ok(!html.includes('orchestrator-lane'), 'Orchestrator lane must NOT be rendered');
  assert.ok(!html.includes('Orchestrator •'), 'Toolbar badge must NOT contain Orchestrator');
  assert.ok(html.includes('1 Worktree'), 'Toolbar badge must show worktree count');
  assert.ok(html.includes('worktree-agents-stack'), 'Worktree agents stack must be rendered');
  assert.ok(html.includes('Lead Orchestrator'), 'Orchestrator node must be placed inside the worktree');
});

test('RenameDialog renders input field with initial title and action buttons', () => {
  const html = renderToStaticMarkup(
    createElement(RenameDialog, {
      isOpen: true,
      isClosing: false,
      initialTitle: 'Original Title',
      onRename: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('Rename Tab Title'));
  assert.ok(html.includes('value="Original Title"'));
  assert.ok(html.includes('Cancel'));
  assert.ok(html.includes('Save'));
});

test('AddAgentDialog renders preset buttons, command and title inputs', () => {
  const html = renderToStaticMarkup(
    createElement(AddAgentDialog, {
      isOpen: true,
      isClosing: false,
      worktreeName: 'feature-branch',
      onCreate: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('Add New Agent'));
  assert.ok(html.includes('feature-branch'));
  assert.ok(html.includes('Codex'));
  assert.ok(html.includes('Claude'));
  assert.ok(html.includes('OpenCode'));
  assert.ok(html.includes('Antigravity'));
  assert.ok(html.includes('Gemini'));
  assert.ok(html.includes('Create Agent'));
});

test('NodeDetails renders rename edit button for agent nodes and Add Agent button for worktrees', () => {
  const agentNode: Node = {
    id: 'agent-1',
    kind: 'agent',
    label: 'My Codex Agent',
    worktreeId: 'wt-1',
    runId: null,
    agentType: 'codex',
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'idle',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: 'o3-mini',
    effort: 'high',
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: true,
  };

  const agentHtml = renderToStaticMarkup(
    createElement(NodeDetails, {
      projectId: 'proj-1',
      details: {
        node: agentNode,
        facts: { workspacePath: 'C:\\test', branch: 'main', terminalVerdict: 'live' },
        conversation: { data: { messages: [], cursor: null, nextCursor: null, limited: false, truncated: false, warnings: [] }, meta: { availability: 'ready', observedAt: null, attemptedAt: '2026-10-17T00:00:00Z', stale: false, partial: false, issue: null } },
        tools: { data: [], meta: { availability: 'ready', observedAt: null, attemptedAt: '2026-10-17T00:00:00Z', stale: false, partial: false, issue: null } },
        tasks: [],
        activity: [],
      } as unknown as NodeDetailsType,
      loading: false,
      error: null,
      selectedNodeId: 'agent-1',
      selectedNode: agentNode,
      onClose: () => {},
      onRefresh: () => {},
    })
  );

  assert.ok(agentHtml.includes('btn-rename-node'), 'Agent node must have rename button');

  const wtNode: Node = {
    id: 'wt-1',
    kind: 'worktree',
    label: 'main',
    worktreeId: 'wt-1',
    runId: null,
    agentType: null,
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'idle',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: false,
  };

  const wtHtml = renderToStaticMarkup(
    createElement(NodeDetails, {
      projectId: 'proj-1',
      details: {
        node: wtNode,
        facts: { workspacePath: 'C:\\test', branch: 'main', terminalVerdict: 'live' },
        conversation: { data: { messages: [], cursor: null, nextCursor: null, limited: false, truncated: false, warnings: [] }, meta: { availability: 'ready', observedAt: null, attemptedAt: '2026-10-17T00:00:00Z', stale: false, partial: false, issue: null } },
        tools: { data: [], meta: { availability: 'ready', observedAt: null, attemptedAt: '2026-10-17T00:00:00Z', stale: false, partial: false, issue: null } },
        tasks: [],
        activity: [],
      } as unknown as NodeDetailsType,
      loading: false,
      error: null,
      selectedNodeId: 'wt-1',
      selectedNode: wtNode,
      onClose: () => {},
      onRefresh: () => {},
    })
  );

  assert.ok(wtHtml.includes('btn-add-agent'), 'Worktree node must have Add Agent button');
});

test('WorkflowGraph renders worktree member agents with node-draggable and drag grip handle', () => {
  const wtNode: Node = {
    id: 'wt-1',
    kind: 'worktree',
    label: 'main',
    worktreeId: 'wt-1',
    runId: null,
    agentType: null,
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'idle',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: null,
    effort: null,
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: false,
  };

  const agNode: Node = {
    id: 'agent-in-wt',
    kind: 'agent',
    label: 'Worker 1',
    worktreeId: 'wt-1',
    runId: null,
    agentType: 'codex',
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'working',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    model: 'o3-mini',
    effort: 'high',
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: true,
  };

  const edge: Edge = {
    id: 'edge-membership',
    source: 'wt-1',
    target: 'agent-in-wt',
    kind: 'contains',
    evidence: 'workspace-membership',
    active: true,
  };

  const html = renderToStaticMarkup(
    createElement(WorkflowGraph, {
      projectId: 'proj-1',
      runId: null,
      loading: false,
      nodes: [wtNode, agNode],
      edges: [edge],
      selectedNodeId: null,
      onSelectNode: () => {},
      isLocallyStale: false,
    })
  );

  assert.ok(html.includes('node-draggable'), 'Worktree agent card must have node-draggable class');
  assert.ok(html.includes('drag-grip-icon'), 'Worktree agent card must render drag grip icon');
  assert.ok(html.includes('Add Agent'), 'Worktree box header must render Add Agent button');
});

test('WorkflowGraph respects worktreeMemberOrder from localStorage to order worktree agents', () => {
  const wtNode: Node = {
    id: 'wt-1',
    kind: 'worktree',
    label: 'main-worktree',
    worktreeId: 'wt-1',
    runId: null,
    agentType: null,
    branch: 'main',
    path: 'C:\\test\\main',
    state: 'idle',
    rawState: null,
    workspaceStatus: null,
    taskOutcome: null,
    liveness: 'live',
    observedAt: null,
    lastActivityAt: null,
    stale: false,
    taskIds: [],
    preview: null,
    outputAvailable: false,
  };
  const ag1: Node = {
    ...wtNode,
    id: 'ag-1',
    kind: 'agent',
    label: 'Alpha Agent',
    worktreeId: 'wt-1',
  };
  const ag2: Node = {
    ...wtNode,
    id: 'ag-2',
    kind: 'agent',
    label: 'Beta Agent',
    worktreeId: 'wt-1',
  };
  const edge1 = { id: 'e1', source: 'wt-1', target: 'ag-1', kind: 'contains' as const, evidence: 'workspace-membership' as const, active: true };
  const edge2 = { id: 'e2', source: 'wt-1', target: 'ag-2', kind: 'contains' as const, evidence: 'workspace-membership' as const, active: true };

  const store = new Map<string, string>();
  store.set('orca-worktree-member-order:proj-order-test', JSON.stringify({
    'wt-1': ['ag-2', 'ag-1'],
  }));
  const originalLocalStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };

  try {
    const html = renderToStaticMarkup(
      createElement(WorkflowGraph, {
        projectId: 'proj-order-test',
        runId: null,
        loading: false,
        nodes: [wtNode, ag1, ag2],
        edges: [edge1, edge2],
        selectedNodeId: null,
        onSelectNode: () => {},
        isLocallyStale: false,
      })
    );

    const betaIdx = html.indexOf('Beta Agent');
    const alphaIdx = html.indexOf('Alpha Agent');
    assert.ok(betaIdx !== -1 && alphaIdx !== -1);
    assert.ok(betaIdx < alphaIdx, 'Beta Agent should appear before Alpha Agent per custom worktree order');
  } finally {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

test('Icon component renders arrow-down and arrow-up paths correctly', () => {
  const downHtml = renderToStaticMarkup(createElement(Icon, { name: 'arrow-down', size: 12 }));
  assert.ok(downHtml.includes('<polyline points="19 12 12 19 5 12"'), 'arrow-down polyline must render');

  const upHtml = renderToStaticMarkup(createElement(Icon, { name: 'arrow-up', size: 12 }));
  assert.ok(upHtml.includes('<polyline points="5 12 12 5 19 12"'), 'arrow-up polyline must render');
});





