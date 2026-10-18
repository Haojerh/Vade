import React, { useRef, useState, useLayoutEffect, useEffect, useMemo, useCallback } from 'react';
import type { Edge, Node } from '../../../shared/contracts';
import { separateWorkflowBoxes, type LayoutBox } from './workflowCollision';
import type { AnchorBox } from './WorkflowEdgesSvg';

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

    const containerRect = container.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;

    const boxes: LayoutBox[] = [];
    const flowPositions = new Map<string, { x: number; y: number }>();
    elementRefs.current.forEach((element, id) => {
      if (!element.isConnected) return;
      const worktree = element.closest('.worktree-box-container');
      if (worktree && worktree !== element && !worktree.classList.contains('unassigned-box-container')) return;
      const group = element.closest('.orchestrator-group') || element;
      const rect = group.getBoundingClientRect();
      const correction = collisionOffsetsRef.current[id] || { x: 0, y: 0 };
      const flow = {
        x: rect.left - containerRect.left + scrollLeft - correction.x,
        y: rect.top - containerRect.top + scrollTop - correction.y,
      };
      flowPositions.set(id, flow);
      const offset = nodeOffsetsRef.current[id] || { x: 0, y: 0 };
      if (!layoutAnchorsRef.current.has(id)) {
        layoutAnchorsRef.current.set(id, { x: flow.x - offset.x, y: flow.y - offset.y });
      }
      const anchor = layoutAnchorsRef.current.get(id)!;
      boxes.push({ id, x: anchor.x + offset.x, y: anchor.y + offset.y, width: rect.width, height: rect.height });
    });
    for (const id of layoutAnchorsRef.current.keys()) {
      if (!flowPositions.has(id)) layoutAnchorsRef.current.delete(id);
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
        newPositions.set(id, {
          x: rect.left - containerRect.left + scrollLeft,
          y: rect.top - containerRect.top + scrollTop,
          width: rect.width,
          height: rect.height,
        });
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
        const right = rect.right - containerRect.left + scrollLeft + 60;
        const bottom = rect.bottom - containerRect.top + scrollTop + 60;
        if (right > contentWidth) contentWidth = right;
        if (bottom > contentHeight) contentHeight = bottom;
      }
    });

    const newCanvasSize = { width: Math.round(contentWidth), height: Math.round(contentHeight) };

    setCanvasSize((prev) => (areSizesEqual(prev, newCanvasSize) ? prev : newCanvasSize));
    setPositions((prev) => (arePositionsEqual(prev, newPositions) ? prev : newPositions));
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
        setIsCanvasPanning(false);
        setTimeout(() => {
          suppressPreviewRef.current = false;
        }, 150);
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
      };

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
      const canvas = containerRef.current;
      const anchor = layoutAnchorsRef.current.get(id);
      const rect = (boundedElement || draggedElement)?.getBoundingClientRect();
      const currentOffset =
        anchor && rect && canvas
          ? {
              x: rect.left - canvas.getBoundingClientRect().left + canvas.scrollLeft - anchor.x,
              y: rect.top - canvas.getBoundingClientRect().top + canvas.scrollTop - anchor.y,
            }
          : nodeOffsets[id] || { x: 0, y: 0 };
      setNodeOffsets((previous) => ({ ...previous, [id]: currentOffset }));
      const minimumX =
        boundedElement && canvas
          ? currentOffset.x -
            (boundedElement.getBoundingClientRect().left -
              canvas.getBoundingClientRect().left -
              canvas.clientLeft +
              canvas.scrollLeft)
          : -Infinity;
      const minimumY =
        boundedElement && canvas
          ? currentOffset.y -
            (boundedElement.getBoundingClientRect().top -
              canvas.getBoundingClientRect().top -
              canvas.clientTop +
              canvas.scrollTop)
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
          const newX = Math.max(minimumX, dragNodeInfoRef.current.originX + dx);
          const newY = Math.max(minimumY, dragNodeInfoRef.current.originY + dy);
          setNodeOffsets((prev) => ({
            ...prev,
            [id]: { x: newX, y: newY },
          }));
          scheduleUpdate();
        }
      };

      const handlePointerUp = () => {
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
