/** Capture two-finger gestures before node dragging; one-finger interactions stay unchanged. */
export function bindWorkflowPinch(container: HTMLElement, zoom: () => number,
  changeZoom: (value: number, point: { x: number; y: number }) => void, cancelDrag: () => void) {
  const touches = new Map<number, { x: number; y: number }>();
  let pinching = false;
  let suppressClick = false;
  const down = (event: PointerEvent) => {
    if (!touches.size) suppressClick = false;
    if (event.pointerType !== 'touch') return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size < 2) return;
    cancelDrag(); pinching = true; suppressClick = true;
    touches.forEach((_point, id) => container.setPointerCapture(id));
    event.preventDefault(); event.stopPropagation();
  };
  const move = (event: PointerEvent) => {
    if (!pinching || !touches.has(event.pointerId)) return;
    const before = [...touches.values()];
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...touches.values()];
    if (before.length >= 2) {
      const distance = (points: typeof before) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const rect = container.getBoundingClientRect();
      if (distance(before) > 0) changeZoom(zoom() * distance(after) / distance(before), {
        x: (after[0].x + after[1].x) / 2 - rect.left, y: (after[0].y + after[1].y) / 2 - rect.top,
      });
    }
    event.preventDefault(); event.stopPropagation();
  };
  const up = (event: PointerEvent) => {
    if (!touches.has(event.pointerId)) return;
    touches.delete(event.pointerId);
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    if (pinching) { event.preventDefault(); event.stopPropagation(); }
    if (!touches.size) pinching = false;
  };
  const click = (event: MouseEvent) => {
    if (suppressClick) { event.preventDefault(); event.stopPropagation(); }
  };
  container.addEventListener('pointerdown', down, { capture: true, passive: false });
  window.addEventListener('pointermove', move, { capture: true, passive: false });
  window.addEventListener('pointerup', up, { capture: true, passive: false });
  window.addEventListener('pointercancel', up, { capture: true, passive: false });
  container.addEventListener('click', click, true);
  return () => {
    container.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    container.removeEventListener('click', click, true);
    touches.forEach((_point, id) => { if (container.hasPointerCapture(id)) container.releasePointerCapture(id); });
    cancelDrag();
  };
}
