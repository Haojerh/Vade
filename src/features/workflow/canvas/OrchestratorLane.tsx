import React from 'react';
import type { Node, Subagent } from '../../../../shared/contracts';
import { WorkflowNodeCardBody } from './WorkflowNodeCard';

interface OrchestratorLaneProps {
  orchestrators: Node[];
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

export const OrchestratorLane: React.FC<OrchestratorLaneProps> = ({
  orchestrators,
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
                onPointerDown={(e) => onNodeDragStart(orch.id, e)}
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
                onPointerDown={(e) => onNodeDragStart(orch.id, e)}
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
                  onOpenContextMenu(e.clientX, e.clientY, orch);
                }}
                onDragOver={(e) => onDragOver(e, orch.id)}
                onDragLeave={(e) => onDragLeave(e, orch.id)}
                onDrop={(e) => onDrop(e, orch.id)}
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
                  onOpenSubagent={subagent => onOpenSubagent(orch.id, subagent)}
                  onSubagentPreview={(subagent, anchor) => onSubagentPreview(orch.id, subagent, anchor)}
                  onSubagentPreviewLeave={onSubagentPreviewLeave}
                />
              </div>
            </div>
          );
        })}
      </div>
    )}
  </div>
);
