import type { Terminal } from '@xterm/xterm';

/** xterm 6's viewport handles wheels, but does not wire touch dragging. */
export function attachTerminalTouch(host: HTMLElement, terminal: Terminal): () => void {
  let previous: { x: number; y: number; startX: number; startY: number } | null = null;
  let pixels = 0, dragging = false;
  const reset = () => { previous = null; pixels = 0; dragging = false; };
  const start = (event: TouchEvent) => {
    reset();
    if (event.touches.length !== 1 || terminal.hasSelection()) return;
    const touch = event.touches[0];
    previous = { x: touch.clientX, y: touch.clientY, startX: touch.clientX, startY: touch.clientY };
  };
  const move = (event: TouchEvent) => {
    if (!previous || event.touches.length !== 1 || terminal.hasSelection()) { reset(); return; }
    const touch = event.touches[0];
    if (!dragging) {
      const vertical = Math.abs(touch.clientY - previous.startY), horizontal = Math.abs(touch.clientX - previous.startX);
      if (vertical < 6) return;
      if (horizontal > vertical) { reset(); return; }
      dragging = true;
    }
    if (!event.cancelable) { reset(); return; }
    event.preventDefault(); event.stopPropagation();
    pixels += previous.y - touch.clientY;
    previous.y = touch.clientY;
    const cell = Math.max(8, (terminal.element?.clientHeight || terminal.rows * 16) / terminal.rows);
    const lines = Math.max(-12, Math.min(12, Math.trunc(pixels / cell)));
    if (!lines) return;
    pixels %= cell;
    if (terminal.buffer.active.type === 'alternate' && terminal.modes.mouseTrackingMode !== 'none') {
      // Preserve the provider's observed mouse protocol. Never manufacture arrow keys.
      const target = terminal.element?.querySelector('.xterm-screen');
      const bounds = target?.getBoundingClientRect();
      if (target && bounds) target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 1, deltaY: lines, clientX: Math.max(bounds.left + 1, Math.min(bounds.right - 1, touch.clientX)), clientY: Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, touch.clientY)) }));
    } else terminal.scrollLines(lines);
  };
  host.addEventListener('touchstart', start, { passive: true, capture: true });
  host.addEventListener('touchmove', move, { passive: false, capture: true });
  host.addEventListener('touchend', reset, { capture: true });
  host.addEventListener('touchcancel', reset, { capture: true });
  return () => {
    reset(); host.removeEventListener('touchstart', start, { capture: true }); host.removeEventListener('touchmove', move, { capture: true });
    host.removeEventListener('touchend', reset, { capture: true }); host.removeEventListener('touchcancel', reset, { capture: true });
  };
}
