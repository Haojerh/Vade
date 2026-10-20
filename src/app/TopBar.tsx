import { Select } from '../components/ui/Select';
import React from 'react';
import type { Project, Run } from '../../shared/contracts';
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
  snapshotLoading: boolean;
  projectsLoading: boolean;
  onRefreshAll: () => void;
  onOpenInbox: () => void;
  inboxUnreadCount: number;
  onToggleKanban?: () => void;
  kanbanOpen?: boolean;
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
  snapshotLoading,
  projectsLoading,
  onRefreshAll,
  onOpenInbox,
  inboxUnreadCount,
  onToggleKanban,
  kanbanOpen,
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
        <button type="button" className="btn btn-secondary btn-sm" onClick={onToggleKanban} aria-expanded={Boolean(kanbanOpen)} aria-haspopup="dialog" aria-label="Toggle Kanban board" title="Kanban board">
          <Icon name="layers" size={14} /><span className="btn-label">Kanban</span>
        </button>
        <button type="button" className="btn btn-secondary btn-sm inbox-trigger" onClick={onOpenInbox} aria-label={`Open inbox, ${inboxUnreadCount} unread results`}>
          <Icon name="bell" size={14} /><span className="btn-label">Inbox</span>{inboxUnreadCount > 0 && <span className="inbox-count">{inboxUnreadCount}</span>}
        </button>

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
