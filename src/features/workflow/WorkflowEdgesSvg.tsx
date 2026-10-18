import React, { useMemo } from 'react';
import type { Edge, Node } from '../../../shared/contracts';

export interface AnchorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AggregatedEdge {
  id: string;
  source: string;
  target: string;
  isActive: boolean;
  kind: string;
}

export function deduplicateWorkflowEdges(
  edges: Edge[],
  nodeMap: Map<string, Node>,
  isLocallyStale: boolean
): AggregatedEdge[] {
  const map = new Map<string, AggregatedEdge>();

  for (const edge of edges) {
    if (edge.kind === 'contains') continue;

    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    if (!srcNode || !tgtNode) continue;

    const key = `${edge.source}->${edge.target}`;

    const isTargetWorking = tgtNode.state === 'working';
    const isFresh = !isLocallyStale && !srcNode.stale && !tgtNode.stale;
    const active = edge.active && isTargetWorking && isFresh;

    if (!map.has(key)) {
      map.set(key, {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        isActive: active,
        kind: edge.kind,
      });
    } else {
      const existing = map.get(key)!;
      if (active) {
        existing.isActive = true;
      }
    }
  }

  return Array.from(map.values());
}

interface WorkflowEdgesSvgProps {
  edges: AggregatedEdge[];
  positions: Map<string, AnchorBox>;
  nodeMap: Map<string, Node>;
  canvasSize: { width: number; height: number };
  prefersReducedMotion: boolean;
}

export const WorkflowEdgesSvg: React.FC<WorkflowEdgesSvgProps> = ({
  edges,
  positions,
  nodeMap,
  canvasSize,
  prefersReducedMotion,
}) => {
  const renderedEdges = useMemo(() => {
    return edges.map((edge) => {
      const srcPos = positions.get(edge.source);
      const tgtPos = positions.get(edge.target);

      if (!srcPos || !tgtPos || srcPos.width === 0 || tgtPos.width === 0) {
        return null;
      }

      const srcNode = nodeMap.get(edge.source);
      const tgtNode = nodeMap.get(edge.target);
      if (!srcNode || !tgtNode) return null;

      // Draw from source right border to target left border
      const startX = srcPos.x + srcPos.width;
      const startY = srcPos.y + srcPos.height / 2;
      const endX = tgtPos.x;
      const endY = tgtPos.y + tgtPos.height / 2;

      // Smooth horizontal cubic bezier curve
      const dx = Math.max(40, Math.abs(endX - startX) * 0.5);
      const pathData = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;

      return (
        <g key={`${edge.source}->${edge.target}`} className={`edge-group ${edge.isActive ? 'edge-active-group' : ''}`}>
          {/* Main edge stroke: strictly idle or active appearance */}
          <path
            d={pathData}
            className={`graph-edge-path ${edge.isActive ? 'edge-active' : 'edge-idle'}`}
            fill="none"
            strokeLinecap="round"
          />

          {/* Ambient glow layer along active paths */}
          {edge.isActive && (
            <path
              d={pathData}
              className="graph-edge-glow"
              fill="none"
              strokeLinecap="round"
            />
          )}

          {/* Traveling delivery packet along same BLUE active path */}
          {edge.isActive && (
            prefersReducedMotion ? (
              <g className="delivery-packet static-packet">
                <circle cx={endX} cy={endY} r="5" className="edge-delivery-halo" />
                <circle cx={endX} cy={endY} r="3" className="edge-delivery-bead" />
              </g>
            ) : (
              <g className="delivery-packet">
                <circle r="5" className="edge-delivery-halo" />
                <circle r="3" className="edge-delivery-bead" />
                <animateMotion
                  path={pathData}
                  dur="2.4s"
                  repeatCount="indefinite"
                  rotate="auto"
                />
              </g>
            )
          )}
        </g>
      );
    });
  }, [edges, positions, nodeMap, prefersReducedMotion]);

  return (
    <svg
      className="graph-svg-overlay"
      aria-hidden="true"
      style={{
        width: `${canvasSize.width}px`,
        height: `${canvasSize.height}px`,
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      <defs>
        <filter id="activeGlowFilter" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {renderedEdges}
    </svg>
  );
};
