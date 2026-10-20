import type { AnchorBox } from './WorkflowEdgesSvg';

export const TOOL_CARD_WIDTH = 280;
export const TOOL_CARD_HEIGHT = 56;
const GAP = 20;
export function boxesOverlap(a: AnchorBox, b: AnchorBox, gap = GAP): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

export function placeToolCard(anchor: AnchorBox, obstacles: AnchorBox[], canvasWidth: number, routingObstacles = obstacles.filter(box => box !== anchor)): AnchorBox {
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
  const lowerBound = (box: AnchorBox) => {
    const { start, end } = toolPorts(anchor, box);
    return Math.hypot(start.x - end.x, start.y - end.y) + overflowCost(box);
  };
  const overflowCost = (box: AnchorBox) => box.x + box.width > canvasWidth ? 60 + (box.x + box.width - canvasWidth) / 4 : 0;
  candidates.sort((a, b) => lowerBound(a) - lowerBound(b));
  let best: AnchorBox | null = null;
  let bestCost = Infinity;
  const seen = new Set<string>();
  let evaluated = 0;
  for (const box of candidates) {
    if (lowerBound(box) >= bestCost) break;
    const key = `${box.x}:${box.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Bound expensive routing independently of the number of candidate coordinates.
    if (evaluated++ >= 24) break;
    const path = toolCardConnectionPath(anchor, box, routingObstacles);
    if (!path) continue;
    const cost = toolPathCost(path) + overflowCost(box);
    if (cost < bestCost) { best = box; bestCost = cost; }
  }
  if (best) return best;
  if (candidates.length) return candidates[0];
  // Crowded canvas: extend its right edge instead of covering another worktree.
  return { x: Math.max(right, ...obstacles.map((box) => box.x + box.width + GAP)), y: Math.max(8, anchor.y), width: TOOL_CARD_WIDTH, height: TOOL_CARD_HEIGHT };
}

type Point = { x: number; y: number };

// Compare the rendered routes, including long Bezier detours, rather than endpoint distance alone.
function toolPathCost(path: string): number {
  const tokens = path.match(/[MLQC]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!;
  let point = { x: 0, y: 0 }, length = 0, turns = 0;
  let index = 0;
  const read = () => ({ x: Number(tokens[index++]), y: Number(tokens[index++]) });
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') { point = read(); continue; }
    if (command === 'L') {
      const next = read(); length += Math.hypot(next.x - point.x, next.y - point.y); point = next; continue;
    }
    const start = point, first = read(), second = command === 'C' ? read() : first, end = read();
    turns += command === 'C' ? 2 : 1;
    for (let sample = 1; sample <= 12; sample++) {
      const t = sample / 12, u = 1 - t;
      const next = command === 'C'
        ? { x: u ** 3 * start.x + 3 * u * u * t * first.x + 3 * u * t * t * second.x + t ** 3 * end.x,
          y: u ** 3 * start.y + 3 * u * u * t * first.y + 3 * u * t * t * second.y + t ** 3 * end.y }
        : { x: u * u * start.x + 2 * u * t * first.x + t * t * end.x,
          y: u * u * start.y + 2 * u * t * first.y + t * t * end.y };
      length += Math.hypot(next.x - point.x, next.y - point.y); point = next;
    }
  }
  return length + turns * 32;
}
/** Try another exit when a nearby sibling's clearance margin traps the facing port. */
export function toolCardConnectionPath(anchor: AnchorBox, card: AnchorBox, obstacles: AnchorBox[]): string | null {
  const { start, end, cardPort } = toolPorts(anchor, card);
  const direct = toolConnectionPath(start, end, obstacles);
  if (direct && !direct.includes(' Q ') && !direct.includes(' C ')) return direct;
  let best = direct;
  let bestCost = direct ? toolPathCost(direct) : Infinity;
  const cx = anchor.x + anchor.width / 2, cy = anchor.y + anchor.height / 2;
  const exits = [
    { point: { x: anchor.x + anchor.width, y: cy }, dx: 12, dy: 0 },
    { point: { x: anchor.x, y: cy }, dx: -12, dy: 0 },
    { point: { x: cx, y: anchor.y }, dx: 0, dy: -12 },
    { point: { x: cx, y: anchor.y + anchor.height }, dx: 0, dy: 12 },
  ].sort((a, b) => Math.abs(a.point.x - end.x) + Math.abs(a.point.y - end.y) - Math.abs(b.point.x - end.x) - Math.abs(b.point.y - end.y));
  for (const { point, dx, dy } of exits) {
    const exit = { x: point.x + dx, y: point.y + dy };
    if (exit.x < 0 || exit.y < 0 || obstacles.some((box) => crosses(point, exit, box))) continue;
    // Prefer one flowing curve over a staircase when there is room around the cards.
    for (const reach of [64, 128, 192, 256, 384, 512]) for (const arrival of [8, 24, 64]) {
      const first = { x: point.x + dx / 12 * reach, y: point.y + dy / 12 * reach };
      const second = { x: end.x + (end.x - cardPort.x) / 8 * arrival, y: end.y + (end.y - cardPort.y) / 8 * arrival };
      const curve = [point, first, second, end];
      const extent = Math.max(...curve.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)])) + 1;
      const outsideCanvas = [
        { x: -extent, y: -extent, width: extent, height: extent * 2 },
        { x: 0, y: -extent, width: extent, height: extent },
      ];
      if (curveAvoidsBoxes(curve, [...obstacles, anchor, ...outsideCanvas])) {
        const path = `M ${point.x} ${point.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`;
        const cost = toolPathCost(path);
        if (cost < bestCost) { best = path; bestCost = cost; }
      }
    }
  }
  if (best) return best;
  for (const { point, dx, dy } of exits) {
    const exit = { x: point.x + dx, y: point.y + dy };
    if (exit.x < 0 || exit.y < 0 || obstacles.some((box) => crosses(point, exit, box))) continue;
    const route = toolConnectionPath(exit, end, [...obstacles, anchor], point);
    if (route) return route;
  }
  return null;
}
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
export function roundedToolPath(points: Point[], obstacles: AnchorBox[] = []): string {
  const route = points.filter((point, index) => {
    const before = points[index - 1], after = points[index + 1];
    return !before || !after || !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
  let path = `M ${route[0].x} ${route[0].y}`;
  for (let index = 1; index < route.length; index++) {
    const point = route[index], next = route[index + 1], previous = route[index - 1];
    if (!next) { path += ` L ${point.x} ${point.y}`; continue; }
    const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    let radius = Math.min(40, distance(previous, point) / 2, distance(point, next) / 2);
    const corner = () => {
      const approach = { x: point.x + (previous.x - point.x) * radius / distance(previous, point), y: point.y + (previous.y - point.y) * radius / distance(previous, point) };
      const leave = { x: point.x + (next.x - point.x) * radius / distance(point, next), y: point.y + (next.y - point.y) * radius / distance(point, next) };
      return { approach, leave, curve: [approach,
        { x: approach.x + (point.x - approach.x) * 2 / 3, y: approach.y + (point.y - approach.y) * 2 / 3 },
        { x: leave.x + (point.x - leave.x) * 2 / 3, y: leave.y + (point.y - leave.y) * 2 / 3 }, leave] };
    };
    while (radius > 1 && !curveAvoidsBoxes(corner().curve, obstacles)) radius /= 2;
    const { approach, leave } = corner();
    path += ` L ${approach.x} ${approach.y} Q ${point.x} ${point.y} ${leave.x} ${leave.y}`;
  }
  return path;
}
function crosses(a: Point, b: Point, box: AnchorBox): boolean {
  if (a.x === b.x) return a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
  return a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
}

function curveAvoidsBoxes(points: Point[], boxes: AnchorBox[], depth = 0): boolean {
  const minX = Math.min(...points.map((point) => point.x)), maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y)), maxY = Math.max(...points.map((point) => point.y));
  const nearby = boxes.filter((box) => maxX > box.x && minX < box.x + box.width && maxY > box.y && minY < box.y + box.height);
  if (!nearby.length) return true;
  if (depth >= 10) return false;
  const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const a = midpoint(points[0], points[1]), b = midpoint(points[1], points[2]), c = midpoint(points[2], points[3]);
  const d = midpoint(a, b), e = midpoint(b, c), center = midpoint(d, e);
  return curveAvoidsBoxes([points[0], a, d, center], nearby, depth + 1)
    && curveAvoidsBoxes([center, e, c, points[3]], nearby, depth + 1);
}

/** Route on obstacle boundaries, so green connectors never cut through another worktree. */
export function toolConnectionPath(start: Point, end: Point, obstacles: AnchorBox[], lead?: Point): string | null {
  const blockers = obstacles.map((box) => ({ x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 }));
  if ((start.x === end.x || start.y === end.y) && !blockers.some((box) => crosses(start, end, box))) return roundedToolPath(lead ? [lead, start, end] : [start, end], obstacles);
  // Match the flowing horizontal connections used by the orchestration graph.
  const direction = end.x >= start.x ? 1 : -1;
  const handle = Math.max(40, Math.abs(end.x - start.x) / 2);
  const first = { x: start.x + direction * handle, y: start.y };
  const second = { x: end.x - direction * handle, y: end.y };
  if (!lead && curveAvoidsBoxes([start, first, second, end], blockers)) {
    return `M ${start.x} ${start.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`;
  }
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
      if (lead) route.unshift(lead);
      return roundedToolPath(route, obstacles);
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
