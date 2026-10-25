import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenTerminalSurfaceReady } from '../features/workflow/terminalSurface';

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
