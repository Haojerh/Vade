import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenTerminalSurfaceReady } from '../features/workflow/terminalSurface';
import { observeTerminalVisibility } from '../features/workflow/terminalVisibility';

test('terminal visibility pauses hidden or collapsed surfaces and disposes every observer', () => {
  const previous = { ResizeObserver: globalThis.ResizeObserver, IntersectionObserver: globalThis.IntersectionObserver };
  const page = new EventTarget() as EventTarget & { hidden: boolean }; page.hidden = false;
  let width = 320, intersect: (entries: any[]) => void = () => {}, resize: () => void = () => {}, disposed = 0;
  class Resize { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() { disposed++; } }
  class Intersection { constructor(callback: (entries: any[]) => void) { intersect = callback; } observe() {} disconnect() { disposed++; } }
  Object.assign(globalThis, { ResizeObserver: Resize, IntersectionObserver: Intersection });
  const surface = { ownerDocument: page, isConnected: true, get clientWidth() { return width; }, clientHeight: 200 } as unknown as HTMLElement;
  const states: boolean[] = [];
  try {
    const dispose = observeTerminalVisibility(surface, value => states.push(value));
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    page.dispatchEvent(new Event('visibilitychange'));
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    width = 0; resize(); width = 320; resize();
    intersect([{ target: surface, isIntersecting: false }]);
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    intersect([{ target: surface, isIntersecting: true }]);
    assert.deepEqual(states, [true, false, true, false, true, false, true]);
    dispose(); page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); resize();
    assert.equal(states.length, 7); assert.equal(disposed, 2);
  } finally { Object.assign(globalThis, previous); }
});

async function fixture(run: (state: { surface: HTMLElement; dialog: { open: boolean }; show: () => void; finish: () => void; frame: () => void; tick: () => Promise<void> }) => Promise<void>) {
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver, MutationObserver: globalThis.MutationObserver };
  const frames = new Map<number, FrameRequestCallback>(); let next = 0, visible = false;
  const changes = new Set<() => void>();
  class Observer { constructor(readonly callback: () => void) { changes.add(callback); } observe() {} disconnect() { changes.delete(this.callback); } }
  let finish!: () => void;
  const animation = { playState: 'running', finished: new Promise<void>(resolve => { finish = () => { animation.playState = 'finished'; resolve(); }; }) };
  const dialog = { open: false, getAnimations: () => [animation] };
  const surface = { get clientWidth() { return visible ? 320 : 0; }, get clientHeight() { return visible ? 220 : 0; }, closest: () => dialog, ownerDocument: { fonts: { ready: Promise.resolve() } } } as unknown as HTMLElement;
  Object.assign(globalThis, { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; }, cancelAnimationFrame: (id: number) => frames.delete(id), ResizeObserver: Observer, MutationObserver: Observer });
  try {
    await run({ surface, dialog, show: () => { visible = true; dialog.open = true; for (const callback of changes) callback(); }, finish, frame: () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); }, tick: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); } });
  } finally { Object.assign(globalThis, previous); }
}

test('first-open terminal initialization waits for a visible dialog and completed entry animation', async () => fixture(async state => {
  let starts = 0;
  const dispose = whenTerminalSurfaceReady(state.surface, () => { starts++; });
  state.frame(); await state.tick(); assert.equal(starts, 0);
  state.show(); state.frame(); await state.tick(); assert.equal(starts, 0);
  state.finish(); await state.tick(); state.frame(); await state.tick();
  assert.equal(starts, 1); dispose();
}));

test('closing the pane during entry never starts a late terminal or leaves readiness observers active', async () => fixture(async state => {
  let starts = 0;
  const dispose = whenTerminalSurfaceReady(state.surface, () => { starts++; });
  state.show(); state.frame(); dispose(); state.finish(); await state.tick(); state.frame(); await state.tick();
  assert.equal(starts, 0);
}));
