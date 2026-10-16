import React from 'react';
import { UsagePanel } from '../usage/UsagePanel';
import { usePopoverState } from '../../hooks/usePopoverState';
import type { DashboardSnapshot, Inventory, Section } from '../../../shared/contracts';
import {
  type NodeDetailsVisibleSections,
  DEFAULT_VISIBLE_SECTIONS,
} from '../workflow/NodeDetails';

export interface ProjectSelectorProps {
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
  visibleSections?: NodeDetailsVisibleSections;
  onToggleVisibleSection?: (key: keyof NodeDetailsVisibleSections) => void;
  onResetVisibleSections?: () => void;
}

export const ProjectSelector: React.FC<ProjectSelectorProps> = ({
  inventorySection,
  loading,
  error,
  selectedProjectId,
  onSelectProject,
  snapshot,
  isLocallyStale,
  connectionMode,
  onCollapse,
  theme,
  onToggleTheme,
  cardStateColors,
  onToggleCardStateColors,
  visibleSections,
  onToggleVisibleSection,
  onResetVisibleSections,
}) => {
  const { present: isSettingsOpen, closing: isSettingsClosing, close: closeSettings, toggle: toggleSettings } = usePopoverState();
  const settingsRef = React.useRef<HTMLDivElement>(null);

  // Close settings popover on click outside or escape
  React.useEffect(() => {
    if (!isSettingsOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        closeSettings();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSettings();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSettingsOpen, closeSettings]);

  const projects = inventorySection?.data?.projects ?? [];
  const runtime = snapshot?.runtime?.data;
  const runtimeMeta = snapshot?.runtime?.meta;
  const activeVisibleSections = visibleSections ?? DEFAULT_VISIBLE_SECTIONS;

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

  const renderRuntimeStatus = () => {
    const graphMeta = snapshot?.graph?.meta;
    const isUnavailable = graphMeta ? graphMeta.availability !== 'ready' : false;
    const isStale = isLocallyStale || Boolean(graphMeta?.stale);
    const isHealthy = connectionMode === 'sse' && !isStale && !isUnavailable;

    const dotClass =
      connectionMode === 'disconnected' || isUnavailable
        ? 'dot-offline'
        : isHealthy
        ? 'dot-live'
        : 'dot-polling';

    const statusTitle =
      connectionMode === 'disconnected'
        ? 'Disconnected'
        : isUnavailable
        ? `Unavailable (${graphMeta?.availability})`
        : isStale
        ? `Stale (${connectionMode === 'sse' ? 'SSE' : 'Polling'})`
        : connectionMode === 'sse'
        ? 'Live SSE'
        : 'Polling';

    return (
      <div className="runtime-status-card" role="status">
        <div className="runtime-status-header">
          <span className={`status-dot ${dotClass}`} aria-hidden="true" />
          <span className="runtime-title">{statusTitle}</span>
        </div>
        <div className="runtime-meta-details">
          {runtime?.version ? (
            <div className="runtime-meta-row">
              <span className="meta-label">Orca:</span>
              <span className="meta-val font-mono">{runtime.version}</span>
            </div>
          ) : runtimeMeta?.issue ? (
            <div className="runtime-meta-row text-warning">
              <span className="meta-label">Runtime:</span>
              <span className="meta-val">{runtimeMeta.issue.code}</span>
            </div>
          ) : (
            <div className="runtime-meta-row text-muted">
              <span className="meta-label">Runtime:</span>
              <span className="meta-val">Active</span>
            </div>
          )}
          {snapshot?.revision && (
            <div className="runtime-meta-row">
              <span className="meta-label">Rev:</span>
              <span className="meta-val font-mono">{snapshot.revision.slice(0, 8)}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <nav className="project-rail" aria-label="Projects navigation">
      {/* Brand Header with Integrated Collapse Action */}
      <div className="rail-brand">
        <div className="brand-title-row">
          <div className="brand-title-main">
            <svg
              className="brand-icon"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <span className="brand-name font-bold">Orca Live</span>
          </div>

          {onCollapse && (
            <button
              type="button"
              className="btn-icon rail-collapse-btn"
              onClick={onCollapse}
              aria-label="Collapse projects sidebar"
              title="Collapse projects sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          )}
        </div>
        <div className="brand-tagline">Workflow Atlas</div>
      </div>

      {/* Mobile Selector Dropdown */}
      <div className="rail-mobile-select">
        <label htmlFor="mobile-project-select" className="rail-section-label">
          Active Project
        </label>
        <div className="custom-select-control w-full">
          <select
            id="mobile-project-select"
            className="rail-select custom-select-native"
            value={selectedProjectId || ''}
            onChange={(e) => onSelectProject(e.target.value)}
            disabled={loading || projects.length === 0}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind})
              </option>
            ))}
          </select>
          <svg className="custom-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
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
            <svg
              className={`rail-chevron-icon ${isProjectsExpanded ? 'is-expanded' : ''}`}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>

        {loading && <div className="rail-empty-hint">Scanning projects…</div>}

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
                ? '…' + primaryPath.slice(-30)
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
                      className={`project-button ${isSelected ? 'active' : ''}`}
                      onClick={() => onSelectProject(proj.id)}
                      aria-pressed={isSelected}
                      aria-label={`Select project ${proj.name}, kind: ${proj.kind}`}
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
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Rail Footer: Anchored to viewport bottom with SSE status & monitor text */}
      <div className="rail-footer">
        {renderRuntimeStatus()}

        {/* Footer controls: Settings dropup popover */}
        <div className="rail-footer-controls" ref={settingsRef}>
          <button
            type="button"
            className={`btn btn-secondary btn-xs ${isSettingsOpen ? 'btn-active' : ''}`}
            onClick={toggleSettings}
            aria-label="Dashboard settings"
            aria-haspopup="dialog"
            aria-expanded={isSettingsOpen && !isSettingsClosing}
            title="Dashboard settings"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="btn-label">Settings</span>
          </button>

          {isSettingsOpen && (
            <div
              className={`footer-settings-popover ${isSettingsClosing ? 'is-closing' : ''}`}
              role="dialog"
              aria-label="Dashboard settings"
            >
              <div className="settings-popover-header">
                <span className="font-bold text-sm">Settings</span>
                <button
                  type="button"
                  className="btn-close"
                  onClick={closeSettings}
                  aria-label="Close settings"
                >
                  ✕
                </button>
              </div>
              <div className="settings-popover-body">
                <label className="settings-option-row">
                  <div className="settings-option-text">
                    <span className="settings-option-label font-semibold">Card State Colors</span>
                    <span className="settings-option-desc text-xs text-muted">
                      Color cards by state: blue working, green completed, neutral idle.
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={cardStateColors}
                    onChange={(e) => onToggleCardStateColors(e.target.checked)}
                  />
                </label>

                <div className="settings-option-row settings-theme-row">
                  <div className="settings-option-text">
                    <span className="settings-option-label font-semibold">Appearance</span>
                    <span className="settings-option-desc text-xs text-muted">
                      Theme: {theme === 'dark' ? 'Dark' : 'Light'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs theme-toggle-btn"
                    onClick={onToggleTheme}
                    aria-label={`Toggle theme, current theme is ${theme}`}
                    title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
                  >
                    {theme === 'dark' ? (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="5" />
                          <line x1="12" y1="1" x2="12" y2="3" />
                          <line x1="12" y1="21" x2="12" y2="23" />
                          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                          <line x1="1" y1="12" x2="3" y2="12" />
                          <line x1="21" y1="12" x2="23" y2="12" />
                          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                        </svg>
                        <span className="btn-label">Light</span>
                      </>
                    ) : (
                      <>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                        <span className="btn-label">Dark</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="settings-sections-group">
                  <div className="settings-group-header">
                    <span className="settings-group-label">Node Details Sections</span>
                    {onResetVisibleSections && (
                      <button
                        type="button"
                        className="btn-link text-xs text-muted"
                        onClick={onResetVisibleSections}
                        title="Reset to all visible"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    Toggle visible sections in node details:
                  </span>
                  <div className="settings-checkboxes-list">
                    <label className="settings-checkbox-item">
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={activeVisibleSections.status}
                        onChange={() => onToggleVisibleSection?.('status')}
                      />
                      <span>Status &amp; Workspace</span>
                    </label>
                    <label className="settings-checkbox-item">
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={activeVisibleSections.tasks}
                        onChange={() => onToggleVisibleSection?.('tasks')}
                      />
                      <span>Assigned Tasks</span>
                    </label>
                    <label className="settings-checkbox-item">
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={activeVisibleSections.latest}
                        onChange={() => onToggleVisibleSection?.('latest')}
                      />
                      <span>Latest Agent Message</span>
                    </label>
                    <label className="settings-checkbox-item">
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={activeVisibleSections.tool}
                        onChange={() => onToggleVisibleSection?.('tool')}
                      />
                      <span>Current Tool Activity</span>
                    </label>
                    <label className="settings-checkbox-item">
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={activeVisibleSections.conversation}
                        onChange={() => onToggleVisibleSection?.('conversation')}
                      />
                      <span>Conversation History</span>
                    </label>
                    <label className="settings-checkbox-item">
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={activeVisibleSections.chatbox}
                        onChange={() => onToggleVisibleSection?.('chatbox')}
                      />
                      <span>Message Agent (Chatbox)</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <UsagePanel />
      </div>
    </nav>
  );
};
