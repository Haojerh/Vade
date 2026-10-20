import React, { useRef, useState, useLayoutEffect, useEffect, useMemo, useCallback } from 'react';
import type { Edge, Node } from '../../../shared/contracts';
import { separateWorkflowBoxes, type LayoutBox } from './workflowCollision';
import type { AnchorBox } from './WorkflowEdgesSvg';
import { placeNewWorktree } from './newWorktreePlacement';
import { clampWorkflowZoom, zoomScrollOffset, workflowBox } from './workflowZoom';
import { bindWorkflowPinch } from './workflowTouch';

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

export function usePrefersReducedMotion(): boolean {
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

export interface UseWorkflowCanvasOptions {
  projectId: string | null;
  nodes: Node[];
  edges: Edge[];
  orchestrators: Node[];
  worktrees: Node[];
  worktreeAgentsMap: Map<string, Node[]>;
  unassignedAgents: Node[];
  chatOpenNodeId: string | null;
  draggingMemberRef: React.MutableRefObject<{ worktreeId: string; agentId: string } | null>;
  closePreview: () => void;
  suppressPreviewRef: React.MutableRefObject<boolean>;
  ready?: boolean;
}

export function useWorkflowCanvas({
  projectId,
  nodes,
  edges,
  orchestrators,
  worktrees,
  worktreeAgentsMap,
  unassignedAgents,
  chatOpenNodeId,
  draggingMemberRef,
  closePreview,
  suppressPreviewRef,
  ready = true,
}: UseWorkflowCanvasOptions) {
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const saved = localStorage.getItem(`orca-workflow-node-offsets:${projectId || 'default'}`);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [collisionOffsets, setCollisionOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const collisionOffsetsRef = useRef(collisionOffsets);
  collisionOffsetsRef.current = collisionOffsets;
  const layoutAnchorsRef = useRef(new Map<string, { x: number; y: number }>());
  const nodeOffsetsRef = useRef(nodeOffsets);
  nodeOffsetsRef.current = nodeOffsets;
  const liveGraphRef = useRef({ projectId, nodes, ready });
  liveGraphRef.current = { projectId, nodes, ready };
  const discoveredWorktrees = useRef<{ projectId: string; seen: Set<string>; pending: Set<string> } | null>(null);
  const revealWorktreeRef = useRef<string | null>(null);

  const effectiveOffsets = useMemo(() => {
    const result = { ...nodeOffsets };
    for (const [id, correction] of Object.entries(collisionOffsets)) {
      const requested = nodeOffsets[id] || { x: 0, y: 0 };
      result[id] = { x: requested.x + correction.x, y: requested.y + correction.y };
    }
    return result;
  }, [nodeOffsets, collisionOffsets]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCollisionOffsets({});
    layoutAnchorsRef.current.clear();
    try {
      const saved = localStorage.getItem(`orca-workflow-node-offsets:${projectId || 'default'}`);
      setNodeOffsets(saved ? JSON.parse(saved) : {});
    } catch {
      setNodeOffsets({});
    }
  }, [projectId]);

  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const dragNodeInfoRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    hasMoved: boolean;
  } | null>(null);
  const justDraggedNodeRef = useRef(false);

  // Canvas panning (drag to move canvas)
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number }>({
    x: 0,
    y: 0,
    scrollLeft: 0,
    scrollTop: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const cancelGestureRef = useRef<(() => void) | null>(null);
  const zoomAnchorRef = useRef<{ left: number; top: number } | null>(null);
  const changeZoom = useCallback((value: number, point?: { x: number; y: number }) => {
    const container = containerRef.current;
    if (!container || dragNodeInfoRef.current || draggingMemberRef.current) return;
    const next = clampWorkflowZoom(value);
    const before = zoomRef.current;
    if (next === before) return;
    const x = point?.x ?? container.clientWidth / 2;
    const y = point?.y ?? container.clientHeight / 2;
    zoomAnchorRef.current = {
      left: zoomScrollOffset(container.scrollLeft, x, before, next),
      top: zoomScrollOffset(container.scrollTop, y, before, next),
    };
    closePreview();
    zoomRef.current = next;
    setZoom(next);
  }, [closePreview, draggingMemberRef]);
  useLayoutEffect(() => {
    if (zoomAnchorRef.current && containerRef.current) {
      containerRef.current.scrollLeft = zoomAnchorRef.current.left;
      containerRef.current.scrollTop = zoomAnchorRef.current.top;
      zoomAnchorRef.current = null;
    }
  }, [zoom]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const wheel = (event: WheelEvent) => {
      // Pinch gestures arrive as Ctrl+wheel. Normal two-finger scrolling pans.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-delta * 0.005), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    container.addEventListener('wheel', wheel, { passive: false });
    return () => container.removeEventListener('wheel', wheel);
  }, [changeZoom]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return bindWorkflowPinch(container, () => zoomRef.current, changeZoom, () => cancelGestureRef.current?.());
  }, [changeZoom]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const elementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [positions, setPositions] = useState<Map<string, AnchorBox>>(new Map());
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const rafIdRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (chatOpenNodeId) {
      elementRefs.current.get(chatOpenNodeId)?.querySelector('textarea')?.focus({ preventScroll: true });
    }
  }, [chatOpenNodeId]);

  const measurePositions = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const contentRect = contentRef.current?.getBoundingClientRect();
    if (!contentRect) return;
    const scale = zoomRef.current;
    const scrollLeft = container.scrollLeft / scale;
    const scrollTop = container.scrollTop / scale;
    const graph = liveGraphRef.current;
    if (graph.projectId && graph.ready) {
      const ids = graph.nodes.filter((node) => node.kind === 'worktree').map((node) => node.id);
      if (discoveredWorktrees.current?.projectId !== graph.projectId) {
        discoveredWorktrees.current = { projectId: graph.projectId, seen: new Set(ids), pending: new Set() };
        revealWorktreeRef.current = null;
      } else {
        for (const id of ids) {
          if (!discoveredWorktrees.current.seen.has(id)) discoveredWorktrees.current.pending.add(id);
          discoveredWorktrees.current.seen.add(id);
        }
      }
    }

    const boxes: LayoutBox[] = [];
    const flowPositions = new Map<string, { x: number; y: number }>();
    elementRefs.current.forEach((element, id) => {
      if (!element.isConnected) return;
      const worktree = element.closest('.worktree-box-container');
      if (worktree && worktree !== element && !worktree.classList.contains('unassigned-box-container')) return;
      const group = element.closest('.orchestrator-group') || element;
      const rect = group.getBoundingClientRect();
      const logical = workflowBox(rect, contentRect, scale);
      const correction = collisionOffsetsRef.current[id] || { x: 0, y: 0 };
      const flow = {
        x: logical.x - correction.x,
        y: logical.y - correction.y,
      };
      flowPositions.set(id, flow);
      const offset = nodeOffsetsRef.current[id] || { x: 0, y: 0 };
      if (!layoutAnchorsRef.current.has(id)) {
        layoutAnchorsRef.current.set(id, { x: flow.x - offset.x, y: flow.y - offset.y });
      }
      const anchor = layoutAnchorsRef.current.get(id)!;
      boxes.push({ id, x: anchor.x + offset.x, y: anchor.y + offset.y, width: logical.width, height: logical.height });
    });
    for (const id of layoutAnchorsRef.current.keys()) {
      if (!flowPositions.has(id)) layoutAnchorsRef.current.delete(id);
    }
    const discovery = discoveredWorktrees.current;
    if (graph.ready && container.clientWidth > 0 && container.clientHeight > 0 && discovery?.projectId === graph.projectId && discovery.pending.size) {
      const updates: Record<string, { x: number; y: number }> = {};
      for (const id of discovery.pending) {
        const box = boxes.find((box) => box.id === id);
        const anchor = layoutAnchorsRef.current.get(id);
        if (!box?.width || !box.height || !anchor) continue;
        const placement = placeNewWorktree(box, { x: scrollLeft, y: scrollTop, width: container.clientWidth / scale, height: container.clientHeight / scale },
          boxes.filter((other) => other.id !== id).map((other) => {
            const correction = collisionOffsetsRef.current[other.id];
            return { ...other, x: other.x + (correction?.x ?? 0), y: other.y + (correction?.y ?? 0) };
          }));
        updates[id] = { x: placement.box.x - anchor.x, y: placement.box.y - anchor.y };
        box.x = placement.box.x; box.y = placement.box.y;
        if (!placement.inViewport) revealWorktreeRef.current = id;
        discovery.pending.delete(id);
      }
      if (Object.keys(updates).length) {
        const next = { ...nodeOffsetsRef.current, ...updates };
        nodeOffsetsRef.current = next;
        setNodeOffsets(next);
        try { localStorage.setItem(`orca-workflow-node-offsets:${graph.projectId}`, JSON.stringify(next)); } catch { /* Storage unavailable. */ }
        return; // Measure the resulting DOM before applying collision corrections.
      }
    }
    if (!draggingMemberRef.current) {
      const corrections: Record<string, { x: number; y: number }> = {};
      for (const box of separateWorkflowBoxes(boxes)) {
        const original = flowPositions.get(box.id)!;
        corrections[box.id] = { x: box.x - original.x, y: box.y - original.y };
      }
      setCollisionOffsets((previous) =>
        Object.keys(previous).length === Object.keys(corrections).length &&
        Object.entries(corrections).every(
          ([id, value]) =>
            previous[id] &&
            Math.abs(previous[id].x - value.x) < 0.5 &&
            Math.abs(previous[id].y - value.y) < 0.5
        )
          ? previous
          : corrections
      );
    }

    const newPositions = new Map<string, AnchorBox>();

    elementRefs.current.forEach((el, id) => {
      if (el && el.isConnected) {
        const rect = el.getBoundingClientRect();
        newPositions.set(id, workflowBox(rect, contentRect, scale));
      }
    });

    // Content extent based on layout content geometry and repositioned node bounds
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

    elementRefs.current.forEach((el) => {
      if (el && el.isConnected) {
        const rect = el.getBoundingClientRect();
        const right = (rect.right - contentRect.left) / scale + 60;
        const bottom = (rect.bottom - contentRect.top) / scale + 60;
        if (right > contentWidth) contentWidth = right;
        if (bottom > contentHeight) contentHeight = bottom;
      }
    });

    const newCanvasSize = { width: Math.round(contentWidth), height: Math.round(contentHeight) };

    setCanvasSize((prev) => (areSizesEqual(prev, newCanvasSize) ? prev : newCanvasSize));
    setPositions((prev) => (arePositionsEqual(prev, newPositions) ? prev : newPositions));
    if (revealWorktreeRef.current) {
      const box = newPositions.get(revealWorktreeRef.current);
      if (box) {
        container.scrollTo({ left: Math.max(0, (box.x - 24) * scale), top: Math.max(0, (box.y - 24) * scale), behavior: 'auto' });
        revealWorktreeRef.current = null;
      }
    }
  }, [draggingMemberRef]);

  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      measurePositions();
    });
  }, [measurePositions]);

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      closePreview();
      suppressPreviewRef.current = true;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (
        target.closest('.graph-node-card') ||
        target.closest('.worktree-box-container') ||
        target.closest('.orchestrator-group') ||
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('a') ||
        target.closest('.node-card-chat-extension') ||
        target.closest('.node-message-preview')
      ) {
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      // The canvas disables native selection, so background clicks must clear it explicitly.
      const selection = window.getSelection();
      if (selection?.anchorNode && container.contains(selection.anchorNode)) {
        selection.removeAllRanges();
      }

      setIsCanvasPanning(true);
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };

      const handlePointerMove = (moveEvt: PointerEvent) => {
        closePreview();
        if (!containerRef.current) return;
        const dx = moveEvt.clientX - panStartRef.current.x;
        const dy = moveEvt.clientY - panStartRef.current.y;
        containerRef.current.scrollLeft = panStartRef.current.scrollLeft - dx;
        containerRef.current.scrollTop = panStartRef.current.scrollTop - dy;
      };

      const handlePointerUp = () => {
        if (cancelGestureRef.current === handlePointerUp) cancelGestureRef.current = null;
        setIsCanvasPanning(false);
        setTimeout(() => {
          suppressPreviewRef.current = false;
        }, 150);
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
      };

      cancelGestureRef.current = handlePointerUp;
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [closePreview, suppressPreviewRef]
  );

  const handleNodeDragStart = useCallback(
    (id: string, e: React.PointerEvent) => {
      closePreview();
      suppressPreviewRef.current = true;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea') ||
        target.closest('a') ||
        target.closest('.node-card-chat-extension') ||
        target.closest('.node-badge-state') ||
        target.closest('.badge-liveness-dot')
      ) {
        return;
      }

      const draggedElement = elementRefs.current.get(id);
      const boundedElement = draggedElement?.matches('.worktree-box-container')
        ? draggedElement
        : draggedElement?.closest<HTMLElement>('.orchestrator-group');
      const anchor = layoutAnchorsRef.current.get(id);
      const rect = (boundedElement || draggedElement)?.getBoundingClientRect();
      const contentRect = contentRef.current?.getBoundingClientRect();
      const scale = zoomRef.current;
      const currentOffset =
        anchor && rect && contentRect
          ? {
              x: (rect.left - contentRect.left) / scale - anchor.x,
              y: (rect.top - contentRect.top) / scale - anchor.y,
            }
          : nodeOffsets[id] || { x: 0, y: 0 };
      setNodeOffsets((previous) => ({ ...previous, [id]: currentOffset }));
      const minimumX =
        rect && contentRect
          ? currentOffset.x - (rect.left - contentRect.left) / scale
          : -Infinity;
      const minimumY =
        rect && contentRect
          ? currentOffset.y - (rect.top - contentRect.top) / scale
          : -Infinity;
      dragNodeInfoRef.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        originX: currentOffset.x,
        originY: currentOffset.y,
        hasMoved: false,
      };

      const handlePointerMove = (moveEvt: PointerEvent) => {
        if (!dragNodeInfoRef.current) return;
        closePreview();
        const dx = moveEvt.clientX - dragNodeInfoRef.current.startX;
        const dy = moveEvt.clientY - dragNodeInfoRef.current.startY;
        if (!dragNodeInfoRef.current.hasMoved && Math.hypot(dx, dy) > 4) {
          dragNodeInfoRef.current.hasMoved = true;
          closePreview();
          setDraggingNodeId(id);
        }
        if (dragNodeInfoRef.current.hasMoved) {
          const newX = Math.max(minimumX, dragNodeInfoRef.current.originX + dx / scale);
          const newY = Math.max(minimumY, dragNodeInfoRef.current.originY + dy / scale);
          setNodeOffsets((prev) => ({
            ...prev,
            [id]: { x: newX, y: newY },
          }));
          scheduleUpdate();
        }
      };

      const handlePointerUp = () => {
        if (cancelGestureRef.current === handlePointerUp) cancelGestureRef.current = null;
        if (dragNodeInfoRef.current?.hasMoved) {
          justDraggedNodeRef.current = true;
          setTimeout(() => {
            justDraggedNodeRef.current = false;
          }, 80);
          setNodeOffsets((latest) => {
            try {
              localStorage.setItem(
                `orca-workflow-node-offsets:${projectId || 'default'}`,
                JSON.stringify(latest)
              );
            } catch {
              // ignore
            }
            return latest;
          });
          scheduleUpdate();
        }
        dragNodeInfoRef.current = null;
        setDraggingNodeId(null);
        setTimeout(() => {
          suppressPreviewRef.current = false;
        }, 150);
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
      };

      cancelGestureRef.current = handlePointerUp;
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [closePreview, nodeOffsets, projectId, scheduleUpdate, suppressPreviewRef]
  );

  useLayoutEffect(() => {
    measurePositions();
  }, [
    nodes,
    edges,
    orchestrators,
    worktrees,
    worktreeAgentsMap,
    unassignedAgents,
    nodeOffsets,
    collisionOffsets,
    chatOpenNodeId,
    measurePositions,
    ready,
    zoom,
  ]);

  const registerRef = useCallback(
    (id: string, el: HTMLElement | null) => {
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
    },
    [scheduleUpdate]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      measurePositions();
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

  return {
    containerRef,
    contentRef,
    zoom,
    changeZoom,
    layoutRef,
    elementRefs,
    registerRef,
    positions,
    canvasSize,
    nodeOffsets,
    setNodeOffsets,
    effectiveOffsets,
    draggingNodeId,
    isCanvasPanning,
    justDraggedNodeRef,
    scheduleUpdate,
    handleCanvasPointerDown,
    handleNodeDragStart,
  };
}
