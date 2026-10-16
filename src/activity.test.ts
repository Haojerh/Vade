import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeGitHubItems } from './githubUnread';
import { latestAgentMessage } from './conversation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LatestMessageCard } from './components/LatestMessageCard';

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
