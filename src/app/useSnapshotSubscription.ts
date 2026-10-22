import { useState, useEffect, useRef } from 'react';
import type { DashboardSnapshot } from '../../shared/contracts';
import { fetchSnapshot, subscribeProjectEvents, withoutClosedTabs } from '../api/client';

export interface UseSnapshotSubscriptionProps {
  selectedProjectId: string | null;
  selectedRunId: string | null;
  onSnapshotArrived: (snap: DashboardSnapshot) => void;
}

export interface UseSnapshotSubscriptionReturn {
  snapshot: DashboardSnapshot | null;
  setSnapshot: React.Dispatch<React.SetStateAction<DashboardSnapshot | null>>;
  snapshotLoading: boolean;
  setSnapshotLoading: React.Dispatch<React.SetStateAction<boolean>>;
  snapshotError: string | null;
  setSnapshotError: React.Dispatch<React.SetStateAction<string | null>>;
  isLocallyStale: boolean;
  setIsLocallyStale: React.Dispatch<React.SetStateAction<boolean>>;
  connectionMode: 'sse' | 'polling' | 'disconnected';
  setConnectionMode: React.Dispatch<React.SetStateAction<'sse' | 'polling' | 'disconnected'>>;
  lastGraphObservedAtRef: React.MutableRefObject<number>;
  selectionGeneration: React.MutableRefObject<number>;
}

export function useSnapshotSubscription({
  selectedProjectId,
  selectedRunId,
  onSnapshotArrived,
}: UseSnapshotSubscriptionProps): UseSnapshotSubscriptionReturn {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [isLocallyStale, setIsLocallyStale] = useState<boolean>(false);
  const [connectionMode, setConnectionMode] = useState<'sse' | 'polling' | 'disconnected'>('disconnected');

  const selectionGeneration = useRef<number>(0);
  const lastGraphObservedAtRef = useRef<number>(0);
  const sseFailureCount = useRef<number>(0);

  // Stable callback ref
  const onSnapshotArrivedRef = useRef(onSnapshotArrived);
  onSnapshotArrivedRef.current = onSnapshotArrived;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  useEffect(() => {
    const closed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string }>).detail, current = snapshotRef.current;
      if (!current || detail?.projectId !== current.projectId) return;
      const next = withoutClosedTabs(current); snapshotRef.current = next;
      setSnapshot(next); onSnapshotArrivedRef.current(next);
    };
    window.addEventListener('ade:session-closed', closed);
    return () => window.removeEventListener('ade:session-closed', closed);
  }, []);

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

      onSnapshotArrivedRef.current(snap);
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

  return {
    snapshot,
    setSnapshot,
    snapshotLoading,
    setSnapshotLoading,
    snapshotError,
    setSnapshotError,
    isLocallyStale,
    setIsLocallyStale,
    connectionMode,
    setConnectionMode,
    lastGraphObservedAtRef,
    selectionGeneration,
  };
}
