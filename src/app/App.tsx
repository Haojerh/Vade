import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useDashboard } from './useDashboard';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { WorkflowGraph } from '../features/workflow/WorkflowGraph';
import {
  NodeDetails,
  type NodeDetailsVisibleSections,
  DEFAULT_VISIBLE_SECTIONS,
} from '../features/workflow/NodeDetails';
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

  // 1. Persistent Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('orca-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // Storage unavailable
    }
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('orca-theme', theme);
    } catch {
      // Storage unavailable
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // 2. Persistent Optional Card State Coloring
  const [cardStateColors, setCardStateColors] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-card-state-colors');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true; // Default enabled as requested
  });

  useEffect(() => {
    try {
      localStorage.setItem('orca-card-state-colors', String(cardStateColors));
    } catch {
      // Storage unavailable
    }
  }, [cardStateColors]);

  // 2b. Persistent Orchestration Separated setting
  const [orchestrationSeparated, setOrchestrationSeparated] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-orchestration-separated');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true; // Default enabled as requested
  });

  useEffect(() => {
    try {
      localStorage.setItem('orca-orchestration-separated', String(orchestrationSeparated));
    } catch {
      // Storage unavailable
    }
  }, [orchestrationSeparated]);

  // 3. Persistent Node Details visible sections
  const [commitGraphEnabled, setCommitGraphEnabled] = useState(() => {
    try { return localStorage.getItem('orca-commit-graph') !== 'false'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('orca-commit-graph', String(commitGraphEnabled)); } catch { /* Storage unavailable */ } }, [commitGraphEnabled]);

  const [visibleSections, setVisibleSections] = useState<NodeDetailsVisibleSections>(() => {
    try {
      const saved = localStorage.getItem('orca-node-details-visible-sections');
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_VISIBLE_SECTIONS, ...parsed };
      }
    } catch {
      // Storage unavailable
    }
    return DEFAULT_VISIBLE_SECTIONS;
  });

  const handleToggleVisibleSection = useCallback((key: keyof NodeDetailsVisibleSections) => {
    setVisibleSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem('orca-node-details-visible-sections', JSON.stringify(next));
      } catch {
        // Storage unavailable
      }
      return next;
    });
  }, []);

  const handleResetVisibleSections = useCallback(() => {
    setVisibleSections(DEFAULT_VISIBLE_SECTIONS);
    try {
      localStorage.removeItem('orca-node-details-visible-sections');
    } catch {
      // Storage unavailable
    }
  }, []);

  // 4. Persistent Sidebar visibility & widths
  const [leftSidebarOpen, setLeftSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-left-open');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  const [rightSidebarOpen, setRightSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-right-open');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-left-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(200, Math.min(360, parsed));
      }
    } catch {
      // Storage unavailable
    }
    return 248;
  });

  const [rightWidth, setRightWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-right-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(280, Math.min(520, parsed));
      }
    } catch {
      // Storage unavailable
    }
    return 340;
  });

  // 4. Persistent Bottom Panel (Progress & Activity) State & Resizing
  const [bottomPanelOpen, setBottomPanelOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-bottom-panel-open');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true; // Default visible as requested
  });

  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(() => {
    const initialWindowHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    const initialMax = Math.max(120, Math.min(500, initialWindowHeight - 50 - 8 - 160));
    try {
      const saved = localStorage.getItem('orca-bottom-panel-height');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(120, Math.min(initialMax, parsed));
      }
    } catch {
      // Storage unavailable
    }
    return Math.max(120, Math.min(260, initialMax));
  });

  const [isBottomDragging, setIsBottomDragging] = useState<boolean>(false);
  const bottomDragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const persistBottomOpen = useCallback((open: boolean) => {
    setBottomPanelOpen(open);
    try {
      localStorage.setItem('orca-bottom-panel-open', String(open));
    } catch {
      // Storage unavailable
    }
  }, []);

  const persistBottomHeight = useCallback((height: number) => {
    setBottomPanelHeight(height);
    try {
      localStorage.setItem('orca-bottom-panel-height', String(height));
    } catch {
      // Storage unavailable
    }
  }, []);

  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const [windowHeight, setWindowHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800
  );

  const topbarRef = useRef<HTMLElement>(null);
  const [topbarHeight, setTopbarHeight] = useState<number>(50);

  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const updateHeight = () => {
      const rect = el.getBoundingClientRect();
      const height = Math.round(rect.height);
      if (height > 0) {
        setTopbarHeight(height);
      }
    };
    updateHeight();
    const ro = new ResizeObserver(() => {
      updateHeight();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isNarrow = windowWidth <= 900;

  // On narrow screens, enforce one sidebar at a time
  useEffect(() => {
    if (isNarrow && leftSidebarOpen && rightSidebarOpen) {
      setRightSidebarOpen(false);
      try {
        localStorage.setItem('orca-sidebar-right-open', 'false');
      } catch {
        // Storage unavailable
      }
    }
  }, [isNarrow, leftSidebarOpen, rightSidebarOpen]);

  const handleToggleLeft = (open: boolean) => {
    if (open && window.innerWidth <= 900) {
      setRightSidebarOpen(false);
      try {
        localStorage.setItem('orca-sidebar-right-open', 'false');
      } catch {
        // Storage unavailable
      }
    }
    setLeftSidebarOpen(open);
    try {
      localStorage.setItem('orca-sidebar-left-open', String(open));
    } catch {
      // Storage unavailable
    }
  };

  const handleToggleRight = (open: boolean) => {
    if (open && window.innerWidth <= 900) {
      setLeftSidebarOpen(false);
      try {
        localStorage.setItem('orca-sidebar-left-open', 'false');
      } catch {
        // Storage unavailable
      }
    }
    setRightSidebarOpen(open);
    try {
      localStorage.setItem('orca-sidebar-right-open', String(open));
    } catch {
      // Storage unavailable
    }
  };

  // Bottom panel vertical dragging & viewport constraint calculation
  const minBottomHeight = 120;
  const minGraphHeight = 160;
  const availableStageHeight = Math.max(minBottomHeight, windowHeight - topbarHeight - 8);
  const maxBottomHeight = Math.max(
    minBottomHeight,
    Math.min(500, availableStageHeight - minGraphHeight)
  );

  // Clamp bottomPanelHeight whenever viewport shrinks or topbar height grows
  useEffect(() => {
    setBottomPanelHeight((curr) => {
      const clamped = Math.max(minBottomHeight, Math.min(maxBottomHeight, curr));
      if (clamped !== curr) {
        persistBottomHeight(clamped);
        return clamped;
      }
      return curr;
    });
  }, [maxBottomHeight, minBottomHeight, persistBottomHeight]);

  const handleBottomPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    bottomDragStartRef.current = { startY: e.clientY, startHeight: bottomPanelHeight };
    setIsBottomDragging(true);
  };

  const handleBottomPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isBottomDragging || !bottomDragStartRef.current) return;
    const deltaY = bottomDragStartRef.current.startY - e.clientY; // dragging up increases height
    const rawHeight = bottomDragStartRef.current.startHeight + deltaY;
    const nextHeight = Math.max(minBottomHeight, Math.min(maxBottomHeight, rawHeight));
    setBottomPanelHeight(nextHeight);
  };

  const handleBottomPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isBottomDragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setIsBottomDragging(false);
    bottomDragStartRef.current = null;
    persistBottomHeight(bottomPanelHeight);
  };

  const handleBottomKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (e.key === 'ArrowUp') {
      delta = 20;
    } else if (e.key === 'ArrowDown') {
      delta = -20;
    } else if (e.key === 'Home') {
      e.preventDefault();
      persistBottomHeight(minBottomHeight);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      persistBottomHeight(maxBottomHeight);
      return;
    }

    if (delta !== 0) {
      e.preventDefault();
      const nextHeight = Math.max(minBottomHeight, Math.min(maxBottomHeight, bottomPanelHeight + delta));
      persistBottomHeight(nextHeight);
    }
  };

  // Toggle expand / restore bottom panel height
  const handleToggleBottomExpand = () => {
    if (bottomPanelHeight > 300) {
      persistBottomHeight(Math.max(minBottomHeight, Math.min(220, maxBottomHeight)));
    } else {
      persistBottomHeight(Math.max(minBottomHeight, Math.min(420, maxBottomHeight)));
    }
  };

  const minCenterWidth = 320;
  const maxAvailableForLeft = isNarrow
    ? windowWidth
    : Math.max(200, windowWidth - minCenterWidth - (rightSidebarOpen ? rightWidth : 0));
  const maxAvailableForRight = isNarrow
    ? windowWidth
    : Math.max(280, windowWidth - minCenterWidth - (leftSidebarOpen ? leftWidth : 0));

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

            {/* Reopen dock indicator if bottom panel closed */}
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
