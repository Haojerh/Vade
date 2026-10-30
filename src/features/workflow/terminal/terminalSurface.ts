/** xterm must measure visible, untransformed text. A child effect can run
 * before its parent dialog opens, so wait for visibility and entry motion. */
export function whenTerminalSurfaceReady(surface: HTMLElement, ready: () => void): () => void {
  let active = true, completed = false, frame = 0, waiting = false;
  const dialog = surface.closest('dialog');
  const check = () => {
    frame = 0;
    if (!active || completed || waiting || !surface.clientWidth || !surface.clientHeight || (dialog && !dialog.open)) return;
    const animations = dialog?.getAnimations().filter(animation => animation.playState === 'running') ?? [];
    if (animations.length) {
      waiting = true;
      void Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(() => { waiting = false; schedule(); });
      return;
    }
    waiting = true;
    void surface.ownerDocument.fonts.ready.then(() => {
      waiting = false;
      if (!active) return;
      if (!surface.clientWidth || !surface.clientHeight || (dialog && !dialog.open)) { schedule(); return; }
      completed = true; resize.disconnect(); mutation?.disconnect(); ready();
    });
  };
  const schedule = () => { if (active && !completed && !frame) frame = requestAnimationFrame(check); };
  const resize = new ResizeObserver(schedule); resize.observe(surface);
  const mutation = dialog ? new MutationObserver(schedule) : null;
  if (dialog) mutation?.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  schedule();
  return () => { active = false; cancelAnimationFrame(frame); resize.disconnect(); mutation?.disconnect(); };
}
