import React from 'react';
import type { Progress } from '../../../shared/contracts';

interface ProgressPanelProps {
  progress: Progress | null | undefined;
  hasSelectedRun: boolean;
  selectedRunObjective?: string | null;
}

export const ProgressPanel: React.FC<ProgressPanelProps> = ({
  progress,
  hasSelectedRun,
  selectedRunObjective,
}) => {
  if (!hasSelectedRun) {
    return (
      <section className="dashboard-panel progress-panel" aria-labelledby="progress-panel-title">
        <div className="panel-header">
          <h2 id="progress-panel-title" className="panel-title">Run Progress</h2>
          <span className="badge badge-neutral">No Run Selected</span>
        </div>
        <div className="panel-content empty-hint">
          Select an active run from the topbar picker to view scoped task progress.
        </div>
      </section>
    );
  }

  if (!progress) {
    return (
      <section className="dashboard-panel progress-panel" aria-labelledby="progress-panel-title">
        <div className="panel-header">
          <h2 id="progress-panel-title" className="panel-title">Run Progress</h2>
          <span className="badge badge-neutral">Unavailable</span>
        </div>
        <div className="panel-content empty-hint">
          Progress evidence is not yet available for this run.
        </div>
      </section>
    );
  }

  const {
    total,
    completed,
    failed,
    working,
    waiting,
    blocked,
    unknown,
    percent,
    coverage,
  } = progress;

  return (
    <section className="dashboard-panel progress-panel" aria-labelledby="progress-panel-title">
      <div className="panel-header">
        <div className="panel-title-group">
          <h2 id="progress-panel-title" className="panel-title">Run Progress</h2>
          {selectedRunObjective && (
            <span className="panel-subtitle" title={selectedRunObjective}>
              {selectedRunObjective}
            </span>
          )}
        </div>
        <div className="panel-badges">
          <span className={`badge badge-coverage-${coverage}`}>
            Coverage: {coverage}
          </span>
        </div>
      </div>

      <div className="panel-content">
        {/* Progress Bar / Percent */}
        <div className="progress-bar-container">
          <div className="progress-bar-meta">
            <span className="progress-label">Recorded task completion · {completed} / {total}</span>
            <span className="progress-percent-text font-mono font-bold">
              {percent !== null ? `${percent}%` : 'Unverified'}
            </span>
          </div>

          <div
            className="progress-track"
            role="progressbar"
            aria-valuenow={percent !== null ? percent : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Run task completion percentage"
            aria-valuetext={percent !== null ? `${completed} of ${total} recorded tasks completed (${percent}%)` : 'Task completion unverified'}
          >
            {percent !== null ? (
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            ) : null}
          </div>

          {percent === null && (
            <div className="progress-caveat">
              {coverage !== 'complete'
                ? `Percentage suppressed: discovery coverage is ${coverage}.`
                : total === 0
                ? 'Percentage suppressed: zero recorded tasks for this run.'
                : 'Percentage suppressed: incomplete verification basis.'}
            </div>
          )}
          <div className="progress-caveat">Based on tasks recorded for the selected run. Agent activity and unrecorded work are not included.</div>
        </div>

        {/* Breakdown Timetable Grid */}
        <div className="progress-breakdown-grid">
          <div className="breakdown-cell cell-total">
            <div className="cell-label">Total Tasks</div>
            <div className="cell-val font-mono">{total}</div>
          </div>
          <div className="breakdown-cell cell-completed">
            <div className="cell-label">Completed</div>
            <div className="cell-val font-mono">{completed}</div>
          </div>
          <div className="breakdown-cell cell-failed">
            <div className="cell-label">Failed</div>
            <div className="cell-val font-mono">{failed}</div>
          </div>
          <div className="breakdown-cell cell-working">
            <div className="cell-label">Working</div>
            <div className="cell-val font-mono">{working}</div>
          </div>
          <div className="breakdown-cell cell-waiting">
            <div className="cell-label">Waiting</div>
            <div className="cell-val font-mono">{waiting}</div>
          </div>
          <div className="breakdown-cell cell-blocked">
            <div className="cell-label">Blocked</div>
            <div className="cell-val font-mono">{blocked}</div>
          </div>
          {unknown > 0 && (
            <div className="breakdown-cell cell-unknown">
              <div className="cell-label">Unknown</div>
              <div className="cell-val font-mono">{unknown}</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
