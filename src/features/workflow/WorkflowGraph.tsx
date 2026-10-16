import React, { useRef, useState, useLayoutEffect, useEffect, useMemo, useCallback } from 'react';
import type { Node, Edge } from '../../../shared/contracts';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { NodeMessagePreview } from './NodeMessagePreview';
import { compareWorkflowNodes } from './workflowOrder';
import { sendNodeMessage } from '../../api/client';

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

export interface DraggedGitHubItem {
  type: 'pr' | 'issue';
  number: number;
  title: string;
  url?: string;
  headRef?: string | null;
  baseRef?: string | null;
  author?: string | null;
  draft?: boolean;
  labels?: string[];
}

export function buildGitHubPrompt(item: DraggedGitHubItem): string {
  if (item.type === 'pr') {
    const lines = [
      `Please review and merge Pull Request #${item.number}: "${item.title}"`,
      '',
      'Context:',
      item.url ? `- Link: ${item.url}` : null,
      item.headRef ? `- Branch: \`${item.headRef}\`${item.baseRef ? ` -> \`${item.baseRef}\`` : ''}` : null,
      item.author ? `- Author: @${item.author}` : null,
      item.draft ? '- Status: Draft' : '- Status: Ready for review',
      '',
      'Instructions:',
      '1. Review the changes and diff against the target branch.',
      '2. Run tests to ensure build and test suite pass without regressions.',
      '3. Merge the PR if sound, or report any requested revisions.',
    ].filter((line): line is string => line !== null);

    return lines.join('\n');
  }

  const lines = [
    `Please investigate and fix Issue #${item.number}: "${item.title}"`,
    '',
    'Context:',
    item.url ? `- Link: ${item.url}` : null,
    item.author ? `- Reported by: @${item.author}` : null,
    item.labels && item.labels.length > 0 ? `- Labels: ${item.labels.join(', ')}` : null,
    '',
    'Instructions:',
    '1. Locate the source code related to the issue and reproduce if needed.',
    '2. Implement a fix following existing project architecture and conventions.',
    '3. Add test coverage and verify all tests pass before completing.',
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
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

  // Chat extension and drag-and-drop state
  const [isDraggingGitHubItem, setIsDraggingGitHubItem] = useState(false);
  const [draggedItem, setDraggedItem] = useState<DraggedGitHubItem | null>(null);
  const [dropHoverNodeId, setDropHoverNodeId] = useState<string | null>(null);
  const [chatOpenNodeId, setChatOpenNodeId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Record<string, string>>({});
  const [chatSending, setChatSending] = useState<Record<string, boolean>>({});
  const [chatStatuses, setChatStatuses] = useState<Record<string, { type: 'success' | 'error'; text: string } | null>>({});

  // Node repositioning (dragging worktrees, orchestrators, unassigned agents)
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { x: number; y: number }>>(() => {
    if (typeof window === 'undefined') return {};
    try {
      const saved = localStorage.getItem(`orca-workflow-node-offsets:${projectId || 'default'}`);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
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

  const showPreview = useCallback((nodeId: string, anchor: HTMLElement) => {
    if (
      draggingNodeId ||
      isCanvasPanning ||
      isDraggingGitHubItem ||
      chatOpenNodeId ||
      suppressPreviewRef.current
    ) {
      return;
    }
    setPreview((current) => current?.nodeId === nodeId ? current : { nodeId, anchor });
  }, [draggingNodeId, isCanvasPanning, isDraggingGitHubItem, chatOpenNodeId]);

  useEffect(() => {
    const onDragStart = (e: Event) => {
      const customEvent = e as CustomEvent<DraggedGitHubItem>;
      setIsDraggingGitHubItem(true);
      if (customEvent.detail) {
        setDraggedItem(customEvent.detail);
      }
    };
    const onDragEnd = () => {
      setIsDraggingGitHubItem(false);
      setDraggedItem(null);
      setDropHoverNodeId(null);
    };

    window.addEventListener('orca:drag-github-item-start', onDragStart);
    window.addEventListener('orca:drag-github-item-end', onDragEnd);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('orca:drag-github-item-start', onDragStart);
      window.removeEventListener('orca:drag-github-item-end', onDragEnd);
      window.removeEventListener('dragend', onDragEnd);
    };
  }, []);

  const toggleChat = useCallback((nodeId: string) => {
    closePreview();
    setChatOpenNodeId((curr) => (curr === nodeId ? null : nodeId));
  }, [closePreview]);

  const closeChat = useCallback((nodeId: string) => {
    setChatOpenNodeId((curr) => (curr === nodeId ? null : curr));
  }, []);

  const handleSendChatMessage = useCallback(async (nodeId: string) => {
    if (!projectId) {
      setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: 'No active project' } }));
      return;
    }
    const text = (chatMessages[nodeId] || '').trim();
    if (!text) return;

    setChatSending((prev) => ({ ...prev, [nodeId]: true }));
    setChatStatuses((prev) => ({ ...prev, [nodeId]: null }));

    try {
      const res = await sendNodeMessage(projectId, nodeId, text);
      if (res.ok) {
        setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'success', text: 'Sent!' } }));
        setChatMessages((prev) => ({ ...prev, [nodeId]: '' }));
        setTimeout(() => {
          setChatOpenNodeId((curr) => (curr === nodeId ? null : curr));
          setChatStatuses((prev) => ({ ...prev, [nodeId]: null }));
        }, 700);
      } else {
        setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: res.message || 'Failed to send' } }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error sending message';
      setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: msg } }));
    } finally {
      setChatSending((prev) => ({ ...prev, [nodeId]: false }));
    }
  }, [projectId, chatMessages]);

  const handleDragOver = useCallback((e: React.DragEvent, nodeId: string) => {
    if (isDraggingGitHubItem || e.dataTransfer.types.includes('application/json')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (dropHoverNodeId !== nodeId) {
        setDropHoverNodeId(nodeId);
      }
    }
  }, [isDraggingGitHubItem, dropHoverNodeId]);

  const handleDragLeave = useCallback((e: React.DragEvent, nodeId: string) => {
    if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
      if (dropHoverNodeId === nodeId) {
        setDropHoverNodeId(null);
      }
    }
  }, [dropHoverNodeId]);

  const handleDrop = useCallback((e: React.DragEvent, nodeId: string) => {
    e.preventDefault();
    setIsDraggingGitHubItem(false);
    setDropHoverNodeId(null);

    let item = draggedItem;
    if (!item) {
      try {
        const json = e.dataTransfer.getData('application/json');
        if (json) {
          item = JSON.parse(json);
        }
      } catch {
        // ignore
      }
    }

    if (item) {
      const prompt = buildGitHubPrompt(item);
      closePreview();
      setChatOpenNodeId(nodeId);
      setChatMessages((prev) => ({ ...prev, [nodeId]: prompt }));
    }
  }, [draggedItem, closePreview]);

  const previewEvents = (node: Node) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      if (chatOpenNodeId || draggingNodeId || isCanvasPanning || isDraggingGitHubItem || suppressPreviewRef.current) return;
      if (!selectedNodeId && event.pointerType !== 'touch') showPreview(node.id, event.currentTarget);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (chatOpenNodeId || selectedNodeId || draggingNodeId || isCanvasPanning || isDraggingGitHubItem || suppressPreviewRef.current || event.pointerType === 'touch') {
        closePreview();
        return;
      }
      showPreview(node.id, event.currentTarget);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      if (!selectedNodeId && !draggingNodeId && !isCanvasPanning) suppressPreviewRef.current = false;
      if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.node-message-preview')) closePreview();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (chatOpenNodeId || (event.target as HTMLElement).closest('.node-card-chat-extension') || draggingNodeId || isCanvasPanning || isDraggingGitHubItem) return;
      if (!selectedNodeId && !suppressPreviewRef.current) showPreview(node.id, event.currentTarget);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Tab') suppressPreviewRef.current = false;
    },
    onClickCapture: () => { suppressPreviewRef.current = true; closePreview(); },
    onBlur: closePreview,
    onPointerDown: closePreview,
    'aria-describedby': preview?.nodeId === node.id ? 'node-message-preview' : undefined,
  });

  const renderChatExtension = (node: Node) => {
    if (chatOpenNodeId !== node.id) return null;
    const status = chatStatuses[node.id];
    const isSending = Boolean(chatSending[node.id]);
    const currentMsg = chatMessages[node.id] || '';

    return (
      <div
        className="node-card-chat-extension"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <textarea
          className="node-card-chat-textarea"
          placeholder={`Message ${node.label}... (Enter to send)`}
          value={currentMsg}
          onChange={(e) => setChatMessages((prev) => ({ ...prev, [node.id]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSendChatMessage(node.id);
            }
          }}
          rows={currentMsg.includes('\n') ? 5 : 2}
          disabled={isSending}
          autoFocus
        />
        <div className="node-card-chat-actions">
          {status ? (
            <span
              className={`font-mono text-xs font-semibold ${
                status.type === 'error' ? 'text-danger' : 'text-success'
              }`}
            >
              {status.text}
            </span>
          ) : (
            <span className="text-muted text-xs font-mono">Right-click toggles</span>
          )}
          <div className="node-card-chat-actions-right">
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => closeChat(node.id)}
              disabled={isSending}
            >
              Close
            </button>
            <button
              type="button"
              className="btn btn-primary btn-xs btn-chat-send"
              onClick={() => handleSendChatMessage(node.id)}
              disabled={isSending || !currentMsg.trim()}
            >
              {isSending ? (
                <span>Sending…</span>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                  <span>Send</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };
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

    // Runtime inventory order can change with activity; layout order must not.
    worktrees.sort(compareWorkflowNodes);
    orchestrators.sort(compareWorkflowNodes);
    allAgents.sort(compareWorkflowNodes);

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
  }, []);

  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      measurePositions();
    });
  }, [measurePositions]);

  const handleResetLayout = useCallback(() => {
    setNodeOffsets({});
    try {
      localStorage.removeItem(`orca-workflow-node-offsets:${projectId || 'default'}`);
    } catch {
      // ignore
    }
    scheduleUpdate();
  }, [projectId, scheduleUpdate]);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
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
  }, [closePreview]);

  const handleNodeDragStart = useCallback((id: string, e: React.PointerEvent) => {
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

    const currentOffset = nodeOffsets[id] || { x: 0, y: 0 };
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
        const newX = dragNodeInfoRef.current.originX + dx;
        const newY = dragNodeInfoRef.current.originY + dy;
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
  }, [closePreview, nodeOffsets, projectId, scheduleUpdate]);

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
      {projectId && !selectedNodeId && !draggingNodeId && !isCanvasPanning && !isDraggingGitHubItem && preview && nodes.some((node) => node.id === preview.nodeId) &&
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

        <div className="graph-toolbar-actions">
          {Object.keys(nodeOffsets).length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-xs btn-reset-layout"
              onClick={handleResetLayout}
              title="Reset repositioned cards and worktrees to default layout"
              aria-label="Reset repositioned cards and worktrees to default layout"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>Reset Layout</span>
            </button>
          )}

          <div className="graph-legend">
            <span className="legend-item">
              <span className="legend-swatch swatch-active" /> Active
            </span>
            <span className="legend-item">
              <span className="legend-swatch swatch-idle" /> Idle
            </span>
          </div>
        </div>
      </div>

      {/* Main Canvas Container */}
      <div
        className={`graph-canvas-container ${isCanvasPanning ? 'is-canvas-panning' : ''}`}
        ref={containerRef}
        onPointerDown={handleCanvasPointerDown}
      >
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
              {orchestrators.length === 0 ? (
                <>
                  <div className="lane-header">
                    <span className="lane-label">Orchestrator</span>
                  </div>
                  <div className="lane-empty-placeholder">
                    <span className="text-muted text-xs">No orchestrator node</span>
                  </div>
                </>
              ) : (
                <div className="orchestrator-cards-list">
                  {orchestrators.map((orch) => {
                    const isSelected = orch.id === selectedNodeId;
                    const offset = nodeOffsets[orch.id];
                    return (
                      <div
                        key={orch.id}
                        className={`orchestrator-group ${draggingNodeId === orch.id ? 'is-dragging-node' : ''}`}
                        style={
                          offset
                            ? { transform: `translate(${offset.x}px, ${offset.y}px)` }
                            : undefined
                        }
                      >
                        <div
                          className="lane-header orchestrator-drag-header"
                          onPointerDown={(e) => handleNodeDragStart(orch.id, e)}
                          title="Click and drag to move orchestrator"
                        >
                          <span className="drag-grip-icon" title="Drag to move orchestrator" aria-hidden="true">⋮⋮</span>
                          <span className="lane-label">Orchestrator</span>
                        </div>

                        <div
                          role="button"
                          tabIndex={0}
                          {...previewEvents(orch)}
                          ref={(el) => registerRef(orch.id, el)}
                          className={`graph-node-card orchestrator-card state-${orch.state} ${
                            isSelected ? 'node-selected' : ''
                          } ${orch.stale ? 'node-stale' : ''} ${
                            isDraggingGitHubItem ? 'node-drag-target-glow' : ''
                          } ${dropHoverNodeId === orch.id ? 'node-drop-hover' : ''} ${
                            chatOpenNodeId === orch.id ? 'node-chat-extended' : ''
                          } ${draggingNodeId === orch.id ? 'is-dragging-node' : ''}`}
                          onPointerDown={(e) => handleNodeDragStart(orch.id, e)}
                          onClick={(e) => {
                            if (justDraggedNodeRef.current) return;
                            if ((e.target as HTMLElement).closest('.node-card-chat-extension')) return;
                            onSelectNode(orch.id);
                          }}
                          onKeyDown={(e) => {
                            if ((e.target as HTMLElement).closest('.node-card-chat-extension')) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSelectNode(orch.id);
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            toggleChat(orch.id);
                          }}
                          onDragOver={(e) => handleDragOver(e, orch.id)}
                          onDragLeave={(e) => handleDragLeave(e, orch.id)}
                          onDrop={(e) => handleDrop(e, orch.id)}
                          aria-pressed={isSelected}
                          aria-label={`Orchestrator: ${orch.label}, state: ${orch.state}, liveness: ${orch.liveness}`}
                        >
                          <div className="node-card-top">
                            <div className="agent-title-row">
                              <span className="drag-grip-icon" title="Drag to reposition orchestrator" aria-hidden="true">⋮⋮</span>
                              <ProviderIcon provider={orch.agentType} size={16} />
                              <span className="agent-label font-semibold">{orch.label}</span>
                            </div>
                            <span className={`node-badge-state state-${orch.state}`}>
                              {orch.state}
                            </span>
                          </div>

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

                          {renderChatExtension(orch)}
                        </div>
                      </div>
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
                    className={`worktree-box-container ${isSelected ? 'worktree-selected' : ''} ${
                      draggingNodeId === wt.id ? 'is-dragging-node' : ''
                    }`}
                    style={
                      nodeOffsets[wt.id]
                        ? { transform: `translate(${nodeOffsets[wt.id].x}px, ${nodeOffsets[wt.id].y}px)` }
                        : undefined
                    }
                    aria-label={`Worktree container: ${wt.label}`}
                  >
                    {/* Worktree Container Header (Drag Handle) */}
                    <div
                      className="worktree-box-header worktree-drag-handle"
                      onPointerDown={(e) => handleNodeDragStart(wt.id, e)}
                      title="Click and drag to move worktree"
                    >
                      <div className="worktree-title-group">
                        <span className="drag-grip-icon" title="Drag to move worktree" aria-hidden="true">⋮⋮</span>
                        <span className="worktree-title-label font-bold text-sm" title={`Worktree: ${wt.label}`}>
                          Worktree: {wt.label}
                        </span>
                        {wt.branch && (
                          <span className="worktree-branch-badge font-mono text-xs" title={wt.branch}>
                            ⎇ {wt.branch}
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
                            <div
                              role="button"
                              tabIndex={0}
                              {...previewEvents(ag)}
                              key={ag.id}
                              ref={(el) => registerRef(ag.id, el)}
                              className={`graph-node-card agent-card state-${ag.state} ${
                                isAgSelected ? 'node-selected' : ''
                              } ${ag.stale ? 'node-stale' : ''} ${
                                isDraggingGitHubItem ? 'node-drag-target-glow' : ''
                              } ${dropHoverNodeId === ag.id ? 'node-drop-hover' : ''} ${
                                chatOpenNodeId === ag.id ? 'node-chat-extended' : ''
                              }`}
                              onClick={(e) => {
                                if ((e.target as HTMLElement).closest('.node-card-chat-extension')) return;
                                onSelectNode(ag.id);
                              }}
                              onKeyDown={(e) => {
                                if ((e.target as HTMLElement).closest('.node-card-chat-extension')) return;
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  onSelectNode(ag.id);
                                }
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                toggleChat(ag.id);
                              }}
                              onDragOver={(e) => handleDragOver(e, ag.id)}
                              onDragLeave={(e) => handleDragLeave(e, ag.id)}
                              onDrop={(e) => handleDrop(e, ag.id)}
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

                              {renderChatExtension(ag)}
                            </div>
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
                        <div
                          role="button"
                          tabIndex={0}
                          {...previewEvents(ag)}
                          key={ag.id}
                          ref={(el) => registerRef(ag.id, el)}
                          className={`graph-node-card agent-card node-draggable ${
                            isAgSelected ? 'node-selected' : ''
                          } ${isDraggingGitHubItem ? 'node-drag-target-glow' : ''} ${
                            dropHoverNodeId === ag.id ? 'node-drop-hover' : ''
                          } ${chatOpenNodeId === ag.id ? 'node-chat-extended' : ''} ${
                            draggingNodeId === ag.id ? 'is-dragging-node' : ''
                          }`}
                          style={
                            nodeOffsets[ag.id]
                              ? { transform: `translate(${nodeOffsets[ag.id].x}px, ${nodeOffsets[ag.id].y}px)` }
                              : undefined
                          }
                          onPointerDown={(e) => handleNodeDragStart(ag.id, e)}
                          onClick={(e) => {
                            if (justDraggedNodeRef.current) return;
                            if ((e.target as HTMLElement).closest('.node-card-chat-extension')) return;
                            onSelectNode(ag.id);
                          }}
                          onKeyDown={(e) => {
                            if ((e.target as HTMLElement).closest('.node-card-chat-extension')) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSelectNode(ag.id);
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            toggleChat(ag.id);
                          }}
                          onDragOver={(e) => handleDragOver(e, ag.id)}
                          onDragLeave={(e) => handleDragLeave(e, ag.id)}
                          onDrop={(e) => handleDrop(e, ag.id)}
                          aria-pressed={isAgSelected}
                          aria-label={`Agent: ${ag.label}, state: ${ag.state}`}
                        >
                          <div className="node-card-top">
                            <div className="agent-title-row">
                              <span className="drag-grip-icon" title="Drag to reposition agent" aria-hidden="true">⋮⋮</span>
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

                          {renderChatExtension(ag)}
                        </div>
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
