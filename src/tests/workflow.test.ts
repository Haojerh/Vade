import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { latestAgentMessage } from '../features/workflow/conversation';
import { LatestMessageCard } from '../features/workflow/LatestMessageCard';
import { ConversationHistory, mergeConversationMessages, mergeLiveConversation } from '../features/workflow/ConversationHistory';
import { bindWorkflowPinch } from '../features/workflow/workflowTouch';
import { compareWorkflowNodes } from '../features/workflow/workflowOrder';
import { separateWorkflowBoxes } from '../features/workflow/workflowCollision';
import { DEFAULT_VISIBLE_SECTIONS, NodeDetails } from '../features/workflow/NodeDetails';
import { WorkflowGraph } from '../features/workflow/WorkflowGraph';
import { validateMessageFiles, MessageAttachments } from '../features/workflow/MessageAttachments';
import type { Node, Edge, NodeDetails as NodeDetailsType } from '../../shared/contracts';
import type { ConversationMessage } from '../../shared/contracts';

test('conversation history prepends older turns, deduplicates boundaries and exposes older paging', () => {
  const older: ConversationMessage = { id: 'old', role: 'user', text: 'Older message', at: null };
  const latest: ConversationMessage = { id: 'new', role: 'agent', text: 'Latest message', at: null };
  assert.deepEqual(mergeConversationMessages([older, latest], [latest]).map(message => message.id), ['old', 'new']);
  const html = renderToStaticMarkup(createElement(ConversationHistory, { projectId: 'project', nodeId: 'node', runId: 'run', page: {
    messages: [older, latest], source: 'transcript', sourceIdentity: 'exact-session', provider: 'codex', cursor: null, nextCursor: 'cur_older', limited: true, truncated: false, warnings: [],
  } }));
  assert.ok(html.includes('Load more'));
  assert.ok(html.includes('conversation-history-content'));
  assert.ok(!html.includes('conversation-history-scroll'));
  assert.ok(html.indexOf('Older message') < html.indexOf('Latest message'));
  const atStart = renderToStaticMarkup(createElement(ConversationHistory, { projectId: 'project', nodeId: 'node', runId: null, page: {
    messages: [latest], source: 'transcript', sourceIdentity: 'exact-session', provider: 'codex', cursor: null, nextCursor: null, limited: false, truncated: false, warnings: [],
  } }));
  assert.ok(!atStart.includes('Start of conversation') && !atStart.includes('conversation-history-pagination'));
});

test('live conversation updates replace matching IDs, retain loaded history and deduplicate reconnects', () => {
  const old: ConversationMessage = { id: 'old', role: 'user', text: 'Earlier', at: null };
  const first: ConversationMessage = { id: 'new', role: 'agent', text: 'First', at: null };
  const updated = { ...first, text: 'Updated' };
  const result = mergeLiveConversation([old, first], [updated, updated]);
  assert.deepEqual(result, [old, updated]);
  assert.deepEqual(mergeLiveConversation(result, [updated]), result);
});
import { WorkflowEdgesSvg } from '../features/workflow/WorkflowEdgesSvg';
import { ToolActivityOverlay } from '../features/workflow/ToolActivityOverlay';
import { boxesOverlap, placeToolCard, toolConnectionPath, toolPorts, toolCardConnectionPath, roundedToolPath } from '../features/workflow/toolActivityLayout';
import { placeNewWorktree } from '../features/workflow/newWorktreePlacement';
import { clampWorkflowZoom, workflowBox, zoomScrollOffset } from '../features/workflow/workflowZoom';
import { ToolEditDiff } from '../features/workflow/ToolActivityCard';

test('tool edit hover renders safe before/after code, location and truncation', () => {
  const html = renderToStaticMarkup(createElement(ToolEditDiff, { edits: [{ path: 'src/app.ts', location: '@@ main', truncated: true,
    lines: [{ kind: 'remove', text: 'before' }, { kind: 'add', text: '<script>after</script>' }] }] }));
  assert.match(html, /src\/app.ts/);
  assert.match(html, /@@ main/);
  assert.match(html, /tool-edit-remove/);
  assert.match(html, /tool-edit-add/);
  assert.match(html, /Preview shortened/);
  assert.ok(!html.includes('<script>'));
});

