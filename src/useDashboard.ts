import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  DashboardSnapshot,
  GitHubData,
  Inventory,
  NodeDetails,
  Section,
} from '../shared/contracts';
import {
  fetchProjects,
  fetchSnapshot,
  fetchNodeDetails,
  fetchGitHub,
  subscribeProjectEvents,
} from './api';

export interface UseDashboardReturn {
  // Inventory
  inventorySection: Section<Inventory> | null;
  projectsLoading: boolean;
  projectsError: string | null;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string) => void;

  // Selected Run
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;

  // Selected Node
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  nodeDetails: NodeDetails | null;
  nodeDetailsLoading: boolean;
  nodeDetailsError: string | null;
  refreshNodeDetails: () => void;
  loadMoreNodeOutput: () => void;

  // Snapshot & Graph
  snapshot: DashboardSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  isLocallyStale: boolean;
  connectionMode: 'sse' | 'polling' | 'disconnected';

  // GitHub Data
  gitHubData: GitHubData | null;
  gitHubLoading: boolean;
  gitHubError: string | null;
  refreshGitHub: () => void;

  // Manual global refresh
  refreshAll: () => void;
}

export function useDashboard(): UseDashboardReturn {
  // Read initial selection from URL params
  const initialParams = new URLSearchParams(window.location.search);
  const initialProjectId = initialParams.get('project');
  const initialRunId = initialParams.get('run');
  const initialNodeId = initialParams.get('node');

  // State
  const [inventorySection, setInventorySection] = useState<Section<Inventory> | null>(null);
  const [projectsLoading, setProjectsLoading] = useState<boolean>(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(initialProjectId);
  const [selectedRunId, setSelectedRunIdState] = useState<string | null>(initialRunId);
  const [selectedNodeId, setSelectedNodeIdState] = useState<string | null>(initialNodeId);

  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [isLocallyStale, setIsLocallyStale] = useState<boolean>(false);
  const [connectionMode, setConnectionMode] = useState<'sse' | 'polling' | 'disconnected'>('disconnected');

  const [nodeDetails, setNodeDetails] = useState<NodeDetails | null>(null);
  const [nodeDetailsLoading, setNodeDetailsLoading] = useState<boolean>(false);
  const [nodeDetailsError, setNodeDetailsError] = useState<string | null>(null);

  const [gitHubData, setGitHubData] = useState<GitHubData | null>(null);
  const [gitHubLoading, setGitHubLoading] = useState<boolean>(false);
  const [gitHubError, setGitHubError] = useState<string | null>(null);

  // References to track generation & timing
  const selectionGeneration = useRef<number>(0);
  const lastGraphObservedAtRef = useRef<number>(0);
  const sseFailureCount = useRef<number>(0);
  const nodeAbortRef = useRef<AbortController | null>(null);
  const githubAbortRef = useRef<AbortController | null>(null);

  // Sync URL search params without reload
  const syncUrl = useCallback((project: string | null, run: string | null, node: string | null) => {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (run) params.set('run', run);
    if (node) params.set('node', node);
    const newSearch = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.replaceState(null, '', newSearch);
  }, []);

  const setSelectedProjectId = useCallback((id: string) => {
    selectionGeneration.current += 1;
    setSelectedProjectIdState(id);
    setSelectedRunIdState(null); // Reset run on project change
    setSelectedNodeIdState(null); // Reset node on project change

    // Immediately clear old snapshot, GitHub, and inspector state
    setSnapshot(null);
    setSnapshotLoading(true);
    setSnapshotError(null);
    setGitHubData(null);
    setGitHubLoading(true);
    setGitHubError(null);
    setNodeDetails(null);
    setNodeDetailsLoading(false);
    setNodeDetailsError(null);

    // Reset observation timing and mark stale until verified
    lastGraphObservedAtRef.current = 0;
    setIsLocallyStale(true);

    // Abort pending requests
    if (githubAbortRef.current) {
      githubAbortRef.current.abort();
      githubAbortRef.current = null;
    }
    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
      nodeAbortRef.current = null;
    }

    syncUrl(id, null, null);
  }, [syncUrl]);

  const setSelectedRunId = useCallback((id: string | null) => {
    selectionGeneration.current += 1;
    setSelectedRunIdState(id);
    setSelectedNodeIdState(null);
    setNodeDetails(null);
    setNodeDetailsError(null);
    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
      nodeAbortRef.current = null;
    }
    syncUrl(selectedProjectId, id, null);
  }, [selectedProjectId, syncUrl]);

  const setSelectedNodeId = useCallback((id: string | null) => {
    setSelectedNodeIdState(id);
    syncUrl(selectedProjectId, selectedRunId, id);
  }, [selectedProjectId, selectedRunId, syncUrl]);

  // Load Inventory
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const section = await fetchProjects();
      setInventorySection(section);
      const projects = section.data?.projects ?? [];
      setSelectedProjectIdState((current) => {
        if (current && projects.some((p) => p.id === current)) {
          return current;
        }
        return projects[0]?.id ?? null;
      });
    } catch (err: any) {
      setProjectsError(err.message || 'Failed to load project inventory');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Staleness watchdog (marks stale after 15s without successful observation)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!lastGraphObservedAtRef.current) {
        setIsLocallyStale(true);
        return;
      }
      const elapsed = Date.now() - lastGraphObservedAtRef.current;
      if (elapsed > 15000) {
        setIsLocallyStale(true);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Snapshot subscription (SSE with polling fallback)
  useEffect(() => {
    if (!selectedProjectId) {
      setSnapshot(null);
      setConnectionMode('disconnected');
      return;
    }

    const currentGen = ++selectionGeneration.current;
    let cancelled = false;
    let sseCleanup: (() => void) | null = null;
    let pollingTimer: NodeJS.Timeout | null = null;

    setSnapshotLoading(true);
    setSnapshotError(null);

    const onFreshSnapshot = (snap: DashboardSnapshot) => {
      if (cancelled || currentGen !== selectionGeneration.current) return;

      const graphMeta = snap.graph.meta;
      const isAvailable = graphMeta.availability === 'ready';
      const isSourceStale = graphMeta.stale;
      const hasIssue = Boolean(graphMeta.issue);

      // Only update lastGraphObservedAtRef and clear staleness if the graph source is ready and not stale
      if (isAvailable && !isSourceStale && !hasIssue && graphMeta.observedAt) {
        const obsEpoch = new Date(graphMeta.observedAt).getTime();
        lastGraphObservedAtRef.current = isNaN(obsEpoch) ? Date.now() : obsEpoch;
        setIsLocallyStale(false);
      } else {
        // Failed, unavailable, or stale source response
        if (graphMeta.observedAt) {
          const obsEpoch = new Date(graphMeta.observedAt).getTime();
          if (!isNaN(obsEpoch)) {
            lastGraphObservedAtRef.current = obsEpoch;
          }
        }
        setIsLocallyStale(true);
      }

      setSnapshot(snap);
      setSnapshotLoading(false);
      setSnapshotError(null);

      // Auto-align selectedRunId if none selected yet
      if (!selectedRunId && snap.graph.data?.selectedRunId) {
        setSelectedRunIdState(snap.graph.data.selectedRunId);
        syncUrl(selectedProjectId, snap.graph.data.selectedRunId, selectedNodeId);
      }
    };

    const startPollingFallback = () => {
      if (cancelled) return;
      setConnectionMode('polling');
      if (sseCleanup) {
        sseCleanup();
        sseCleanup = null;
      }

      const poll = async () => {
        if (cancelled || currentGen !== selectionGeneration.current) return;
        try {
          const snap = await fetchSnapshot(selectedProjectId, selectedRunId);
          onFreshSnapshot(snap);
        } catch (err: any) {
          if (!cancelled && currentGen === selectionGeneration.current) {
            setSnapshotError(err.message || 'Snapshot polling failed');
          }
        }
      };

      poll();
      pollingTimer = setInterval(poll, 5000);
    };

    // Try SSE first
    try {
      setConnectionMode('sse');
      sseCleanup = subscribeProjectEvents(
        selectedProjectId,
        selectedRunId,
        (snap) => {
          sseFailureCount.current = 0;
          onFreshSnapshot(snap);
        },
        () => {
          sseFailureCount.current += 1;
          // After 2 consecutive failures, switch to polling fallback
          if (sseFailureCount.current >= 2) {
            startPollingFallback();
          }
        },
      );
    } catch {
      startPollingFallback();
    }

    return () => {
      cancelled = true;
      if (sseCleanup) sseCleanup();
      if (pollingTimer) clearInterval(pollingTimer);
    };
  }, [selectedProjectId, selectedRunId, selectedNodeId, syncUrl]);

  // Load GitHub data for selected project
  const loadGitHub = useCallback(async () => {
    if (!selectedProjectId) {
      setGitHubData(null);
      return;
    }

    if (githubAbortRef.current) {
      githubAbortRef.current.abort();
    }
    const abort = new AbortController();
    githubAbortRef.current = abort;

    setGitHubLoading(true);
    setGitHubError(null);

    try {
      const data = await fetchGitHub(selectedProjectId, abort.signal);
      setGitHubData(data);
    } catch (err: any) {
      if (!abort.signal.aborted) {
        setGitHubError(err.message || 'Failed to load GitHub activity');
      }
    } finally {
      if (!abort.signal.aborted) {
        setGitHubLoading(false);
      }
    }
  }, [selectedProjectId]);

  useEffect(() => {
    loadGitHub();
    const interval = setInterval(loadGitHub, 60000); // 60s background refresh
    return () => {
      clearInterval(interval);
      if (githubAbortRef.current) {
        githubAbortRef.current.abort();
      }
    };
  }, [loadGitHub]);

  // Load Node Details for selected node
  const loadNodeDetails = useCallback(
    async (cursor?: string | null) => {
      if (!selectedProjectId || !selectedNodeId) {
        setNodeDetails(null);
        return;
      }

      if (nodeAbortRef.current) {
        nodeAbortRef.current.abort();
      }
      const abort = new AbortController();
      nodeAbortRef.current = abort;

      setNodeDetailsLoading(true);
      setNodeDetailsError(null);

      try {
        const details = await fetchNodeDetails(
          selectedProjectId,
          selectedNodeId,
          cursor,
          100,
          abort.signal,
        );

        if (cursor && nodeDetails && details.output.data) {
          // Append output lines for pagination
          setNodeDetails({
            ...details,
            output: {
              ...details.output,
              data: {
                ...details.output.data,
                lines: [...(nodeDetails.output.data?.lines ?? []), ...details.output.data.lines],
              },
            },
          });
        } else {
          setNodeDetails(details);
        }
      } catch (err: any) {
        if (!abort.signal.aborted) {
          setNodeDetailsError(err.message || 'Failed to load node details');
        }
      } finally {
        if (!abort.signal.aborted) {
          setNodeDetailsLoading(false);
        }
      }
    },
    [selectedProjectId, selectedNodeId, nodeDetails],
  );

  useEffect(() => {
    if (selectedNodeId) {
      loadNodeDetails();
    } else {
      setNodeDetails(null);
    }
    return () => {
      if (nodeAbortRef.current) {
        nodeAbortRef.current.abort();
      }
    };
  }, [selectedProjectId, selectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshNodeDetails = useCallback(() => {
    loadNodeDetails();
  }, [loadNodeDetails]);

  const loadMoreNodeOutput = useCallback(() => {
    const nextCursor = nodeDetails?.output.data?.nextCursor;
    if (nextCursor) {
      loadNodeDetails(nextCursor);
    }
  }, [nodeDetails, loadNodeDetails]);

  const refreshAll = useCallback(() => {
    loadProjects();
    loadGitHub();
    if (selectedNodeId) {
      loadNodeDetails();
    }
  }, [loadProjects, loadGitHub, selectedNodeId, loadNodeDetails]);

  return {
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
    refreshGitHub: loadGitHub,

    refreshAll,
  };
}
