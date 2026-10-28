import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationMessage, ConversationPage, ToolActivity } from '../../shared/contracts';
import { ConversationHistory, conversationTimeline } from '../features/workflow/ConversationHistory';
import {
  ConversationToolGroup,
  classifyToolActivity,
  formatToolClause,
  groupConversationTimeline,
  summarizeToolGroup,
  toolGroupClauses,
  toolGroupIcon,
} from '../features/workflow/toolGroups';

test('summarizeToolGroup counts consecutive tool calls in first-seen category order without inferring outcomes', () => {
  const tools: ToolActivity[] = [
    { id: 'cmd-1', at: '2026-10-28T01:00:01Z', label: 'Run: npm run typecheck', detail: 'Run: npm run typecheck' },
    { id: 'cmd-2', at: '2026-10-28T01:00:02Z', label: 'Bash: git status --short', detail: 'Bash: git status --short' },
    { id: 'edit-1', at: '2026-10-28T01:00:03Z', label: 'Edit: src/a.ts', edits: [{ path: 'src/a.ts', lines: [{ kind: 'add', text: 'const a = 1;' }], truncated: false }] },
    { id: 'cmd-3', at: '2026-10-28T01:00:04Z', label: 'Exec: git diff', detail: 'Exec: git diff' },
    { id: 'edit-2', at: '2026-10-28T01:00:05Z', label: 'Edit: src/b.ts', edits: [{ path: 'src/b.ts', lines: [{ kind: 'remove', text: 'old' }, { kind: 'add', text: 'new' }], truncated: false }] },
    { id: 'cmd-4', at: '2026-10-28T01:00:06Z', label: 'Terminal: npm test', detail: 'Terminal: npm test' },
  ];
  assert.equal(classifyToolActivity(tools[3]), 'run', 'Command arguments mentioning diff must remain command calls');
  assert.deepEqual(toolGroupClauses(tools), [
    { category: 'run', count: 4, text: 'Ran 4 commands' },
    { category: 'edit', count: 2, text: 'Edited 2 files' },
  ]);
  assert.equal(summarizeToolGroup(tools), 'Ran 4 commands, Edited 2 files');
  assert.equal(toolGroupIcon(tools), 'wrench');
  assert.equal(toolGroupIcon(tools.slice(0, 2)), 'terminal');
  assert.equal(toolGroupIcon([tools[2], tools[4]]), 'file-edit');
});

test('summarizeToolGroup deduplicates repeated paths across a group and labels pathless file calls as calls', () => {
  const repeatedSamePath: ToolActivity[] = [
    { id: 'e1', at: '2026-10-28T01:10:01Z', label: 'Edit: src/same.ts', edits: [{ path: 'src/same.ts', lines: [{ kind: 'add', text: 'first' }], truncated: false }] },
    { id: 'e2', at: '2026-10-28T01:10:02Z', label: 'Edit: src/same.ts', edits: [{ path: 'src/same.ts', lines: [{ kind: 'add', text: 'second' }], truncated: false }] },
    { id: 'r1', at: '2026-10-28T01:10:03Z', label: 'Read: src/same.ts' },
    { id: 'r2', at: '2026-10-28T01:10:04Z', label: 'Read: src/same.ts' },
    { id: 'l1', at: '2026-10-28T01:10:05Z', label: 'List: src/features' },
    { id: 'l2', at: '2026-10-28T01:10:06Z', label: 'List: src/features' },
  ];
  assert.equal(summarizeToolGroup(repeatedSamePath), 'Edited 1 file, Read 1 file, Listed 1 directory');

  const pathless: ToolActivity[] = [
    { id: 'pe1', at: null, label: 'Edit' },
    { id: 'pe2', at: null, label: 'Edit' },
    { id: 'pr1', at: null, label: 'Read' },
    { id: 'pl1', at: null, label: 'List' },
  ];
  assert.equal(summarizeToolGroup(pathless), '2 edit calls, 1 read call, 1 list call');

  const mixedPathedAndPathless: ToolActivity[] = [
    { id: 'me1', at: null, label: 'Edit: src/a.ts', edits: [{ path: 'src/a.ts', lines: [{ kind: 'add', text: 'x' }], truncated: false }] },
    { id: 'me2', at: null, label: 'Edit' },
  ];
  assert.equal(summarizeToolGroup(mixedPathedAndPathless), '2 edit calls', 'When any edit call lacks a path, unique file count is unverified');
});

