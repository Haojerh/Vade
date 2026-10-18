import React, { useRef } from 'react';
import type { Node } from '../../../shared/contracts';
import type { AnchorBox } from './WorkflowEdgesSvg';
import type { LiveTool } from './useLiveGraphActivity';
import { DeliveryPacket } from './DeliveryPacket';
import { boxesOverlap, placeToolCard, toolConnectionPath, toolPorts } from './toolActivityLayout';
import { ToolActivityCard } from './ToolActivityCard';

export function ToolActivityOverlay({ tools, positions, reducedMotion, canvasWidth = Infinity, nodes = [], onHold }: {
  tools: LiveTool[]; positions: Map<string, AnchorBox>; reducedMotion: boolean; canvasWidth?: number; nodes?: Node[];
  onHold?: (id: string, held: boolean) => void;
}) {
  const placements = useRef(new Map<string, { box: AnchorBox; anchor: string; routeKey: string; path: string | null }>());
  const currentIds = new Set(tools.map((tool) => tool.id));
  for (const id of placements.current.keys()) if (!currentIds.has(id)) placements.current.delete(id);
  const placed: AnchorBox[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return <div className="tool-activity-overlay" aria-label="Live tool activity">
    {tools.map((tool) => {
      const anchor = positions.get(tool.nodeId);
      if (!anchor?.width) return null;
      const agent = byId.get(tool.nodeId);
      const obstacles = [...positions].filter(([id]) => {
        if (id === tool.nodeId) return false;
        const node = byId.get(id);
        return !(node?.kind === 'worktree' && agent?.worktreeId && node.worktreeId === agent.worktreeId);
      }).map(([, box]) => box);
      const blockers = [...obstacles, anchor, ...placed];
      const anchorKey = `${anchor.x}:${anchor.y}:${anchor.width}:${anchor.height}`;
      const previous = placements.current.get(tool.id);
      const box = previous?.anchor === anchorKey && !blockers.some((blocker) => boxesOverlap(previous.box, blocker))
        ? previous.box : placeToolCard(anchor, blockers, canvasWidth);
      const { start, end, cardPort } = toolPorts(anchor, box);
      const routeKey = `${anchorKey}:${box.x}:${box.y}:${JSON.stringify(obstacles)}`;
      const path = previous?.routeKey === routeKey ? previous.path : toolConnectionPath(start, end, [...obstacles, ...placed]);
      placements.current.set(tool.id, { box, anchor: anchorKey, routeKey, path });
      placed.push(box);
      return <div key={tool.id} className="tool-activity-event">
        {path && <svg className="tool-activity-connection" aria-hidden="true">
          <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d={`M ${end.x} ${end.y} L ${cardPort.x} ${cardPort.y}`} fill="none" stroke="currentColor" strokeWidth="1.5" />
          <DeliveryPacket key={path} path={path} reducedMotion={reducedMotion} endX={end.x} endY={end.y} tone="green" />
        </svg>}
        <ToolActivityCard tool={tool} box={box} onHold={onHold} />
      </div>;
    })}
  </div>;
}
