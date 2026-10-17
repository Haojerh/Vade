import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useDashboard } from './useDashboard';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { WorkflowGraph } from '../features/workflow/WorkflowGraph';
import {
  NodeDetails,
  type NodeDetailsVisibleSections,
  DEFAULT_VISIBLE_SECTIONS,
} from '../features/workflow/NodeDetails';
import { ProgressPanel } from '../features/activity/ProgressPanel';
import { ActivityPanel } from '../features/activity/ActivityPanel';
import { GitHubPanel } from '../features/github/GitHubPanel';
import { ResizableSidebar } from '../components/ui/ResizableSidebar';
import { RefreshIcon } from '../components/ui/RefreshIcon';
import { PrerequisitesGate } from '../components/ui/PrerequisitesGate';
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
    gitHubQuery,
    setGitHubQuery,
    refreshGitHub,

    refreshAll,
  } = useDashboard();

  // Prerequisites State (Enforces Orca App, CLI, and Orchestration skill)
  const [prerequisites, setPrerequisites] = useState<PrerequisitesStatus | null>(null);
  const [prerequisitesLoading, setPrerequisitesLoading] = useState<boolean>(true);
  const [isCheckingPrerequisites, setIsCheckingPrerequisites] = useState<boolean>(false);

  const checkPrerequisitesStatus = useCallback(async (isManual = false) => {
    if (isManual) {
      setIsCheckingPrerequisites(true);
    }
    try {
      const status = await fetchPrerequisites();
      setPrerequisites(status);
      if (status.ready) {
        refreshAll();
      }
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
  }, [refreshAll]);

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

  // 3. Persistent Node Details visible sections
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

  const worktreeNodes = useMemo(() => {
    return (graph?.nodes ?? []).filter((n) => n.kind === 'worktree');
  }, [graph?.nodes]);

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
          onToggleCardStateColors={setCardStateColors}
          visibleSections={visibleSections}
          onToggleVisibleSection={handleToggleVisibleSection}
          onResetVisibleSections={handleResetVisibleSections}
        />
      </ResizableSidebar>

      {/* 2. Main Content Center Stage */}
      <main className="dashboard-main-stage" role="main">
        {/* Top Header Bar */}
        <header ref={topbarRef} className="dashboard-topbar">
          <div className="topbar-left-group">
            {/* Reopen Left Sidebar Button if closed */}
            {!leftSidebarOpen && (
              <button
                type="button"
                className="btn-sidebar-reopen"
                onClick={() => handleToggleLeft(true)}
                aria-label="Open projects sidebar"
                title="Open projects sidebar"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
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

          {/* Center Run Selector */}
          <div className="topbar-center-group">
            {runs.length > 0 && (
              <div className="center-run-picker">
                <label htmlFor="center-run-select" className="run-picker-label text-xs font-semibold">
                  Run:
                </label>
                <div className="custom-select-control run-select-wrapper">
                  <select
                    id="center-run-select"
                    className="center-run-select custom-select-native"
                    value={selectedRunId || ''}
                    onChange={(e) => setSelectedRunId(e.target.value || null)}
                    aria-label="Select active workflow run"
                  >
                    <option value="">Default run ({runs[0]?.sourceRunId || 'auto'})</option>
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.sourceRunId} {r.objective ? `— ${r.objective.slice(0, 40)}` : ''}
                      </option>
                    ))}
                  </select>
                  <svg
                    className="custom-select-arrow"
                    width="12"
                    height="12"
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
                </div>
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
              title="Refresh all data"
            >
              <RefreshIcon busy={snapshotLoading || projectsLoading} size={13} />
              <span className="btn-label">Refresh</span>
            </button>

            {/* Reopen Right Sidebar Button if closed */}
            {!rightSidebarOpen && (
              <button
                type="button"
                className="btn-sidebar-reopen"
                onClick={() => handleToggleRight(true)}
                aria-label="Open GitHub sidebar"
                title="Open GitHub sidebar"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                </svg>
                <span className="btn-label">GitHub</span>
              </button>
            )}
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

        {/* Stage Content: Split between Graph Viewport and Bottom Panels */}
        <div className="stage-workspace-split">
          {/* Graph Viewport (Self-contained scrollable canvas) */}
          <div className="stage-graph-container">
            <WorkflowGraph
              projectId={selectedProjectId}
              runId={selectedRunId}
              loading={!snapshot && (snapshotLoading || projectsLoading)}
              nodes={graph?.nodes ?? []}
              edges={graph?.edges ?? []}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              isLocallyStale={isLocallyStale || Boolean(graphMeta?.stale) || (graphMeta ? graphMeta.availability !== 'ready' : false)}
            />

            {/* Reopen dock indicator if bottom panel closed */}
            {!bottomPanelOpen && (
              <div className="bottom-panel-reopen-dock">
                <button
                  type="button"
                  className="btn btn-secondary btn-xs btn-reopen-dock"
                  onClick={() => persistBottomOpen(true)}
                  aria-label="Open run progress and activity panel"
                  title="Open run progress and activity panel"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                  <span>Show Run Progress & Activity</span>
                </button>
              </div>
            )}
          </div>

          {/* Draggable Vertical Separator Handle (Only when bottom panel open) */}
          {bottomPanelOpen && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-valuenow={Math.round(bottomPanelHeight)}
              aria-valuemin={minBottomHeight}
              aria-valuemax={maxBottomHeight}
              aria-label="Resize progress and activity panel"
              tabIndex={0}
              className={`stage-bottom-resizer ${isBottomDragging ? 'is-dragging' : ''}`}
              onPointerDown={handleBottomPointerDown}
              onPointerMove={handleBottomPointerMove}
              onPointerUp={handleBottomPointerUp}
              onPointerCancel={handleBottomPointerUp}
              onKeyDown={handleBottomKeyDown}
            >
              <div className="resizer-horizontal-line" />
            </div>
          )}

          {/* Bottom Panels Container (Independently hideable, expandable, and vertically draggable) */}
          <div
            className={`stage-bottom-panels-container ${isBottomDragging ? 'is-dragging' : ''} ${
              !bottomPanelOpen ? 'is-collapsed' : 'is-open'
            }`}
            style={{
              height: bottomPanelOpen ? `${bottomPanelHeight}px` : '0px',
            }}
            aria-hidden={!bottomPanelOpen}
            inert={!bottomPanelOpen ? true : undefined}
          >
            {/* Header with expand and hide controls */}
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
                  onClick={handleToggleBottomExpand}
                  aria-label={bottomPanelHeight > 340 ? 'Restore bottom panel height' : 'Expand bottom panel height'}
                  title={bottomPanelHeight > 340 ? 'Restore bottom panel height' : 'Expand bottom panel height'}
                >
                  {bottomPanelHeight > 340 ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="4 14 10 14 10 20" />
                      <polyline points="20 10 14 10 14 4" />
                      <line x1="14" y1="10" x2="21" y2="3" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  )}
                </button>

                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => persistBottomOpen(false)}
                  aria-label="Hide progress and activity panel"
                  title="Hide progress and activity panel"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Scrollable inner content: ProgressPanel + ActivityPanel */}
            <div className="bottom-panel-scrollable-content">
              <ProgressPanel
                progress={graph?.progress}
                hasSelectedRun={Boolean(effectiveRunId)}
                selectedRunObjective={effectiveRun?.objective}
              />

              <ActivityPanel
                activity={graph?.activity}
                onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
              />
            </div>
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
          projectId={selectedProjectId}
          project={currentProject}
          projectKind={currentProject?.kind}
          data={gitHubData}
          loading={gitHubLoading}
          error={gitHubError}
          query={gitHubQuery}
          onScopeChange={setGitHubQuery}
          availableWorktrees={worktreeNodes}
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
        onClose={() => setSelectedNodeId(null)}
        onRefresh={refreshNodeDetails}
        visibleSections={visibleSections}
      />
    </div>
  );
};
