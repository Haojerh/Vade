import React from 'react';
import type { Progress, Activity, Run } from '../../shared/contracts';
import { ProgressPanel } from '../features/activity/ProgressPanel';
import { ActivityPanel } from '../features/activity/ActivityPanel';
import { Icon } from '../components/ui/Icon';

export interface BottomPanelProps {
  isOpen: boolean;
  onToggleOpen: (open: boolean) => void;
  height: number;
  minHeight: number;
  maxHeight: number;
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onToggleExpand: () => void;
  effectiveRun: Run | undefined;
  effectiveRunId: string | null;
  progress: Progress | undefined;
  activity: Activity[] | undefined;
  onSelectNode: (nodeId: string | null) => void;
}

export const BottomPanel: React.FC<BottomPanelProps> = ({
  isOpen,
  onToggleOpen,
  height,
  minHeight,
  maxHeight,
  isDragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onToggleExpand,
  effectiveRun,
  effectiveRunId,
  progress,
  activity,
  onSelectNode,
}) => {
  return (
    <>
      {/* Reopen dock indicator if bottom panel closed */}
      {!isOpen && (
        <div className="bottom-panel-reopen-dock">
          <button
            type="button"
            className="btn btn-secondary btn-xs btn-reopen-dock"
            onClick={() => onToggleOpen(true)}
            aria-label="Open run progress and activity panel"
            title="Open run progress and activity panel"
          >
            <Icon name="chevron-up" size={12} />
            <span>Show Run Progress & Activity</span>
          </button>
        </div>
      )}

      {/* Draggable Vertical Separator Handle (Only when bottom panel open) */}
      {isOpen && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-valuenow={Math.round(height)}
          aria-valuemin={minHeight}
          aria-valuemax={maxHeight}
          aria-label="Resize progress and activity panel"
          tabIndex={0}
          className={`stage-bottom-resizer ${isDragging ? 'is-dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <div className="resizer-horizontal-line" />
        </div>
      )}

      {/* Bottom Panels Container */}
      <div
        className={`stage-bottom-panels-container ${isDragging ? 'is-dragging' : ''} ${
          !isOpen ? 'is-collapsed' : 'is-open'
        }`}
        style={{
          height: isOpen ? `${height}px` : '0px',
        }}
        aria-hidden={!isOpen}
        inert={!isOpen ? true : undefined}
      >
        <div className="bottom-panel-control-header">
          <div className="bottom-control-title-group">
            <span className="bottom-control-title font-semibold text-xs">Run Progress & Activity</span>
            {effectiveRun && (
              <span className="bottom-run-tag font-mono text-xs text-muted">
                {effectiveRun.sourceRunId}
              </span>
            )}
          </div>

          <div className="bottom-control-actions">
            <button
              type="button"
              className="btn-icon"
              onClick={onToggleExpand}
              aria-label={height > 340 ? 'Restore bottom panel height' : 'Expand bottom panel height'}
              title={height > 340 ? 'Restore bottom panel height' : 'Expand bottom panel height'}
            >
              {height > 340 ? (
                <Icon name="collapse" size={13} />
              ) : (
                <Icon name="expand" size={13} />
              )}
            </button>

            <button
              type="button"
              className="btn-icon"
              onClick={() => onToggleOpen(false)}
              aria-label="Hide progress and activity panel"
              title="Hide progress and activity panel"
            >
              <Icon name="chevron-down" size={13} />
            </button>
          </div>
        </div>

        <div className="bottom-panel-scrollable-content">
          <ProgressPanel
            progress={progress}
            hasSelectedRun={Boolean(effectiveRunId)}
            selectedRunObjective={effectiveRun?.objective}
          />

          <ActivityPanel
            activity={activity}
            onSelectNode={onSelectNode}
          />
        </div>
      </div>
    </>
  );
};
