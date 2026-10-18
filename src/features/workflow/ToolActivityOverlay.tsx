import React from 'react';
import type { AnchorBox } from './WorkflowEdgesSvg';
import type { LiveTool } from './useLiveGraphActivity';

export function ToolActivityOverlay({ tools, positions, reducedMotion, canvasWidth = Infinity }: {
  tools: LiveTool[]; positions: Map<string, AnchorBox>; reducedMotion: boolean; canvasWidth?: number;
}) {
  const slots = new Map<string, number>();
  return <div className="tool-activity-overlay" aria-label="Live tool activity">
    {tools.map((tool) => {
      const anchor = positions.get(tool.nodeId);
      if (!anchor?.width) return null;
      const index = slots.get(tool.nodeId) ?? 0;
      slots.set(tool.nodeId, index + 1);
      const right = anchor.x + anchor.width + 64 + Math.floor(index / 4) * 314;
      const onLeft = right + 250 > canvasWidth && anchor.x >= 314;
      const x = onLeft ? Math.max(8, anchor.x - 314 - Math.floor(index / 4) * 314) : right;
      const y = anchor.y + (index % 4) * 42;
      const startX = onLeft ? anchor.x : anchor.x + anchor.width;
      const startY = anchor.y + anchor.height / 2;
      const endX = onLeft ? x + 250 : x;
      const d = `M ${startX} ${startY} C ${endX} ${startY}, ${startX} ${y + 16}, ${endX} ${y + 16}`;
      return <div key={tool.id} className="tool-activity-event">
        <svg className="tool-activity-connection" aria-hidden="true">
          <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx={startX} cy={startY} r="3" fill="currentColor" />
          {!reducedMotion && <circle r="4" fill="currentColor"><animateMotion path={d} dur="0.7s" repeatCount="1" fill="freeze" /></circle>}
        </svg>
        <div className="tool-activity-node" style={{ left: x, top: y }} title={tool.label}>
          <span className="tool-activity-dot" />{tool.label}
        </div>
      </div>;
    })}
  </div>;
}
