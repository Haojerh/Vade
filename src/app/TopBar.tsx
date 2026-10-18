import { Select } from '../components/ui/Select';
import React from 'react';
import type { Project, Run, SourceMeta } from '../../shared/contracts';
import { RefreshIcon } from '../components/ui/RefreshIcon';
import { Icon } from '../components/ui/Icon';

export interface TopBarProps {
  topbarRef: React.RefObject<HTMLElement | null>;
  leftSidebarOpen: boolean;
  onToggleLeft: (open: boolean) => void;
  rightSidebarOpen: boolean;
  onToggleRight: (open: boolean) => void;
  currentProject: Project | undefined;
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  isLocallyStale: boolean;
  graphMeta: SourceMeta | undefined;
  connectionMode: 'sse' | 'polling' | 'disconnected';
  generatedAt: string | undefined;
  snapshotLoading: boolean;
  projectsLoading: boolean;
  onRefreshAll: () => void;
}

function formatIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

export const TopBar: React.FC<TopBarProps> = ({
  topbarRef,
  leftSidebarOpen,
  onToggleLeft,
  rightSidebarOpen,
  onToggleRight,
  currentProject,
  runs,
  selectedRunId,
  onSelectRun,
  isLocallyStale,
  graphMeta,
  connectionMode,
  generatedAt,
  snapshotLoading,
  projectsLoading,
  onRefreshAll,
}) => {
  return (
    <header ref={topbarRef} className="dashboard-topbar">
      <div className="topbar-left-group">
        {!leftSidebarOpen && (
          <button
            type="button"
            className="btn-sidebar-reopen"
            onClick={() => onToggleLeft(true)}
            aria-label="Open projects sidebar"
            title="Open projects sidebar"
          >
            <Icon name="sidebar-left" size={15} />
            <span className="btn-label">Projects</span>
          </button>
        )}

        <div className="topbar-project-info">
          <div className="project-title-row">
            <h1 className="active-project-heading">
              {currentProject ? currentProject.name : 'Orca Dashboard'}
            </h1>
            {currentProject && (
              <span className={`project-kind-tag kind-${currentProject.kind}`}>
                {currentProject.kind}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="topbar-center-group">
        {runs.length > 0 && (
          <div className="center-run-picker">
            <label htmlFor="center-run-select" className="run-picker-label text-xs font-semibold">
              Run:
            </label>
            <Select wrapperClassName="run-select-wrapper"
                id="center-run-select"
                className="center-run-select"
                value={selectedRunId || ''}
                onChange={(e) => onSelectRun(e.target.value || null)}
                aria-label="Select active workflow run"
              >
                <option value="">Default run ({runs[0]?.sourceRunId || 'auto'})</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.sourceRunId} {r.objective ? `— ${r.objective.slice(0, 40)}` : ''}
                  </option>
                ))}
              </Select>
          </div>
        )}
      </div>

      <div className="topbar-meta-controls">
        <div className="freshness-indicator">
          <span
            className={`sync-dot ${
              isLocallyStale || graphMeta?.stale || (graphMeta && graphMeta.availability !== 'ready')
                ? 'sync-stale'
                : connectionMode === 'sse'
                ? 'sync-live'
                : 'sync-warn'
            }`}
            aria-hidden="true"
          />
          <span className="sync-text font-mono text-xs">
            {isLocallyStale || graphMeta?.stale || (graphMeta && graphMeta.availability !== 'ready') ? (
              <span className="text-warning font-semibold">
                {graphMeta?.availability === 'unavailable'
                  ? 'Source Unavailable'
                  : graphMeta?.availability === 'unsupported'
                  ? 'Source Unsupported'
                  : 'Stale Snapshot'}
              </span>
            ) : (
              <span>Observed: {formatIso(graphMeta?.observedAt || generatedAt)}</span>
            )}
          </span>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onRefreshAll}
          disabled={snapshotLoading || projectsLoading}
          aria-label="Refresh all data"
          title="Refresh all data"
        >
          <RefreshIcon busy={snapshotLoading || projectsLoading} size={13} />
          <span className="btn-label">Refresh</span>
        </button>

        {!rightSidebarOpen && (
          <button
            type="button"
            className="btn-sidebar-reopen"
            onClick={() => onToggleRight(true)}
            aria-label="Open GitHub sidebar"
            title="Open GitHub sidebar"
          >
            <Icon name="sidebar-right" size={15} />
            <span className="btn-label">GitHub</span>
          </button>
        )}
      </div>
    </header>
  );
};
