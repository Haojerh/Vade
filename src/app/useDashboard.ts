import { useState, useEffect, useCallback } from 'react';
import type {
  DashboardSnapshot,
  GitHubData,
  Inventory,
  NodeDetails,
  Section,
} from '../../shared/contracts';
import { fetchProjects, fetchSnapshot } from '../api/client';
import { useSelectionSync } from './useSelectionSync';
import { useNodeDetailsLoader } from './useNodeDetailsLoader';
import { useGitHubActivity } from '../features/github/useGitHubActivity';
import { useSnapshotSubscription } from './useSnapshotSubscription';

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
  refreshGitHub: () => void;

  // Manual global refresh
  refreshAll: () => void;
}

export function useDashboard(): UseDashboardReturn {
  // 1. Selection & URL synchronization
  const {
    selectedProjectId,
    setSelectedProjectIdState,
    selectedRunId,
    setSelectedRunIdState,
    selectedNodeId,
    setSelectedNodeIdState,
    syncUrl,
  } = useSelectionSync();

  // 2. Inventory state
  const [inventorySection, setInventorySection] = useState<Section<Inventory> | null>(null);
  const [projectsLoading, setProjectsLoading] = useState<boolean>(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // 3. Node details loader
  const {
    nodeDetails,
    setNodeDetails,
    nodeDetailsLoading,
    setNodeDetailsLoading,
    nodeDetailsError,
    setNodeDetailsError,
    nodeAbortRef,
    nodeGeneration,
    loadNodeDetails,
    refreshNodeDetails,
  } = useNodeDetailsLoader({
    selectedProjectId,
    selectedNodeId,
    selectedRunId,
  });

  // 4. GitHub activity loader
  const {
    gitHubData,
    setGitHubData,
    gitHubLoading,
    setGitHubLoading,
    gitHubError,
    setGitHubError,
    githubAbortRef,
    githubGeneration,
    loadGitHub,
  } = useGitHubActivity({ selectedProjectId });

  // 5. Snapshot subscription & staleness watchdog
  const handleSnapshotArrived = useCallback((snap: DashboardSnapshot) => {
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
        const freshNode = snap.graph.data?.nodes?.find((n) => n.id === currentNodeId);
        if (freshNode) {
          setNodeDetails((prev) => (prev && prev.node.id === currentNodeId ? { ...prev, node: freshNode } : prev));
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


  }, [selectedProjectId, selectedRunId, syncUrl, setNodeDetails, setNodeDetailsError, setNodeDetailsLoading, nodeAbortRef, setSelectedNodeIdState, setSelectedRunIdState]);

  const {
    snapshot,
    setSnapshot,
    snapshotLoading,
    setSnapshotLoading,
    snapshotError,
    setSnapshotError,
    isLocallyStale,
    setIsLocallyStale,
    connectionMode,
    lastGraphObservedAtRef,
    selectionGeneration,
  } = useSnapshotSubscription({
    selectedProjectId,
    selectedRunId,
    onSnapshotArrived: handleSnapshotArrived,
  });

  // Mutator for changing selected project
  const setSelectedProjectId = useCallback((id: string) => {
    selectionGeneration.current += 1;
    nodeGeneration.current += 1;
    githubGeneration.current += 1;

    setSelectedProjectIdState(id);
    setSelectedRunIdState(null);
    setSelectedNodeIdState(null);

    setSnapshot(null);
    setSnapshotLoading(true);
    setSnapshotError(null);
    setGitHubData(null);
    setGitHubLoading(true);
    setGitHubError(null);
    setNodeDetails(null);
    setNodeDetailsLoading(false);
    setNodeDetailsError(null);

    lastGraphObservedAtRef.current = 0;
    setIsLocallyStale(true);

    if (githubAbortRef.current) {
      githubAbortRef.current.abort();
      githubAbortRef.current = null;
    }
    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
      nodeAbortRef.current = null;
    }

    syncUrl(id, null, null);
  }, [selectionGeneration, nodeGeneration, githubGeneration, setSelectedProjectIdState, setSelectedRunIdState, setSelectedNodeIdState, setSnapshot, setSnapshotLoading, setSnapshotError, setGitHubData, setGitHubLoading, setGitHubError, setNodeDetails, setNodeDetailsLoading, setNodeDetailsError, lastGraphObservedAtRef, setIsLocallyStale, githubAbortRef, nodeAbortRef, syncUrl]);

  // Mutator for changing selected run
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
  }, [selectionGeneration, nodeGeneration, nodeAbortRef, setSelectedRunIdState, setSelectedNodeIdState, setNodeDetails, setNodeDetailsLoading, setNodeDetailsError, setSnapshot, setSnapshotLoading, setSnapshotError, lastGraphObservedAtRef, setIsLocallyStale, syncUrl, selectedProjectId]);

  // Mutator for changing selected node
  const setSelectedNodeId = useCallback((id: string | null) => {
    nodeGeneration.current += 1;
    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
      nodeAbortRef.current = null;
    }
    setSelectedNodeIdState(id);
    if (!id) {
      setNodeDetails(null);
      setNodeDetailsError(null);
      setNodeDetailsLoading(false);
    } else {
      setNodeDetails((prev) => (prev && prev.node.id === id ? prev : null));
      setNodeDetailsError(null);
      setNodeDetailsLoading(true);
    }
    syncUrl(selectedProjectId, selectedRunId, id);
  }, [nodeGeneration, nodeAbortRef, setSelectedNodeIdState, setNodeDetails, setNodeDetailsError, setNodeDetailsLoading, syncUrl, selectedProjectId, selectedRunId]);

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
  }, [setSelectedProjectIdState]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Global refresh
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
  }, [loadProjects, loadGitHub, selectedNodeId, loadNodeDetails, selectedProjectId, selectionGeneration, setSnapshotLoading, selectedRunId, setSnapshot, setSnapshotError, lastGraphObservedAtRef, setIsLocallyStale]);

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
