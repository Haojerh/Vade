import type { AnchorBox } from './WorkflowEdgesSvg';

export const TOOL_CARD_WIDTH = 280;
export const TOOL_CARD_HEIGHT = 56;
const GAP = 20;
export function boxesOverlap(a: AnchorBox, b: AnchorBox, gap = GAP): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

export function placeToolCard(anchor: AnchorBox, obstacles: AnchorBox[], canvasWidth: number): AnchorBox {
  const right = anchor.x + anchor.width + 64;
  const left = anchor.x - TOOL_CARD_WIDTH - 64;
  const candidates: AnchorBox[] = [];
  const xs = [right, left, 8, ...(Number.isFinite(canvasWidth) ? [canvasWidth - TOOL_CARD_WIDTH - 8] : []),
    ...obstacles.flatMap((box) => [box.x - TOOL_CARD_WIDTH - GAP, box.x + box.width + GAP])];
  const ys = [anchor.y + (anchor.height - TOOL_CARD_HEIGHT) / 2, anchor.y, anchor.y - TOOL_CARD_HEIGHT - GAP, anchor.y + anchor.height + GAP, 8,
    ...obstacles.flatMap((box) => [box.y - TOOL_CARD_HEIGHT - GAP, box.y + box.height + GAP])];
  for (const x of xs) for (const y of ys) {
    const box = { x, y, width: TOOL_CARD_WIDTH, height: TOOL_CARD_HEIGHT };
    if (x >= 8 && y >= 8 && !boxesOverlap(box, anchor, 64) && !obstacles.some((obstacle) => boxesOverlap(box, obstacle))) candidates.push(box);
  }
  const score = (box: AnchorBox) => {
    const { start, end } = toolPorts(anchor, box);
    const direct = start.x === end.x || start.y === end.y;
    const blocked = obstacles.filter((obstacle) => obstacle !== anchor).some((obstacle) =>
      crosses(start, { x: end.x, y: start.y }, obstacle) || crosses({ x: end.x, y: start.y }, end, obstacle));
    return Math.abs(start.x - end.x) + Math.abs(start.y - end.y)
      + (direct ? 0 : 80) + (blocked ? 600 : 0) + (box.x + box.width > canvasWidth ? 60 : 0);
  };
  candidates.sort((a, b) => score(a) - score(b));
  if (candidates.length) return candidates[0];
  // Crowded canvas: extend its right edge instead of covering another worktree.
  return { x: Math.max(right, ...obstacles.map((box) => box.x + box.width + GAP)), y: Math.max(8, anchor.y), width: TOOL_CARD_WIDTH, height: TOOL_CARD_HEIGHT };
}

