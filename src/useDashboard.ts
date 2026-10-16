import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  DashboardSnapshot,
  GitHubData,
  GitHubQuery,
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

  // Selected Node (for modal inspection)
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  nodeDetails: NodeDetails | null;
  nodeDetailsLoading: boolean;
  nodeDetailsError: string | null;
  refreshNodeDetails: () => void;
  loadNewerConversation: () => void;

  // Snapshot & Graph
  snapshot: DashboardSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  isLocallyStale: boolean;
  connectionMode: 'sse' | 'polling' | 'disconnected';

  // GitHub Data & Scope
  gitHubData: GitHubData | null;
  gitHubLoading: boolean;
  gitHubError: string | null;
  gitHubQuery: GitHubQuery;
  setGitHubQuery: (query: GitHubQuery) => void;
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
  const [gitHubQuery, setGitHubQueryState] = useState<GitHubQuery>({ scope: 'general' });

  // References to track generation & timing
  const selectionGeneration = useRef<number>(0);
  const nodeGeneration = useRef<number>(0);
  const githubGeneration = useRef<number>(0);
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
    nodeGeneration.current += 1;
    githubGeneration.current += 1;

    setSelectedProjectIdState(id);
    setSelectedRunIdState(null); // Reset run on project change
    setSelectedNodeIdState(null); // Reset node modal selection
    setGitHubQueryState({ scope: 'general' }); // Reset GitHub scope to general

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
    nodeGeneration.current += 1;
    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
      nodeAbortRef.current = null;
    }
    setSelectedRunIdState(id);
    setSelectedNodeIdState(null);
    setNodeDetails(null);
    setNodeDetailsLoading(false);
    setNodeDetailsError(null);
    setSnapshot(null);
    setSnapshotLoading(true);
    setSnapshotError(null);
    lastGraphObservedAtRef.current = 0;
    setIsLocallyStale(true);
    syncUrl(selectedProjectId, id, null);
  }, [selectedProjectId, syncUrl]);

  const setSelectedNodeId = useCallback((id: string | null) => {
    nodeGeneration.current += 1;
    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
      nodeAbortRef.current = null;
    }
    setSelectedNodeIdState(id);
    setNodeDetails(null);
    setNodeDetailsError(null);
    setNodeDetailsLoading(Boolean(id));
    syncUrl(selectedProjectId, selectedRunId, id);
  }, [selectedProjectId, selectedRunId, syncUrl]);

  const setGitHubQuery = useCallback((query: GitHubQuery) => {
    githubGeneration.current += 1;
    if (githubAbortRef.current) {
      githubAbortRef.current.abort();
      githubAbortRef.current = null;
    }
    setGitHubData(null);
    setGitHubError(null);
    setGitHubLoading(true);
    setGitHubQueryState(query);
  }, []);

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

      if (isAvailable && !isSourceStale && !hasIssue && graphMeta.observedAt) {
        const obsEpoch = new Date(graphMeta.observedAt).getTime();
        lastGraphObservedAtRef.current = isNaN(obsEpoch) ? Date.now() : obsEpoch;
        setIsLocallyStale(Date.now() - lastGraphObservedAtRef.current > 15000);
      } else {
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

      // Verify that if a node was selected, it still exists in the fresh snapshot
      setSelectedNodeIdState((currentNodeId) => {
        if (currentNodeId) {
          const nodeExists = snap.graph.data?.nodes?.some((n) => n.id === currentNodeId);
          if (!nodeExists) {
            setNodeDetails(null);
            setNodeDetailsError(null);
            setNodeDetailsLoading(false);
            if (nodeAbortRef.current) {
              nodeAbortRef.current.abort();
              nodeAbortRef.current = null;
            }
            syncUrl(selectedProjectId, selectedRunId, null);
            return null;
          }
        }
        return currentNodeId;
      });

      // Verify that if a run was selected, it still exists in the fresh snapshot
      setSelectedRunIdState((currentRunId) => {
        if (currentRunId) {
          const runExists = snap.graph.data?.runs?.some((r) => r.id === currentRunId);
          if (!runExists) {
            syncUrl(selectedProjectId, null, null);
            return null;
          }
        }
        return currentRunId;
      });

      // Verify that if a worktree scope is selected in GitHub, it still exists
      setGitHubQueryState((prev) => {
        if (prev.scope === 'worktree') {
          const worktreeExists = snap.graph.data?.nodes?.some(
            (n) => n.kind === 'worktree' && n.id === prev.nodeId,
          );
          if (!worktreeExists) {
            return { scope: 'general' };
          }
        }
        return prev;
      });
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
  }, [selectedProjectId, selectedRunId]);

  // Load GitHub data for selected project and scope
  const loadGitHub = useCallback(async () => {
    if (!selectedProjectId) {
      setGitHubData(null);
      return;
    }

    const currentGen = ++githubGeneration.current;

    if (githubAbortRef.current) {
      githubAbortRef.current.abort();
    }
    const abort = new AbortController();
    githubAbortRef.current = abort;

    setGitHubLoading(true);
    setGitHubError(null);

    try {
      const data = await fetchGitHub(selectedProjectId, gitHubQuery, abort.signal);
      if (!abort.signal.aborted && currentGen === githubGeneration.current) {
        setGitHubData(data);
      }
    } catch (err: any) {
      if (!abort.signal.aborted && currentGen === githubGeneration.current) {
        setGitHubError(err.message || 'Failed to load GitHub activity');
      }
    } finally {
      if (!abort.signal.aborted && currentGen === githubGeneration.current) {
        setGitHubLoading(false);
      }
    }
  }, [selectedProjectId, gitHubQuery]);

  useEffect(() => {
    loadGitHub();
    const interval = setInterval(loadGitHub, 60000);
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

      const currentGen = ++nodeGeneration.current;

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
          {
            runId: selectedRunId,
            cursor: cursor || undefined,
            limit: 20,
          },
          abort.signal,
        );

        if (abort.signal.aborted || currentGen !== nodeGeneration.current) return;

        if (cursor && nodeDetails && details.conversation?.data && nodeDetails.conversation?.data) {
          // If source changed, reset to new page
          if (details.conversation.data.sourceIdentity !== nodeDetails.conversation.data.sourceIdentity) {
            setNodeDetails(details);
          } else {
            // Deduplicate by message ID and merge chronologically
            const existing = nodeDetails.conversation.data.messages;
            const incoming = details.conversation.data.messages;
            const existingIds = new Set(existing.map((m) => m.id));
            const newMessages = incoming.filter((m) => !existingIds.has(m.id));
            const combined = [...existing, ...newMessages];

            setNodeDetails({
              ...details,
              conversation: {
                ...details.conversation,
                data: {
                  ...details.conversation.data,
                  messages: combined,
                },
              },
            });
          }
        } else {
          setNodeDetails(details);
        }
      } catch (err: any) {
        if (!abort.signal.aborted && currentGen === nodeGeneration.current) {
          setNodeDetailsError(err.message || 'Failed to load node details');
        }
      } finally {
        if (!abort.signal.aborted && currentGen === nodeGeneration.current) {
          setNodeDetailsLoading(false);
        }
      }
    },
    [selectedProjectId, selectedNodeId, selectedRunId, nodeDetails],
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
  }, [selectedProjectId, selectedNodeId, selectedRunId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshNodeDetails = useCallback(() => {
    loadNodeDetails();
  }, [loadNodeDetails]);

  const loadNewerConversation = useCallback(() => {
    const nextCursor = nodeDetails?.conversation?.data?.nextCursor;
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
    if (selectedProjectId) {
      const generation = selectionGeneration.current;
      setSnapshotLoading(true);
      void fetchSnapshot(selectedProjectId, selectedRunId).then((next) => {
        if (generation !== selectionGeneration.current) return;
        setSnapshot(next);
        setSnapshotError(null);
        const observed = Date.parse(next.graph.meta.observedAt ?? '');
        lastGraphObservedAtRef.current = Number.isFinite(observed) ? observed : 0;
        setIsLocallyStale(next.graph.meta.stale || next.graph.meta.availability !== 'ready' ||
          !Number.isFinite(observed) || Date.now() - observed > 15000);
      }).catch((error) => {
        if (generation === selectionGeneration.current) setSnapshotError(error.message || 'Snapshot refresh failed');
      }).finally(() => {
        if (generation === selectionGeneration.current) setSnapshotLoading(false);
      });
    }
  }, [loadProjects, loadGitHub, selectedNodeId, loadNodeDetails, selectedProjectId, selectedRunId]);

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
    loadNewerConversation,

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
    refreshGitHub: loadGitHub,

    refreshAll,
  };
}
