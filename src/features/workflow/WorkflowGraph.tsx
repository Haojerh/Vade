import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import type { Node, Edge, Project } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { NodeMessagePreview } from './NodeMessagePreview';
import { compareWorkflowNodes } from './workflowOrder';
import { sendNodeMessage } from '../../api/client';
import { validateMessageFiles } from './MessageAttachments';
import { deduplicateWorkflowEdges, WorkflowEdgesSvg } from './WorkflowEdgesSvg';
import { NodeChatExtension, WorkflowNodeCardBody } from './WorkflowNodeCard';
import { WorktreeBox } from './WorktreeBox';
import { usePrefersReducedMotion, useWorkflowCanvas } from './useWorkflowCanvas';
import { useWorktreeMemberOrder } from './useWorktreeMemberOrder';
import { useWorkflowOverlays, WorkflowOverlays } from './WorkflowOverlays';
import { useLiveGraphActivity } from './useLiveGraphActivity';
import { ToolActivityOverlay } from './ToolActivityOverlay';

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
  toolActivityEnabled?: boolean;
  project?: Project | null;
  onRefresh?: () => void;
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
  toolActivityEnabled = true,
  project,
  onRefresh,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { tools, packets, holdTool } = useLiveGraphActivity(`${projectId}:${runId}`, nodes, edges, toolActivityEnabled && !isLocallyStale);
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
  useEffect(() => {
    setChatFiles({});
  }, [projectId]);
  const [chatSending, setChatSending] = useState<Record<string, boolean>>({});
  const [chatStatuses, setChatStatuses] = useState<Record<string, { type: 'success' | 'error'; text: string } | null>>(
    {}
  );

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
      const parentWtId = containsAgentToWorktree.get(ag.id);
      if (parentWtId && worktreeAgentsMap.has(parentWtId)) {
        worktreeAgentsMap.get(parentWtId)!.push(ag);
        continue;
      }

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

  const nodeMap = useMemo(() => {
    const map = new Map<string, Node>();
    for (const n of nodes) {
      if (n.kind !== 'terminal') {
        map.set(n.id, n);
      }
    }
    return map;
  }, [nodes]);

  const deduplicatedEdges = useMemo(
    () => deduplicateWorkflowEdges(edges, nodeMap, isLocallyStale),
    [edges, nodeMap, isLocallyStale]
  );

  const draggingMemberRef = useRef<{ worktreeId: string; agentId: string } | null>(null);

  const {
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
  } = useWorkflowCanvas({
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
  });

  const {
    worktreeMemberOrder,
    draggingMember,
    setDraggingMember,
    dropTargetMember,
    setDropTargetMember,
    getOrderedMembers,
    isValidReorder,
    handleReorderMember,
    handleResetLayout,
  } = useWorktreeMemberOrder({
    projectId,
    worktreeAgentsMap,
    elementRefs,
    containerRef,
    nodeOffsets,
    setNodeOffsets,
    prefersReducedMotion,
    scheduleUpdate,
    draggingMemberRef,
  });

  const overlays = useWorkflowOverlays({
    projectId,
    project,
    onSelectNode,
    onOpenChat: setChatOpenNodeId,
    onResetLayout: handleResetLayout,
    onRefresh,
    scheduleUpdate,
  });

  const showPreview = useCallback(
    (nodeId: string, anchor: HTMLElement) => {
      if (
        draggingNodeId ||
        isCanvasPanning ||
        isDraggingGitHubItem ||
        chatOpenNodeId ||
        suppressPreviewRef.current
      ) {
        return;
      }
      setPreview((current) => (current?.nodeId === nodeId ? current : { nodeId, anchor }));
    },
    [draggingNodeId, isCanvasPanning, isDraggingGitHubItem, chatOpenNodeId]
  );

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
  }, [setDraggingMember, setDropTargetMember]);

  const closeChat = useCallback((nodeId: string) => {
    setChatOpenNodeId((curr) => (curr === nodeId ? null : curr));
  }, []);

  const handleSendChatMessage = useCallback(
    async (nodeId: string) => {
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
          setChatStatuses((prev) => ({
            ...prev,
            [nodeId]: { type: 'error', text: res.message || 'Failed to send' },
          }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error sending message';
        setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: msg } }));
      } finally {
        setChatSending((prev) => ({ ...prev, [nodeId]: false }));
      }
    },
    [projectId, chatMessages, chatFiles, chatSending]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, nodeId: string) => {
      if (
        isDraggingGitHubItem ||
        e.dataTransfer.types.includes('application/json') ||
        e.dataTransfer.types.includes('Files')
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (dropHoverNodeId !== nodeId) {
          setDropHoverNodeId(nodeId);
        }
      }
    },
    [isDraggingGitHubItem, dropHoverNodeId]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent, nodeId: string) => {
      if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
        if (dropHoverNodeId === nodeId) {
          setDropHoverNodeId(null);
        }
      }
    },
    [dropHoverNodeId]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent, nodeId: string) => {
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
    },
    [draggedItem, closePreview, chatFiles, chatSending]
  );

  const previewEvents = (node: Node) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      if (
        chatOpenNodeId ||
        draggingNodeId ||
        isCanvasPanning ||
        isDraggingGitHubItem ||
        suppressPreviewRef.current
      )
        return;
      if (!selectedNodeId && event.pointerType !== 'touch') showPreview(node.id, event.currentTarget);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      if (
        chatOpenNodeId ||
        selectedNodeId ||
        draggingNodeId ||
        isCanvasPanning ||
        isDraggingGitHubItem ||
        suppressPreviewRef.current ||
        event.pointerType === 'touch'
      ) {
        closePreview();
        return;
      }
      showPreview(node.id, event.currentTarget);
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      if (!selectedNodeId && !draggingNodeId && !isCanvasPanning) suppressPreviewRef.current = false;
      if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.node-message-preview'))
        closePreview();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (
        chatOpenNodeId ||
        (event.target as HTMLElement).closest('.node-card-chat-extension') ||
        draggingNodeId ||
        isCanvasPanning ||
        isDraggingGitHubItem
      )
        return;
      if (!selectedNodeId && !suppressPreviewRef.current) showPreview(node.id, event.currentTarget);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Tab') suppressPreviewRef.current = false;
    },
    onClickCapture: () => {
      suppressPreviewRef.current = true;
      closePreview();
    },
    onBlur: closePreview,
    onPointerDown: closePreview,
    'aria-describedby': preview?.nodeId === node.id ? 'node-message-preview' : undefined,
  });

  const renderChatExtension = (node: Node) => {
    if (chatOpenNodeId !== node.id) return null;
    return (
      <NodeChatExtension
        node={node}
        files={chatFiles[node.id] || []}
        status={chatStatuses[node.id]}
        isSending={Boolean(chatSending[node.id])}
        currentMsg={chatMessages[node.id] || ''}
        onChangeFiles={(files) => setChatFiles((prev) => ({ ...prev, [node.id]: files }))}
        onChangeMessage={(msg) => setChatMessages((prev) => ({ ...prev, [node.id]: msg }))}
        onSendMessage={() => handleSendChatMessage(node.id)}
        onClose={() => closeChat(node.id)}
      />
    );
  };

  return (
    <section
      className="workflow-graph-wrapper"
      aria-label="Workflow relationship graph"
      onContextMenu={(e) => {
        if (
          (e.target as HTMLElement).closest(
            '.worktree-box-container, .agent-card, .node-card, button, input, textarea, dialog, [role="menu"]'
          )
        )
          return;
        e.preventDefault();
        overlays.setWorktreeContextMenu(null);
        overlays.setNodeContextMenu(null);
        overlays.setCanvasMenu({ x: e.clientX, y: e.clientY });
        closePreview();
      }}
    >
      <WorkflowOverlays overlays={overlays} />

      {projectId &&
        !selectedNodeId &&
        !draggingNodeId &&
        !isCanvasPanning &&
        !isDraggingGitHubItem &&
        preview &&
        nodes.some((node) => node.id === preview.nodeId) && (
          <NodeMessagePreview
            key={`${projectId}:${runId}:${preview.nodeId}`}
            projectId={projectId}
            runId={runId}
            nodeId={preview.nodeId}
            anchor={preview.anchor}
            onLeave={closePreview}
          />
        )}

      {/* Graph Toolbar */}
      <div className="graph-toolbar">
        <div className="toolbar-title-group">
          <h2 className="graph-title">Workflow Topology</h2>
          <span className="node-count-badge font-mono">
            {orchestrationSeparated
              ? `${orchestrators.length} Orchestrator${orchestrators.length === 1 ? '' : 's'} • `
              : ''}
            {worktrees.length} Worktree{worktrees.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="graph-toolbar-actions">
          <button
            type="button"
            className="btn btn-secondary btn-xs"
            disabled={!overlays.canAddWorktree}
            onClick={() => {
              closePreview();
              overlays.addWorktreeConfirmation.open();
            }}
            title={
              overlays.canAddWorktree
                ? 'Create a new worktree'
                : 'Select a Git project with one backing repository'
            }
          >
            <Icon name="plus" size={12} />
            <span>Add Worktree</span>
          </button>
          {(Object.keys(nodeOffsets).length > 0 || Object.keys(worktreeMemberOrder).length > 0) && (
            <button
              type="button"
              className="btn btn-secondary btn-xs btn-reset-layout"
              onClick={() => {
                closePreview();
                overlays.resetConfirmation.open();
              }}
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
        <WorkflowEdgesSvg
          edges={deduplicatedEdges}
          positions={positions}
          nodeMap={nodeMap}
          canvasSize={canvasSize}
          prefersReducedMotion={prefersReducedMotion}
          packets={isLocallyStale ? [] : packets}
        />
        <ToolActivityOverlay tools={isLocallyStale ? [] : tools} positions={positions} reducedMotion={prefersReducedMotion} canvasWidth={containerRef.current?.clientWidth || canvasSize.width} nodes={nodes} onHold={holdTool} />

        {nodes.length === 0 ? (
          <div className="graph-empty-state">
            <div className="empty-title" role="status">
              {loading ? 'Loading Workflow Nodes…' : 'No Workflow Nodes Discovered'}
            </div>
            <div className="empty-description">
              {loading
                ? orchestrationSeparated
                  ? 'Reading project worktrees, orchestrators, and agents.'
                  : 'Reading project worktrees and agents.'
                : orchestrationSeparated
                  ? 'No active worktrees, orchestrators, or agents found for this project snapshot.'
                  : 'No active worktrees or agents found for this project snapshot.'}
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
                            offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined
                          }
                        >
                          <div
                            className="lane-header orchestrator-drag-header"
                            onPointerDown={(e) => handleNodeDragStart(orch.id, e)}
                            title="Click and drag to move orchestrator"
                          >
                            <span className="drag-grip-icon" title="Drag to move orchestrator" aria-hidden="true">
                              ⋮⋮
                            </span>
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
                              overlays.setWorktreeContextMenu(null);
                              overlays.setNodeContextMenu({
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
                            <WorkflowNodeCardBody
                              node={orch}
                              gripTitle="Drag to reposition orchestrator"
                              iconSize={16}
                              showPreviewText={true}
                              showStaleTag={false}
                              chatExtension={renderChatExtension(orch)}
                            />
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
                return (
                  <WorktreeBox
                    key={wt.id}
                    worktree={wt}
                    members={members}
                    selectedNodeId={selectedNodeId}
                    draggingNodeId={draggingNodeId}
                    effectiveOffset={effectiveOffsets[wt.id]}
                    isDraggingGitHubItem={isDraggingGitHubItem}
                    dropHoverNodeId={dropHoverNodeId}
                    chatOpenNodeId={chatOpenNodeId}
                    draggingMember={draggingMember}
                    dropTargetMember={dropTargetMember}
                    nodeMap={nodeMap}
                    justDraggedNodeRef={justDraggedNodeRef}
                    registerRef={registerRef}
                    previewEvents={previewEvents}
                    renderChatExtension={renderChatExtension}
                    isValidReorder={isValidReorder}
                    onSelectNode={onSelectNode}
                    onNodeDragStart={handleNodeDragStart}
                    onOpenAddAgent={(worktree) => overlays.addAgentConfirmation.open(worktree)}
                    onOpenWorktreeContextMenu={(x, y, worktree) =>
                      overlays.setWorktreeContextMenu({ x, y, worktree })
                    }
                    onOpenNodeContextMenu={(x, y, node) => {
                      overlays.setWorktreeContextMenu(null);
                      overlays.setNodeContextMenu({ x, y, node });
                    }}
                    onSetDraggingMember={setDraggingMember}
                    onSetDropTargetMember={setDropTargetMember}
                    onReorderMember={handleReorderMember}
                    onGitHubDragOver={handleDragOver}
                    onGitHubDragLeave={handleDragLeave}
                    onGitHubDrop={handleDrop}
                  />
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
                            overlays.setWorktreeContextMenu(null);
                            overlays.setNodeContextMenu({
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
                          <WorkflowNodeCardBody
                            node={ag}
                            gripTitle="Drag to reposition agent"
                            iconSize={15}
                            showPreviewText={false}
                            showStaleTag={false}
                            chatExtension={renderChatExtension(ag)}
                          />
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
