export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Preserve the requested order and move only later boxes down when they collide.
// Recompute from requested positions so closing a composer restores the layout.
export function separateWorkflowBoxes(boxes: LayoutBox[], gap = 16): LayoutBox[] {
  const placed: LayoutBox[] = [];
  for (const source of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))) {
    const box = { ...source, x: Math.max(0, source.x), y: Math.max(0, source.y) };
    for (let attempt = 0; attempt < placed.length; attempt++) {
      const collisions = placed.filter((other) =>
        box.x < other.x + other.width + gap && box.x + box.width + gap > other.x &&
        box.y < other.y + other.height + gap && box.y + box.height + gap > other.y);
      if (!collisions.length) break;
      box.y = Math.max(...collisions.map((other) => other.y + other.height + gap));
    }
    placed.push(box);
  }
  return placed;
}