test('tool clauses cover singular, plural and multi-file edit previews across categories', () => {
  assert.equal(formatToolClause('run', 1), 'Ran 1 command');
  assert.equal(formatToolClause('run', 4), 'Ran 4 commands');
  assert.equal(formatToolClause('edit', 1), 'Edited 1 file');
  assert.equal(formatToolClause('edit', 2), 'Edited 2 files');
  assert.equal(formatToolClause('edit', 1, false), '1 edit call');
  assert.equal(formatToolClause('edit', 2, false), '2 edit calls');
  assert.equal(formatToolClause('read', 1), 'Read 1 file');
  assert.equal(formatToolClause('read', 3), 'Read 3 files');
  assert.equal(formatToolClause('read', 2, false), '2 read calls');
  assert.equal(formatToolClause('search', 1), 'Searched 1 time');
  assert.equal(formatToolClause('search', 2), 'Searched 2 times');
  assert.equal(formatToolClause('list', 1), 'Listed 1 directory');
  assert.equal(formatToolClause('list', 2), 'Listed 2 directories');
  assert.equal(formatToolClause('list', 2, false), '2 list calls');
  assert.equal(formatToolClause('web', 1), 'Searched the web 1 time');
  assert.equal(formatToolClause('web', 2), 'Searched the web 2 times');
  assert.equal(formatToolClause('mcp', 1), 'Used 1 integration');
  assert.equal(formatToolClause('mcp', 2), 'Used 2 integrations');
  assert.equal(formatToolClause('agent', 1), 'Ran 1 agent');
  assert.equal(formatToolClause('agent', 2), 'Ran 2 agents');
  assert.equal(formatToolClause('plan', 1), 'Updated the plan');
  assert.equal(formatToolClause('plan', 3), 'Updated the plan 3 times');
  assert.equal(formatToolClause('other', 1), 'Used 1 tool');
  assert.equal(formatToolClause('other', 2), 'Used 2 tools');

  const multiFilePatch: ToolActivity = {
    id: 'patch-1',
    at: '2026-10-28T01:00:00Z',
    label: 'Edit: src/one.ts',
    edits: [
      { path: 'src/one.ts', lines: [{ kind: 'add', text: 'export const one = 1;' }], truncated: false },
      { path: 'src/two.ts', lines: [{ kind: 'add', text: 'export const two = 2;' }], truncated: false },
    ],
  };
  assert.equal(summarizeToolGroup([multiFilePatch]), 'Edited 2 files');
  assert.equal(
    summarizeToolGroup([
      { id: 'r1', at: null, label: 'Read: README.md' },
      { id: 's1', at: null, label: 'Search: ConversationHistory' },
      { id: 'l1', at: null, label: 'List: src/features' },
      { id: 'w1', at: null, label: 'Web: https://example.com' },
      { id: 'm1', at: null, label: 'mcp__github__list_Notification' },
      { id: 'a1', at: null, label: 'Agent: researcher' },
      { id: 'p1', at: null, label: 'update_plan: checklist' },
      { id: 'o1', at: null, label: 'REPL: inspect state' },
    ]),
    'Read 1 file, Searched 1 time, Listed 1 directory, Searched the web 1 time, Used 1 integration, Ran 1 agent, Updated the plan, Used 1 tool',
  );
});

test('groupConversationTimeline groups only consecutive tools between public messages and preserves provenance and message fields', () => {
  const messages: ConversationMessage[] = [
    {
      id: 'u1',
      role: 'user',
      text: 'Check the build and fix the bug',
      at: '2026-10-28T02:00:00Z',
      rewindable: true,
      images: [{ id: 'img_1', mimeType: 'image/png', bytes: 512 }],
    },
    { id: 'a1', role: 'agent', text: 'Inspecting the files now.', at: '2026-10-28T02:00:10Z' },
    { id: 'a2', role: 'agent', text: 'Applied the fix and verified.', at: '2026-10-28T02:00:30Z' },
  ];
  const tools: ToolActivity[] = [
    { id: 'before-cutoff', at: '2026-10-28T01:59:00Z', label: 'Run: echo old' },
    { id: 't1', at: '2026-10-28T02:00:03Z', label: 'Read: src/index.ts' },
    { id: 't2', at: '2026-10-28T02:00:05Z', label: 'Search: bug' },
    { id: 't3', at: '2026-10-28T02:00:15Z', label: 'Edit: src/index.ts', edits: [{ path: 'src/index.ts', lines: [{ kind: 'add', text: 'fixed();' }], truncated: false }] },
    { id: 't4', at: '2026-10-28T02:00:20Z', label: 'Run: npm test' },
    { id: 't5', at: '2026-10-28T02:00:25Z', label: 'Run: npm run typecheck' },
  ];

  const timeline = conversationTimeline(messages, tools, true);
  const grouped = groupConversationTimeline(timeline);

  assert.deepEqual(
    grouped.map(entry => entry.kind === 'message' ? `msg:${entry.id}` : `tools:${entry.tools.map(t => t.id).join(',')}`),
    ['msg:u1', 'tools:t1,t2', 'msg:a1', 'tools:t3,t4,t5', 'msg:a2'],
  );
  assert.equal(grouped[0].kind, 'message');
  assert.equal(grouped[0].message.rewindable, true);
  assert.deepEqual(grouped[0].message.images, [{ id: 'img_1', mimeType: 'image/png', bytes: 512 }]);
  assert.equal(grouped[1].kind, 'tools');
  assert.equal(summarizeToolGroup(grouped[1].tools), 'Read 1 file, Searched 1 time');
  assert.equal(grouped[3].kind, 'tools');
  assert.equal(summarizeToolGroup(grouped[3].tools), 'Edited 1 file, Ran 2 commands');
});

