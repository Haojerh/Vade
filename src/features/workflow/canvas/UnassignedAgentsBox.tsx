import React from 'react';
import type { Node, Subagent } from '../../../../shared/contracts';
import { WorkflowNodeCardBody } from './WorkflowNodeCard';

interface UnassignedAgentsBoxProps {
  unassignedAgents: Node[];
  selectedNodeId: string | null;
  draggingNodeId: string | null;
  effectiveOffsets: Record<string, { x: number; y: number }>;
  isDraggingGitHubItem: boolean;
  dropHoverNodeId: string | null;
  chatOpenNodeId: string | null;
  justDraggedNodeRef: React.MutableRefObject<boolean>;
  registerRef: (id: string, el: HTMLElement | null) => void;
  previewEvents: (node: Node) => React.HTMLAttributes<HTMLElement>;
  renderChatExtension: (node: Node) => React.ReactNode;
  onSelectNode: (id: string) => void;
  onNodeDragStart: (id: string, e: React.PointerEvent) => void;
  onOpenContextMenu: (x: number, y: number, node: Node) => void;
  onDragOver: (e: React.DragEvent, nodeId: string) => void;
  onDragLeave: (e: React.DragEvent, nodeId: string) => void;
  onDrop: (e: React.DragEvent, nodeId: string) => void;
  onOpenSubagent: (nodeId: string, subagent: Subagent) => void;
  onSubagentPreview: (nodeId: string, subagent: Subagent, anchor: HTMLElement) => void;
  onSubagentPreviewLeave: () => void;
}

export const UnassignedAgentsBox: React.FC<UnassignedAgentsBoxProps> = ({
  unassignedAgents,
  selectedNodeId,
  draggingNodeId,
  effectiveOffsets,
  isDraggingGitHubItem,
  dropHoverNodeId,
  chatOpenNodeId,
  justDraggedNodeRef,
  registerRef,
  previewEvents,
  renderChatExtension,
  onSelectNode,
  onNodeDragStart,
  onOpenContextMenu,
  onDragOver,
  onDragLeave,
  onDrop,
  onOpenSubagent,
  onSubagentPreview,
  onSubagentPreviewLeave,
}) => (
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
            onPointerDown={(e) => onNodeDragStart(ag.id, e)}
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
              onOpenContextMenu(e.clientX, e.clientY, ag);
            }}
            onDragOver={(e) => onDragOver(e, ag.id)}
            onDragLeave={(e) => onDragLeave(e, ag.id)}
            onDrop={(e) => onDrop(e, ag.id)}
            aria-pressed={isAgSelected}
            aria-label={ag.kind === 'terminal' ? `Terminal: ${ag.label}, liveness: ${ag.liveness}` : `Agent: ${ag.label}, state: ${ag.state}`}
          >
            <WorkflowNodeCardBody
              node={ag}
              gripTitle="Drag to reposition agent"
              iconSize={15}
              showPreviewText={false}
              showStaleTag={false}
              chatExtension={renderChatExtension(ag)}
              onOpenSubagent={subagent => onOpenSubagent(ag.id, subagent)}
              onSubagentPreview={(subagent, anchor) => onSubagentPreview(ag.id, subagent, anchor)}
              onSubagentPreviewLeave={onSubagentPreviewLeave}
            />
          </div>
        );
      })}
    </div>
  </div>
);
