import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeGitHubItem, observeGitHubItems, readUnreadHistory, saveUnreadHistory } from '../features/github/githubUnread';
import { latestAgentMessage } from '../features/workflow/conversation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LatestMessageCard } from '../features/workflow/LatestMessageCard';
import { normalizeProvider, ProviderIcon } from '../components/providers/ProviderIcon';
import { ORCA_PROVIDER_IMAGES } from '../components/providers/OrcaProviderAssets';

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
