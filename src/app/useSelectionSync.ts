import { useState, useCallback } from 'react';

export interface UseSelectionSyncReturn {
  selectedProjectId: string | null;
  setSelectedProjectIdState: React.Dispatch<React.SetStateAction<string | null>>;
  selectedRunId: string | null;
  setSelectedRunIdState: React.Dispatch<React.SetStateAction<string | null>>;
  selectedNodeId: string | null;
  setSelectedNodeIdState: React.Dispatch<React.SetStateAction<string | null>>;
  syncUrl: (project: string | null, run: string | null, node: string | null) => void;
}

export function useSelectionSync(): UseSelectionSyncReturn {
  const initialParams = new URLSearchParams(window.location.search);
  const initialProjectId = initialParams.get('project');
  const initialRunId = initialParams.get('run');
  const initialNodeId = initialParams.get('node');

  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(initialProjectId);
  const [selectedRunId, setSelectedRunIdState] = useState<string | null>(initialRunId);
  const [selectedNodeId, setSelectedNodeIdState] = useState<string | null>(initialNodeId);

  const syncUrl = useCallback((project: string | null, run: string | null, node: string | null) => {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (run) params.set('run', run);
    if (node) params.set('node', node);
    const newSearch = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.replaceState(null, '', newSearch);
  }, []);

  return {
    selectedProjectId,
    setSelectedProjectIdState,
    selectedRunId,
    setSelectedRunIdState,
    selectedNodeId,
    setSelectedNodeIdState,
    syncUrl,
  };
}
