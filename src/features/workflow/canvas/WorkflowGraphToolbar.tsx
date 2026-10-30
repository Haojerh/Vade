import React from 'react';
import type { Node } from '../../../../shared/contracts';
import { Icon } from '../../../components/ui/Icon';
import { ProjectShortcuts } from '../../projects/ProjectShortcuts';
import type { HistoryDrag } from '../../agents/historyDrag';

interface WorkflowGraphToolbarProps {
  projectId: string | null;
  nodes: Node[];
  selectedNodeId: string | null;
  canAddWorktree: boolean;
  hasCustomLayout: boolean;
  onSelectNode: (id: string) => void;
  onRefresh?: () => void;
  onDragShortcut: (drag: HistoryDrag | null) => void;
  onAddWorktree: () => void;
  onResetLayout: () => void;
}

export const WorkflowGraphToolbar: React.FC<WorkflowGraphToolbarProps> = ({
  projectId,
  nodes,
  selectedNodeId,
  canAddWorktree,
  hasCustomLayout,
  onSelectNode,
  onRefresh,
  onDragShortcut,
  onAddWorktree,
  onResetLayout,
}) => (
  <div className="graph-toolbar">
    <div className="toolbar-title-group">
      <h2 className="graph-title">Workflow Topology</h2>
    </div>

    <div className="graph-toolbar-actions">
      {projectId && (
        <ProjectShortcuts
          key={projectId}
          projectId={projectId}
          nodes={nodes}
          selectedNodeId={selectedNodeId}
          onOpen={onSelectNode}
          onRefresh={onRefresh}
          onDragShortcut={onDragShortcut}
        />
      )}
      <button
        type="button"
        className="btn btn-secondary btn-xs"
        disabled={!canAddWorktree}
        onClick={onAddWorktree}
        title={
          canAddWorktree
            ? 'Create a new worktree'
            : 'Select a Git project with one backing repository'
        }
      >
        <Icon name="plus" size={12} />
        <span>Add Worktree</span>
      </button>
      {hasCustomLayout && (
        <button
          type="button"
          className="btn btn-secondary btn-xs btn-reset-layout"
          onClick={onResetLayout}
          title="Reset repositioned cards and worktrees to default layout"
          aria-label="Reset repositioned cards and worktrees to default layout"
        >
          <Icon name="rotate-ccw" size={12} />
          <span>Reset Layout</span>
        </button>
      )}

      <div className="graph-legend">
        <span className="legend-item"><span className="legend-swatch swatch-tool" /> Tool</span>
        <span className="legend-item">
          <span className="legend-swatch swatch-active" /> Active
        </span>
        <span className="legend-item">
          <span className="legend-swatch swatch-idle" /> Idle
        </span>
      </div>
    </div>
  </div>
);