test('topology zoom keeps geometry logical and the pointer anchored across scales', () => {
  for (const zoom of [0.4, 0.75, 1, 1.5, 2]) {
    const origin = { left: -200, top: -150 };
    const rect = { left: origin.left + 320 * zoom, top: origin.top + 180 * zoom, width: 300 * zoom, height: 120 * zoom };
    assert.deepEqual(workflowBox(rect, origin, zoom), { x: 320, y: 180, width: 300, height: 120 });
    const next = clampWorkflowZoom(zoom + 0.1);
    const before = (500 + 200) / zoom;
    const after = (zoomScrollOffset(500, 200, zoom, next) + 200) / next;
    assert.ok(Math.abs(before - after) < 0.00001);
  }
  assert.equal(clampWorkflowZoom(0.1), 0.4);
  assert.equal(clampWorkflowZoom(5), 2);
  assert.equal(zoomScrollOffset(0, 0, 1, 0.4), 0);
});

test('new worktrees use free space in the scrolled viewport without covering existing groups', () => {
  const viewport = { x: 500, y: 800, width: 1000, height: 700 };
  const occupied = [{ x: 520, y: 820, width: 450, height: 450 }];
  const original = structuredClone(occupied);
  const placement = placeNewWorktree({ width: 350, height: 180 }, viewport, occupied);
  assert.equal(placement.inViewport, true);
  assert.ok(placement.box.x >= viewport.x && placement.box.x + placement.box.width <= viewport.x + viewport.width);
  assert.ok(placement.box.y >= viewport.y && placement.box.y + placement.box.height <= viewport.y + viewport.height);
  assert.equal(boxesOverlap(placement.box, occupied[0], 16), false);
  assert.deepEqual(occupied, original);
  const full = placeNewWorktree({ width: 350, height: 180 }, viewport, [viewport]);
  assert.equal(full.inViewport, false);
  assert.equal(boxesOverlap(full.box, viewport, 16), false);
  const large = placeNewWorktree({ width: 1400, height: 900 }, viewport, occupied);
  assert.equal(large.inViewport, false);
  assert.equal(boxesOverlap(large.box, occupied[0], 16), false);
});

test('working graph edges animate only explicit message packets, once and in the observed direction', () => {
  const source = { id: 'source', kind: 'orchestrator' } as Node;
  const target = { id: 'target', kind: 'agent', state: 'working' } as Node;
  const props = {
    edges: [{ id: 'edge', source: source.id, target: target.id, kind: 'delegates', isActive: true }],
    nodeMap: new Map([[source.id, source], [target.id, target]]),
    positions: new Map([[source.id, { x: 0, y: 0, width: 100, height: 100 }], [target.id, { x: 200, y: 0, width: 100, height: 100 }]]),
    canvasSize: { width: 600, height: 400 }, prefersReducedMotion: false,
  };
  assert.equal(renderToStaticMarkup(createElement(WorkflowEdgesSvg, props)).includes('animateMotion'), false);
  const packets = [{ id: 'reply', source: target.id, target: source.id, at: new Date().toISOString(), expiresAt: Date.now() + 1600 }];
  const html = renderToStaticMarkup(createElement(WorkflowEdgesSvg, { ...props, packets }));
  assert.match(html, /repeatCount="1"/);
  assert.match(html, /keyPoints="1;0"/);
  assert.equal(html.includes('indefinite'), false);
  assert.equal(renderToStaticMarkup(createElement(WorkflowEdgesSvg, { ...props, packets, prefersReducedMotion: true })).includes('animateMotion'), false);
  const toolHtml = renderToStaticMarkup(createElement(ToolActivityOverlay, { positions: props.positions, reducedMotion: false,
    tools: [{ id: 'tool', nodeId: 'target', label: 'Read: index.html', at: null, expiresAt: Date.now() + 4500 }] }));
  assert.match(toolHtml, /Read: index.html/);
  assert.match(toolHtml, /repeatCount="1"/);
  assert.match(toolHtml, /delivery-packet-green/);
  const outside = renderToStaticMarkup(createElement(ToolActivityOverlay, {
    positions: new Map([['target', { x: 400, y: 80, width: 260, height: 100 }]]), canvasWidth: 700, reducedMotion: true,
    tools: [{ id: 'tool', nodeId: 'target', label: 'Read: index.html', at: null, expiresAt: Date.now() + 4500 }],
  }));
  assert.match(outside, /tool-activity-detail/);
  assert.equal(outside.includes('animateMotion'), false);
});

