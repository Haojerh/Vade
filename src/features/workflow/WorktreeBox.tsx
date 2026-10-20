import { KANBAN_DRAG_TYPE } from '../kanban/kanban';
import React from 'react';
import type { Node } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { WorkflowNodeCardBody, WorktreeDropPreviewSlot } from './WorkflowNodeCard';

export interface WorktreeBoxProps {
  worktree: Node;
  members: Node[];
  selectedNodeId: string | null;
  draggingNodeId: string | null;
  effectiveOffset: { x: number; y: number } | undefined;
  isDraggingGitHubItem: boolean;
  dropHoverNodeId: string | null;
  chatOpenNodeId: string | null;
  draggingMember: { worktreeId: string; agentId: string } | null;
  dropTargetMember: { worktreeId: string; agentId: string; position: 'before' | 'after' } | null;
  nodeMap: Map<string, Node>;
  justDraggedNodeRef: React.MutableRefObject<boolean>;
  registerRef: (id: string, el: HTMLElement | null) => void;
  previewEvents: (node: Node) => Record<string, any>;
  renderChatExtension: (node: Node) => React.ReactNode;
  isValidReorder: (
    membersList: Node[],
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ) => boolean;
  onSelectNode: (id: string) => void;
  onNodeDragStart: (id: string, e: React.PointerEvent) => void;
  onOpenAddAgent: (worktree: Node) => void;
  onOpenWorktreeContextMenu: (x: number, y: number, worktree: Node) => void;
  onOpenNodeContextMenu: (x: number, y: number, node: Node) => void;
  onSetDraggingMember: (val: { worktreeId: string; agentId: string } | null) => void;
  onSetDropTargetMember: (
    val: { worktreeId: string; agentId: string; position: 'before' | 'after' } | null
  ) => void;
  onReorderMember: (
    worktreeId: string,
    draggedAgentId: string,
    targetAgentId: string,
    position: 'before' | 'after'
  ) => void;
  onGitHubDragOver: (e: React.DragEvent, nodeId: string) => void;
  onGitHubDragLeave: (e: React.DragEvent, nodeId: string) => void;
  onGitHubDrop: (e: React.DragEvent, nodeId: string) => void;
}

