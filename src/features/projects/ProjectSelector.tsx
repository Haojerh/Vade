import { Select } from '../../components/ui/Select';
import React from 'react';
import type { DashboardSnapshot, Inventory, Section } from '../../../shared/contracts';
import {
  type NodeDetailsVisibleSections,
} from '../workflow/NodeDetails';
import { Icon } from '../../components/ui/Icon';
import { RegisterProject } from './RegisterProject';
import { DeleteProject } from './DeleteProject';

export interface ProjectSelectorProps {
  footerActions?: React.ReactNode;
  onOpenSettings?: () => void;
  standalone?: boolean;
  onRegistered?: (id: string) => void;
  onDeleted?: () => void;
  failedProjectIds?: ReadonlySet<string>;
  inventorySection: Section<Inventory> | null;
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  snapshot: DashboardSnapshot | null;
  isLocallyStale: boolean;
  connectionMode: 'sse' | 'polling' | 'disconnected';
  onCollapse?: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  cardStateColors: boolean;
  onToggleCardStateColors: (enabled: boolean) => void;
  orchestrationSeparated?: boolean;
  onToggleOrchestrationSeparated?: (separated: boolean) => void;
  visibleSections?: NodeDetailsVisibleSections;
  onToggleVisibleSection?: (key: keyof NodeDetailsVisibleSections) => void;
  onResetVisibleSections?: () => void;
  commitGraphEnabled?: boolean;
  onToggleCommitGraph?: (enabled: boolean) => void;
  toolActivityEnabled?: boolean;
  onToggleToolActivity?: (enabled: boolean) => void;
  chatToolCallsEnabled?: boolean;
  onToggleChatToolCalls?: (enabled: boolean) => void;
}

export const ProjectSelector: React.FC<ProjectSelectorProps> = ({
  footerActions,
  onOpenSettings,
  standalone,
  onRegistered,
  onDeleted,
  failedProjectIds,
  inventorySection,
  loading,
  error,
  selectedProjectId,
  onSelectProject,
  onCollapse,
}) => {

  const projects = inventorySection?.data?.projects ?? [];



  const [isProjectsExpanded, setIsProjectsExpanded] = React.useState<boolean>(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('orca-projects-expanded');
        if (saved !== null) {
          return saved === 'true';
        }
      }
    } catch {
      // Storage unavailable fallback
    }
    return true;
  });

  const toggleProjectsExpanded = React.useCallback(() => {
    setIsProjectsExpanded((prev) => {
      const next = !prev;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('orca-projects-expanded', String(next));
        }
      } catch {
        // Storage unavailable
      }
      return next;
    });
  }, []);

  const currentProjectId = React.useMemo(() => {
    if (selectedProjectId && projects.some((p) => p.id === selectedProjectId)) {
      return selectedProjectId;
    }
    return projects[0]?.id ?? null;
  }, [projects, selectedProjectId]);

  return (
    <nav className="project-rail" aria-label="Projects navigation">
      {/* Mobile Selector Dropdown */}
      <div className="rail-mobile-select">
        <label htmlFor="mobile-project-select" className="rail-section-label">
          Active Project
        </label>
        <Select wrapperClassName="w-full"
            id="mobile-project-select"
            className="rail-select"
            value={selectedProjectId || ''}
            onChange={(e) => onSelectProject(e.target.value)}
            disabled={loading || projects.length === 0}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind})
              </option>
            ))}
          </Select>
      </div>

      {/* Project Navigation Section */}
      <div className="rail-section rail-projects-section">
        <div className="rail-section-header">
          <button
            type="button"
            className="rail-section-toggle-btn"
            onClick={toggleProjectsExpanded}
            aria-expanded={isProjectsExpanded}
            aria-controls="rail-project-list"
            aria-label={isProjectsExpanded ? 'Collapse projects list' : 'Expand projects list'}
            title={isProjectsExpanded ? 'Collapse projects list' : 'Expand projects list'}
          >
            <span className="rail-section-toggle-left">
              <span className="rail-section-label">Projects</span>
              <span className="rail-section-badge font-mono">{projects.length}</span>
            </span>
            <Icon
              name="chevron-down"
              size={14}
              className={`rail-chevron-icon ${isProjectsExpanded ? 'is-expanded' : ''}`}
            />
          </button>
          {standalone && onRegistered && <RegisterProject onRegistered={onRegistered} />}
          {onCollapse && <button type="button" className="btn-icon project-collapse-button" onClick={onCollapse} aria-label="Collapse projects sidebar" title="Collapse projects sidebar"><Icon name="chevrons-left" size={14} /></button>}
        </div>

        {loading && <div className="rail-empty-hint">Scanning projectsâ€¦</div>}

        {error && (
          <div className="rail-error-hint" role="alert">
            <span className="font-semibold">Failed to load:</span> {error}
          </div>
        )}

        {!loading && projects.length === 0 && !error && (
          <div className="rail-empty-hint">No registered projects found.</div>
        )}

        <div className="rail-projects-scrollable">
          <ul id="rail-project-list" className="project-list" role="list">
            {projects.map((proj) => {
              const isSelected = proj.id === selectedProjectId;
              const isCurrent = proj.id === currentProjectId;
              const isHidden = !isProjectsExpanded && !isCurrent;
              const primaryPath = proj.paths[0] || '';
              const displayPath = primaryPath.length > 32
                ? 'â€¦' + primaryPath.slice(-30)
                : primaryPath;

              return (
                <li
                  key={proj.id}
                  className={`project-item ${isHidden ? 'is-collapsed-hidden' : ''}`}
                  aria-hidden={isHidden ? true : undefined}
                >
                  <div className="project-item-inner">
                    <button
                      type="button"
                      className={`project-button ${isSelected ? 'active' : ''} ${failedProjectIds?.has(proj.id) ? 'has-recent-failure' : ''}`}
                      onClick={() => onSelectProject(proj.id)}
                      aria-pressed={isSelected}
                      aria-label={`Select project ${proj.name}, kind: ${proj.kind}${failedProjectIds?.has(proj.id) ? ', recent unhandled failure' : ''}`}
                      tabIndex={isHidden ? -1 : 0}
                    >
                      <div className="project-button-main">
                        <span className="project-name">{proj.name}</span>
                        <span className={`project-kind-badge kind-${proj.kind}`}>
                          {proj.kind}
                        </span>
                      </div>
                      {primaryPath && (
                        <div className="project-path font-mono" title={primaryPath}>
                          {displayPath}
                        </div>
                      )}
                    </button>
                    {standalone && onDeleted && <DeleteProject project={proj} onDeleted={onDeleted} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Sidebar controls */}
      <div className="rail-footer">

        <div className="rail-footer-controls">
          <button type="button" className="btn-icon" onClick={onOpenSettings}
            aria-label="Dashboard settings" title="Dashboard settings">
            <Icon name="settings" size={15} />
          </button>
          {footerActions}
        </div>
      </div>
    </nav>
  );
};
