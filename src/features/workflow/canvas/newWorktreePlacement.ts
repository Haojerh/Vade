import type { AnchorBox } from './WorkflowEdgesSvg';

export function placeNewWorktree(size: { width: number; height: number }, viewport: AnchorBox, occupied: AnchorBox[]): { box: AnchorBox; inViewport: boolean } {
  const gap = 24;
  const dimensions = { width: size.width, height: size.height };
  const xs = new Set([viewport.x + gap, viewport.x + (viewport.width - size.width) / 2,
    viewport.x + viewport.width - size.width - gap, ...occupied.flatMap((box) => [box.x + box.width + gap, box.x - size.width - gap])]);
  const ys = new Set([viewport.y + gap, viewport.y + (viewport.height - size.height) / 2,
    viewport.y + viewport.height - size.height - gap, ...occupied.flatMap((box) => [box.y + box.height + gap, box.y - size.height - gap])]);
  const candidates: { box: AnchorBox; inViewport: boolean; score: number }[] = [];
  for (const x of xs) for (const y of ys) {
    if (x < 0 || y < 0) continue;
    const box = { x, y, ...dimensions };
    if (occupied.some((other) => x < other.x + other.width + 16 && x + size.width + 16 > other.x
      && y < other.y + other.height + 16 && y + size.height + 16 > other.y)) continue;
    const inViewport = x >= viewport.x && y >= viewport.y && x + size.width <= viewport.x + viewport.width && y + size.height <= viewport.y + viewport.height;
    const score = Math.hypot(x + size.width / 2 - viewport.x - viewport.width / 2, y + size.height / 2 - viewport.y - viewport.height / 2);
    candidates.push({ box, inViewport, score });
  }
  candidates.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.score - b.score);
  const selected = candidates[0];
  if (selected) return { box: selected.box, inViewport: selected.inViewport };
  return { box: { x: viewport.x + gap, y: Math.max(viewport.y + gap, ...occupied.map((box) => box.y + box.height + gap)), ...dimensions }, inViewport: false };
}
