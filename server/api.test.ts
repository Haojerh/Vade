import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from './api.js';
import { CommandRunner } from './cli.js';
import { SnapshotManager } from './snapshot.js';
import { hashId, globalSourceMaps } from './orca.js';

describe('server/api', () => {
  let server: http.Server;
  let baseUrl: string;

  const projApiId = hashId('proj', 'github:testowner/testrepo');
  const nodeApiId = hashId('node', 'wt-api-1');

  before(async () => {
    globalSourceMaps.projectSourceMap.set(projApiId, {
      sourceId: 'github:testowner/testrepo',
      repoIds: ['repo-api'],
      paths: ['C:\\api-test'],
    });

    const fakeRunner: CommandRunner = async (_exe, args) => {
      const cmd = args.join(' ');
      if (cmd.includes('project list')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              projects: [
                {
                  id: 'github:testowner/testrepo',
                  displayName: 'API Test Proj',
                  kind: 'git',
                  sourceRepoIds: ['repo-api'],
                },
              ],
            },
            _meta: { runtimeId: 'rt-api' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('project setups')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: [
              {
                projectId: 'github:testowner/testrepo',
                repoId: 'repo-api',
                path: 'C:\\api-test',
                hostId: 'local',
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('repo list')) {
        return { stdout: JSON.stringify({ ok: true, result: [] }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('worktree ps')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-api-1',
                  repoId: 'repo-api',
                  path: 'C:\\api-test',
                  workspaceStatus: 'in-progress',
                  status: 'working',
                  terminalVerdict: 'live',
                  agents: [],
                },
              ],
            },
            _meta: { runtimeId: 'rt-api' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('terminal list')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { terminals: [] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('orchestration run-list')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { runs: [] } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('remote -v')) {
        return {
          stdout: 'origin https://github.com/testowner/testrepo.git (fetch)\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('/pulls?') || cmd.includes('/commits?') || cmd.includes('/events?')) {
        return {
          stdout: JSON.stringify([]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const snapshotManager = new SnapshotManager(fakeRunner);
    server = createServer({ runner: fakeRunner, snapshotManager });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('GET /api/health returns 200 ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.readOnly, true);
  });

  test('GET /api/health with unexpected query returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/health?unexpected=true`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_ARGUMENT');
  });

  test('POST /api/health returns 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  test('Origin validation blocks foreign origins and allows configured origins', async () => {
    const foreignRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'http://malicious-site.com' },
    });
    assert.equal(foreignRes.status, 403);
    const foreignBody = await foreignRes.json();
    assert.equal(foreignBody.error.code, 'FORBIDDEN_ORIGIN');

    const validRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');
  });

  test('GET /api/projects returns project inventory', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data);
    assert.ok(Array.isArray(body.data.projects));
    assert.equal(body.meta.availability, 'ready');
  });

  test('GET /api/projects/:projectId/snapshot returns DashboardSnapshot', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projApiId}/snapshot`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.projectId, projApiId);
    assert.ok(body.revision);
    assert.ok(body.graph.data);

    // Nonexistent project
    const notFoundRes = await fetch(`${baseUrl}/api/projects/nonexistent_id/snapshot`);
    assert.equal(notFoundRes.status, 404);

    // R4: requesting an unknown runId on snapshot returns 404 RUN_NOT_FOUND
    const badRunRes = await fetch(`${baseUrl}/api/projects/${projApiId}/snapshot?runId=run_unknown_123`);
    assert.equal(badRunRes.status, 404);
    const badRunBody = await badRunRes.json();
    assert.equal(badRunBody.error.code, 'RUN_NOT_FOUND');
  });

  test('GET /api/projects/:projectId/nodes/:nodeId returns NodeDetails and checks query limits', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?limit=50`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.node.id, nodeApiId);

    // Invalid limit > 200
    const badLimitRes = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?limit=999`);
    assert.equal(badLimitRes.status, 400);

    // Unexpected query
    const badQueryRes = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?foo=bar`);
    assert.equal(badQueryRes.status, 400);
  });

  test('GET /api/projects/:projectId/github returns GitHubData', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projApiId}/github`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.repository);
    assert.ok(body.pullRequests);
    assert.ok(body.commits);
    assert.ok(body.pushEvents);
  });

  test('Unrecognized /api route returns JSON 404, not HTML', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_ARGUMENT');
  });

  test('SSE stream GET /api/projects/:projectId/events delivers initial snapshot', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projApiId}/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const reader = res.body?.getReader();
    assert.ok(reader);

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: snapshot/);
    assert.match(text, /data: \{/);

    reader.cancel();
  });
});
