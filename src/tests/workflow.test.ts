import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { latestAgentMessage } from '../features/workflow/conversation';
import { LatestMessageCard } from '../features/workflow/LatestMessageCard';
import { compareWorkflowNodes } from '../features/workflow/workflowOrder';
import { separateWorkflowBoxes } from '../features/workflow/workflowCollision';
import { DEFAULT_VISIBLE_SECTIONS, NodeDetails } from '../features/workflow/NodeDetails';
import { WorkflowGraph } from '../features/workflow/WorkflowGraph';
import { validateMessageFiles, MessageAttachments } from '../features/workflow/MessageAttachments';
import type { Node, Edge, NodeDetails as NodeDetailsType } from '../../shared/contracts';
import { WorkflowEdgesSvg } from '../features/workflow/WorkflowEdgesSvg';
import { ToolActivityOverlay } from '../features/workflow/ToolActivityOverlay';

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
  assert.match(toolHtml, /left:328px/);
  const outside = renderToStaticMarkup(createElement(ToolActivityOverlay, {
    positions: new Map([['target', { x: 400, y: 80, width: 260, height: 100 }]]), canvasWidth: 700, reducedMotion: true,
    tools: [{ id: 'tool', nodeId: 'target', label: 'Read: index.html', at: null, expiresAt: Date.now() + 4500 }],
  }));
  assert.match(outside, /left:122px/);
  assert.equal(outside.includes('animateMotion'), false);
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
  assert.equal(DEFAULT_VISIBLE_SECTIONS.status, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.tasks, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.latest, true);
  assert.equal(DEFAULT_VISIBLE_SECTIONS.tool, true);
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
  assert.ok(html.includes('Status &amp; Workspace'));

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
