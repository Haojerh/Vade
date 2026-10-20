import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeConversationEvents } from '../api/client';

test('conversation SSE resumes the forward cursor after page hiding and ignores events after cleanup', () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const priorSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  let visibility = () => {};
  const page = { hidden: false, addEventListener(_name: string, fn: () => void) { visibility = fn; }, removeEventListener() {} };
  const sources: FakeSource[] = [];
  class FakeSource {
    handlers = new Map<string, (event: any) => void>();
    closed = false;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(public url: string) { sources.push(this); }
    addEventListener(name: string, fn: (event: any) => void) { this.handlers.set(name, fn); }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeSource });
  let updates = 0;
  let cleanup: (() => void) | undefined;
  try {
    cleanup = subscribeConversationEvents('project', 'node', 'run', () => { updates++; }, () => {}, () => {});
    const event = { data: JSON.stringify({ data: { nextCursor: 'opaque-forward' }, meta: {} }) };
    sources[0].handlers.get('conversation')!(event);
    assert.equal(updates, 1);
    page.hidden = true; visibility();
    assert.equal(sources[0].closed, true);
    assert.equal(sources.length, 1);
    page.hidden = false; visibility();
    assert.match(sources[1].url, /runId=run/);
    assert.match(sources[1].url, /cursor=opaque-forward/);
    cleanup(); cleanup = undefined;
    sources[1].handlers.get('conversation')!(event);
    assert.equal(updates, 1);
    assert.equal(sources[1].closed, true);
  } finally {
    cleanup?.();
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (priorSource) Object.defineProperty(globalThis, 'EventSource', priorSource); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});
