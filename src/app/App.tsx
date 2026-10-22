import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useDashboard } from './useDashboard';
import { useDashboardLayoutPrefs } from './useDashboardLayoutPrefs';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { WorkflowGraph } from '../features/workflow/WorkflowGraph';
import { NodeDetails } from '../features/workflow/NodeDetails';
import { AgentHistoryPanel } from '../features/agents/AgentHistoryPanel';
import type { HistoryDrag } from '../features/agents/historyDrag';
import '../features/agents/agents.css';
import { resumeHistorySession } from '../api/client';
import { GitHubPanel } from '../features/github/GitHubPanel';
import { ResizableSidebar } from '../components/ui/ResizableSidebar';
import { PrerequisitesGate } from '../components/ui/PrerequisitesGate';
import { TopBar } from './TopBar';
import { SettingsPage } from './SettingsPage';
import { BottomPanel } from './BottomPanel';
import { fetchPrerequisites } from '../api/client';
import type { InboxItem, PrerequisitesStatus } from '../../shared/contracts';
import '../styles/activity.css';
import '../styles/inbox.css';
import { useInbox } from '../features/inbox/useInbox';
import { InboxPanel } from '../features/inbox/InboxPanel';
import { useConfirmationState } from '../hooks/useConfirmationState';
import { useKanban } from '../features/kanban/useKanban';
import { KanbanBoard } from '../features/kanban/KanbanBoard';
import '../styles/kanban.css';
import { Modal } from '../components/ui/Modal';
import { Icon } from '../components/ui/Icon';
import { StatusBar } from './StatusBar';
import { DashboardActions } from './DashboardActions';

