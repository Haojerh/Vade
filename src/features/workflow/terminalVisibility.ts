/** Visibility controls renderer output credit, never the lifetime of the owned
 * PTY or keyboard writes already in flight. */
export function observeTerminalVisibility(surface: HTMLElement, changed: (visible: boolean) => void): () => void {
  const document = surface.ownerDocument;
  let active = true, intersecting = true, previous: boolean | undefined;
  const check = () => {
    if (!active) return;
    const visible = !document.hidden && intersecting && surface.isConnected && surface.clientWidth > 0 && surface.clientHeight > 0;
    if (visible !== previous) { previous = visible; changed(visible); }
  };
  const resize = new ResizeObserver(check); resize.observe(surface);
  const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    const entry = entries.find(entry => entry.target === surface);
    if (entry) { intersecting = entry.isIntersecting; check(); }
  });
  intersection?.observe(surface);
  document.addEventListener('visibilitychange', check);
  check();
  return () => { active = false; resize.disconnect(); intersection?.disconnect(); document.removeEventListener('visibilitychange', check); };
}
