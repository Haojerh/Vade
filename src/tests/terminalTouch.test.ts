import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Terminal } from '@xterm/xterm';
import { attachTerminalTouch } from '../features/workflow/terminalTouch';

function fixture(provider?: string, alternate = false) {
  const host = new EventTarget(), lines: number[] = [], wheels: Event[] = [];
  let selected = false;
  const target = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100 }), dispatchEvent: (event: Event) => wheels.push(event) };
  const terminal = { rows: 10, element: { clientHeight: 100, querySelector: () => target }, hasSelection: () => selected, scrollLines: (value: number) => lines.push(value), buffer: { active: { type: alternate ? 'alternate' : 'normal' } }, modes: { mouseTrackingMode: 'vt200' } } as unknown as Terminal;
  const dispose = attachTerminalTouch(host as HTMLElement, terminal);
  const touch = (type: string, y: number, x = 30, count = 1) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) });
    host.dispatchEvent(event); return event;
  };
  return { lines, wheels, touch, dispose, select: () => { selected = true; } };
}

test('finger dragging scrolls terminal history both ways and cleans up on disposal', () => {
  const f = fixture('codex');
  f.touch('touchstart', 100);
  assert.equal(f.touch('touchmove', 130).defaultPrevented, true);
  f.touch('touchmove', 110);
  assert.deepEqual(f.lines, [-3, 2]);
  f.touch('touchend', 110, 30, 0); f.touch('touchmove', 50);
  f.dispose(); f.touch('touchstart', 100); f.touch('touchmove', 50);
  assert.deepEqual(f.lines, [-3, 2]);
});

test('touch scrolling preserves taps, horizontal gestures, pinch zoom and text selection', () => {
  const f = fixture();
  f.touch('touchstart', 100); assert.equal(f.touch('touchmove', 103).defaultPrevented, false);
  f.touch('touchstart', 100); assert.equal(f.touch('touchmove', 110, 80).defaultPrevented, false);
  f.touch('touchstart', 100); assert.equal(f.touch('touchmove', 130, 30, 2).defaultPrevented, false);
  f.touch('touchmove', 160);
  f.touch('touchstart', 100); f.select(); assert.equal(f.touch('touchmove', 130).defaultPrevented, false);
  assert.deepEqual(f.lines, []); f.dispose();
});

test('small drags accumulate to rows and cancel releases the gesture', () => {
  const f = fixture();
  f.touch('touchstart', 100); f.touch('touchmove', 107); f.touch('touchmove', 113);
  assert.deepEqual(f.lines, [-1]);
  f.touch('touchcancel', 113, 30, 0); f.touch('touchmove', 160);
  assert.deepEqual(f.lines, [-1]); f.dispose();
});

test('Codex fullscreen touch scrolling uses native wheel reports instead of its empty local scrollback', () => {
  const previous = globalThis.WheelEvent;
  class TestWheel extends Event { constructor(type: string, readonly options: WheelEventInit) { super(type, options); } }
  Object.assign(globalThis, { WheelEvent: TestWheel });
  const f = fixture('codex', true);
  try {
    f.touch('touchstart', 100); f.touch('touchmove', -400);
    assert.deepEqual(f.lines, []); assert.equal(f.wheels.length, 1);
    assert.equal((f.wheels[0] as TestWheel).options.deltaY, 12);
    assert.equal((f.wheels[0] as TestWheel).options.deltaMode, 1);
    f.touch('touchmove', -370);
    assert.equal((f.wheels[1] as TestWheel).options.deltaY, -3);
  } finally { f.dispose(); Object.assign(globalThis, { WheelEvent: previous }); }
});
