import React, { useRef, useState, useLayoutEffect, useEffect, useMemo, useCallback } from 'react';
import type { Node, Edge } from '../../../shared/contracts';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { Icon } from '../../components/ui/Icon';
import { NodeMessagePreview } from './NodeMessagePreview';
import { compareWorkflowNodes } from './workflowOrder';
import { separateWorkflowBoxes, type LayoutBox } from './workflowCollision';
import {
  sendNodeMessage,
  deleteWorktree,
  closeAgentTab,
  renameNodeTitle,
  createWorktreeAgent,
} from '../../api/client';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { RenameDialog } from '../../components/ui/RenameDialog';
import { AddAgentDialog } from '../../components/ui/AddAgentDialog';
import { MessageAttachments, validateMessageFiles } from './MessageAttachments';

interface WorkflowGraphProps {
  projectId: string | null;
  runId: string | null;
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  isLocallyStale: boolean;
  loading: boolean;
  orchestrationSeparated?: boolean;
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
  orchestrationSeparated = true,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const resetConfirmation = useConfirmationState();
  const [preview, setPreview] = useState<{ nodeId: string; anchor: HTMLElement } | null>(null);
  const suppressPreviewRef = useRef(false);
  const closePreview = useCallback(() => setPreview(null), []);

  // Chat extension and drag-and-drop state
  const [isDraggingGitHubItem, setIsDraggingGitHubItem] = useState(false);
  const [draggedItem, setDraggedItem] = useState<DraggedGitHubItem | null>(null);
  const [dropHoverNodeId, setDropHoverNodeId] = useState<string | null>(null);
  const [chatOpenNodeId, setChatOpenNodeId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Record<string, string>>({});
  const [chatFiles, setChatFiles] = useState<Record<string, File[]>>({});
  useEffect(() => { setChatFiles({}); }, [projectId]);
  const [chatSending, setChatSending] = useState<Record<string, boolean>>({});
  const [chatStatuses, setChatStatuses] = useState<Record<string, { type: 'success' | 'error'; text: string } | null>>({});

  // Worktree & node context menus, actions and dialog state
  const [worktreeContextMenu, setWorktreeContextMenu] = useState<{ x: number; y: number; worktree: Node } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; node: Node } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement>(null);

  const deleteWorktreeConfirmation = useConfirmationState<Node>();
  const [isDeletingWorktree, setIsDeletingWorktree] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const closeAgentTabConfirmation = useConfirmationState<Node>();
  const [isClosingAgentTab, setIsClosingAgentTab] = useState(false);
  const [closeTabError, setCloseTabError] = useState<string | null>(null);

  const renameConfirmation = useConfirmationState<Node>();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const addAgentConfirmation = useConfirmationState<Node>();
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [createAgentError, setCreateAgentError] = useState<string | null>(null);

  useEffect(() => {
    if (!worktreeContextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as globalThis.Node)) {
        setWorktreeContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorktreeContextMenu(null);
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [worktreeContextMenu]);

  useEffect(() => {
    if (!nodeContextMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (nodeContextMenuRef.current && !nodeContextMenuRef.current.contains(e.target as globalThis.Node)) {
        setNodeContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNodeContextMenu(null);
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [nodeContextMenu]);

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

  // Worktree agent vertical order state (persisted per worktree/project)
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
  const draggingMemberRef = useRef(draggingMember);
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
      setDraggingMember(null);
      setDropTargetMember(null);
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
    if ((!text && !chatFiles[nodeId]?.length) || chatSending[nodeId]) return;

    setChatSending((prev) => ({ ...prev, [nodeId]: true }));
    setChatStatuses((prev) => ({ ...prev, [nodeId]: null }));

    try {
      const res = await sendNodeMessage(projectId, nodeId, text, undefined, chatFiles[nodeId] || []);
      if (res.ok) {
        setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'success', text: 'Sent!' } }));
        setChatMessages((prev) => ({ ...prev, [nodeId]: '' }));
        setChatFiles((prev) => ({ ...prev, [nodeId]: [] }));
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
  }, [projectId, chatMessages, chatFiles, chatSending]);