export const WorktreeBox: React.FC<WorktreeBoxProps> = ({
  worktree: wt,
  members,
  selectedNodeId,
  draggingNodeId,
  effectiveOffset,
  isDraggingGitHubItem,
  dropHoverNodeId,
  chatOpenNodeId,
  draggingMember,
  dropTargetMember,
  nodeMap,
  justDraggedNodeRef,
  registerRef,
  previewEvents,
  renderChatExtension,
  isValidReorder,
  onSelectNode,
  onNodeDragStart,
  onOpenAddAgent,
  onOpenWorktreeContextMenu,
  onOpenNodeContextMenu,
  onSetDraggingMember,
  onSetDropTargetMember,
  onReorderMember,
  onGitHubDragOver,
  onGitHubDragLeave,
  onGitHubDrop,
}) => {
  const isSelected = wt.id === selectedNodeId;

  return (
    <div
      ref={(el) => registerRef(wt.id, el)}
      className={`worktree-box-container ${isSelected ? 'worktree-selected' : ''} ${
        draggingNodeId === wt.id ? 'is-dragging-node' : ''
      }`}
      style={
        effectiveOffset
          ? { transform: `translate(${effectiveOffset.x}px, ${effectiveOffset.y}px)` }
          : undefined
      }
      aria-label={`Worktree container: ${wt.label}`}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.agent-card, .node-card-chat-extension, button, input, textarea')) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        onOpenWorktreeContextMenu(e.clientX, e.clientY, wt);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
          if (dropTargetMember?.worktreeId === wt.id) {
            onSetDropTargetMember(null);
          }
        }
      }}
    >
      {/* Worktree Container Header (Drag Handle) */}
      <div
        className="worktree-box-header worktree-drag-handle"
        onPointerDown={(e) => onNodeDragStart(wt.id, e)}
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
            onClick={() => onOpenAddAgent(wt)}
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
                onSetDropTargetMember({
                  worktreeId: wt.id,
                  agentId: firstMember.id,
                  position: 'before',
                });
              } else if (e.clientY > rect.bottom - 20 && lastMember && lastMember.id !== draggingMember.agentId) {
                onSetDropTargetMember({
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
            onReorderMember(wt.id, draggingMember.agentId, dropTargetMember.agentId, dropTargetMember.position);
            onSetDraggingMember(null);
            onSetDropTargetMember(null);
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
            const isDropTargetBefore =
              dropTargetMember?.worktreeId === wt.id &&
              dropTargetMember?.agentId === ag.id &&
              dropTargetMember?.position === 'before';
            const isDropTargetAfter =
              dropTargetMember?.worktreeId === wt.id &&
              dropTargetMember?.agentId === ag.id &&
              dropTargetMember?.position === 'after';

            const showPreviewBefore = Boolean(
              isDropTargetBefore &&
                draggingMember &&
                draggedNode &&
                isValidReorder(members, draggingMember.agentId, ag.id, 'before')
            );
            const showPreviewAfter = Boolean(
              isDropTargetAfter &&
                draggingMember &&
                draggedNode &&
                isValidReorder(members, draggingMember.agentId, ag.id, 'after')
            );

            return (
              <React.Fragment key={ag.id}>
                {showPreviewBefore && (
                  <WorktreeDropPreviewSlot
                    key={`drop-preview-before-${ag.id}`}
                    draggedNode={draggedNode}
                    targetNode={ag}
                    position="before"
                  />
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
                      onSetDraggingMember({ worktreeId: wt.id, agentId: ag.id });
                    });
                  }}
                  onDragOver={(e) => {
                    if (isDraggingGitHubItem || e.dataTransfer.types.includes(KANBAN_DRAG_TYPE)) {
                      onGitHubDragOver(e, ag.id);
                      return;
                    }
                    if (draggingMember && draggingMember.worktreeId === wt.id && draggingMember.agentId !== ag.id) {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      const rect = e.currentTarget.getBoundingClientRect();
                      const midY = rect.top + rect.height / 2;
                      const position = e.clientY < midY ? 'before' : 'after';
                      onSetDropTargetMember({
                        worktreeId: wt.id,
                        agentId: ag.id,
                        position,
                      });
                    }
                  }}
                  onDragLeave={(e) => {
                    if (isDraggingGitHubItem || e.dataTransfer.types.includes(KANBAN_DRAG_TYPE)) {
                      onGitHubDragLeave(e, ag.id);
                      return;
                    }
                    if (!e.currentTarget.parentElement?.contains(e.relatedTarget as globalThis.Node)) {
                      onSetDropTargetMember(null);
                    }
                  }}
                  onDrop={(e) => {
                    if (isDraggingGitHubItem || e.dataTransfer.types.includes(KANBAN_DRAG_TYPE)) {
                      onGitHubDrop(e, ag.id);
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    if (
                      draggingMember &&
                      draggingMember.worktreeId === wt.id &&
                      draggingMember.agentId !== ag.id &&
                      dropTargetMember
                    ) {
                      onReorderMember(wt.id, draggingMember.agentId, ag.id, dropTargetMember.position);
                    }
                    onSetDraggingMember(null);
                    onSetDropTargetMember(null);
                  }}
                  onDragEnd={() => {
                    onSetDraggingMember(null);
                    onSetDropTargetMember(null);
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
                    onOpenNodeContextMenu(e.clientX, e.clientY, ag);
                  }}
                  aria-pressed={isAgSelected}
                  aria-label={`Agent: ${ag.label}, state: ${ag.state}, liveness: ${ag.liveness}`}
                >
                  <WorkflowNodeCardBody
                    node={ag}
                    gripTitle="Drag up or down to reorder agent in worktree"
                    iconSize={15}
                    showPreviewText={true}
                    showStaleTag={true}
                    chatExtension={renderChatExtension(ag)}
                  />
                </div>

                {showPreviewAfter && (
                  <WorktreeDropPreviewSlot
                    key={`drop-preview-after-${ag.id}`}
                    draggedNode={draggedNode}
                    targetNode={ag}
                    position="after"
                  />
                )}
              </React.Fragment>
            );
          })
        )}
      </div>
    </div>
  );
};
