import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCatalogResponse } from '../../shared/contracts';
import { fetchAgentCatalog } from '../api/client';

/** The host-detected catalog is the only source of installed agent choices. */
export function useAgentCatalog(enabled = true) {
  const [catalog, setCatalog] = useState<AgentCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    try {
      const next = await fetchAgentCatalog(controller.signal);
      if (!controller.signal.aborted) setCatalog(next);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
    return () => request.current?.abort();
  }, [enabled, refresh]);
  const defaultAgent = catalog?.installed.find(agent => agent.id === catalog.defaultAgentId) ?? null;
  return { catalog, defaultAgent, loading, error, refresh };
}
