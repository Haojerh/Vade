import React, { useRef, useState, useLayoutEffect, useEffect, useMemo } from 'react';
import type { Node, Edge, State } from '../../shared/contracts';

interface WorkflowGraphProps {
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  isLocallyStale: boolean;
}

interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setPrefersReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return prefersReduced;
}

export const WorkflowGraph: React.FC<WorkflowGraphProps> = ({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  isLocallyStale,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());
  const [filterKind, setFilterKind] = useState<string>('all');

  // Categorize nodes into columns / layers
  const { orchestrators, worktrees, agents, terminals } = useMemo(() => {
    const orchestrators: Node[] = [];
    const worktrees: Node[] = [];
    const agents: Node[] = [];
    const terminals: Node[] = [];

    for (const n of nodes) {
      if (filterKind !== 'all' && n.kind !== filterKind) {
        continue;
      }
      if (n.kind === 'orchestrator') orchestrators.push(n);
      else if (n.kind === 'worktree') worktrees.push(n);
      else if (n.kind === 'agent') agents.push(n);
      else terminals.push(n);
    }
    return { orchestrators, worktrees, agents, terminals };
  }, [nodes, filterKind]);

  // Update node positions for SVG edge rendering
  const updatePositions = () => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const newPositions = new Map<string, NodePosition>();

    nodeRefs.current.forEach((el, id) => {
      if (el) {
        const rect = el.getBoundingClientRect();
        newPositions.set(id, {
          x: rect.left - containerRect.left + containerRef.current!.scrollLeft,
          y: rect.top - containerRect.top + containerRef.current!.scrollTop,
          width: rect.width,
          height: rect.height,
        });
      }
    });

    setNodePositions(newPositions);
  };

  useLayoutEffect(() => {
    updatePositions();
  }, [nodes, edges, filterKind, orchestrators, worktrees, agents, terminals]);

  useEffect(() => {
    window.addEventListener('resize', updatePositions);
    return () => window.removeEventListener('resize', updatePositions);
  }, []);

  // Keyboard navigation across nodes
  const handleKeyDown = (e: React.KeyboardEvent, index: number, colNodes: Node[]) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = (index + 1) % colNodes.length;
      onSelectNode(colNodes[nextIndex].id);
      nodeRefs.current.get(colNodes[nextIndex].id)?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = (index - 1 + colNodes.length) % colNodes.length;
      onSelectNode(colNodes[prevIndex].id);
      nodeRefs.current.get(colNodes[prevIndex].id)?.focus();
    }
  };

  const visibleNodeMap = useMemo(() => {
    const map = new Map<string, Node>();
    nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [nodes]);

  // Render SVG connection paths
  const renderedEdges = useMemo(() => {
    return edges.map((edge) => {
      const srcPos = nodePositions.get(edge.source);
      const tgtPos = nodePositions.get(edge.target);
      if (!srcPos || !tgtPos) return null;

      const srcNode = visibleNodeMap.get(edge.source);
      const tgtNode = visibleNodeMap.get(edge.target);
      if (!srcNode || !tgtNode) return null;

      // Calculate connection coordinates
      const isForward = srcPos.x < tgtPos.x;
      const startX = isForward ? srcPos.x + srcPos.width : srcPos.x;
      const startY = srcPos.y + srcPos.height / 2;
      const endX = isForward ? tgtPos.x : tgtPos.x + tgtPos.width;
      const endY = tgtPos.y + tgtPos.height / 2;

      const deltaX = Math.abs(endX - startX) * 0.5;
      const pathData = `M ${startX} ${startY} C ${startX + (isForward ? deltaX : -deltaX)} ${startY}, ${
        endX - (isForward ? deltaX : -deltaX)
      } ${endY}, ${endX} ${endY}`;

      // Is edge active?
      // PLAN rule: "Glow only real relationship edges whose target has fresh working activity evidence and whose edge endpoints are fresh; live PTY alone never glows."
      const isTargetWorking = tgtNode.state === 'working';
      const isFresh = !isLocallyStale && !srcNode.stale && !tgtNode.stale;
      const isActive = edge.active && isTargetWorking && isFresh;

      const isConnectedToSelected =
        edge.source === selectedNodeId || edge.target === selectedNodeId;

      return (
        <g key={edge.id} className={`edge-group ${isActive ? 'edge-active' : ''}`}>
          {/* Base stroke */}
          <path
            d={pathData}
            className={`graph-edge-path ${edge.kind} ${isActive ? 'active-path' : ''} ${
              isConnectedToSelected ? 'selected-path' : ''
            }`}
            strokeWidth={isConnectedToSelected ? 2.5 : 1.5}
            strokeDasharray={edge.kind === 'contains' ? '4 3' : edge.kind === 'lineage' ? '6 3' : 'none'}
          />

          {/* Traveling Signal (Signature Move) for active edges - completely omitted under reduced-motion */}
          {isActive && !prefersReducedMotion && (
            <circle r="4" className="edge-traveling-signal">
              <animateMotion
                path={pathData}
                dur="2.4s"
                repeatCount="indefinite"
                rotate="auto"
              />
            </circle>
          )}

          {/* Edge Kind Tag / Midpoint tooltip */}
          <title>
            {`${edge.kind.toUpperCase()} (${edge.evidence}) [${srcNode.label} -> ${tgtNode.label}]${
              isActive ? ' • ACTIVE' : ''
            }`}
          </title>
        </g>
      );
    });
  }, [edges, nodePositions, visibleNodeMap, selectedNodeId, isLocallyStale, prefersReducedMotion]);

  const renderNodeCard = (node: Node, index: number, colNodes: Node[]) => {
    const isSelected = node.id === selectedNodeId;

    return (
      <button
        key={node.id}
        ref={(el) => {
          if (el) nodeRefs.current.set(node.id, el);
          else nodeRefs.current.delete(node.id);
        }}
        type="button"
        className={`graph-node-card kind-${node.kind} state-${node.state} ${
          isSelected ? 'node-selected' : ''
        } ${node.stale ? 'node-stale' : ''}`}
        onClick={() => onSelectNode(node.id)}
        onKeyDown={(e) => handleKeyDown(e, index, colNodes)}
        aria-pressed={isSelected}
        aria-label={`${node.kind} node: ${node.label}, state: ${node.state}, liveness: ${node.liveness}`}
      >
        <div className="node-card-header">
          <span className={`node-badge-kind kind-${node.kind}`}>
            {node.kind}
          </span>
          <span className={`node-badge-state state-${node.state}`}>
            {node.state}
          </span>
        </div>

        <div className="node-card-title font-semibold">{node.label}</div>

        {node.branch && (
          <div className="node-card-sub font-mono text-muted">
            <span className="branch-icon">⎇</span> {node.branch}
          </div>
        )}

        {node.preview && (
          <div className="node-card-preview font-mono text-xs">
            {node.preview}
          </div>
        )}

        <div className="node-card-footer">
          <span className={`badge-liveness-dot dot-${node.liveness}`} title={`Liveness: ${node.liveness}`} />
          <span className="node-footer-meta font-mono text-xs">
            {node.taskIds.length > 0 ? `${node.taskIds.length} tasks` : node.liveness}
          </span>
          {node.stale && <span className="badge-stale-tag">Stale</span>}
        </div>
      </button>
    );
  };

  return (
    <section className="workflow-graph-wrapper" aria-label="Workflow relationship graph">
      {/* Graph Toolbar */}
      <div className="graph-toolbar">
        <div className="toolbar-title-group">
          <h2 className="graph-title">Topology & Worktrees</h2>
          <span className="node-count-badge font-mono">
            {nodes.length} nodes • {edges.length} edges
          </span>
        </div>

        <div className="toolbar-controls">
          <div className="kind-filter-group" role="group" aria-label="Filter nodes by kind">
            {['all', 'orchestrator', 'worktree', 'agent', 'terminal'].map((k) => (
              <button
                key={k}
                type="button"
                className={`filter-btn ${filterKind === k ? 'active' : ''}`}
                onClick={() => setFilterKind(k)}
              >
                {k.charAt(0).toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>

          <div className="graph-legend">
            <span className="legend-item">
              <span className="legend-swatch swatch-active" /> Active
            </span>
            <span className="legend-item">
              <span className="legend-swatch swatch-contains" /> Contains
            </span>
            <span className="legend-item">
              <span className="legend-swatch swatch-lineage" /> Lineage
            </span>
            <span className="legend-item">
              <span className="legend-swatch swatch-delegates" /> Delegates
            </span>
          </div>
        </div>
      </div>

      {/* Main Canvas with SVG behind and HTML Nodes in front */}
      <div className="graph-canvas-container" ref={containerRef}>
        <svg
          className="graph-svg-edges"
          aria-hidden="true"
          style={{
            width: '100%',
            height: '100%',
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
          }}
        >
          <defs>
            <linearGradient id="activeEdgeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#0d9488" stopOpacity="1" />
            </linearGradient>
          </defs>
          {renderedEdges}
        </svg>

        {nodes.length === 0 ? (
          <div className="graph-empty-state">
            <div className="empty-title">No Nodes Discovered</div>
            <div className="empty-description">
              No active worktrees, orchestrators, or agents found for this project snapshot.
            </div>
          </div>
        ) : (
          <div className="graph-columns-layout">
            {/* Column 0: Orchestrator */}
            {orchestrators.length > 0 && (
              <div className="graph-column col-orchestrator">
                <div className="column-header">
                  <span className="col-name">Orchestrators</span>
                  <span className="col-count font-mono">{orchestrators.length}</span>
                </div>
                <div className="column-nodes">
                  {orchestrators.map((n, i) => renderNodeCard(n, i, orchestrators))}
                </div>
              </div>
            )}

            {/* Column 1: Worktrees */}
            <div className="graph-column col-worktree">
              <div className="column-header">
                <span className="col-name">Workspaces & Worktrees</span>
                <span className="col-count font-mono">{worktrees.length}</span>
              </div>
              <div className="column-nodes">
                {worktrees.length === 0 ? (
                  <div className="column-empty-hint">No worktree nodes</div>
                ) : (
                  worktrees.map((n, i) => renderNodeCard(n, i, worktrees))
                )}
              </div>
            </div>

            {/* Column 2: Agents */}
            <div className="graph-column col-agent">
              <div className="column-header">
                <span className="col-name">Agents & Workers</span>
                <span className="col-count font-mono">{agents.length}</span>
              </div>
              <div className="column-nodes">
                {agents.length === 0 ? (
                  <div className="column-empty-hint">No agent nodes in scope</div>
                ) : (
                  agents.map((n, i) => renderNodeCard(n, i, agents))
                )}
              </div>
            </div>

            {/* Column 3: Terminals */}
            {terminals.length > 0 && (
              <div className="graph-column col-terminal">
                <div className="column-header">
                  <span className="col-name">Shells & Terminals</span>
                  <span className="col-count font-mono">{terminals.length}</span>
                </div>
                <div className="column-nodes">
                  {terminals.map((n, i) => renderNodeCard(n, i, terminals))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