test('tool cards avoid occupied worktrees and route their delivery paths around blockers', () => {
  const anchor = { x: 400, y: 80, width: 260, height: 100 };
  const otherWorktree = { x: 690, y: 40, width: 380, height: 500 };
  const previousCard = { x: 80, y: 80, width: 280, height: 56 };
  const obstacles = [anchor, otherWorktree, previousCard];
  const card = placeToolCard(anchor, obstacles, 1100);
  for (const obstacle of obstacles) assert.equal(boxesOverlap(card, obstacle), false);
  const blocker = { x: 200, y: 50, width: 100, height: 100 };
  const path = toolConnectionPath({ x: 100, y: 100 }, { x: 400, y: 100 }, [blocker]);
  assert.ok(path);
  assert.notEqual(path, 'M 100 100 L 400 100');
  assert.match(path, / Q /);
  const points = [...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
  assert.deepEqual(points[0], { x: 100, y: 100 });
  assert.deepEqual(points.at(-1), { x: 400, y: 100 });
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    if (a.y === b.y) assert.ok(a.y <= blocker.y || a.y >= blocker.y + blocker.height || Math.max(a.x, b.x) <= blocker.x || Math.min(a.x, b.x) >= blocker.x + blocker.width);
    else assert.ok(a.x <= blocker.x || a.x >= blocker.x + blocker.width || Math.max(a.y, b.y) <= blocker.y || Math.min(a.y, b.y) >= blocker.y + blocker.height);
  }
});

test('orchestrator tools never overlap their associated worktree, inside or outside its box', () => {
  const worktree = { x: 360, y: 80, width: 600, height: 500 };
  for (const anchor of [{ x: 20, y: 100, width: 260, height: 100 }, { x: 400, y: 140, width: 260, height: 100 }]) {
    const html = renderToStaticMarkup(createElement(ToolActivityOverlay, {
      tools: [{ id: 'edit', nodeId: 'coordinator', label: 'Edit: test.ts', at: null, expiresAt: 9999999999999 }],
      positions: new Map([['coordinator', anchor], ['workspace', worktree]]), reducedMotion: true, canvasWidth: 1100,
      nodes: [{ id: 'coordinator', kind: 'orchestrator', worktreeId: 'wt' }, { id: 'workspace', kind: 'worktree', worktreeId: 'wt' }] as Node[],
    }));
    const style = html.match(/class="tool-activity-node" style="([^"]+)"/)?.[1];
    assert.ok(style);
    const x = Number(style.match(/left:([\d.-]+)px/)?.[1]);
    const y = Number(style.match(/top:([\d.-]+)px/)?.[1]);
    assert.equal(boxesOverlap({ x, y, width: 280, height: 56 }, worktree), false);
    assert.equal(boxesOverlap({ x, y, width: 280, height: 56 }, anchor), false);
  }
});

test('tool connectors can exit a containing worktree without matching optional workspace IDs', () => {
  const html = renderToStaticMarkup(createElement(ToolActivityOverlay, {
    tools: [{ id: 'edit', nodeId: 'agent', label: 'Edit: test.ts', at: null, expiresAt: 9999999999999 }],
    positions: new Map([
      ['agent', { x: 60, y: 80, width: 260, height: 100 }],
      ['workspace', { x: 20, y: 20, width: 440, height: 300 }],
      ['sibling', { x: 60, y: 185, width: 260, height: 100 }],
    ]), reducedMotion: true, canvasWidth: 900,
    nodes: [{ id: 'agent', kind: 'agent' }, { id: 'workspace', kind: 'worktree' }, { id: 'sibling', kind: 'agent' }] as Node[],
  }));
  assert.match(html, /class="tool-activity-connection"/);
});

test('tool placement favors a clean direct connection and leaves room for the packet at arrival', () => {
  const anchor = { x: 400, y: 80, width: 260, height: 100 };
  const card = placeToolCard(anchor, [anchor], 800);
  const { start, end, cardPort } = toolPorts(anchor, card);
  assert.equal(start.y, end.y);
  assert.equal(Math.abs(end.x - cardPort.x), 8);
  assert.match(toolConnectionPath(start, end, [])!, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  const below = toolPorts(anchor, { x: 400, y: 240, width: 280, height: 56 });
  assert.equal(below.start.y, 180);
  assert.equal(below.start.x, below.end.x);
  assert.equal(below.end.y, 232);
  const smooth = toolConnectionPath({ x: 420, y: 100 }, { x: 340, y: 200 }, []);
  assert.equal(smooth, 'M 420 100 C 380 100, 380 200, 340 200');
  assert.equal(smooth.includes(' Q '), false);
});

test('tool detours favor a compact rounded route over a longer sweeping curve', () => {
  const path = toolCardConnectionPath({ x: 400, y: 80, width: 260, height: 100 },
    { x: 400, y: 400, width: 280, height: 56 }, [{ x: 400, y: 190, width: 260, height: 100 }]);
  assert.ok(path);
  assert.match(path, / Q /);
  assert.equal([...path.matchAll(/ Q /g)].length, 2);
  assert.ok(path.endsWith('L 530 392'));
  assert.equal(roundedToolPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]),
    'M 0 0 L 60 0 Q 100 0 100 40 L 100 100');
});

