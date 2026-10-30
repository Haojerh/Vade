import { useMemo } from 'react';
import { useGitHubActivity } from '../../hooks/github/useGitHubActivity';
import { GitHubPanel } from './GitHubPanel';

export function WorktreeHistory({ projectId, nodeId, branch, commitGraphEnabled }: { projectId: string; nodeId: string; branch?: string; commitGraphEnabled: boolean }) {
  const query = useMemo(() => ({ scope: 'worktree' as const, nodeId }), [nodeId]);
  const { gitHubData, gitHubLoading, gitHubError, loadGitHub } = useGitHubActivity({ selectedProjectId: projectId, query });
  return <>
    <GitHubPanel projectId={projectId} data={gitHubData} loading={gitHubLoading} error={gitHubError} query={query} onRefresh={() => void loadGitHub()} commitGraphEnabled={commitGraphEnabled} worktreeBranch={branch} embedded />
  </>;
}
