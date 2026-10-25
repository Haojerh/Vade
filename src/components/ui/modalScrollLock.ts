const locks = new WeakMap<Document, { dialogs: HTMLElement[]; release(): void }>();

/** Native dialog makes the background inert, but iOS can still chain touch
 * scrolling to it. Freeze the page and allow scrolling only inside the top modal. */
export function lockModalScroll(dialog: HTMLElement): () => void {
  const document = dialog.ownerDocument, window = document.defaultView!;
  let state = locks.get(document);
  if (!state) {
    const body = document.body;
    const saved = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width, overflow: body.style.overflow };
    const x = window.scrollX, y = window.scrollY;
    const dialogs: HTMLElement[] = [];
    let previous: { x: number; y: number } | undefined;
    Object.assign(body.style, { position: 'fixed', top: `${-y}px`, left: `${-x}px`, right: '0', width: '100%', overflow: 'hidden' });
    const start = (event: TouchEvent) => { previous = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : undefined; };
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !previous) { previous = undefined; return; }
      const touch = event.touches[0], dy = previous.y - touch.clientY, dx = previous.x - touch.clientX;
      previous = { x: touch.clientX, y: touch.clientY };
      const top = dialogs.at(-1);
      let element = event.target as HTMLElement | null;
      if (element?.nodeType !== 1) element = element?.parentElement ?? null;
      const prevent = () => { if (event.cancelable) event.preventDefault(); };
      if (!top || !element || !top.contains(element)) { prevent(); return; }
      if (Math.abs(dx) > Math.abs(dy) || !dy) return;
      if (element.closest('.agent-terminal-screen')) { prevent(); return; }
      while (element && top.contains(element)) {
        const overflow = window.getComputedStyle(element).overflowY;
        if (/(auto|scroll)/.test(overflow) && element.scrollHeight > element.clientHeight + 1 && (dy > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0)) return;
        if (element === top) break;
        element = element.parentElement;
      }
      prevent();
    };
    document.addEventListener('touchstart', start, { passive: true, capture: true });
    document.addEventListener('touchmove', move, { passive: false, capture: true });
    state = { dialogs, release: () => {
      document.removeEventListener('touchstart', start, { capture: true }); document.removeEventListener('touchmove', move, { capture: true });
      Object.assign(body.style, saved); window.scrollTo(x, y); locks.delete(document);
    } };
    locks.set(document, state);
  }
  state.dialogs.push(dialog);
  let released = false;
  return () => {
    if (released) return; released = true;
    state!.dialogs.splice(state!.dialogs.lastIndexOf(dialog), 1);
    if (!state!.dialogs.length) state!.release();
  };
}
