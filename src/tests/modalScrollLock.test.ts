import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockModalScroll } from '../components/ui/modalScrollLock';

function fixture() {
  const listeners = new Map<string, (event: any) => void>(), restored: number[][] = [];
  const style = { position: '', top: '', left: '', right: '', width: '', overflow: '' };
  const document = { body: { style }, defaultView: { scrollX: 3, scrollY: 50, scrollTo: (x: number, y: number) => restored.push([x, y]), getComputedStyle: (element: any) => ({ overflowY: element.overflowY ?? 'visible' }) }, addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler), removeEventListener: (name: string) => listeners.delete(name) } as unknown as Document;
  const element = (parent: HTMLElement | null = null, values: object = {}) => {
    const value = { nodeType: 1, ownerDocument: document, parentElement: parent, scrollTop: 0, clientHeight: 100, scrollHeight: 100, overflowY: 'visible', closest: () => null, contains(target: any) { while (target) { if (target === this) return true; target = target.parentElement; } return false; }, ...values };
    return value as unknown as HTMLElement;
  };
  const gesture = (target: HTMLElement, from: number, to: number, count = 1) => {
    let prevented = false;
    listeners.get('touchstart')?.({ touches: [{ clientX: 0, clientY: from }] });
    listeners.get('touchmove')?.({ target, cancelable: true, touches: Array.from({ length: count }, () => ({ clientX: 0, clientY: to })), preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { element, gesture, style, restored, listeners };
}

test('modal touch scroll stays inside its scrollable content and never chains to the background', () => {
  const f = fixture(), modal = f.element(), outside = f.element(), list = f.element(modal, { overflowY: 'auto', scrollHeight: 300 });
  const release = lockModalScroll(modal);
  assert.equal(f.style.position, 'fixed'); assert.equal(f.style.top, '-50px');
  assert.equal(f.gesture(list, 100, 50), false); // The list can consume a downward scroll.
  list.scrollTop = 200; assert.equal(f.gesture(list, 100, 50), true);
  list.scrollTop = 0; assert.equal(f.gesture(list, 50, 100), true);
  assert.equal(f.gesture(outside, 100, 50), true);
  assert.equal(f.gesture(list, 100, 50, 2), false); // Pinch zoom stays available.
  const terminal = f.element(modal); Object.assign(terminal, { closest: () => terminal });
  assert.equal(f.gesture(terminal, 100, 50), true); // Custom terminal scrolling receives the same event.
  release(); release(); assert.equal(f.style.position, ''); assert.deepEqual(f.restored, [[3, 50]]); assert.equal(f.listeners.size, 0);
});

test('nested confirmations keep the page locked until the final modal closes', () => {
  const f = fixture(), outer = f.element(), inner = f.element();
  const first = lockModalScroll(outer), second = lockModalScroll(inner);
  assert.equal(f.gesture(outer, 100, 50), true);
  second(); assert.equal(f.style.position, 'fixed'); assert.equal(f.restored.length, 0);
  first(); assert.equal(f.style.position, ''); assert.deepEqual(f.restored, [[3, 50]]);
});
