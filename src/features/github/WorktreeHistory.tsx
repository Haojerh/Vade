import { useMemo } from 'react';
import { useGitHubActivity } from './useGitHubActivity';
import { GitHubPanel } from './GitHubPanel';

export function WorktreeHistory({ projectId, nodeId, branch, commitGraphEnabled }: { projectId: string; nodeId: string; branch?: string; commitGraphEnabled: boolean }) {
  const query = useMemo(() => ({ scope: 'worktree' as const, nodeId }), [nodeId]);
  const { gitHubData, gitHubLoading, gitHubError, loadGitHub } = useGitHubActivity({ selectedProjectId: projectId, query });
  return <>
    <p className="text-xs text-muted branch-history-note">Includes commits inherited from the base branch. Git does not record which worktree created a commit.</p>
    <GitHubPanel projectId={projectId} data={gitHubData} loading={gitHubLoading} error={gitHubError} query={query} onRefresh={() => void loadGitHub()} commitGraphEnabled={commitGraphEnabled} worktreeBranch={branch} embedded />
  </>;
}
