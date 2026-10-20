import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxItem } from '../../shared/contracts';
import { readHandled, failedInboxProjects } from '../features/inbox/inboxState';
import { InboxPanel } from '../features/inbox/InboxPanel';
import { useDashboard } from '../app/useDashboard';

const now = Date.parse('2026-10-19T06:00:00Z');
const failure: InboxItem = { id: 'failure', nodeId: 'node_pane', runId: null, entityId: 'agent:pane', projectId: 'project', projectName: 'Demo', title: '<script>Failed test</script>', outcome: 'failed', at: '2026-10-19T04:00:00Z', source: 'agent' };
test('handled IDs survive serialization, malformed storage is ignored and bounded', () => {
  assert.deepEqual([...readHandled(JSON.stringify(['one', 'two', 42]))], ['one', 'two']);
  assert.equal(readHandled('broken').size, 0);
  assert.equal(readHandled(JSON.stringify(Array.from({ length: 2100 }, (_, i) => String(i)))).size, 2000);
});
test('project failure line clears on handling, newer success or age, independently per entity', () => {
  assert.ok(failedInboxProjects([failure], new Set(), now).has('project'));
  assert.equal(failedInboxProjects([failure], new Set(['failure']), now).size, 0);
  const success: InboxItem = { ...failure, id: 'success', outcome: 'succeeded', at: '2026-10-19T05:00:00Z' };
  assert.equal(failedInboxProjects([failure, success], new Set(), now).size, 0);
  assert.equal(failedInboxProjects([failure], new Set(), now + 24 * 60 * 60 * 1000).size, 0);
  assert.ok(failedInboxProjects([failure, { ...success, entityId: 'another-agent' }], new Set(), now).has('project'));
});
test('inbox renders safe result text and explicit handling controls', () => {
  const html = renderToStaticMarkup(React.createElement(InboxPanel, { isOpen: true, isClosing: false, onClose() {}, items: [failure], handled: new Set<string>(), onHandle() {}, loading: false, issue: null, partial: false, onRefresh() {}, onOpenAgent() {} }));
  assert.ok(html.includes('Mark all handled'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Failed'));
  assert.ok(html.includes('Open agent details for'));
  assert.ok(html.includes('inbox-tab-indicator'));
  assert.ok(html.includes('result-failed'));
});

test('opening inbox agents preserves current-project snapshots and changes project/run/node together', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let path = '';
  const initial = { search: '?project=project', pathname: '/' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: initial, history: { replaceState(_state: unknown, _title: string, url: string) { path = url; } } } });
  try {
    function Probe({ destination }: { destination: string }) {
      const dashboard = useDashboard();
      const once = React.useRef(false);
      if (!once.current) {
        once.current = true;
        dashboard.setSelectedProjectId('project');
        dashboard.openInboxNode(destination, 'node_pane', destination === 'project' ? null : 'run_exact');
      }
      return React.createElement('div', { 'data-project': dashboard.selectedProjectId, 'data-node': dashboard.selectedNodeId,
        'data-run': dashboard.selectedRunId, 'data-loading': dashboard.snapshotLoading });
    }
    const same = renderToStaticMarkup(React.createElement(Probe, { destination: 'project' }));
    assert.match(same, /data-node="node_pane"/);
    assert.match(same, /data-loading="false"/);
    assert.equal(path, '?project=project&node=node_pane');
    const other = renderToStaticMarkup(React.createElement(Probe, { destination: 'other-project' }));
    assert.match(other, /data-project="other-project"/);
    assert.match(other, /data-node="node_pane"/);
    assert.match(other, /data-run="run_exact"/);
    assert.equal(path, '?project=other-project&run=run_exact&node=node_pane');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('inbox arrow opens the exact agent item without handling it or refreshing', () => {
  let tree: React.ReactElement<any>;
  let opened: InboxItem | null = null;
  const props = { isOpen: true, isClosing: false, onClose() {}, items: [failure], handled: new Set<string>(),
    onHandle() { assert.fail('Opening details must not mark a result handled'); }, loading: false, issue: null, partial: false,
    onRefresh() { assert.fail('Opening details must not refresh the inbox'); }, onOpenAgent(item: InboxItem) { opened = item; } };
  function Probe() { tree = InboxPanel(props); return tree; }
  renderToStaticMarkup(React.createElement(Probe));
  function arrow(node: React.ReactNode): React.ReactElement<any> | undefined {
    for (const child of React.Children.toArray(node)) {
      if (!React.isValidElement<any>(child)) continue;
      const props = child.props as { className?: string; children?: React.ReactNode };
      if (props.className === 'inbox-open-project') return child as React.ReactElement<any>;
      const found = arrow(props.children);
      if (found) return found;
    }
  }
  const button = arrow(tree!);
  assert.ok(button);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(opened, failure);
  const unavailable = renderToStaticMarkup(React.createElement(InboxPanel, { ...props, items: [{ ...failure, nodeId: null }] }));
  assert.match(unavailable, /class="inbox-open-project" disabled=""/);
  assert.ok(unavailable.includes('Agent is no longer available'));
});
