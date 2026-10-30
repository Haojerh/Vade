import React, { useRef, useState, useMemo, useCallback } from 'react';
import type { Node, Edge, Project, Subagent } from '../../../../shared/contracts';
import { WorkflowZoomControls } from './WorkflowZoomControls';
import { NodeMessagePreview } from '../node-details/NodeMessagePreview';
import { compareWorkflowNodes } from './workflowOrder';
import { runProjectShortcutRequest } from '../../../api/client';
import { deduplicateWorkflowEdges, WorkflowEdgesSvg } from './WorkflowEdgesSvg';
import { WorktreeBox } from './WorktreeBox';
import { usePrefersReducedMotion, useWorkflowCanvas } from '../../../hooks/workflow/useWorkflowCanvas';
import { useWorktreeMemberOrder } from '../../../hooks/workflow/useWorktreeMemberOrder';
import { useWorkflowOverlays, WorkflowOverlays } from './WorkflowOverlays';
import { useLiveGraphActivity } from '../../../hooks/workflow/useLiveGraphActivity';
import { ToolActivityOverlay } from '../chat/ToolActivityOverlay';
import { SubagentDetailsDialog } from '../chat/SubagentTray';
import type { KanbanCard } from '../../kanban/kanban';
import type { HistoryDrag } from '../../agents/historyDrag';
import { buildGitHubPrompt, type DraggedGitHubItem } from './githubDragPrompt';
import { useWorkflowNodeChat } from '../../../hooks/workflow/useWorkflowNodeChat';
import { WorkflowGraphToolbar } from './WorkflowGraphToolbar';
import { OrchestratorLane } from './OrchestratorLane';
import { UnassignedAgentsBox } from './UnassignedAgentsBox';

