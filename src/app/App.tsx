import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDashboard } from './useDashboard';
import { useDashboardLayoutPrefs } from './useDashboardLayoutPrefs';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { WorkflowGraph } from '../features/workflow/WorkflowGraph';
import { NodeDetails } from '../features/workflow/NodeDetails';
import { GitHubPanel } from '../features/github/GitHubPanel';
import { ResizableSidebar } from '../components/ui/ResizableSidebar';
import { PrerequisitesGate } from '../components/ui/PrerequisitesGate';
import { TopBar } from './TopBar';
import { BottomPanel } from './BottomPanel';
import { fetchPrerequisites } from '../api/client';
import type { PrerequisitesStatus } from '../../shared/contracts';
import '../styles/activity.css';

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

  // Prerequisites State (Enforces Orca App, CLI, and Orchestration skill)
  const [prerequisites, setPrerequisites] = useState<PrerequisitesStatus | null>(null);
  const [prerequisitesLoading, setPrerequisitesLoading] = useState<boolean>(true);
  const [isCheckingPrerequisites, setIsCheckingPrerequisites] = useState<boolean>(false);

  // Stable reference for refreshAll so prerequisites check does not recreate on node/run selection
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  const checkPrerequisitesStatus = useCallback(async (isManual = false) => {
    if (isManual) {
      setIsCheckingPrerequisites(true);
    }
    try {
      const status = await fetchPrerequisites();
      setPrerequisites((prev) => {
        if (status.ready && (!prev || !prev.ready || isManual)) {
          refreshAllRef.current();
        }
        return status;
      });
    } catch {
      setPrerequisites({
        orcaApp: false,
        orcaAppOpen: false,
        orcaCli: false,
        orchestrationSkill: false,
        orcaCliSkill: false,
        ready: false,
        issues: ['Prerequisites check failed to connect to local server.'],
      });
    } finally {
      setPrerequisitesLoading(false);
      if (isManual) {
        setIsCheckingPrerequisites(false);
      }
    }
  }, []);

  useEffect(() => {
    checkPrerequisitesStatus();
  }, [checkPrerequisitesStatus]);

  useEffect(() => {
    if (prerequisites && !prerequisites.ready) {
      const timer = setInterval(() => {
        checkPrerequisitesStatus();
      }, 5000);
      return () => clearInterval(timer);
    }
  }, [prerequisites, checkPrerequisitesStatus]);

  const {
    theme,
    toggleTheme,
    cardStateColors,
    setCardStateColors,
    orchestrationSeparated,
    setOrchestrationSeparated,
    commitGraphEnabled,
    setCommitGraphEnabled,
    visibleSections,
    handleToggleVisibleSection,
    handleResetVisibleSections,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftWidth,
    setRightWidth,
    handleToggleLeft,
    handleToggleRight,
    maxAvailableForLeft,
    maxAvailableForRight,
    topbarRef,
    topbarHeight,
    bottomPanelOpen,
    persistBottomOpen,
    bottomPanelHeight,
    minBottomHeight,
    maxBottomHeight,
    isBottomDragging,
    handleBottomPointerDown,
    handleBottomPointerMove,
    handleBottomPointerUp,
    handleBottomKeyDown,
    handleToggleBottomExpand,
  } = useDashboardLayoutPrefs();

  const projects = inventorySection?.data?.projects ?? [];
  const currentProject = projects.find((p) => p.id === selectedProjectId);
  const graph = snapshot?.graph?.data;
  const graphMeta = snapshot?.graph?.meta;
  const runtimeMeta = snapshot?.runtime?.meta;

  const runs = graph?.runs ?? [];
  // Effective run ID: explicit selection, backend default graph.selectedRunId, or fallback to first run
  const effectiveRunId = selectedRunId ?? graph?.selectedRunId ?? runs[0]?.id ?? null;
  const effectiveRun = runs.find((r) => r.id === effectiveRunId) ?? runs[0];

  // If checking initially or prerequisites not met, block user with PrerequisitesGate
  if (prerequisitesLoading && !prerequisites) {
    return (
      <div className="dashboard-app-root">
        <PrerequisitesGate
          prerequisites={null}
          loading={true}
          onRecheck={() => checkPrerequisitesStatus(true)}
          isChecking={false}
        />
      </div>
    );
  }

  if (prerequisites && !prerequisites.ready) {
    return (
      <div className="dashboard-app-root">
        <PrerequisitesGate
          prerequisites={prerequisites}
          loading={prerequisitesLoading}
          onRecheck={() => checkPrerequisitesStatus(true)}
          isChecking={isCheckingPrerequisites}
        />
      </div>
    );
  }

  return (
    <div
      className="dashboard-app-root"
      data-card-colors={cardStateColors ? 'true' : 'false'}
      style={{ '--topbar-height': `${topbarHeight}px` } as React.CSSProperties}
    >
      {/* 1. Left Project Navigation (Resizable Sidebar) */}
      <ResizableSidebar
        side="left"
        defaultWidth={248}
        minWidth={200}
        maxWidth={360}
        maxAvailableWidth={maxAvailableForLeft}
        onWidthChange={setLeftWidth}
        storageKey="orca-sidebar-left"
        isOpen={leftSidebarOpen}
        onToggle={handleToggleLeft}
        ariaLabel="Projects Navigation Sidebar"
      >
        <ProjectSelector
          inventorySection={inventorySection}
          loading={projectsLoading}
          error={projectsError}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
          snapshot={snapshot}
          isLocallyStale={isLocallyStale}
          connectionMode={connectionMode}
          onCollapse={() => handleToggleLeft(false)}
          theme={theme}
          onToggleTheme={toggleTheme}
          cardStateColors={cardStateColors}
          commitGraphEnabled={commitGraphEnabled}
          onToggleCommitGraph={setCommitGraphEnabled}
          onToggleCardStateColors={setCardStateColors}
          orchestrationSeparated={orchestrationSeparated}
          onToggleOrchestrationSeparated={setOrchestrationSeparated}
          visibleSections={visibleSections}
          onToggleVisibleSection={handleToggleVisibleSection}
          onResetVisibleSections={handleResetVisibleSections}
        />
      </ResizableSidebar>

      {/* 2. Main Content Center Stage */}
      <main className="dashboard-main-stage" role="main">
        {/* Top Header Bar */}
        <TopBar
          topbarRef={topbarRef}
          leftSidebarOpen={leftSidebarOpen}
          onToggleLeft={handleToggleLeft}
          rightSidebarOpen={rightSidebarOpen}
          onToggleRight={handleToggleRight}
          currentProject={currentProject}
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          isLocallyStale={isLocallyStale}
          graphMeta={graphMeta}
          connectionMode={connectionMode}
          generatedAt={snapshot?.generatedAt}
          snapshotLoading={snapshotLoading}
          projectsLoading={projectsLoading}
          onRefreshAll={refreshAll}
        />

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

        {/* Stage Content: Split between Graph Viewport and Bottom Panels */}
        <div className="stage-workspace-split">
          {/* Graph Viewport (Self-contained scrollable canvas) */}
          <div className="stage-graph-container">
            <WorkflowGraph
              project={currentProject}
              onRefresh={refreshAll}
              projectId={selectedProjectId}
              runId={selectedRunId}
              loading={!snapshot && (snapshotLoading || projectsLoading)}
              nodes={graph?.nodes ?? []}
              edges={graph?.edges ?? []}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              isLocallyStale={isLocallyStale || Boolean(graphMeta?.stale) || (graphMeta ? graphMeta.availability !== 'ready' : false)}
              orchestrationSeparated={orchestrationSeparated}
            />

            {/* Bottom Panels Container (Independently hideable, expandable, and vertically draggable) */}
            <BottomPanel
              isOpen={bottomPanelOpen}
              onToggleOpen={persistBottomOpen}
              height={bottomPanelHeight}
              minHeight={minBottomHeight}
              maxHeight={maxBottomHeight}
              isDragging={isBottomDragging}
              onPointerDown={handleBottomPointerDown}
              onPointerMove={handleBottomPointerMove}
              onPointerUp={handleBottomPointerUp}
              onKeyDown={handleBottomKeyDown}
              onToggleExpand={handleToggleBottomExpand}
              effectiveRun={effectiveRun}
              effectiveRunId={effectiveRunId}
              progress={graph?.progress}
              activity={graph?.activity}
              onSelectNode={setSelectedNodeId}
            />
          </div>
        </div>
      </main>

      {/* 3. Right Persistent GitHub Panel (Resizable Sidebar) */}
      <ResizableSidebar
        side="right"
        defaultWidth={340}
        minWidth={280}
        maxWidth={520}
        maxAvailableWidth={maxAvailableForRight}
        onWidthChange={setRightWidth}
        storageKey="orca-sidebar-right"
        isOpen={rightSidebarOpen}
        onToggle={handleToggleRight}
        ariaLabel="GitHub Activity Sidebar"
      >
        <GitHubPanel
          commitGraphEnabled={commitGraphEnabled}
          projectId={selectedProjectId}
          project={currentProject}
          projectKind={currentProject?.kind}
          data={gitHubData}
          loading={gitHubLoading}
          error={gitHubError}
          onRefresh={refreshGitHub}
          onCollapse={() => handleToggleRight(false)}
        />
      </ResizableSidebar>

      {/* 4. Native Dialog Modal for Node Inspection */}
      <NodeDetails
        projectId={selectedProjectId}
        details={nodeDetails}
        loading={nodeDetailsLoading}
        error={nodeDetailsError}
        selectedNodeId={selectedNodeId}
        selectedNode={snapshot?.graph.data?.nodes.find((n) => n.id === selectedNodeId) ?? null}
        onClose={() => setSelectedNodeId(null)}
        onRefresh={refreshNodeDetails}
        visibleSections={visibleSections}
        commitGraphEnabled={commitGraphEnabled}
      />
    </div>
  );
};