type Point = { x: number; y: number };
/** Use the facing borders; vertically stacked cards should not exit from the agent's side. */
export function toolPorts(anchor: AnchorBox, card: AnchorBox): { start: Point; end: Point; cardPort: Point } {
  const cx = anchor.x + anchor.width / 2, cy = anchor.y + anchor.height / 2;
  if (card.x >= anchor.x + anchor.width) return { start: { x: anchor.x + anchor.width, y: cy },
    end: { x: card.x - 8, y: card.y + card.height / 2 }, cardPort: { x: card.x, y: card.y + card.height / 2 } };
  if (card.x + card.width <= anchor.x) return { start: { x: anchor.x, y: cy },
    end: { x: card.x + card.width + 8, y: card.y + card.height / 2 }, cardPort: { x: card.x + card.width, y: card.y + card.height / 2 } };
  const x = (Math.max(anchor.x, card.x) + Math.min(anchor.x + anchor.width, card.x + card.width)) / 2;
  if (card.y >= anchor.y + anchor.height) return { start: { x, y: anchor.y + anchor.height }, end: { x, y: card.y - 8 }, cardPort: { x, y: card.y } };
  return { start: { x, y: anchor.y }, end: { x, y: card.y + card.height + 8 }, cardPort: { x, y: card.y + card.height } };
}
export function roundedToolPath(points: Point[]): string {
  const route = points.filter((point, index) => {
    const before = points[index - 1], after = points[index + 1];
    return !before || !after || !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
  let path = `M ${route[0].x} ${route[0].y}`;
  for (let index = 1; index < route.length; index++) {
    const point = route[index], next = route[index + 1], previous = route[index - 1];
    if (!next) { path += ` L ${point.x} ${point.y}`; continue; }
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    const radius = Math.min(12, distance(previous, point) / 2, distance(point, next) / 2);
    const approach = { x: point.x + (previous.x - point.x) * radius / distance(previous, point), y: point.y + (previous.y - point.y) * radius / distance(previous, point) };
    const leave = { x: point.x + (next.x - point.x) * radius / distance(point, next), y: point.y + (next.y - point.y) * radius / distance(point, next) };
    path += ` L ${approach.x} ${approach.y} Q ${point.x} ${point.y} ${leave.x} ${leave.y}`;
  }
  return path;
}
function crosses(a: Point, b: Point, box: AnchorBox): boolean {
  if (a.x === b.x) return a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
  return a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
}

/** Route on obstacle boundaries, so green connectors never cut through another worktree. */
export function toolConnectionPath(start: Point, end: Point, obstacles: AnchorBox[]): string | null {
  const blockers = obstacles.map((box) => ({ x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 }));
  if ((start.x === end.x || start.y === end.y) && !blockers.some((box) => crosses(start, end, box))) return roundedToolPath([start, end]);
  const xs = [...new Set([start.x, end.x, ...blockers.flatMap((box) => [box.x, box.x + box.width])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...blockers.flatMap((box) => [box.y, box.y + box.height])])].sort((a, b) => a - b);
  // Bound routing work in very large projects; hide the connector rather than draw through a worktree.
  if (xs.length * ys.length > 10000) return null;
  const points = xs.flatMap((x) => ys.map((y) => ({ x, y })));
  const key = (point: Point) => `${point.x}:${point.y}`;
  const indices = new Map(points.map((point, index) => [key(point), index]));
  const origin = indices.get(key(start))!;
  const target = indices.get(key(end))!;
  const costs = new Map([[origin, 0]]);
  const parents = new Map<number, number>();
  const queue = new Set([origin]);
  while (queue.size) {
    let current = -1;
    let best = Infinity;
    for (const index of queue) {
      const point = points[index];
      const estimate = costs.get(index)! + Math.abs(point.x - end.x) + Math.abs(point.y - end.y);
      if (estimate < best) { best = estimate; current = index; }
    }
    queue.delete(current);
    if (current === target) {
      const route: Point[] = [];
      for (let index: number | undefined = current; index !== undefined; index = parents.get(index)) route.unshift(points[index]);
      return roundedToolPath(route);
    }
    const point = points[current];
    const xi = xs.indexOf(point.x), yi = ys.indexOf(point.y);
    for (const [x, y] of [[xs[xi - 1], point.y], [xs[xi + 1], point.y], [point.x, ys[yi - 1]], [point.x, ys[yi + 1]]]) {
      if (x === undefined || y === undefined || x < 0 || y < 0) continue;
      const next = indices.get(`${x}:${y}`)!;
      const nextPoint = points[next];
      if (blockers.some((box) => crosses(point, nextPoint, box))) continue;
      const parent = parents.get(current);
      const previous = parent === undefined ? null : points[parent];
      const turn = previous && (previous.x === point.x) !== (point.x === x) ? 32 : 0;
      const cost = costs.get(current)! + Math.abs(x - point.x) + Math.abs(y - point.y) + turn;
      if (cost >= (costs.get(next) ?? Infinity)) continue;
      costs.set(next, cost); parents.set(next, current); queue.add(next);
    }
  }
  return null;
}
