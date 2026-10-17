import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitHubUrl,
  parseGitRemoteOutput,
  resolveProjectRepo,
  collectGitHubData,
} from './github.js';
import { CommandRunner } from './cli.js';
import { Project, Graph } from '../../shared/contracts.js';

describe('server/github', () => {
  test('pages only the requested activity and advances past issue pages containing only PRs', async () => {
    const endpoints: string[] = [];
    const project: Project = { id: 'pagination', name: 'test', kind: 'git', sourceProjectId: 'github:owner/repo', repoIds: [], paths: [], hostIds: [] };
    const runner: CommandRunner = async (_exe, args) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/'))!;
      endpoints.push(endpoint);
      return { stdout: JSON.stringify(Array.from({ length: 20 }, (_, index) => ({
        number: index + 1, pull_request: {},
      }))), stderr: '', exitCode: 0 };
    };
    const result = await collectGitHubData(project, { scope: 'general', activity: 'issues', page: 2 }, runner);
    assert.deepEqual(endpoints, ['repos/owner/repo/issues?state=all&sort=updated&direction=desc&per_page=20&page=2']);
    assert.deepEqual(result.issues.data, []);
    assert.equal(result.pagination?.issues.nextPage, 3);
    assert.equal(result.pagination?.commits.nextPage, null);
    const last = await collectGitHubData(project, { scope: 'general', activity: 'issues', page: 10000 }, runner);
    assert.equal(last.pagination?.issues.nextPage, null);
  });
  test('parseGitHubUrl handles HTTPS, SSH and rejects unsupported hosts', () => {
    const httpsRes = parseGitHubUrl('https://github.com/Haojerh/orca-visualization.git');
    assert.equal(httpsRes.owner, 'Haojerh');
    assert.equal(httpsRes.name, 'orca-visualization');

    const sshRes = parseGitHubUrl('git@github.com:Haojerh/orca-visualization.git');
    assert.equal(sshRes.owner, 'Haojerh');
    assert.equal(sshRes.name, 'orca-visualization');

    assert.throws(
      () => parseGitHubUrl('https://gitlab.com/user/repo.git'),
      (err: any) => err.issue?.code === 'REMOTE_UNSUPPORTED'
    );

    assert.throws(
      () => parseGitHubUrl('not-a-valid-url'),
      (err: any) => err.issue?.code === 'REMOTE_MISSING'
    );
  });

  test('parseGitRemoteOutput selects origin or unambiguous remote', () => {
    const gitRemoteText = `
origin  https://github.com/Haojerh/orca-visualization.git (fetch)
origin  https://github.com/Haojerh/orca-visualization.git (push)
upstream  https://github.com/other/orca-visualization.git (fetch)
`;
    const res = parseGitRemoteOutput(gitRemoteText);
    assert.equal(res.owner, 'Haojerh');
    assert.equal(res.remoteName, 'origin');

    // Conflicting remotes without origin
    const ambiguousText = `
upstream  https://github.com/upstream/repo.git (fetch)
mirror  https://github.com/mirror/repo.git (fetch)
`;
    assert.throws(
      () => parseGitRemoteOutput(ambiguousText),
      (err: any) => err.issue?.code === 'REMOTE_AMBIGUOUS'
    );
  });

  test('collectGitHubData handles general scope with PR merged status and issues filtering', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\test'],
      hostIds: ['local'],
    };

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        return {
          stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/pulls?')) {
        return {
          stdout: JSON.stringify([
            {
              number: 42,
              title: 'Feature PR',
              html_url: 'https://github.com/Haojerh/orca-visualization/pull/42',
              state: 'closed',
              draft: false,
              user: { login: 'alice' },
              updated_at: '2026-10-15T10:00:00Z',
              merged_at: '2026-10-15T10:30:00Z',
              head: { ref: 'feat/one' },
              base: { ref: 'main' },
            },
            {
              number: 43,
              title: 'Open PR',
              html_url: 'https://github.com/Haojerh/orca-visualization/pull/43',
              state: 'open',
              draft: true,
              user: { login: 'bob' },
              updated_at: '2026-10-15T11:00:00Z',
              merged_at: null,
              head: { ref: 'feat/two' },
              base: { ref: 'main' },
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/commits?')) {
        return {
          stdout: JSON.stringify([
            {
              sha: 'sha123456789',
              commit: {
                message: 'feat: add feature\n\nbody details',
                author: { name: 'alice', date: '2026-10-15T09:00:00Z' },
              },
              html_url: 'https://github.com/Haojerh/orca-visualization/commit/sha123',
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/issues?')) {
        return {
          stdout: JSON.stringify([
            {
              number: 101,
              title: 'Real Issue',
              html_url: 'https://github.com/Haojerh/orca-visualization/issues/101',
              state: 'open',
              user: { login: 'carol' },
              updated_at: '2026-10-15T12:00:00Z',
              labels: [{ name: 'bug' }],
            },
            {
              number: 42,
              title: 'Feature PR (as issue)',
              html_url: 'https://github.com/Haojerh/orca-visualization/pull/42',
              state: 'closed',
              user: { login: 'alice' },
              pull_request: { url: 'https://api.github.com/...' },
              labels: [],
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(proj, { scope: 'general' }, fakeRunner);
    assert.equal(ghData.auth, 'available');
    assert.ok(ghData.repository);
    assert.equal(ghData.repository?.owner, 'Haojerh');
    assert.equal(ghData.scope.kind, 'general');
    assert.equal(ghData.scope.commits, 'default-branch');
    assert.equal(ghData.scope.pullRequests, 'repository');
    assert.equal(ghData.scope.issues, 'repository');

    // PRs
    assert.equal(ghData.pullRequests.meta.availability, 'ready');
    assert.equal(ghData.pullRequests.data?.length, 2);
    // PR #42 has merged_at so state is 'merged'
    assert.equal(ghData.pullRequests.data?.[0].state, 'merged');
    assert.equal(ghData.pullRequests.data?.[0].mergedAt, '2026-10-15T10:30:00.000Z');
    assert.equal(ghData.pullRequests.data?.[1].state, 'open');

    // Commits
    assert.equal(ghData.commits.meta.availability, 'ready');
    assert.equal(ghData.commits.data?.length, 1);
    assert.equal(ghData.commits.data?.[0].message, 'feat: add feature');

    // Issues: PR object filtered out
    assert.equal(ghData.issues.meta.availability, 'ready');
    assert.equal(ghData.issues.data?.length, 1);
    assert.equal(ghData.issues.data?.[0].number, 101);
    assert.deepEqual(ghData.issues.data?.[0].labels, ['bug']);
  });

  test('collectGitHubData handles worktree scope with branch and resolves worktree remote', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\default-path'],
      hostIds: ['local'],
    };

    const mockGraph: Graph = {
      runs: [],
      selectedRunId: null,
      nodes: [
        {
          id: 'node_wt1',
          kind: 'worktree',
          label: 'Feature Worktree',
          worktreeId: 'wt-1',
          runId: null,
          agentType: null,
          branch: 'feat/ui-revamp',
          path: 'C:\\worktree-path',
          state: 'idle',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: {
        total: 0,
        completed: 0,
        failed: 0,
        working: 0,
        waiting: 0,
        blocked: 0,
        unknown: 0,
        percent: null,
        coverage: 'unavailable',
        basis: 'completed-tasks',
      },
      activity: [],
    };

    let requestedSha: string | null = null;
    let requestedHead: string | null = null;

    const fakeRunner: CommandRunner = async (_exe, args, opts) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        assert.equal(opts?.cwd, 'C:\\worktree-path');
        return {
          stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/commits?')) {
        const m = cmd.match(/sha=([^&\s]+)/);
        if (m) requestedSha = m[1];
        return { stdout: JSON.stringify([{ sha: 'sha999' }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('/pulls?')) {
        const m = cmd.match(/head=([^&\s]+)/);
        if (m) requestedHead = m[1];
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('/issues?')) {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(
      proj,
      { scope: 'worktree', nodeId: 'node_wt1' },
      fakeRunner,
      mockGraph
    );

    assert.equal(ghData.scope.kind, 'worktree');
    assert.equal(ghData.scope.nodeId, 'node_wt1');
    assert.equal(ghData.scope.branch, 'feat/ui-revamp');
    assert.equal(ghData.scope.commits, 'branch');
    assert.equal(ghData.scope.pullRequests, 'head-branch');
    assert.equal(requestedSha, 'feat%2Fui-revamp');
    assert.equal(requestedHead, 'Haojerh%3Afeat%2Fui-revamp');
  });

  test('collectGitHubData handles worktree with missing remote branch', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\path'],
      hostIds: ['local'],
    };

    const mockGraph: Graph = {
      runs: [],
      selectedRunId: null,
      nodes: [
        {
          id: 'node_wt_local',
          kind: 'worktree',
          label: 'Local Only Branch',
          worktreeId: 'wt-local',
          runId: null,
          agentType: null,
          branch: 'local-only',
          path: 'C:\\path',
          state: 'idle',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: {
        total: 0,
        completed: 0,
        failed: 0,
        working: 0,
        waiting: 0,
        blocked: 0,
        unknown: 0,
        percent: null,
        coverage: 'unavailable',
        basis: 'completed-tasks',
      },
      activity: [],
    };

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        return {
          stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/commits?')) {
        return {
          stdout: '',
          stderr: 'Not Found (HTTP 404)',
          exitCode: 1,
        };
      }
      if (cmd.includes('/pulls?')) {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('/issues?')) {
        return { stdout: JSON.stringify([]), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(
      proj,
      { scope: 'worktree', nodeId: 'node_wt_local' },
      fakeRunner,
      mockGraph
    );

    assert.equal(ghData.scope.commits, 'unavailable');
    assert.equal(ghData.commits.meta.availability, 'unavailable');
    assert.equal(ghData.commits.meta.issue?.code, 'REMOTE_MISSING');
  });

  test('collectGitHubData handles folder worktree without branch with SCOPE_UNAVAILABLE', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\path'],
      hostIds: ['local'],
    };

    const mockGraph: Graph = {
      runs: [],
      selectedRunId: null,
      nodes: [
        {
          id: 'node_folder_wt',
          kind: 'worktree',
          label: 'Folder Worktree',
          worktreeId: 'wt-folder',
          runId: null,
          agentType: null,
          branch: null,
          path: 'C:\\path',
          state: 'idle',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: {
        total: 0,
        completed: 0,
        failed: 0,
        working: 0,
        waiting: 0,
        blocked: 0,
        unknown: 0,
        percent: null,
        coverage: 'unavailable',
        basis: 'completed-tasks',
      },
      activity: [],
    };

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        return {
          stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/issues?')) {
        return { stdout: JSON.stringify([{ number: 1, title: 'Issue 1' }]), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(
      proj,
      { scope: 'worktree', nodeId: 'node_folder_wt' },
      fakeRunner,
      mockGraph
    );

    assert.equal(ghData.scope.commits, 'unavailable');
    assert.equal(ghData.scope.pullRequests, 'unavailable');
    assert.equal(ghData.commits.meta.availability, 'unavailable');
    assert.equal(ghData.commits.meta.issue?.code, 'SCOPE_UNAVAILABLE');
    assert.equal(ghData.pullRequests.meta.availability, 'unavailable');
    assert.equal(ghData.pullRequests.meta.issue?.code, 'SCOPE_UNAVAILABLE');
    assert.equal(ghData.issues.meta.availability, 'ready');
  });

  test('collectGitHubData handles folder project with no git remote', async () => {
    const folderProj: Project = {
      id: 'proj_folder',
      name: 'Folder Proj',
      kind: 'folder',
      sourceProjectId: 'folder:local',
      repoIds: [],
      paths: [],
      hostIds: ['local'],
    };

    const ghData = await collectGitHubData(folderProj);
    assert.equal(ghData.repository, null);
    assert.equal(ghData.auth, 'unknown');
    assert.equal(ghData.pullRequests.meta.availability, 'unavailable');
    assert.equal(ghData.pullRequests.meta.issue?.code, 'REMOTE_MISSING');
  });

  test('collectGitHubData handles malformed upstream payloads with INVALID_UPSTREAM (B1)', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\test'],
      hostIds: ['local'],
    };

    // Test non-array PRs and malformed commits/issues
    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        return { stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('/pulls?')) {
        // Not an array
        return { stdout: JSON.stringify({ error: 'not an array' }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('/commits?')) {
        // Array with malformed item (missing sha)
        return { stdout: JSON.stringify([{ notSha: '123' }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('/issues?')) {
        // Array with malformed item (missing number)
        return { stdout: JSON.stringify([{ title: 'No number' }]), stderr: '', exitCode: 0 };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(proj, { scope: 'general' }, fakeRunner);
    assert.equal(ghData.pullRequests.meta.availability, 'unavailable');
    assert.equal(ghData.pullRequests.meta.issue?.code, 'INVALID_UPSTREAM');
    assert.equal(ghData.commits.meta.availability, 'unavailable');
    assert.equal(ghData.commits.meta.issue?.code, 'INVALID_UPSTREAM');
    assert.equal(ghData.issues.meta.availability, 'unavailable');
    assert.equal(ghData.issues.meta.issue?.code, 'INVALID_UPSTREAM');
  });

  test('selected worktree remote failure does not fall back to project repository (B2)', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\project-repo'],
      hostIds: ['local'],
    };

    const mockGraph: Graph = {
      runs: [],
      selectedRunId: null,
      nodes: [
        {
          id: 'node_wt_broken',
          kind: 'worktree',
          label: 'Broken Worktree',
          worktreeId: 'wt-broken',
          runId: null,
          agentType: null,
          branch: 'feat/test',
          path: 'C:\\broken-worktree-path',
          state: 'working',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: {
        total: 0,
        completed: 0,
        failed: 0,
        working: 0,
        waiting: 0,
        blocked: 0,
        unknown: 0,
        percent: null,
        coverage: 'unavailable',
        basis: 'completed-tasks',
      },
      activity: [],
    };

    const fakeRunner: CommandRunner = async (_exe, args, opts) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        // If run on worktree path, it fails with no remotes
        if (opts?.cwd === 'C:\\broken-worktree-path') {
          return { stdout: '', stderr: 'fatal: no remotes\n', exitCode: 1 };
        }
        // Project path would succeed with origin
        return { stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(
      proj,
      { scope: 'worktree', nodeId: 'node_wt_broken' },
      fakeRunner,
      mockGraph
    );

    // Repository must be null and sections unavailable - NOT fallen back to project repo
    assert.equal(ghData.repository, null);
    assert.equal(ghData.pullRequests.meta.availability, 'unavailable');
    assert.equal(ghData.commits.meta.availability, 'unavailable');
    assert.equal(ghData.issues.meta.availability, 'unavailable');
  });

  test('worktree missing path with a branch does not fall back to project repository', async () => {
    const proj: Project = {
      id: 'proj_1',
      name: 'orca-visualization',
      kind: 'git',
      sourceProjectId: 'github:Haojerh/orca-visualization',
      repoIds: ['repo-1'],
      paths: ['C:\\project-repo'],
      hostIds: ['local'],
    };

    const mockGraph: Graph = {
      runs: [],
      selectedRunId: null,
      nodes: [
        {
          id: 'node_wt_nopath',
          kind: 'worktree',
          label: 'No Path Worktree',
          worktreeId: 'wt-nopath',
          runId: null,
          agentType: null,
          branch: 'feat/test',
          path: null,
          state: 'working',
          rawState: null,
          workspaceStatus: null,
          taskOutcome: null,
          liveness: 'live',
          observedAt: null,
          lastActivityAt: null,
          stale: false,
          taskIds: [],
          preview: null,
          outputAvailable: true,
        },
      ],
      edges: [],
      tasks: [],
      progress: {
        total: 0,
        completed: 0,
        failed: 0,
        working: 0,
        waiting: 0,
        blocked: 0,
        unknown: 0,
        percent: null,
        coverage: 'unavailable',
        basis: 'completed-tasks',
      },
      activity: [],
    };

    let projectRemoteCalled = false;
    const fakeRunner: CommandRunner = async (_exe, args, opts) => {
      const cmd = args.join(' ');
      if (cmd.includes('remote -v')) {
        if (opts?.cwd === 'C:\\project-repo') {
          projectRemoteCalled = true;
          return { stdout: 'origin https://github.com/Haojerh/orca-visualization.git (fetch)\n', stderr: '', exitCode: 0 };
        }
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(
      proj,
      { scope: 'worktree', nodeId: 'node_wt_nopath' },
      fakeRunner,
      mockGraph
    );

    assert.equal(projectRemoteCalled, false, 'Project remote must not be called for worktree scope');
    assert.equal(ghData.repository, null);
    assert.equal(ghData.pullRequests.meta.availability, 'unavailable');
    assert.equal(ghData.pullRequests.meta.issue?.code, 'REMOTE_MISSING');
    assert.equal(ghData.commits.meta.availability, 'unavailable');
    assert.equal(ghData.commits.meta.issue?.code, 'REMOTE_MISSING');
    assert.equal(ghData.issues.meta.availability, 'unavailable');
    assert.equal(ghData.issues.meta.issue?.code, 'REMOTE_MISSING');
  });
});