  const handleDragOver = useCallback((e: React.DragEvent, nodeId: string) => {
    if (isDraggingGitHubItem || e.dataTransfer.types.includes('application/json') || e.dataTransfer.types.includes('Files')) {
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

    if (e.dataTransfer.files.length) {
      if (chatSending[nodeId]) return;
      const files = [...(chatFiles[nodeId] || []), ...Array.from(e.dataTransfer.files)];
      const error = validateMessageFiles(files);
      closePreview();
      setChatOpenNodeId(nodeId);
      if (error) setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: error } }));
      else setChatFiles((prev) => ({ ...prev, [nodeId]: files }));
      return;
    }

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
  }, [draggedItem, closePreview, chatFiles, chatSending]);

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
        <MessageAttachments files={chatFiles[node.id] || []} disabled={isSending}
          onChange={(files) => setChatFiles((prev) => ({ ...prev, [node.id]: files }))}
          renderControls={(attachButton) => (<div className="node-card-chat-actions">
          {attachButton}
          {status && (
            <span
              className={`font-mono text-xs font-semibold ${
                status.type === 'error' ? 'text-danger' : 'text-success'
              }`}
            >
              {status.text}
            </span>
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
              disabled={isSending || (!currentMsg.trim() && !chatFiles[node.id]?.length)}
            >
              {isSending ? (
                <span>Sending…</span>
              ) : (
                <>
                  <Icon name="send" size={12} />
                  <span>Send</span>
                </>
              )}
            </button>
          </div>
        </div>)}>
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
        />
        </MessageAttachments>
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
  useLayoutEffect(() => {
    if (chatOpenNodeId) {
      elementRefs.current.get(chatOpenNodeId)?.querySelector('textarea')?.focus({ preventScroll: true });
    }
  }, [chatOpenNodeId]);

  // 1. Separate orchestrators, worktrees, and member agents. Filter out terminals completely.
  const { orchestrators, worktrees, worktreeAgentsMap, unassignedAgents } = useMemo(() => {
    const validNodes = nodes.filter((n) => n.kind !== 'terminal');
    const orchestrators: Node[] = [];
    const worktrees: Node[] = [];
    const allAgents: Node[] = [];

    for (const n of validNodes) {
      if (n.kind === 'orchestrator') {
        if (orchestrationSeparated) {
          orchestrators.push(n);
        } else {
          allAgents.push(n);
        }
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
        if (!orchestrationSeparated && ag.kind === 'orchestrator' && worktrees.length > 0) {
          worktreeAgentsMap.get(worktrees[0].id)!.push(ag);
        } else {
          unassignedAgents.push(ag);
        }
      }
    }

    return { orchestrators, worktrees, worktreeAgentsMap, unassignedAgents };
  }, [nodes, edges, orchestrationSeparated]);

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

    const boxes: LayoutBox[] = [];
    const flowPositions = new Map<string, { x: number; y: number }>();
    elementRefs.current.forEach((element, id) => {
      if (!element.isConnected) return;
      const worktree = element.closest('.worktree-box-container');
      if (worktree && worktree !== element && !worktree.classList.contains('unassigned-box-container')) return;
      const group = element.closest('.orchestrator-group') || element;
      const rect = group.getBoundingClientRect();
      const correction = collisionOffsetsRef.current[id] || { x: 0, y: 0 };
      const flow = { x: rect.left - containerRect.left + scrollLeft - correction.x,
        y: rect.top - containerRect.top + scrollTop - correction.y };
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
      setCollisionOffsets((previous) => Object.keys(previous).length === Object.keys(corrections).length &&
        Object.entries(corrections).every(([id, value]) => previous[id] &&
          Math.abs(previous[id].x - value.x) < 0.5 && Math.abs(previous[id].y - value.y) < 0.5)
        ? previous : corrections);
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
  }, []);

  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      measurePositions();
    });
  }, [measurePositions]);

  const getOrderedMembers = useCallback((worktreeId: string, rawMembers: Node[]) => {
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
  }, [worktreeMemberOrder]);

  const isValidReorder = useCallback((
    membersList: Node[],
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ) => {
    if (draggedId === targetId) return false;
    const ids = membersList.map((m) => m.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return false;

    if (position === 'before' && toIdx === fromIdx + 1) return false;
    if (position === 'after' && toIdx === fromIdx - 1) return false;

    return true;
  }, []);

  const handleReorderMember = useCallback((
    worktreeId: string,
    draggedAgentId: string,
    targetAgentId: string,
    position: 'before' | 'after'
  ) => {
    if (draggedAgentId === targetAgentId) return;
    const rawMembers = worktreeAgentsMap.get(worktreeId) || [];
    const currentOrdered = getOrderedMembers(worktreeId, rawMembers);
    const ids = currentOrdered.map((m) => m.id);

    const fromIdx = ids.indexOf(draggedAgentId);
    if (fromIdx === -1) return;

    const newIds = [...ids];
    newIds.splice(fromIdx, 1);
    const insertIdx = newIds.indexOf(targetAgentId);
    if (insertIdx === -1) return;

    if (position === 'after') {
      newIds.splice(insertIdx + 1, 0, draggedAgentId);
    } else {
      newIds.splice(insertIdx, 0, draggedAgentId);
    }

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
  }, [worktreeAgentsMap, getOrderedMembers, projectId, scheduleUpdate]);

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
  }, [projectId, nodeOffsets, scheduleUpdate]);

  const handleConfirmDeleteWorktree = useCallback(async () => {
    const wt = deleteWorktreeConfirmation.data;
    if (!projectId || !wt) return;
    setIsDeletingWorktree(true);
    setDeleteError(null);
    try {
      await deleteWorktree(projectId, wt.id);
      deleteWorktreeConfirmation.close();
      scheduleUpdate();
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete worktree');
    } finally {
      setIsDeletingWorktree(false);
    }
  }, [projectId, deleteWorktreeConfirmation, scheduleUpdate]);

  const handleConfirmCloseAgentTab = useCallback(async () => {
    const node = closeAgentTabConfirmation.data;
    if (!projectId || !node) return;
    setIsClosingAgentTab(true);
    setCloseTabError(null);
    try {
      await closeAgentTab(projectId, node.id);
      closeAgentTabConfirmation.close();
      scheduleUpdate();
    } catch (err: any) {
      setCloseTabError(err.message || 'Failed to close agent tab');
    } finally {
      setIsClosingAgentTab(false);
    }
  }, [projectId, closeAgentTabConfirmation, scheduleUpdate]);

  const handleConfirmRename = useCallback(async (newTitle: string) => {
    const node = renameConfirmation.data;
    if (!projectId || !node) return;
    setIsRenaming(true);
    setRenameError(null);
    try {
      await renameNodeTitle(projectId, node.id, newTitle);
      renameConfirmation.close();
      scheduleUpdate();
    } catch (err: any) {
      setRenameError(err.message || 'Failed to rename tab title');
    } finally {
      setIsRenaming(false);
    }
  }, [projectId, renameConfirmation, scheduleUpdate]);

  const handleConfirmCreateAgent = useCallback(async (command: string, title?: string) => {
    const wt = addAgentConfirmation.data;
    if (!projectId || !wt) return;
    setIsCreatingAgent(true);
    setCreateAgentError(null);
    try {
      await createWorktreeAgent(projectId, wt.id, command, title);
      addAgentConfirmation.close();
      scheduleUpdate();
    } catch (err: any) {
      setCreateAgentError(err.message || 'Failed to create agent');
    } finally {
      setIsCreatingAgent(false);
    }
  }, [projectId, addAgentConfirmation, scheduleUpdate]);

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

    const draggedElement = elementRefs.current.get(id);
    const boundedElement = draggedElement?.matches('.worktree-box-container')
      ? draggedElement : draggedElement?.closest<HTMLElement>('.orchestrator-group');
    const canvas = containerRef.current;
    const anchor = layoutAnchorsRef.current.get(id);
    const rect = (boundedElement || draggedElement)?.getBoundingClientRect();
    const currentOffset = anchor && rect && canvas ? {
      x: rect.left - canvas.getBoundingClientRect().left + canvas.scrollLeft - anchor.x,
      y: rect.top - canvas.getBoundingClientRect().top + canvas.scrollTop - anchor.y,
    } : nodeOffsets[id] || { x: 0, y: 0 };
    setNodeOffsets((previous) => ({ ...previous, [id]: currentOffset }));
    const minimumX = boundedElement && canvas
      ? currentOffset.x - (boundedElement.getBoundingClientRect().left - canvas.getBoundingClientRect().left - canvas.clientLeft + canvas.scrollLeft)
      : -Infinity;
    const minimumY = boundedElement && canvas
      ? currentOffset.y - (boundedElement.getBoundingClientRect().top - canvas.getBoundingClientRect().top - canvas.clientTop + canvas.scrollTop)
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
  }, [closePreview, nodeOffsets, projectId, scheduleUpdate]);

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
      const deltaY = prevTop - nextTop;

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
  }, [worktreeMemberOrder, nodeOffsets, prefersReducedMotion, scheduleUpdate]);

  useLayoutEffect(() => {
    measurePositions();
  }, [nodes, edges, orchestrators, worktrees, worktreeAgentsMap, unassignedAgents, nodeOffsets, collisionOffsets, chatOpenNodeId, measurePositions]);

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
      <ConfirmationDialog
        isOpen={resetConfirmation.present}
        isClosing={resetConfirmation.closing}
        title="Reset layout?"
        description="Return cards and worktrees in this project to their default positions. Your saved layout will be cleared."
        confirmLabel="Reset layout"
        confirmVariant="danger"
        onConfirm={() => {
          handleResetLayout();
          resetConfirmation.close();
        }}
        onClose={resetConfirmation.close}
      />

      <ConfirmationDialog
        isOpen={deleteWorktreeConfirmation.present}
        isClosing={deleteWorktreeConfirmation.closing}
        title="Delete Worktree?"
        description={
          <>
            Are you sure you want to delete worktree <strong>{deleteWorktreeConfirmation.data?.label}</strong>? This will remove the worktree from Orca and git.
          </>
        }
        confirmLabel="Delete Worktree"
        confirmVariant="danger"
        isConfirming={isDeletingWorktree}
        error={deleteError}
        onConfirm={handleConfirmDeleteWorktree}
        onClose={() => {
          deleteWorktreeConfirmation.close();
          setDeleteError(null);
        }}
      />

      <ConfirmationDialog
        isOpen={closeAgentTabConfirmation.present}
        isClosing={closeAgentTabConfirmation.closing}
        title="Close Agent Tab?"
        description={
          <>
            Are you sure you want to close the terminal tab for agent <strong>{closeAgentTabConfirmation.data?.label}</strong>? This will terminate the running session.
          </>
        }
        confirmLabel="Close Tab"
        confirmVariant="danger"
        isConfirming={isClosingAgentTab}
        error={closeTabError}
        onConfirm={handleConfirmCloseAgentTab}
        onClose={() => {
          closeAgentTabConfirmation.close();
          setCloseTabError(null);
        }}
      />

      <RenameDialog
        isOpen={renameConfirmation.present}
        isClosing={renameConfirmation.closing}
        initialTitle={renameConfirmation.data?.label || ''}
        isRenaming={isRenaming}
        error={renameError}
        onRename={handleConfirmRename}
        onClose={() => {
          renameConfirmation.close();
          setRenameError(null);
        }}
      />

      <AddAgentDialog
        isOpen={addAgentConfirmation.present}
        isClosing={addAgentConfirmation.closing}
        worktreeName={addAgentConfirmation.data?.label || ''}
        isCreating={isCreatingAgent}
        error={createAgentError}
        onCreate={handleConfirmCreateAgent}
        onClose={() => {
          addAgentConfirmation.close();
          setCreateAgentError(null);
        }}
      />

      {worktreeContextMenu && (
        <div
          ref={contextMenuRef}
          className="worktree-context-menu"
          style={{
            left: Math.min(worktreeContextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 190),
            top: Math.min(worktreeContextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 600) - 140),
          }}
          role="menu"
          aria-label="Worktree actions"
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              const wt = worktreeContextMenu.worktree;
              setWorktreeContextMenu(null);
              addAgentConfirmation.open(wt);
            }}
          >
            <Icon name="plus" size={14} />
            <span>Add New Agent</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              const wt = worktreeContextMenu.worktree;
              setWorktreeContextMenu(null);
              onSelectNode(wt.id);
            }}
          >
            <Icon name="search" size={14} />
            <span>Inspect Worktree</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item context-menu-item-danger"
            onClick={() => {
              const wt = worktreeContextMenu.worktree;
              setWorktreeContextMenu(null);
              deleteWorktreeConfirmation.open(wt);
            }}
          >
            <Icon name="trash" size={14} />
            <span>Delete Worktree</span>
          </button>
        </div>
      )}

      {nodeContextMenu && (
        <div
          ref={nodeContextMenuRef}
          className="worktree-context-menu node-context-menu"
          style={{
            left: Math.min(nodeContextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 190),
            top: Math.min(nodeContextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 600) - 140),
          }}
          role="menu"
          aria-label="Agent actions"
        >
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              const n = nodeContextMenu.node;
              setNodeContextMenu(null);
              setChatOpenNodeId(n.id);
            }}
          >
            <Icon name="message-square" size={14} />
            <span>Send Message</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            onClick={() => {
              const n = nodeContextMenu.node;
              setNodeContextMenu(null);
              renameConfirmation.open(n);
            }}
          >
            <Icon name="edit" size={14} />
            <span>Rename Title</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item context-menu-item-danger"
            onClick={() => {
              const n = nodeContextMenu.node;
              setNodeContextMenu(null);
              closeAgentTabConfirmation.open(n);
            }}
          >
            <Icon name="trash" size={14} />
            <span>Close Agent Tabs</span>
          </button>
        </div>
      )}
      {projectId && !selectedNodeId && !draggingNodeId && !isCanvasPanning && !isDraggingGitHubItem && preview && nodes.some((node) => node.id === preview.nodeId) &&
        <NodeMessagePreview key={`${projectId}:${runId}:${preview.nodeId}`} projectId={projectId} runId={runId}
          nodeId={preview.nodeId} anchor={preview.anchor} onLeave={closePreview} />}
      {/* Graph Toolbar */}
      <div className="graph-toolbar">
        <div className="toolbar-title-group">
          <h2 className="graph-title">Workflow Topology</h2>
          <span className="node-count-badge font-mono">
            {orchestrationSeparated ? `${orchestrators.length} Orchestrator${orchestrators.length === 1 ? '' : 's'} • ` : ''}{worktrees.length} Worktree{worktrees.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="graph-toolbar-actions">
          {(Object.keys(nodeOffsets).length > 0 || Object.keys(worktreeMemberOrder).length > 0) && (
            <button
              type="button"
              className="btn btn-secondary btn-xs btn-reset-layout"
              onClick={() => { closePreview(); resetConfirmation.open(); }}
              title="Reset repositioned cards and worktrees to default layout"
              aria-label="Reset repositioned cards and worktrees to default layout"
            >
              <Icon name="rotate-ccw" size={12} />
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
              {loading
                ? (orchestrationSeparated ? 'Reading project worktrees, orchestrators, and agents.' : 'Reading project worktrees and agents.')
                : (orchestrationSeparated ? 'No active worktrees, orchestrators, or agents found for this project snapshot.' : 'No active worktrees or agents found for this project snapshot.')}
            </div>
          </div>
        ) : (
          <div className="sketch-graph-layout" ref={layoutRef}>
            {/* LEFT COLUMN: Orchestrator Lane */}
            {orchestrationSeparated && (
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
                    const offset = effectiveOffsets[orch.id];
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
                            e.stopPropagation();
                            setWorktreeContextMenu(null);
                            setNodeContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              node: orch,
                            });
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
            )}

            {/* RIGHT COLUMN: Worktree Containers Lane */}
            <div className="worktrees-lane">
              {worktrees.map((wt) => {
                const members = getOrderedMembers(wt.id, worktreeAgentsMap.get(wt.id) ?? []);
                const isSelected = wt.id === selectedNodeId;

                return (
                  <div
                    key={wt.id}
                    ref={(el) => registerRef(wt.id, el)}
                    className={`worktree-box-container ${isSelected ? 'worktree-selected' : ''} ${
                      draggingNodeId === wt.id ? 'is-dragging-node' : ''
                    }`}
                    style={
                      effectiveOffsets[wt.id]
                        ? { transform: `translate(${effectiveOffsets[wt.id].x}px, ${effectiveOffsets[wt.id].y}px)` }
                        : undefined
                    }
                    aria-label={`Worktree container: ${wt.label}`}
                    onContextMenu={(e) => {
                      if ((e.target as HTMLElement).closest('.agent-card, .node-card-chat-extension, button, input, textarea')) {
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      setWorktreeContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        worktree: wt,
                      });
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
                        if (dropTargetMember?.worktreeId === wt.id) {
                          setDropTargetMember(null);
                        }
                      }
                    }}
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

                      <div className="worktree-header-actions" style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={() => addAgentConfirmation.open(wt)}
                          aria-label={`Add new agent in ${wt.label}`}
                          title="Add new agent"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                        >
                          <Icon name="plus" size={12} />
                          <span>Add Agent</span>
                        </button>
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
                    <div
                      className="worktree-agents-stack"
                      onDragOver={(e) => {
                        if (isDraggingGitHubItem) return;
                        if (draggingMember && draggingMember.worktreeId === wt.id) {
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'move';
                          const rect = e.currentTarget.getBoundingClientRect();
                          const firstMember = members[0];
                          const lastMember = members[members.length - 1];
                          if (members.length > 0) {
                            if (e.clientY < rect.top + 20 && firstMember && firstMember.id !== draggingMember.agentId) {
                              setDropTargetMember({
                                worktreeId: wt.id,
                                agentId: firstMember.id,
                                position: 'before',
                              });
                            } else if (e.clientY > rect.bottom - 20 && lastMember && lastMember.id !== draggingMember.agentId) {
                              setDropTargetMember({
                                worktreeId: wt.id,
                                agentId: lastMember.id,
                                position: 'after',
                              });
                            }
                          }
                        }
                      }}
                      onDrop={(e) => {
                        if (isDraggingGitHubItem) return;
                        if (draggingMember && draggingMember.worktreeId === wt.id && dropTargetMember) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleReorderMember(wt.id, draggingMember.agentId, dropTargetMember.agentId, dropTargetMember.position);
                          setDraggingMember(null);
                          setDropTargetMember(null);
                        }
                      }}
                    >
                      {members.length === 0 ? (
                        <div className="worktree-empty-agents text-xs text-muted">
                          No member agents in this worktree
                        </div>
                      ) : (
                        members.map((ag) => {
                          const draggedNode = draggingMember ? nodeMap.get(draggingMember.agentId) : null;
                          const isAgSelected = ag.id === selectedNodeId;
                          const isDraggingThis = draggingMember?.agentId === ag.id;
                          const isDropTargetBefore = dropTargetMember?.worktreeId === wt.id && dropTargetMember?.agentId === ag.id && dropTargetMember?.position === 'before';
                          const isDropTargetAfter = dropTargetMember?.worktreeId === wt.id && dropTargetMember?.agentId === ag.id && dropTargetMember?.position === 'after';

                          const showPreviewBefore = Boolean(isDropTargetBefore && draggingMember && draggedNode && isValidReorder(members, draggingMember.agentId, ag.id, 'before'));
                          const showPreviewAfter = Boolean(isDropTargetAfter && draggingMember && draggedNode && isValidReorder(members, draggingMember.agentId, ag.id, 'after'));

                          return (
                            <React.Fragment key={ag.id}>
                              {showPreviewBefore && (
                                <div key={`drop-preview-before-${ag.id}`} className="worktree-drop-preview-slot" aria-hidden="true">
                                  <div className="worktree-drop-preview-card">
                                    <div className="node-card-top">
                                      <div className="agent-title-row">
                                        <span className="drag-grip-icon" aria-hidden="true">⋮⋮</span>
                                        <ProviderIcon provider={draggedNode?.agentType} size={15} />
                                        <span className="agent-label font-semibold">{draggedNode?.label}</span>
                                      </div>
                                      <span className="node-badge-state preview-pill">
                                        <Icon name="arrow-up" size={10} />
                                        <span>Move here</span>
                                      </span>
                                    </div>
                                    <div className="preview-hint-text font-mono text-xs">
                                      Drop to position before {ag.label}
                                    </div>
                                  </div>
                                </div>
                              )}

                              <div
                                role="button"
                                tabIndex={0}
                                {...previewEvents(ag)}
                                ref={(el) => registerRef(ag.id, el)}
                                draggable={!chatOpenNodeId}
                                onDragStart={(e) => {
                                  if (isDraggingGitHubItem || chatOpenNodeId) return;
                                  e.stopPropagation();
                                  e.dataTransfer.setData('text/plain', ag.id);
                                  e.dataTransfer.setData('application/orca-agent-id', ag.id);
                                  e.dataTransfer.setData('application/orca-worktree-id', wt.id);
                                  e.dataTransfer.effectAllowed = 'move';
                                  requestAnimationFrame(() => {
                                    setDraggingMember({ worktreeId: wt.id, agentId: ag.id });
                                  });
                                }}
                                onDragOver={(e) => {
                                  if (isDraggingGitHubItem) {
                                    handleDragOver(e, ag.id);
                                    return;
                                  }
                                  if (draggingMember && draggingMember.worktreeId === wt.id && draggingMember.agentId !== ag.id) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.dataTransfer.dropEffect = 'move';
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midY = rect.top + rect.height / 2;
                                    const position = e.clientY < midY ? 'before' : 'after';
                                    setDropTargetMember({
                                      worktreeId: wt.id,
                                      agentId: ag.id,
                                      position,
                                    });
                                  }
                                }}
                                onDragLeave={(e) => {
                                  if (isDraggingGitHubItem) {
                                    handleDragLeave(e, ag.id);
                                    return;
                                  }
                                  if (!e.currentTarget.parentElement?.contains(e.relatedTarget as globalThis.Node)) {
                                    setDropTargetMember(null);
                                  }
                                }}
                                onDrop={(e) => {
                                  if (isDraggingGitHubItem) {
                                    handleDrop(e, ag.id);
                                    return;
                                  }
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (draggingMember && draggingMember.worktreeId === wt.id && draggingMember.agentId !== ag.id && dropTargetMember) {
                                    handleReorderMember(wt.id, draggingMember.agentId, ag.id, dropTargetMember.position);
                                  }
                                  setDraggingMember(null);
                                  setDropTargetMember(null);
                                }}
                                onDragEnd={() => {
                                  setDraggingMember(null);
                                  setDropTargetMember(null);
                                }}
                                className={`graph-node-card agent-card node-draggable state-${ag.state} ${
                                  isAgSelected ? 'node-selected' : ''
                                } ${ag.stale ? 'node-stale' : ''} ${
                                  isDraggingGitHubItem ? 'node-drag-target-glow' : ''
                                } ${dropHoverNodeId === ag.id ? 'node-drop-hover' : ''} ${
                                  chatOpenNodeId === ag.id ? 'node-chat-extended' : ''
                                } ${isDraggingThis ? 'is-member-dragging' : ''} ${
                                  isDropTargetBefore ? 'drop-before' : ''
                                } ${isDropTargetAfter ? 'drop-after' : ''}`}
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
                                  e.stopPropagation();
                                  setWorktreeContextMenu(null);
                                  setNodeContextMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    node: ag,
                                  });
                                }}
                                aria-pressed={isAgSelected}
                                aria-label={`Agent: ${ag.label}, state: ${ag.state}, liveness: ${ag.liveness}`}
                              >
                                <div className="node-card-top">
                                  <div className="agent-title-row">
                                    <span className="drag-grip-icon" title="Drag up or down to reorder agent in worktree" aria-hidden="true">⋮⋮</span>
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

                              {showPreviewAfter && (
                                <div key={`drop-preview-after-${ag.id}`} className="worktree-drop-preview-slot" aria-hidden="true">
                                  <div className="worktree-drop-preview-card">
                                    <div className="node-card-top">
                                      <div className="agent-title-row">
                                        <span className="drag-grip-icon" aria-hidden="true">⋮⋮</span>
                                        <ProviderIcon provider={draggedNode?.agentType} size={15} />
                                        <span className="agent-label font-semibold">{draggedNode?.label}</span>
                                      </div>
                                      <span className="node-badge-state preview-pill">
                                        <Icon name="arrow-down" size={10} />
                                        <span>Move here</span>
                                      </span>
                                    </div>
                                    <div className="preview-hint-text font-mono text-xs">
                                      Drop to position after {ag.label}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </React.Fragment>
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
                            effectiveOffsets[ag.id]
                              ? { transform: `translate(${effectiveOffsets[ag.id].x}px, ${effectiveOffsets[ag.id].y}px)` }
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
                            e.stopPropagation();
                            setWorktreeContextMenu(null);
                            setNodeContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              node: ag,
                            });
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
