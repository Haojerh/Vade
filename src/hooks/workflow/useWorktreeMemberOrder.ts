import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { Node } from '../../../shared/contracts';
import { compareWorkflowNodes, placeWorkflowMember } from '../../features/workflow/canvas/workflowOrder';

export interface UseWorktreeMemberOrderOptions {
  projectId: string | null;
  worktreeAgentsMap: Map<string, Node[]>;
  elementRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  nodeOffsets: Record<string, { x: number; y: number }>;
  setNodeOffsets: React.Dispatch<React.SetStateAction<Record<string, { x: number; y: number }>>>;
  prefersReducedMotion: boolean;
  zoom: number;
  scheduleUpdate: () => void;
  draggingMemberRef: React.MutableRefObject<{ worktreeId: string; agentId: string } | null>;
}

export function useWorktreeMemberOrder({
  projectId,
  worktreeAgentsMap,
  elementRefs,
  containerRef,
  nodeOffsets,
  setNodeOffsets,
  prefersReducedMotion,
  zoom,
  scheduleUpdate,
  draggingMemberRef,
}: UseWorktreeMemberOrderOptions) {
  const [worktreeMemberOrder, setWorktreeMemberOrder] = useState<Record<string, string[]>>(() => {
    try {
      const storage = typeof window !== 'undefined' ? window.localStorage : (globalThis as any)?.localStorage;
      const saved = storage?.getItem(`orca-worktree-member-order:${projectId || 'default'}`);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [draggingMember, setDraggingMember] = useState<{ worktreeId: string; agentId: string } | null>(null);
  const [dropTargetMember, setDropTargetMember] = useState<{
    worktreeId: string;
    agentId: string;
    position: 'before' | 'after';
  } | null>(null);
  const flipPendingRef = useRef<Map<string, number> | null>(null);
  draggingMemberRef.current = draggingMember;

  useEffect(() => {
    try {
      const storage = typeof window !== 'undefined' ? window.localStorage : (globalThis as any)?.localStorage;
      const saved = storage?.getItem(`orca-worktree-member-order:${projectId || 'default'}`);
      setWorktreeMemberOrder(saved ? JSON.parse(saved) : {});
    } catch {
      setWorktreeMemberOrder({});
    }
  }, [projectId]);

  const getOrderedMembers = useCallback(
    (worktreeId: string, rawMembers: Node[]) => {
      const customOrder = worktreeMemberOrder[worktreeId];
      if (!customOrder || customOrder.length === 0) return rawMembers;
      const orderMap = new Map<string, number>();
      customOrder.forEach((id, idx) => orderMap.set(id, idx));
      return [...rawMembers].sort((a, b) => {
        const idxA = orderMap.has(a.id) ? orderMap.get(a.id)! : 9999;
        const idxB = orderMap.has(b.id) ? orderMap.get(b.id)! : 9999;
        if (idxA !== idxB) return idxA - idxB;
        return compareWorkflowNodes(a, b);
      });
    },
    [worktreeMemberOrder]
  );

  const isValidReorder = useCallback(
    (membersList: Node[], draggedId: string, targetId: string, position: 'before' | 'after') => {
      if (draggedId === targetId) return false;
      const ids = membersList.map((m) => m.id);
      const fromIdx = ids.indexOf(draggedId);
      const toIdx = ids.indexOf(targetId);
      if (fromIdx === -1 || toIdx === -1) return false;

      if (position === 'before' && toIdx === fromIdx + 1) return false;
      if (position === 'after' && toIdx === fromIdx - 1) return false;

      return true;
    },
    []
  );

  const handleReorderMember = useCallback(
    (worktreeId: string, draggedAgentId: string, targetAgentId: string, position: 'before' | 'after') => {
      if (draggedAgentId === targetAgentId) return;
      const rawMembers = worktreeAgentsMap.get(worktreeId) || [];
      const currentOrdered = getOrderedMembers(worktreeId, rawMembers);
      const ids = currentOrdered.map((m) => m.id);

      const newIds = placeWorkflowMember(ids, draggedAgentId, targetAgentId, position);

      if (newIds.every((id, i) => id === ids[i])) return;

      // Capture current member positions before updating (FLIP switch animation)
      const prevPositions = new Map<string, number>();
      for (const id of ids) {
        const el = elementRefs.current.get(id);
        if (el && el.isConnected) {
          prevPositions.set(id, el.getBoundingClientRect().top);
        }
      }
      flipPendingRef.current = prevPositions;

      setWorktreeMemberOrder((prev) => {
        const next = { ...prev, [worktreeId]: newIds };
        try {
          localStorage.setItem(`orca-worktree-member-order:${projectId || 'default'}`, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      scheduleUpdate();
    },
    [worktreeAgentsMap, getOrderedMembers, elementRefs, projectId, scheduleUpdate]
  );

  const handleResetLayout = useCallback(() => {
    // Capture member positions before reset (FLIP switch animation)
    const prevPositions = new Map<string, number>();
    for (const [id, el] of elementRefs.current.entries()) {
      if (el && el.isConnected && !nodeOffsets[id]) {
        prevPositions.set(id, el.getBoundingClientRect().top);
      }
    }
    flipPendingRef.current = prevPositions;

    setNodeOffsets({});
    setWorktreeMemberOrder({});
    try {
      localStorage.removeItem(`orca-workflow-node-offsets:${projectId || 'default'}`);
      localStorage.removeItem(`orca-worktree-member-order:${projectId || 'default'}`);
    } catch {
      // ignore
    }
    scheduleUpdate();
  }, [projectId, nodeOffsets, setNodeOffsets, elementRefs, scheduleUpdate]);

  useLayoutEffect(() => {
    if (!flipPendingRef.current || flipPendingRef.current.size === 0) return;
    const prevPositions = flipPendingRef.current;
    flipPendingRef.current = null;

    if (prefersReducedMotion) return;

    const animatedElements: HTMLElement[] = [];

    for (const [id, prevTop] of prevPositions.entries()) {
      const el = elementRefs.current.get(id);
      if (!el || !el.isConnected) continue;

      const nextTop = el.getBoundingClientRect().top;
      const deltaY = (prevTop - nextTop) / zoom;

      if (Math.abs(deltaY) > 0.5) {
        // Invert: position element back at its previous visual location
        el.style.transform = `translateY(${deltaY}px)`;
        el.style.transition = 'none';
        animatedElements.push(el);
      }
    }

    if (animatedElements.length === 0) return;

    // Force reflow
    void containerRef.current?.offsetHeight;

    // Play: transition to natural DOM position
    for (const el of animatedElements) {
      el.style.transition = 'transform 0.28s cubic-bezier(0.2, 0, 0, 1)';
      el.style.transform = '';
    }

    // Cleanup styles after animation completes
    const timer = setTimeout(() => {
      for (const el of animatedElements) {
        el.style.transition = '';
      }
      scheduleUpdate();
    }, 300);

    return () => clearTimeout(timer);
  }, [worktreeMemberOrder, nodeOffsets, prefersReducedMotion, elementRefs, containerRef, scheduleUpdate, zoom]);

  return {
    worktreeMemberOrder,
    draggingMember,
    setDraggingMember,
    dropTargetMember,
    setDropTargetMember,
    getOrderedMembers,
    isValidReorder,
    handleReorderMember,
    handleResetLayout,
  };
}
