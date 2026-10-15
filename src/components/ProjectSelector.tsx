import React from 'react';
import type { DashboardSnapshot, Inventory, Section } from '../../shared/contracts';

interface ProjectSelectorProps {
  inventorySection: Section<Inventory> | null;
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  snapshot: DashboardSnapshot | null;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  isLocallyStale: boolean;
  connectionMode: 'sse' | 'polling' | 'disconnected';
}

export const ProjectSelector: React.FC<ProjectSelectorProps> = ({
  inventorySection,
  loading,
  error,
  selectedProjectId,
  onSelectProject,
  snapshot,
  selectedRunId,
  onSelectRun,
  isLocallyStale,
  connectionMode,
}) => {
  const projects = inventorySection?.data?.projects ?? [];
  const runs = snapshot?.graph?.data?.runs ?? [];
  const runtime = snapshot?.runtime?.data;
  const runtimeMeta = snapshot?.runtime?.meta;

  return (
    <aside className="project-rail" aria-label="Projects and runs navigation">
      {/* Brand Header */}
      <div className="rail-brand">
        <div className="brand-title-row">
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
          <h1 className="brand-name">Orca Live</h1>
        </div>
        <div className="brand-tagline">Workflow Atlas</div>
      </div>

      {/* Runtime / Connection Badge */}
      {(() => {
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
                  <span className="meta-val">Unknown</span>
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
      })()}

      {/* Mobile Selector Dropdown */}
      <div className="rail-mobile-select">
        <label htmlFor="mobile-project-select" className="rail-section-label">
          Active Project
        </label>
        <select
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
        </select>
      </div>

      {/* Project Navigation List */}
      <div className="rail-section">
        <div className="rail-section-header">
          <span className="rail-section-label">Projects</span>
          <span className="rail-section-badge font-mono">{projects.length}</span>
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

        <ul className="project-list" role="list">
          {projects.map((proj) => {
            const isSelected = proj.id === selectedProjectId;
            const primaryPath = proj.paths[0] || '';
            const displayPath = primaryPath.length > 32
              ? '…' + primaryPath.slice(-30)
              : primaryPath;

            return (
              <li key={proj.id} className="project-item">
                <button
                  type="button"
                  className={`project-button ${isSelected ? 'active' : ''}`}
                  onClick={() => onSelectProject(proj.id)}
                  aria-pressed={isSelected}
                  aria-label={`Select project ${proj.name}, kind: ${proj.kind}`}
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
              </li>
            );
          })}
        </ul>
      </div>

      {/* Associated Runs Section */}
      <div className="rail-section rail-runs-section">
        <div className="rail-section-header">
          <span className="rail-section-label">Associated Runs</span>
          <span className="rail-section-badge font-mono">{runs.length}</span>
        </div>

        {runs.length === 0 ? (
          <div className="rail-empty-hint">No associated runs for this project.</div>
        ) : (
          <ul className="run-list" role="list">
            {runs.map((r) => {
              const isSelected = r.id === selectedRunId;
              return (
                <li key={r.id} className="run-item">
                  <button
                    type="button"
                    className={`run-button ${isSelected ? 'active' : ''}`}
                    onClick={() => onSelectRun(r.id)}
                    aria-pressed={isSelected}
                    aria-label={`Run ${r.sourceRunId}: ${r.objective}`}
                  >
                    <div className="run-header">
                      <span className="run-id font-mono">{r.sourceRunId}</span>
                      <span className="run-association-badge">{r.association}</span>
                    </div>
                    <div className="run-objective" title={r.objective}>
                      {r.objective || '(no objective)'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Rail Footer */}
      <div className="rail-footer">
        <div className="rail-footer-text">Orca Multi-Agent System</div>
        <div className="rail-footer-sub">Read-Only Live Monitor</div>
      </div>
    </aside>
  );
};
