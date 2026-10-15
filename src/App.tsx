import React, { useState, useEffect } from 'react';
import { useDashboard } from './useDashboard';
import { ProjectSelector } from './components/ProjectSelector';
import { WorkflowGraph } from './components/WorkflowGraph';
import { NodeDetails } from './components/NodeDetails';
import { ProgressPanel } from './components/ProgressPanel';
import { ActivityPanel } from './components/ActivityPanel';
import { GitHubPanel } from './components/GitHubPanel';

export const App: React.FC = () => {
  const {
    inventorySection,
    projectsLoading,
    projectsError,
    selectedProjectId,
    setSelectedProjectId,

    selectedRunId,
    setSelectedRunId,

    selectedNodeId,
    setSelectedNodeId,
    nodeDetails,
    nodeDetailsLoading,
    nodeDetailsError,
    refreshNodeDetails,
    loadMoreNodeOutput,

    snapshot,
    snapshotLoading,
    snapshotError,
    isLocallyStale,
    connectionMode,

    gitHubData,
    gitHubLoading,
    gitHubError,
    refreshGitHub,

    refreshAll,
  } = useDashboard();

  // Right sidebar tab: 'inspector' | 'activity' | 'github'
  const [rightPanelTab, setRightPanelTab] = useState<'inspector' | 'activity' | 'github'>('inspector');

  // When a node is selected, auto-switch right panel to inspector
  useEffect(() => {
    if (selectedNodeId) {
      setRightPanelTab('inspector');
    }
  }, [selectedNodeId]);

  const projects = inventorySection?.data?.projects ?? [];
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const graph = snapshot?.graph?.data;
  const graphMeta = snapshot?.graph?.meta;
  const runtimeMeta = snapshot?.runtime?.meta;

  const currentRun = graph?.runs?.find((r) => r.id === selectedRunId);

  const formatIso = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return iso;
    }
  };

  return (
    <div className="dashboard-app-root">
      {/* 1. Left Project Rail */}
      <ProjectSelector
        inventorySection={inventorySection}
        loading={projectsLoading}
        error={projectsError}
        selectedProjectId={selectedProjectId}
        onSelectProject={setSelectedProjectId}
        snapshot={snapshot}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
        isLocallyStale={isLocallyStale}
        connectionMode={connectionMode}
      />

      {/* 2. Main Content Center Stage */}
      <main className="dashboard-main-stage" role="main">
        {/* Top Header Bar */}
        <header className="dashboard-topbar">
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
            {currentProject?.paths?.[0] && (
              <div className="active-project-path font-mono text-xs text-muted" title={currentProject.paths[0]}>
                {currentProject.paths[0]}
              </div>
            )}
          </div>

          <div className="topbar-meta-controls">
            {/* Freshness / Staleness Badge */}
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
                  <span>Observed: {formatIso(graphMeta?.observedAt || snapshot?.generatedAt)}</span>
                )}
              </span>
            </div>

            {/* Global Refresh Button */}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={refreshAll}
              disabled={snapshotLoading || projectsLoading}
              aria-label="Refresh all data"
            >
              <svg
                className={`refresh-icon ${snapshotLoading ? 'spin' : ''}`}
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
              <span>Refresh</span>
            </button>
          </div>
        </header>

        {/* Global Warning / Alert Banners if source issues exist */}
        <div className="dashboard-alerts-container" aria-live="polite">
          {runtimeMeta?.issue && (
            <div className="banner-alert banner-alert-error" role="alert">
              <span className="font-semibold">Orca Runtime Issue [{runtimeMeta.issue.code}]:</span>{' '}
              {runtimeMeta.issue.message}
            </div>
          )}

          {graphMeta?.issue && (
            <div className="banner-alert banner-alert-error" role="alert">
              <span className="font-semibold">Graph Observation Error [{graphMeta.issue.code}]:</span>{' '}
              {graphMeta.issue.message}
            </div>
          )}

          {graphMeta?.partial && (
            <div className="banner-alert banner-alert-info">
              <span className="font-semibold">Partial Graph Scope:</span> Host limits or discovery bounds capped the workspace enumeration.
            </div>
          )}

          {snapshotError && (
            <div className="banner-alert banner-alert-warning" role="alert">
              <span className="font-semibold">Connection Alert:</span> {snapshotError}
            </div>
          )}
        </div>

        {/* Graph & Central Viewport */}
        <div className="stage-scrollable-content">
          <WorkflowGraph
            nodes={graph?.nodes ?? []}
            edges={graph?.edges ?? []}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            isLocallyStale={isLocallyStale || Boolean(graphMeta?.stale) || (graphMeta ? graphMeta.availability !== 'ready' : false)}
          />

          {/* Progress Panel for Selected Run */}
          <div className="stage-bottom-panels">
            <ProgressPanel
              progress={graph?.progress}
              hasSelectedRun={Boolean(selectedRunId)}
              selectedRunObjective={currentRun?.objective}
            />
          </div>
        </div>
      </main>

      {/* 3. Right Inspector & Detail Surface */}
      <aside className="dashboard-right-panel" aria-label="Inspector and external telemetry">
        {/* Top Tab Bar for Right Panel */}
        <div className="right-panel-nav" role="tablist" aria-label="Detail views">
          <button
            type="button"
            role="tab"
            id="tab-btn-inspector"
            aria-selected={rightPanelTab === 'inspector'}
            aria-controls="panel-view-inspector"
            className={`tab-btn ${rightPanelTab === 'inspector' ? 'active' : ''}`}
            onClick={() => setRightPanelTab('inspector')}
          >
            Node Inspector
            {selectedNodeId && <span className="tab-dot" />}
          </button>

          <button
            type="button"
            role="tab"
            id="tab-btn-activity"
            aria-selected={rightPanelTab === 'activity'}
            aria-controls="panel-view-activity"
            className={`tab-btn ${rightPanelTab === 'activity' ? 'active' : ''}`}
            onClick={() => setRightPanelTab('activity')}
          >
            Activity
            <span className="tab-count font-mono">{graph?.activity?.length ?? 0}</span>
          </button>

          <button
            type="button"
            role="tab"
            id="tab-btn-github"
            aria-selected={rightPanelTab === 'github'}
            aria-controls="panel-view-github"
            className={`tab-btn ${rightPanelTab === 'github' ? 'active' : ''}`}
            onClick={() => setRightPanelTab('github')}
          >
            GitHub
          </button>
        </div>

        {/* Tab Contents */}
        <div className="right-panel-content">
          {rightPanelTab === 'inspector' && (
            <div id="panel-view-inspector" role="tabpanel" aria-labelledby="tab-btn-inspector">
              <NodeDetails
                details={nodeDetails}
                loading={nodeDetailsLoading}
                error={nodeDetailsError}
                selectedNodeId={selectedNodeId}
                onClose={() => setSelectedNodeId(null)}
                onRefresh={refreshNodeDetails}
                onLoadMore={loadMoreNodeOutput}
              />
            </div>
          )}

          {rightPanelTab === 'activity' && (
            <div id="panel-view-activity" role="tabpanel" aria-labelledby="tab-btn-activity">
              <ActivityPanel
                activity={graph?.activity}
                onSelectNode={(nodeId) => {
                  setSelectedNodeId(nodeId);
                  setRightPanelTab('inspector');
                }}
              />
            </div>
          )}

          {rightPanelTab === 'github' && (
            <div id="panel-view-github" role="tabpanel" aria-labelledby="tab-btn-github">
              <GitHubPanel
                data={gitHubData}
                loading={gitHubLoading}
                error={gitHubError}
                onRefresh={refreshGitHub}
              />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};
