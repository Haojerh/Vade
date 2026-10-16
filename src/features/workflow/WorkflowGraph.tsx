import React, { useRef, useState, useLayoutEffect, useEffect, useMemo, useCallback } from 'react';
import type { Node, Edge } from '../../../shared/contracts';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { NodeMessagePreview } from './NodeMessagePreview';

interface WorkflowGraphProps {
  projectId: string | null;
  runId: string | null;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  isLocallyStale: boolean;
  loading: boolean;
}

interface AnchorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function arePositionsEqual(a: Map<string, AnchorBox>, b: Map<string, AnchorBox>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, valA] of a) {
    const valB = b.get(key);
    if (!valB) return false;
    if (
      Math.abs(valA.x - valB.x) > 0.5 ||
      Math.abs(valA.y - valB.y) > 0.5 ||
      Math.abs(valA.width - valB.width) > 0.5 ||
      Math.abs(valA.height - valB.height) > 0.5
    ) {
      return false;
    }
  }
  return true;
}

function areSizesEqual(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.height - b.height) <= 0.5;
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
  projectId,
  runId,
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  isLocallyStale,
  loading,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [preview, setPreview] = useState<{ nodeId: string; anchor: HTMLElement } | null>(null);
  const suppressPreviewRef = useRef(false);
  const closePreview = useCallback(() => setPreview(null), []);
  const showPreview = (nodeId: string, anchor: HTMLElement) => {
    setPreview((current) => current?.nodeId === nodeId ? current : { nodeId, anchor });
  };
  const previewEvents = (node: Node) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!selectedNodeId && !suppressPreviewRef.current && event.pointerType !== 'touch') showPreview(node.id, event.currentTarget);
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (selectedNodeId || event.pointerType === 'touch') return;
      suppressPreviewRef.current = false;
      showPreview(node.id, event.currentTarget);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!selectedNodeId) suppressPreviewRef.current = false;
      if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.node-message-preview')) closePreview();
    },
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
      if (!selectedNodeId && !suppressPreviewRef.current) showPreview(node.id, event.currentTarget);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Tab') suppressPreviewRef.current = false;
    },
    onClickCapture: () => { suppressPreviewRef.current = true; closePreview(); },
    onBlur: closePreview,
    onPointerDown: closePreview,
    'aria-describedby': preview?.nodeId === node.id ? 'node-message-preview' : undefined,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const elementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [positions, setPositions] = useState<Map<string, AnchorBox>>(new Map());
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const rafIdRef = useRef<number | null>(null);

  // 1. Separate orchestrators, worktrees, and member agents. Filter out terminals completely.
  const { orchestrators, worktrees, worktreeAgentsMap, unassignedAgents } = useMemo(() => {
    const validNodes = nodes.filter((n) => n.kind !== 'terminal');
    const orchestrators: Node[] = [];
    const worktrees: Node[] = [];
    const allAgents: Node[] = [];

    for (const n of validNodes) {
      if (n.kind === 'orchestrator') {
        orchestrators.push(n);
      } else if (n.kind === 'worktree') {
        worktrees.push(n);
      } else if (n.kind === 'agent') {
        allAgents.push(n);
      }
    }

    // Map worktreeId or contains edges to group agents
    // Contains edges: source is worktree, target is agent
    const containsAgentToWorktree = new Map<string, string>();
    for (const e of edges) {
      if (e.kind === 'contains') {
        containsAgentToWorktree.set(e.target, e.source);
      }
    }

    const worktreeAgentsMap = new Map<string, Node[]>();
    for (const wt of worktrees) {
      worktreeAgentsMap.set(wt.id, []);
    }

    const unassignedAgents: Node[] = [];

    for (const ag of allAgents) {
      // Check contains edge first
      const parentWtId = containsAgentToWorktree.get(ag.id);
      if (parentWtId && worktreeAgentsMap.has(parentWtId)) {
        worktreeAgentsMap.get(parentWtId)!.push(ag);
        continue;
      }

      // Check worktreeId field matching worktree node's worktreeId or id
      let matched = false;
      if (ag.worktreeId) {
        for (const wt of worktrees) {
          if (wt.worktreeId === ag.worktreeId || wt.id === ag.worktreeId) {
            worktreeAgentsMap.get(wt.id)!.push(ag);
            matched = true;
            break;
          }
        }
      }

      if (!matched) {
        unassignedAgents.push(ag);
      }
    }

    return { orchestrators, worktrees, worktreeAgentsMap, unassignedAgents };
  }, [nodes, edges]);

  // Node lookup map
  const nodeMap = useMemo(() => {
    const map = new Map<string, Node>();
    for (const n of nodes) {
      if (n.kind !== 'terminal') {
        map.set(n.id, n);
      }
    }
    return map;
  }, [nodes]);

  // 2. Compute deduplicated single paths for edges
  // Rules:
  // - Omit all terminal nodes
  // - Omit contains edges (membership is spatial inside the worktree)
  // - Deduplicate by `${source}->${target}`
  // - Exactly idle / active appearance
  const deduplicatedEdges = useMemo(() => {
    interface AggregatedEdge {
      id: string;
      source: string;
      target: string;
      isActive: boolean;
      kind: string;
    }

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
  }, [edges, nodeMap, isLocallyStale]);

  // 3. Measure positions of all registered element refs
  const measurePositions = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;

    const newPositions = new Map<string, AnchorBox>();

    elementRefs.current.forEach((el, id) => {
      if (el && el.isConnected) {
        const rect = el.getBoundingClientRect();
        newPositions.set(id, {
          x: rect.left - containerRect.left + scrollLeft,
          y: rect.top - containerRect.top + scrollTop,
          width: rect.width,
          height: rect.height,
        });
      }
    });

    // Content extent based strictly on layout content geometry (never container.scrollWidth which self-inflates from SVG child)
    let contentWidth = container.clientWidth;
    let contentHeight = container.clientHeight;

    const layoutEl = layoutRef.current;
    if (layoutEl) {
      const layoutScrollW = layoutEl.scrollWidth || layoutEl.offsetWidth;
      const layoutScrollH = layoutEl.scrollHeight || layoutEl.offsetHeight;
      const rightExtent = (layoutEl.offsetLeft || 40) + layoutScrollW + 40;
      const bottomExtent = (layoutEl.offsetTop || 32) + layoutScrollH + 32;
      contentWidth = Math.max(container.clientWidth, rightExtent);
      contentHeight = Math.max(container.clientHeight, bottomExtent);
    }

    const newCanvasSize = { width: Math.round(contentWidth), height: Math.round(contentHeight) };

    setCanvasSize((prev) => (areSizesEqual(prev, newCanvasSize) ? prev : newCanvasSize));
    setPositions((prev) => (arePositionsEqual(prev, newPositions) ? prev : newPositions));
  }, []);

  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      measurePositions();
    });
  }, [measurePositions]);

  useLayoutEffect(() => {
    scheduleUpdate();
  }, [nodes, edges, orchestrators, worktrees, worktreeAgentsMap, unassignedAgents, scheduleUpdate]);

  // Set ref helper: dynamically observe mounted elements, unobserve unmounted
  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    const prevEl = elementRefs.current.get(id);
    if (prevEl === el) return;

    if (prevEl && resizeObserverRef.current) {
      resizeObserverRef.current.unobserve(prevEl);
    }

    if (el) {
      elementRefs.current.set(id, el);
      if (resizeObserverRef.current) {
        resizeObserverRef.current.observe(el);
      }
    } else {
      elementRefs.current.delete(id);
    }
    scheduleUpdate();
  }, [scheduleUpdate]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      scheduleUpdate();
    });
    resizeObserverRef.current = observer;

    observer.observe(container);
    if (layoutRef.current) {
      observer.observe(layoutRef.current);
    }
    elementRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });

    window.addEventListener('resize', scheduleUpdate);

    // Continuous geometry tracking during CSS hide/expand transitions (e.g. sidebars or bottom panel)
    let transitionAnimId: number;
    let transitionStartTime: number | null = null;
    const transitionDuration = 300;

    const onTransitionActivity = () => {
      transitionStartTime = performance.now();
      const step = (now: number) => {
        if (!transitionStartTime) return;
        measurePositions();
        if (now - transitionStartTime < transitionDuration) {
          transitionAnimId = requestAnimationFrame(step);
        }
      };
      cancelAnimationFrame(transitionAnimId);
      transitionAnimId = requestAnimationFrame(step);
    };

    window.addEventListener('transitionstart', onTransitionActivity);
    window.addEventListener('transitionrun', onTransitionActivity);
    window.addEventListener('transitionend', onTransitionActivity);

    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('transitionstart', onTransitionActivity);
      window.removeEventListener('transitionrun', onTransitionActivity);
      window.removeEventListener('transitionend', onTransitionActivity);
      cancelAnimationFrame(transitionAnimId);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [scheduleUpdate, measurePositions]);

  // 4. Render Edge Paths
  const renderedEdges = useMemo(() => {
    return deduplicatedEdges.map((edge) => {
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
  }, [deduplicatedEdges, positions, nodeMap, prefersReducedMotion]);

  return (
    <section className="workflow-graph-wrapper" aria-label="Workflow relationship graph">
      {projectId && !selectedNodeId && preview && nodes.some((node) => node.id === preview.nodeId) &&
        <NodeMessagePreview key={`${projectId}:${runId}:${preview.nodeId}`} projectId={projectId} runId={runId}
          nodeId={preview.nodeId} anchor={preview.anchor} onLeave={closePreview} />}
      {/* Graph Toolbar */}
      <div className="graph-toolbar">
        <div className="toolbar-title-group">
          <h2 className="graph-title">Workflow Topology</h2>
          <span className="node-count-badge font-mono">
            {orchestrators.length} Orchestrator{orchestrators.length === 1 ? '' : 's'} • {worktrees.length} Worktree{worktrees.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="graph-legend">
          <span className="legend-item">
            <span className="legend-swatch swatch-active" /> Active
          </span>
          <span className="legend-item">
            <span className="legend-swatch swatch-idle" /> Idle
          </span>
        </div>
      </div>

      {/* Main Canvas Container */}
      <div className="graph-canvas-container" ref={containerRef}>
        {/* SVG overlay placed above container backgrounds and below card buttons */}
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

        {nodes.length === 0 ? (
          <div className="graph-empty-state">
            <div className="empty-title" role="status">{loading ? 'Loading Workflow Nodes…' : 'No Workflow Nodes Discovered'}</div>
            <div className="empty-description">
              {loading ? 'Reading project worktrees, orchestrators, and agents.' : 'No active worktrees, orchestrators, or agents found for this project snapshot.'}
            </div>
          </div>
        ) : (
          <div className="sketch-graph-layout" ref={layoutRef}>
            {/* LEFT COLUMN: Orchestrator Lane */}
            <div className="orchestrator-lane">
              <div className="lane-header">
                <span className="lane-label">Orchestrator</span>
              </div>

              {orchestrators.length === 0 ? (
                <div className="lane-empty-placeholder">
                  <span className="text-muted text-xs">No orchestrator node</span>
                </div>
              ) : (
                <div className="orchestrator-cards-list">
                  {orchestrators.map((orch) => {
                    const isSelected = orch.id === selectedNodeId;
                    return (
                      <button
                        {...previewEvents(orch)}
                        key={orch.id}
                        ref={(el) => registerRef(orch.id, el)}
                        type="button"
                        className={`graph-node-card orchestrator-card state-${orch.state} ${
                          isSelected ? 'node-selected' : ''
                        } ${orch.stale ? 'node-stale' : ''}`}
                        onClick={() => onSelectNode(orch.id)}
                        aria-pressed={isSelected}
                        aria-label={`Orchestrator: ${orch.label}, state: ${orch.state}, liveness: ${orch.liveness}`}
                      >
                        <div className="node-card-top">
                          <ProviderIcon provider={orch.agentType} size={16} />
                          <span className={`node-badge-state state-${orch.state}`}>
                            {orch.state}
                          </span>
                        </div>

                        <div className="node-card-title font-semibold">{orch.label}</div>

                        {orch.preview && (
                          <div className="node-card-preview font-mono text-xs text-muted">
                            {orch.preview}
                          </div>
                        )}

                        <div className="node-card-footer">
                          <div className="node-footer-left">
                            <span
                              className={`badge-liveness-dot dot-${orch.liveness}`}
                              title={`Liveness: ${orch.liveness}`}
                            />
                            <span className="node-footer-meta font-mono text-xs">
                              {orch.taskIds.length > 0 ? `${orch.taskIds.length} tasks` : orch.liveness}
                            </span>
                          </div>
                          {((orch.model && orch.model !== 'unknown') || (orch.effort && orch.effort !== 'unknown')) && (
                            <div
                              className="node-footer-right"
                              title={`${orch.model && orch.model !== 'unknown' ? orch.model : 'Model unavailable'}${orch.effort && orch.effort !== 'unknown' ? ` • effort: ${orch.effort}` : ''}`}
                            >
                              {orch.model && orch.model !== 'unknown' && <span className="node-model-name font-mono text-xs">
                                {orch.model}
                              </span>}
                              {orch.effort && orch.effort !== 'unknown' && (
                                <span className="node-effort-badge font-mono text-xs">
                                  {orch.effort}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* RIGHT COLUMN: Worktree Containers Lane */}
            <div className="worktrees-lane">
              {worktrees.map((wt) => {
                const members = worktreeAgentsMap.get(wt.id) ?? [];
                const isSelected = wt.id === selectedNodeId;

                return (
                  <div
                    key={wt.id}
                    ref={(el) => registerRef(wt.id, el)}
                    className={`worktree-box-container ${isSelected ? 'worktree-selected' : ''}`}
                    aria-label={`Worktree container: ${wt.label}`}
                  >
                    {/* Worktree Container Header */}
                    <div className="worktree-box-header">
                      <div className="worktree-title-group">
                        <span className="worktree-title-label font-bold text-sm">
                          Worktree: {wt.label}
                        </span>
                        {wt.branch && (
                          <span className="worktree-branch-badge font-mono text-xs">
                            ⎇ {wt.branch}
                          </span>
                        )}
                        {wt.workspaceStatus && (
                          <span className="badge badge-neutral text-xs">
                            {wt.workspaceStatus}
                          </span>
                        )}
                      </div>

                      <div className="worktree-header-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() => onSelectNode(wt.id)}
                          aria-label={`Inspect worktree facts for ${wt.label}`}
                        >
                          Inspect Worktree
                        </button>
                      </div>
                    </div>

                    {/* Member Agents Vertically Stacked Inside */}
                    <div className="worktree-agents-stack">
                      {members.length === 0 ? (
                        <div className="worktree-empty-agents text-xs text-muted">
                          No member agents in this worktree
                        </div>
                      ) : (
                        members.map((ag) => {
                          const isAgSelected = ag.id === selectedNodeId;
                          return (
                            <button
                              {...previewEvents(ag)}
                              key={ag.id}
                              ref={(el) => registerRef(ag.id, el)}
                              type="button"
                              className={`graph-node-card agent-card state-${ag.state} ${
                                isAgSelected ? 'node-selected' : ''
                              } ${ag.stale ? 'node-stale' : ''}`}
                              onClick={() => onSelectNode(ag.id)}
                              aria-pressed={isAgSelected}
                              aria-label={`Agent: ${ag.label}, state: ${ag.state}, liveness: ${ag.liveness}`}
                            >
                              <div className="node-card-top">
                                <div className="agent-title-row">
                                  <ProviderIcon provider={ag.agentType} size={15} />
                                  <span className="agent-label font-semibold">{ag.label}</span>
                                </div>
                                <span className={`node-badge-state state-${ag.state}`}>
                                  {ag.state}
                                </span>
                              </div>

                              {ag.preview && (
                                <div className="node-card-preview font-mono text-xs text-muted">
                                  {ag.preview}
                                </div>
                              )}

                              <div className="node-card-footer">
                                <div className="node-footer-left">
                                  <span
                                    className={`badge-liveness-dot dot-${ag.liveness}`}
                                    title={`Liveness: ${ag.liveness}`}
                                  />
                                  <span className="node-footer-meta font-mono text-xs">
                                    {ag.taskIds.length > 0 ? `${ag.taskIds.length} tasks` : ag.liveness}
                                  </span>
                                  {ag.stale && <span className="badge-stale-tag">Stale</span>}
                                </div>
                                {((ag.model && ag.model !== 'unknown') || (ag.effort && ag.effort !== 'unknown')) && (
                                  <div
                                    className="node-footer-right"
                                    title={`${ag.model && ag.model !== 'unknown' ? ag.model : 'Model unavailable'}${ag.effort && ag.effort !== 'unknown' ? ` • effort: ${ag.effort}` : ''}`}
                                  >
                                    {ag.model && ag.model !== 'unknown' && <span className="node-model-name font-mono text-xs">
                                      {ag.model}
                                    </span>}
                                    {ag.effort && ag.effort !== 'unknown' && (
                                      <span className="node-effort-badge font-mono text-xs">
                                        {ag.effort}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Unassigned Agents Section if any */}
              {unassignedAgents.length > 0 && (
                <div className="worktree-box-container unassigned-box-container">
                  <div className="worktree-box-header">
                    <span className="worktree-title-label font-bold text-sm text-muted">
                      Unassigned Agents
                    </span>
                  </div>
                  <div className="worktree-agents-stack">
                    {unassignedAgents.map((ag) => {
                      const isAgSelected = ag.id === selectedNodeId;
                      return (
                        <button
                          {...previewEvents(ag)}
                          key={ag.id}
                          ref={(el) => registerRef(ag.id, el)}
                          type="button"
                          className={`graph-node-card agent-card ${
                            isAgSelected ? 'node-selected' : ''
                          }`}
                          onClick={() => onSelectNode(ag.id)}
                          aria-pressed={isAgSelected}
                          aria-label={`Agent: ${ag.label}, state: ${ag.state}`}
                        >
                          <div className="node-card-top">
                            <div className="agent-title-row">
                              <ProviderIcon provider={ag.agentType} size={15} />
                              <span className="agent-label font-semibold">{ag.label}</span>
                            </div>
                            <span className={`node-badge-state state-${ag.state}`}>
                              {ag.state}
                            </span>
                          </div>

                          <div className="node-card-footer">
                            <div className="node-footer-left">
                              <span
                                className={`badge-liveness-dot dot-${ag.liveness}`}
                                title={`Liveness: ${ag.liveness}`}
                              />
                              <span className="node-footer-meta font-mono text-xs">
                                {ag.taskIds.length > 0 ? `${ag.taskIds.length} tasks` : ag.liveness}
                              </span>
                            </div>
                            {((ag.model && ag.model !== 'unknown') || (ag.effort && ag.effort !== 'unknown')) && (
                              <div
                                className="node-footer-right"
                                title={`${ag.model && ag.model !== 'unknown' ? ag.model : 'Model unavailable'}${ag.effort && ag.effort !== 'unknown' ? ` • effort: ${ag.effort}` : ''}`}
                              >
                                {ag.model && ag.model !== 'unknown' && <span className="node-model-name font-mono text-xs">
                                  {ag.model}
                                </span>}
                                {ag.effort && ag.effort !== 'unknown' && (
                                  <span className="node-effort-badge font-mono text-xs">
                                    {ag.effort}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