test('ConversationToolGroup renders a compact collapsed summary and expands to ordered per-tool details without inferred outcomes', () => {
  const tools: ToolActivity[] = [
    { id: 'run-1', at: '2026-10-28T03:00:01Z', label: 'Run: npm test', detail: 'Run: npm test -- --grep toolGroups' },
    { id: 'run-2', at: '2026-10-28T03:00:02Z', label: 'Run: git status', detail: 'Run: git status' },
    { id: 'run-3', at: '2026-10-28T03:00:03Z', label: 'Run: npm run typecheck', detail: 'Run: npm run typecheck' },
    { id: 'run-4', at: '2026-10-28T03:00:04Z', label: 'Run: git diff', detail: 'Run: git diff' },
    { id: 'edit-1', at: '2026-10-28T03:00:05Z', label: 'Edit: src/one.ts', edits: [{ path: 'src/one.ts', lines: [{ kind: 'remove', text: 'beforeOne' }, { kind: 'add', text: 'afterOne' }], truncated: false }] },
    { id: 'edit-2', at: '2026-10-28T03:00:06Z', label: 'Edit: src/two.ts', edits: [{ path: 'src/two.ts', lines: [{ kind: 'remove', text: 'beforeTwo' }, { kind: 'add', text: 'afterTwo' }], truncated: false }] },
  ];

  const collapsed = renderToStaticMarkup(createElement(ConversationToolGroup, { tools }));
  assert.match(collapsed, /class="conversation-tool-group"/);
  assert.match(collapsed, /aria-label="Ran 4 commands, Edited 2 files"[^>]*aria-expanded="false"/);
  assert.match(collapsed, />Ran 4 commands,</);assert.match(collapsed, />Edited 2 files</);
  assert.equal([...collapsed.matchAll(/class="conversation-tool-group-clause"/g)].length,2,'each category has its own icon and label');
  assert.match(collapsed, /inert=""/);
  assert.doesNotMatch(collapsed, /Succeeded|Completed|Failed|failed|interrupted/i);

  const expanded = renderToStaticMarkup(createElement(ConversationToolGroup, { tools, defaultOpen: true }));
  assert.match(expanded, /aria-label="Ran 4 commands, Edited 2 files"[^>]*aria-expanded="true"/);
  const ids = [...expanded.matchAll(/data-tool-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['run-1', 'run-2', 'run-3', 'run-4', 'edit-1', 'edit-2']);
  assert.match(expanded, /beforeOne/);
  assert.match(expanded, /afterOne/);
  assert.match(expanded, /beforeTwo/);
  assert.match(expanded, /afterTwo/);
});

test('ConversationHistory interleaves grouped tool calls and user image attachments between public turns in chronological order', () => {
  const page: ConversationPage = {
    messages: [
      {
        id: 'm1',
        role: 'user',
        text: 'First user prompt',
        at: '2026-10-28T04:00:00Z',
        rewindable: true,
        images: [{ id: 'img_tok_1', mimeType: 'image/png', bytes: 1024 }],
      },
      { id: 'm2', role: 'agent', text: 'Intermediate agent narration', at: '2026-10-28T04:00:10Z' },
      { id: 'm3', role: 'agent', text: 'Final agent answer', at: '2026-10-28T04:00:25Z' },
    ],
    source: 'transcript',
    sourceIdentity: 'src_session_1',
    provider: 'codex',
    cursor: null,
    nextCursor: null,
    limited: false,
    truncated: false,
    warnings: [],
  };
  const tools: ToolActivity[] = [
    { id: 't1', at: '2026-10-28T04:00:02Z', label: 'Read: src/app.ts' },
    { id: 't2', at: '2026-10-28T04:00:04Z', label: 'Read: src/main.tsx' },
    { id: 't3', at: '2026-10-28T04:00:12Z', label: 'Edit: src/app.ts', edits: [{ path: 'src/app.ts', lines: [{ kind: 'add', text: 'export {};' }], truncated: false }] },
    { id: 't4', at: '2026-10-28T04:00:15Z', label: 'Run: npm test' },
  ];

  const html = renderToStaticMarkup(createElement(ConversationHistory, {
    projectId: 'proj',
    nodeId: 'node',
    runId: null,
    page,
    tools,
  }));

  const userIndex = html.indexOf('First user prompt');
  const imageIndex = html.indexOf('/api/projects/proj/nodes/node/conversation-image?source=src_session_1&amp;id=img_tok_1');
  const firstGroupIndex = html.indexOf('Read 2 files');
  const midAgentIndex = html.indexOf('Intermediate agent narration');
  const secondGroupIndex = html.indexOf('Edited 1 file, Ran 1 command');
  const finalAgentIndex = html.indexOf('Final agent answer');

  assert.ok(userIndex >= 0 && imageIndex > userIndex);
  assert.ok(firstGroupIndex > imageIndex);
  assert.ok(midAgentIndex > firstGroupIndex);
  assert.ok(secondGroupIndex > midAgentIndex);
  assert.ok(finalAgentIndex > secondGroupIndex);
});
