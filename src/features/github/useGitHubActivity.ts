import { useState, useEffect, useRef, useCallback } from 'react';
import type { GitHubData, GitHubQuery } from '../../../shared/contracts';
import { fetchGitHub } from '../../api/client';

export interface UseGitHubActivityProps {
  selectedProjectId: string | null;
  query?: GitHubQuery;
}

export interface UseGitHubActivityReturn {
  gitHubData: GitHubData | null;
  setGitHubData: React.Dispatch<React.SetStateAction<GitHubData | null>>;
  gitHubLoading: boolean;
  setGitHubLoading: React.Dispatch<React.SetStateAction<boolean>>;
  gitHubError: string | null;
  setGitHubError: React.Dispatch<React.SetStateAction<string | null>>;
  githubAbortRef: React.MutableRefObject<AbortController | null>;
  githubGeneration: React.MutableRefObject<number>;
  loadGitHub: () => Promise<void>;
}

const REPOSITORY_QUERY: GitHubQuery = { scope: 'general' };

export function useGitHubActivity({ selectedProjectId, query = REPOSITORY_QUERY }: UseGitHubActivityProps): UseGitHubActivityReturn {
  const [gitHubData, setGitHubData] = useState<GitHubData | null>(null);
  const [gitHubLoading, setGitHubLoading] = useState<boolean>(false);
  const [gitHubError, setGitHubError] = useState<string | null>(null);

  const githubGeneration = useRef<number>(0);
  const githubAbortRef = useRef<AbortController | null>(null);

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
      const data = await fetchGitHub(selectedProjectId, query, abort.signal);
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
  }, [selectedProjectId, query]);

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

  return {
    gitHubData,
    setGitHubData,
    gitHubLoading,
    setGitHubLoading,
    gitHubError,
    setGitHubError,
    githubAbortRef,
    githubGeneration,
    loadGitHub,
  };
}