test('tool placement uses the nearby gap between worktrees instead of routing below the entire graph', () => {
  const anchor = { x: 127, y: 84, width: 325, height: 116 };
  const containingWorktree = { x: 12, y: 14, width: 553, height: 330 };
  const rightWorktree = { x: 595, y: 58, width: 620, height: 203 };
  const lowerWorktree = { x: 5, y: 366, width: 620, height: 204 };
  const sibling = { x: 127, y: 212, width: 325, height: 116 };
  const routingObstacles = [rightWorktree, lowerWorktree, sibling];
  const occupied = [containingWorktree, ...routingObstacles, anchor];
  const card = placeToolCard(anchor, occupied, 1223, routingObstacles);
  for (const obstacle of occupied) assert.equal(boxesOverlap(card, obstacle), false);
  assert.ok(card.x >= containingWorktree.x + containingWorktree.width);
  assert.ok(card.y >= rightWorktree.y + rightWorktree.height);
  assert.ok(card.y + card.height < lowerWorktree.y);
  const path = toolCardConnectionPath(anchor, card, routingObstacles)!;
  assert.match(path, /^M 452 142 C /);
  assert.equal(path.includes(' Q '), false);
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

test('DEFAULT_VISIBLE_SECTIONS has all sections visible by default', () => {
  assert.equal(DEFAULT_VISIBLE_SECTIONS.conversation, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.chatbox, true);
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
  assert.equal(html.includes('node-details-settings-container'), false);
  assert.equal(html.includes('Node details section visibility settings'), false);
  assert.equal(html.includes('Status &amp; Workspace'), false);
  assert.equal(html.includes('Latest Agent Message'), false);
  assert.equal(html.includes('Message Agent</h3>'), false);
  assert.equal(html.includes('Conversation History'), false);
  assert.ok(html.includes('aria-label="Conversation"'));

  const htmlHidden = renderToStaticMarkup(createElement(NodeDetails, {
    projectId: 'proj_1',
    details,
    loading: false,
    error: null,
    selectedNodeId: 'agent-1',
    onClose: () => {},
    onRefresh: () => {},
    visibleSections: { ...DEFAULT_VISIBLE_SECTIONS, conversation: false },
  }));
  assert.equal(htmlHidden.includes('Status &amp; Workspace'), false);
  assert.equal(htmlHidden.includes('Conversation History'), false);
  assert.ok(htmlHidden.includes('composer-only-dialog'));
  assert.equal(htmlHidden.includes('section-header-row'), false);
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
  assert.ok(html.includes('Status &amp; Workspace'));
  assert.equal(html.includes('Close Agent Tab'), false);
});

test('two-finger canvas pinch cancels dragging, anchors zoom at the midpoint and preserves later taps', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const captures = new Set<number>();
  const container = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id),
  });
  const pointer = (target: EventTarget, type: string, id: number, x: number, pointerType = 'touch') => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: id, pointerType, clientX: x, clientY: 100 });
    target.dispatchEvent(event); return event;
  };
  let zoom = 1;
  let cancelled = 0;
  const anchors: { x: number; y: number }[] = [];
  const cleanup = bindWorkflowPinch(container as unknown as HTMLElement, () => zoom, (value, point) => { zoom = value; anchors.push(point); }, () => { cancelled++; });
  try {
    pointer(container, 'pointerdown', 1, 100);
    assert.equal(cancelled, 0);
    pointer(container, 'pointerdown', 2, 200);
    assert.equal(cancelled, 1);
    assert.ok(pointer(events, 'pointermove', 2, 300).defaultPrevented);
    assert.equal(zoom, 2);
    assert.deepEqual(anchors[0], { x: 190, y: 80 });
    pointer(events, 'pointermove', 2, 200);
    assert.equal(zoom, 1);
    pointer(events, 'pointerup', 1, 100);
    pointer(events, 'pointerup', 2, 200);
    assert.equal(captures.size, 0);
    const ghost = new Event('click', { cancelable: true }); container.dispatchEvent(ghost);
    assert.ok(ghost.defaultPrevented);
    pointer(container, 'pointerdown', 3, 100, 'mouse');
    const deliberate = new Event('click', { cancelable: true }); container.dispatchEvent(deliberate);
    assert.equal(deliberate.defaultPrevented, false);
  } finally {
    cleanup();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
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
    loading: true,
    error: null,
    selectedNodeId: 'agent-1',
    selectedNode: matchingDetails.node,
    onClose: () => {},
    onRefresh: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));

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

  assert.ok(!html.includes('alert-error'), 'Error alert must be suppressed for unstarted sessions');
  assert.ok(!html.includes('[CONVERSATION_UNSUPPORTED]'), 'Error code must not be shown in alert');
  assert.ok(html.includes('No conversation messages recorded for this session.'), 'Friendly empty hint must be shown');
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