export { buildGitHubPrompt, type DraggedGitHubItem };

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
  onResumeHistory?: (id: string, worktreeId: string) => Promise<string>;
  historyDrag?: HistoryDrag | null;
  onDropKanbanCard?: (cardId: string, node: Node) => KanbanCard | undefined;
  onSendKanbanCard?: (cardId: string, node: Node, message: string, files: File[]) => Promise<{ ok: boolean; message?: string }>;
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
  onResumeHistory,
  historyDrag,
  onDropKanbanCard,
  onSendKanbanCard,
}) => {
  const [shortcutDrag, setShortcutDrag] = useState<HistoryDrag | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const { tools, packets, holdTool } = useLiveGraphActivity(`${projectId}:${runId}`, nodes, edges, toolActivityEnabled && !isLocallyStale);
  const [preview, setPreview] = useState<{ nodeId: string; anchor: HTMLElement; subagent?: Subagent } | null>(null);
  const [openSubagent, setOpenSubagent] = useState<{ nodeId: string; subagent: Subagent } | null>(null);
  const suppressPreviewRef = useRef(false);
  const closePreview = useCallback(() => setPreview(null), []);

  // Keep owned terminals in the same worktree layout as agents.
  const { orchestrators, worktrees, worktreeAgentsMap, unassignedAgents } = useMemo(() => {
    const validNodes = nodes;
    const orchestrators: Node[] = [];
    const worktrees: Node[] = [];
    const allAgents: Node[] = [];

    for (const n of validNodes) {
      if (n.kind === 'orchestrator' || n.workflow?.role === 'orchestrator') {
        if (orchestrationSeparated) {
          orchestrators.push(n);
        } else {
          allAgents.push(n);
        }
      } else if (n.kind === 'worktree') {
        worktrees.push(n);
      } else if (n.kind === 'agent' || n.kind === 'terminal') {
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
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  const deduplicatedEdges = useMemo(
    () => deduplicateWorkflowEdges(edges, nodeMap, isLocallyStale),
    [edges, nodeMap, isLocallyStale]
  );

  const draggingMemberRef = useRef<{ worktreeId: string; agentId: string } | null>(null);
  const [chatOpenNodeIdState, setChatOpenNodeIdState] = useState<string | null>(null);

  const {
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
  } = useWorkflowCanvas({
    projectId,
    nodes,
    edges,
    orchestrators,
    worktrees,
    worktreeAgentsMap,
    unassignedAgents,
    chatOpenNodeId: chatOpenNodeIdState,
    draggingMemberRef,
    closePreview,
    suppressPreviewRef,
    ready: !loading && !isLocallyStale,
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
    zoom,
  });

  const {
    isDraggingGitHubItem,
    dropHoverNodeId,
    chatOpenNodeId,
    setChatOpenNodeId,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    renderChatExtension,
  } = useWorkflowNodeChat({
    projectId,
    nodes,
    onSelectNode,
    closePreview,
    setDraggingMember,
    setDropTargetMember,
    onDropKanbanCard,
    onSendKanbanCard,
  });

  React.useEffect(() => {
    setChatOpenNodeIdState(chatOpenNodeId);
  }, [chatOpenNodeId]);

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
      setPreview((current) => (current?.nodeId === nodeId && !current.subagent ? current : { nodeId, anchor }));
    },
    [draggingNodeId, isCanvasPanning, isDraggingGitHubItem, chatOpenNodeId]
  );

  /** A child card previews that child's own newest reply, never its parent's. */
  const showSubagentPreview = useCallback(
    (nodeId: string, subagent: Subagent, anchor: HTMLElement) => {
      if (draggingNodeId || isCanvasPanning || isDraggingGitHubItem || chatOpenNodeId || suppressPreviewRef.current) return;
      setPreview((current) => (current?.nodeId === nodeId && current.subagent?.id === subagent.id && current.anchor === anchor
        ? current : { nodeId, anchor, subagent }));
    },
    [draggingNodeId, isCanvasPanning, isDraggingGitHubItem, chatOpenNodeId]
  );

  const previewEvents = (node: Node) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      // Child cards own their own preview; the parent must not claim these pointers.
      if ((event.target as HTMLElement).closest('.node-subagent-card')) return;
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
      if ((event.target as HTMLElement).closest('.node-subagent-card')) return;
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
      if (event.relatedTarget instanceof Element
        && (event.relatedTarget.closest('.node-message-preview') || event.relatedTarget.closest('.node-subagent-card'))) return;
      closePreview();
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (
        chatOpenNodeId ||
        (event.target as HTMLElement).closest('.node-card-chat-extension') ||
        (event.target as HTMLElement).closest('.node-subagent-card') ||
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
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.node-subagent-card')) return;
      closePreview();
    },
    onPointerDown: closePreview,
    'aria-describedby': preview?.nodeId === node.id ? 'node-message-preview' : undefined,
  });

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
            key={`${projectId}:${runId}:${preview.nodeId}:${preview.subagent?.id ?? ''}`}
            projectId={projectId}
            runId={runId}
            nodeId={preview.nodeId}
            subagent={preview.subagent ?? null}
            anchor={preview.anchor}
            onLeave={closePreview}
          />
        )}

      <WorkflowGraphToolbar
        projectId={projectId}
        nodes={nodes}
        selectedNodeId={selectedNodeId}
        canAddWorktree={overlays.canAddWorktree}
        hasCustomLayout={Object.keys(nodeOffsets).length > 0 || Object.keys(worktreeMemberOrder).length > 0}
        onSelectNode={onSelectNode}
        onRefresh={onRefresh}
        onDragShortcut={setShortcutDrag}
        onAddWorktree={() => {
          closePreview();
          overlays.addWorktreeConfirmation.open();
        }}
        onResetLayout={() => {
          closePreview();
          overlays.resetConfirmation.open();
        }}
      />

      {/* Main Canvas Container */}
      <div
        className={`graph-canvas-container ${isCanvasPanning ? 'is-canvas-panning' : ''}`}
        ref={containerRef}
        onPointerDown={handleCanvasPointerDown}
      >
        <div className="workflow-zoom-extent" style={{ width: canvasSize.width * zoom, height: canvasSize.height * zoom }}>
        <div className="workflow-zoom-content" ref={contentRef} style={{ width: canvasSize.width || '100%', minHeight: canvasSize.height, transform: `scale(${zoom})` }}>
        <WorkflowEdgesSvg
          edges={deduplicatedEdges}
          positions={positions}
          nodeMap={nodeMap}
          canvasSize={canvasSize}
          prefersReducedMotion={prefersReducedMotion}
          packets={isLocallyStale ? [] : packets}
        />
        <ToolActivityOverlay tools={isLocallyStale ? [] : tools} positions={positions} reducedMotion={prefersReducedMotion} canvasWidth={(containerRef.current?.clientWidth || canvasSize.width) / zoom} nodes={nodes} onHold={holdTool} />

        {nodes.length === 0 ? (
          <div className="graph-empty-state">
            <div className="empty-title" role="status">
              {!projectId ? 'Add your first repository' : loading ? 'Loading Workflow Nodes…' : 'No Workflow Nodes Discovered'}
            </div>
            <div className="empty-description">
              {!projectId ? 'Open Projects and add the absolute path of a local Git repository to start.' : loading
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
              <OrchestratorLane
                orchestrators={orchestrators}
                selectedNodeId={selectedNodeId}
                draggingNodeId={draggingNodeId}
                effectiveOffsets={effectiveOffsets}
                isDraggingGitHubItem={isDraggingGitHubItem}
                dropHoverNodeId={dropHoverNodeId}
                chatOpenNodeId={chatOpenNodeId}
                justDraggedNodeRef={justDraggedNodeRef}
                registerRef={registerRef}
                previewEvents={previewEvents}
                renderChatExtension={renderChatExtension}
                onSelectNode={onSelectNode}
                onNodeDragStart={handleNodeDragStart}
                onOpenContextMenu={(x, y, node) => {
                  overlays.setWorktreeContextMenu(null);
                  overlays.setNodeContextMenu({ x, y, node });
                }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onOpenSubagent={(nodeId, subagent) => setOpenSubagent({ nodeId, subagent })}
                onSubagentPreview={showSubagentPreview}
                onSubagentPreviewLeave={closePreview}
              />
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
                    onOpenSubagent={(subagent, nodeId) => setOpenSubagent({ nodeId, subagent })}
                    onSubagentPreview={(subagent, anchor, nodeId) => showSubagentPreview(nodeId, subagent, anchor)}
                    onSubagentPreviewLeave={closePreview}
                    isValidReorder={isValidReorder}
                    onSelectNode={onSelectNode}
                    historyDrag={shortcutDrag ?? historyDrag}
                    onResumeHistory={projectId ? async (id, worktreeId, placement) => {
                      let nodeId: string;
                      if (id.startsWith('shortcut:')) {
                        const result = await runProjectShortcutRequest(projectId, id.slice(9), worktreeId);
                        nodeId = result.nodeId; onRefresh?.(); onSelectNode(nodeId);
                        if (!result.staged) throw new Error(result.message);
                      } else {
                        if (!onResumeHistory) throw new Error('History resume unavailable');
                        nodeId = await onResumeHistory(id, worktreeId);
                      }
                      handleReorderMember(worktreeId, nodeId, placement?.targetId ?? '', placement?.position ?? 'after');
                    } : undefined}
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
                <UnassignedAgentsBox
                  unassignedAgents={unassignedAgents}
                  selectedNodeId={selectedNodeId}
                  draggingNodeId={draggingNodeId}
                  effectiveOffsets={effectiveOffsets}
                  isDraggingGitHubItem={isDraggingGitHubItem}
                  dropHoverNodeId={dropHoverNodeId}
                  chatOpenNodeId={chatOpenNodeId}
                  justDraggedNodeRef={justDraggedNodeRef}
                  registerRef={registerRef}
                  previewEvents={previewEvents}
                  renderChatExtension={renderChatExtension}
                  onSelectNode={onSelectNode}
                  onNodeDragStart={handleNodeDragStart}
                  onOpenContextMenu={(x, y, node) => {
                    overlays.setWorktreeContextMenu(null);
                    overlays.setNodeContextMenu({ x, y, node });
                  }}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onOpenSubagent={(nodeId, subagent) => setOpenSubagent({ nodeId, subagent })}
                  onSubagentPreview={showSubagentPreview}
                  onSubagentPreviewLeave={closePreview}
                />
              )}
            </div>
          </div>
        )}
        </div>
        </div>
      </div>
      <WorkflowZoomControls zoom={zoom} onChange={changeZoom} />
      {projectId && <SubagentDetailsDialog projectId={projectId} nodeId={openSubagent?.nodeId ?? ''} provider={nodes.find(node => node.id === openSubagent?.nodeId)?.agentType ?? null}
        subagent={openSubagent?.subagent ?? null} onClose={() => setOpenSubagent(null)} />}
    </section>
  );
};
