import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitHubUrl,
  parseGitRemoteOutput,
  resolveProjectRepo,
  collectGitHubData,
} from './github.js';
import { CommandRunner } from './cli.js';
import { Project } from '../shared/contracts.js';

describe('server/github', () => {
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

  test('collectGitHubData handles successful responses and independent section failures', async () => {
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
              state: 'open',
              draft: false,
              user: { login: 'alice' },
              updated_at: '2026-10-15T10:00:00Z',
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/commits?')) {
        // HTTP 409 empty repository
        return {
          stdout: '',
          stderr: 'Git Repository is empty. (HTTP 409)',
          exitCode: 1,
        };
      }
      if (cmd.includes('/events?')) {
        return {
          stdout: JSON.stringify([
            {
              id: 'evt_1',
              type: 'PushEvent',
              actor: { login: 'bob' },
              payload: { ref: 'refs/heads/main', head: 'commit-sha-1' },
              created_at: '2026-10-15T11:00:00Z',
            },
            {
              id: 'evt_2',
              type: 'WatchEvent',
            },
          ]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const ghData = await collectGitHubData(proj, fakeRunner);
    assert.equal(ghData.auth, 'available');
    assert.ok(ghData.repository);
    assert.equal(ghData.repository?.owner, 'Haojerh');

    // PRs: ready with 1 item
    assert.equal(ghData.pullRequests.meta.availability, 'ready');
    assert.equal(ghData.pullRequests.data?.length, 1);
    assert.equal(ghData.pullRequests.data?.[0].number, 42);

    // Commits: empty because of 409 empty repository
    assert.equal(ghData.commits.meta.availability, 'empty');
    assert.equal(ghData.commits.data?.length, 0);

    // Events: filtered to 1 PushEvent
    assert.equal(ghData.pushEvents.meta.availability, 'ready');
    assert.equal(ghData.pushEvents.data?.length, 1);
    assert.equal(ghData.pushEvents.data?.[0].actor, 'bob');
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
});