export const App: React.FC = () => {
  const [pageHash, setPageHash] = useState(() => window.location.hash);
  useEffect(() => {
    const changed = () => {
      const next = window.location.hash;
      const switchingPage = pageHash.startsWith('#/settings') !== next.startsWith('#/settings');
      if (switchingPage && document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(() => { flushSync(() => setPageHash(next)); });
      } else setPageHash(next);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [pageHash]);
  const {
    inventorySection,
    projectsLoading,
    projectsError,
    selectedProjectId,
    setSelectedProjectId,
    openInboxNode,

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

  const [rightSection, setRightSection] = useState<'source' | 'agents'>(() => { try { return localStorage.getItem('vade:right-section') === 'agents' ? 'agents' : 'source'; } catch { return 'source'; } });
  const rightTabsRef = useRef<HTMLElement>(null);
  const [rightTabLine, setRightTabLine] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const bar = rightTabsRef.current;
    if (!bar) return;
    const measure = () => {
      const tab = bar.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!tab) return;
      const style = getComputedStyle(tab);
      const paddingLeft = parseFloat(style.paddingLeft);
      const paddingRight = parseFloat(style.paddingRight);
      const left = tab.offsetLeft + tab.clientLeft + paddingLeft;
      const width = Math.max(0, tab.clientWidth - paddingLeft - paddingRight);
      setRightTabLine((current) => current.left === left && current.width === width ? current : { left, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    bar.querySelectorAll('button').forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [rightSection]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [historyDrag, setHistoryDrag] = useState<HistoryDrag | null>(null);
  const historyProject = useRef(selectedProjectId); historyProject.current = selectedProjectId;
  const resumeSavedSession = useCallback(async (id: string, worktreeId: string) => {
    if (!selectedProjectId) throw new Error('Select a project before resuming a session');
    const result = await resumeHistorySession(selectedProjectId, { sessionId: id, worktreeId });
    setHistoryRevision(value => value + 1);
    if (historyProject.current === result.projectId) { refreshAll(); openInboxNode(result.projectId, result.nodeId, null); }
    return result.nodeId;
  }, [selectedProjectId, refreshAll, openInboxNode]);
  // Prerequisites State (Enforces Orca App, CLI, and Orchestration skill)
  const [prerequisites, setPrerequisites] = useState<PrerequisitesStatus | null>(null);
  const [prerequisitesLoading, setPrerequisitesLoading] = useState<boolean>(true);
  const [isCheckingPrerequisites, setIsCheckingPrerequisites] = useState<boolean>(false);
  const prerequisitesRequestRef = useRef(false);
  const prerequisitesReadyRef = useRef(false);
  const inbox = useInbox(Boolean(prerequisites?.ready));
  const kanban = useKanban(Boolean(prerequisites?.ready));
  const pendingKanbanAgent = useRef<{ projectId: string; nodeId: string; runId: string | null } | null>(null);
  const kanbanOverlay = useConfirmationState({ onClosed: () => {
    const target = pendingKanbanAgent.current;
    pendingKanbanAgent.current = null;
    if (target) openInboxNode(target.projectId, target.nodeId, target.runId);
  } });
  const [draggingKanban, setDraggingKanban] = useState(false);
  const pendingInboxItem = useRef<InboxItem | null>(null);
  const inboxModal = useConfirmationState({ onClosed: () => {
    const item = pendingInboxItem.current;
    pendingInboxItem.current = null;
    if (item?.nodeId) openInboxNode(item.projectId, item.nodeId, item.runId);
  } });

  // Stable reference for refreshAll so prerequisites check does not recreate on node/run selection
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  const checkPrerequisitesStatus = useCallback(async (isManual = false) => {
    if (prerequisitesRequestRef.current) return;
    prerequisitesRequestRef.current = true;
    if (isManual) {
      setIsCheckingPrerequisites(true);
    }
    try {
      const status = await fetchPrerequisites();
      if (status.ready && (!prerequisitesReadyRef.current || isManual)) refreshAllRef.current();
      prerequisitesReadyRef.current = status.ready;
      setPrerequisites(status);
    } catch {
      prerequisitesReadyRef.current = false;
      setPrerequisites({
        runtime: 'ade',
        git: false,
        orcaApp: false,
        orcaAppOpen: false,
        orcaCli: false,
        orchestrationSkill: false,
        orcaCliSkill: false,
        ready: false,
        issues: ['Prerequisites check failed to connect to local server.'],
      });
    } finally {
      prerequisitesRequestRef.current = false;
      setPrerequisitesLoading(false);
      if (isManual) {
        setIsCheckingPrerequisites(false);
      }
    }
  }, []);

  useEffect(() => {
    const check = () => { void checkPrerequisitesStatus(); };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    const timer = setInterval(check, 3000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [checkPrerequisitesStatus]);

  const {
    theme,
    toggleTheme,
    cardStateColors,
    setCardStateColors,
    orchestrationSeparated,
    setOrchestrationSeparated,
    commitGraphEnabled,
    setCommitGraphEnabled,
    toolActivityEnabled,
    setToolActivityEnabled,
    chatToolCallsEnabled,
    setChatToolCallsEnabled,
    visibleSections,
    handleToggleVisibleSection,
    handleResetVisibleSections,
    leftSidebarOpen,
    rightSidebarOpen,
    isNarrow,
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
  } = useDashboardLayoutPrefs(Boolean(prerequisites?.ready));

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

  if (pageHash.startsWith('#/settings')) return <SettingsPage
    section={pageHash.split('/')[2] ?? 'general'} onBack={() => { window.location.hash = ''; }}
    theme={theme} onToggleTheme={toggleTheme} cardStateColors={cardStateColors} onToggleCardStateColors={setCardStateColors}
    orchestrationSeparated={orchestrationSeparated} onToggleOrchestrationSeparated={setOrchestrationSeparated}
    commitGraphEnabled={commitGraphEnabled} onToggleCommitGraph={setCommitGraphEnabled}
    toolActivityEnabled={toolActivityEnabled} onToggleToolActivity={setToolActivityEnabled}
    chatToolCallsEnabled={chatToolCallsEnabled} onToggleChatToolCalls={setChatToolCallsEnabled}
  />;

  return (
    <div
      className="dashboard-app-root dashboard-unified-header"
      data-card-colors={cardStateColors ? 'true' : 'false'}
      style={{ '--topbar-height': `${topbarHeight}px` } as React.CSSProperties}
    >
        {/* Top Header Bar */}
        <TopBar
          topbarRef={topbarRef}
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
        />

      <div className="dashboard-workspace">
      {!leftSidebarOpen && <button type="button" className="sidebar-edge-tab sidebar-edge-left" aria-label="Open projects sidebar" title="Open projects sidebar" onClick={() => handleToggleLeft(true)}><Icon name="chevrons-right" size={14} /></button>}
      {!rightSidebarOpen && <button type="button" className="sidebar-edge-tab sidebar-edge-right" aria-label="Open tools sidebar" title="Open tools sidebar" onClick={() => handleToggleRight(true)}><Icon name="chevrons-left" size={14} /></button>}
      {/* 1. Left Project Navigation (Resizable Sidebar) */}
      {isNarrow && (leftSidebarOpen || rightSidebarOpen) && (
        <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => {
          handleToggleLeft(false);
          handleToggleRight(false);
        }} />
      )}
      <ResizableSidebar
        side="left"
        isOverlay={isNarrow}
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
          footerActions={<DashboardActions kanbanOpen={kanbanOverlay.present}
            onToggleKanban={() => kanbanOverlay.present ? kanbanOverlay.close() : kanbanOverlay.open()}
            onOpenInbox={() => { inboxModal.open(); void inbox.refresh(); }} unread={inbox.unreadCount}
            refreshing={snapshotLoading || projectsLoading} onRefresh={refreshAll} />}
          onOpenSettings={() => { window.location.hash = '/settings/general'; }}
          standalone={prerequisites?.runtime === 'ade'}
          onRegistered={id => { refreshAll(); setSelectedProjectId(id); }}
          onDeleted={refreshAll}
          failedProjectIds={inbox.failedProjectIds}
          inventorySection={inventorySection}
          loading={projectsLoading}
          error={projectsError}
          selectedProjectId={selectedProjectId}
          onSelectProject={(id) => {
            setSelectedProjectId(id);
            if (isNarrow) handleToggleLeft(false);
          }}
          snapshot={snapshot}
          isLocallyStale={isLocallyStale}
          connectionMode={connectionMode}
          onCollapse={() => handleToggleLeft(false)}
          theme={theme}
          onToggleTheme={toggleTheme}
          cardStateColors={cardStateColors}
          commitGraphEnabled={commitGraphEnabled}
          onToggleCommitGraph={setCommitGraphEnabled}
          toolActivityEnabled={toolActivityEnabled}
          onToggleToolActivity={setToolActivityEnabled}
          chatToolCallsEnabled={chatToolCallsEnabled}
          onToggleChatToolCalls={setChatToolCallsEnabled}
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
        {/* Global Warning / Alert Banners if source issues exist */}
        <div className="dashboard-alerts-container" aria-live="polite">
          {runtimeMeta?.issue && (
            <div className="banner-alert banner-alert-error" role="alert">
              <span className="font-semibold">Runtime Issue [{runtimeMeta.issue.code}]:</span>{' '}
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
            <Modal isOpen={kanbanOverlay.present} isClosing={kanbanOverlay.closing} onClose={kanbanOverlay.close}
              nonModal={draggingKanban} className={`kanban-dialog ${draggingKanban ? 'kanban-dragging' : ''}`} aria-label="Project Kanban board">
              <KanbanBoard board={kanban} projectId={selectedProjectId} onClose={kanbanOverlay.close} onDragStateChange={setDraggingKanban}
                onOpenAgent={card => {
                  if (!card.assignment) return;
                  pendingKanbanAgent.current = { projectId: card.projectId, nodeId: card.assignment.nodeId, runId: card.assignment.runId };
                  kanbanOverlay.close();
                }} />
            </Modal>
            <WorkflowGraph
              onDropKanbanCard={cardId => {
                const card = kanban.cards.find(card => card.id === cardId && card.projectId === selectedProjectId && (card.status === 'todo' || card.status === 'failed'));
                if (card) { setDraggingKanban(false); kanbanOverlay.reset(); }
                return card;
              }}
              onSendKanbanCard={(cardId, node, message, files) => selectedProjectId
                ? kanban.assign(cardId, selectedProjectId, node, selectedRunId, message, files)
                : Promise.resolve({ ok: false, message: 'No active project.' })}
              project={currentProject}
              onResumeHistory={resumeSavedSession}
              historyDrag={historyDrag}
              onRefresh={refreshAll}
              projectId={selectedProjectId}
              runId={selectedRunId}
              loading={!snapshot && (snapshotLoading || projectsLoading)}
              nodes={graph?.nodes ?? []}
              edges={graph?.edges ?? []}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              isLocallyStale={isLocallyStale || Boolean(graphMeta?.stale) || (graphMeta ? graphMeta.availability !== 'ready' : false)}
              orchestrationSeparated={prerequisites?.runtime === 'ade' ? false : orchestrationSeparated}
              toolActivityEnabled={toolActivityEnabled}
            />

            {/* Bottom Panels Container (Independently hideable, expandable, and vertically draggable) */}
            {prerequisites?.runtime !== 'ade' && <BottomPanel
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
            />}
          </div>
        </div>
      </main>

      {/* 3. Right Persistent GitHub Panel (Resizable Sidebar) */}
      <ResizableSidebar
        side="right"
        isOverlay={isNarrow}
        defaultWidth={340}
        minWidth={280}
        maxWidth={520}
        maxAvailableWidth={maxAvailableForRight}
        onWidthChange={setRightWidth}
        storageKey="orca-sidebar-right"
        isOpen={rightSidebarOpen}
        onToggle={handleToggleRight}
        ariaLabel="Source Control and Agents Sidebar"
      >
        <div className="right-tools">
          <nav ref={rightTabsRef} className="right-tool-tabs github-tabs-nav" data-section={rightSection} role="tablist" aria-label="Right sidebar sections">
            <span
              className="github-tab-indicator"
              aria-hidden="true"
              style={{
                transform: `translateX(${rightTabLine.left}px) scaleX(${rightTabLine.width})`,
                opacity: rightTabLine.width ? 1 : 0,
              }}
            />
            {(['source', 'agents'] as const).map(section => <button key={section} className={`tab-btn ${rightSection === section ? 'active' : ''}`} role="tab" aria-label={section === 'source' ? 'Source Control' : 'Agents'} title={section === 'source' ? 'Source Control' : 'Agents'} aria-selected={rightSection === section} onClick={() => { setRightSection(section); try { localStorage.setItem('vade:right-section', section); } catch {} }}><Icon name={section === 'source' ? 'git-branch' : 'message-square'} size={15} /></button>)}
            <button type="button" className="btn-icon right-tool-collapse" aria-label="Collapse tools sidebar" title="Collapse tools sidebar" onClick={() => handleToggleRight(false)}><Icon name="chevrons-right" size={14} /></button>
          </nav>
          <div className="right-tool-content" hidden={rightSection !== 'source'}>
        <GitHubPanel
          commitGraphEnabled={commitGraphEnabled}
          projectId={selectedProjectId}
          project={currentProject}
          projectKind={currentProject?.kind}
          data={gitHubData}
          loading={gitHubLoading}
          error={gitHubError}
          onRefresh={refreshGitHub}
        />
          </div>
          {rightSection === 'agents' && <div className="right-tool-content"><AgentHistoryPanel key={selectedProjectId ?? 'all'} projectId={selectedProjectId} worktrees={graph?.nodes.filter(node => node.kind === 'worktree') ?? []} onResume={resumeSavedSession} onDragSession={setHistoryDrag} onOpen={(projectId, nodeId) => openInboxNode(projectId, nodeId, null)} revision={historyRevision} /></div>}
        </div>
      </ResizableSidebar>

      {/* 4. Native Dialog Modal for Node Inspection */}
      <InboxPanel isOpen={inboxModal.present} isClosing={inboxModal.closing} onClose={inboxModal.close}
        items={inbox.items} handled={inbox.handled} onHandle={inbox.markHandled} onClear={inbox.clearItems} loading={inbox.loading}
        issue={inbox.error || inbox.section?.meta.issue?.message || null} partial={Boolean(inbox.section?.meta.partial)}
        onRefresh={() => { void inbox.refresh(); }} onOpenAgent={item => {
          if (!item.nodeId) return;
          pendingInboxItem.current = item;
          inboxModal.close();
        }} />
      <NodeDetails
        selectedRunId={selectedRunId}
        projectId={selectedProjectId}
        details={nodeDetails}
        loading={nodeDetailsLoading}
        error={nodeDetailsError}
        selectedNodeId={selectedNodeId}
        selectedNode={snapshot?.graph.data?.nodes.find((n) => n.id === selectedNodeId) ?? null}
        onClose={() => setSelectedNodeId(null)}
        onRefresh={refreshNodeDetails}
        onSessionChange={refreshAll}
        visibleSections={visibleSections}
        commitGraphEnabled={commitGraphEnabled}
        chatToolCallsEnabled={chatToolCallsEnabled}
      />
      </div>
      <StatusBar />
    </div>
  );
};
