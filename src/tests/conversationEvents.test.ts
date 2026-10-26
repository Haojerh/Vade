import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeConversationEvents, subscribeProjectEvents } from '../api/client';

test('project SSE pauses while hidden, restores snapshots and ignores replaced streams', () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), priorSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const page = new EventTarget() as EventTarget & { hidden: boolean }; page.hidden = false;
  const sources: FakeSource[] = [];
  class FakeSource {
    handlers = new Map<string, (event: any) => void>(); closed = false; onerror: ((event: any) => void) | null = null;
    constructor(public url: string) { sources.push(this); }
    addEventListener(name: string, fn: (event: any) => void) { this.handlers.set(name, fn); }
    close() { this.closed = true; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeSource });
  let updates = 0, errors = 0;
  let dispose: (() => void) | undefined;
  try {
    dispose = subscribeProjectEvents('project', null, () => updates++, () => errors++);
    const event = { data: JSON.stringify({ graph: { data: null } }) };
    sources[0].handlers.get('snapshot')!(event); assert.equal(updates, 1);
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); assert.ok(sources[0].closed);
    sources[0].handlers.get('snapshot')!(event); sources[0].onerror?.({}); assert.equal(updates, 1); assert.equal(errors, 0);
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); assert.equal(sources.length, 2);
    sources[0].handlers.get('snapshot')!(event); assert.equal(updates, 1);
    sources[1].handlers.get('snapshot')!(event); assert.equal(updates, 2);
    dispose(); page.dispatchEvent(new Event('visibilitychange')); sources[1].handlers.get('snapshot')!(event);
    assert.equal(updates, 2); assert.equal(sources.length, 2); assert.ok(sources[1].closed);
    page.hidden = true;
    dispose = subscribeProjectEvents('project', null, () => updates++, () => errors++, true);
    assert.equal(sources.length, 3, 'Opt-in Automatic Kanban keeps observations needed for background dispatch');
    sources[2].handlers.get('snapshot')!(event); assert.equal(updates, 3);
    page.dispatchEvent(new Event('visibilitychange')); assert.equal(sources[2].closed, false);
  } finally {
    dispose?.();
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (priorSource) Object.defineProperty(globalThis, 'EventSource', priorSource); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});

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
  const savedCursor = { current: null as string | null };
  let cleanup: (() => void) | undefined;
  try {
    cleanup = subscribeConversationEvents('project', 'node', 'run', () => { updates++; }, () => {}, () => {}, savedCursor);
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
    cleanup = subscribeConversationEvents('project', 'node', 'run', () => { updates++; }, () => {}, () => {}, savedCursor);
    assert.match(sources[2].url, /cursor=opaque-forward/, 'Switching back from Terminal must retain the exact forward cursor');
  } finally {
    cleanup?.();
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (priorSource) Object.defineProperty(globalThis, 'EventSource', priorSource); else Reflect.deleteProperty(globalThis, 'EventSource');
  }
});
