import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from './api.js';
import { CommandRunner } from './cli.js';
import { SnapshotManager } from './snapshot.js';
import { hashId, globalSourceMaps } from './orca.js';
import { UsageCollector } from './usage.js';

describe('server/api', () => {
  let server: http.Server;
  let baseUrl: string;
  let graphGate: Promise<void> | null = null;

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
        if (graphGate) await graphGate;
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              worktrees: [
                {
                  worktreeId: 'wt-api-1',
                  repoId: 'repo-api',
                  path: 'C:\\api-test',
                  branch: 'main',
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
      if (cmd.includes('/pulls?') || cmd.includes('/commits?') || cmd.includes('/issues?')) {
        return {
          stdout: JSON.stringify([]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const snapshotManager = new SnapshotManager(fakeRunner);
    server = createServer({ runner: fakeRunner, snapshotManager, usageCollector: new UsageCollector(async () => ({
      accounts: [{ email: 'private@example.test', token: 'secret' }],
      rateLimits: { codex: { provider: 'codex', status: 'ok', updatedAt: Date.now(),
        session: { usedPercent: 8, resetsAt: Date.now() + 3600000 } } },
    })) });

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

  test('GET /api/usage returns only normalized quotas and rejects arbitrary RPC input', async () => {
    const res = await fetch(`${baseUrl}/api/usage`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.providers[0].windows[0].usedPercent, 8);
    assert.ok(!JSON.stringify(body).includes('private@example.test'));
    assert.ok(!JSON.stringify(body).includes('secret'));
    assert.equal((await fetch(`${baseUrl}/api/usage?method=accounts.selectCodex`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/usage`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${baseUrl}/api/usage`, { headers: { Origin: 'https://example.test' } })).status, 403);
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
    assert.ok(body.conversation);

    // Invalid limit with non-integer prefix
    const nonIntPrefixRes = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?limit=50abc`);
    assert.equal(nonIntPrefixRes.status, 400);

    // Invalid limit > 200
    const badLimitRes = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?limit=999`);
    assert.equal(badLimitRes.status, 400);

    // Empty query value
    const emptyValRes = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?limit=`);
    assert.equal(emptyValRes.status, 400);

    // Unexpected query
    const badQueryRes = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${nodeApiId}?foo=bar`);
    assert.equal(badQueryRes.status, 400);
  });

  test('GET /api/projects/:projectId/github supports general and worktree scopes and enforces query rules', async () => {
    // 1. No query defaults to general scope
    const res = await fetch(`${baseUrl}/api/projects/${projApiId}/github`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.repository);
    assert.ok(body.pullRequests);
    assert.ok(body.commits);
    assert.ok(body.issues);
    assert.equal(body.pushEvents, undefined); // pushEvents must be absent
    assert.equal(body.scope.kind, 'general');

    // 2. Explicit scope=general
    const generalRes = await fetch(`${baseUrl}/api/projects/${projApiId}/github?scope=general`);
    assert.equal(generalRes.status, 200);
    const generalBody = await generalRes.json();
    assert.equal(generalBody.scope.kind, 'general');

    // 3. General scope with nodeId must be rejected with 400
    const invalidGeneralRes = await fetch(
      `${baseUrl}/api/projects/${projApiId}/github?scope=general&nodeId=${nodeApiId}`
    );
    assert.equal(invalidGeneralRes.status, 400);

    // 4. Worktree scope with valid nodeId
    const worktreeRes = await fetch(
      `${baseUrl}/api/projects/${projApiId}/github?scope=worktree&nodeId=${nodeApiId}`
    );
    assert.equal(worktreeRes.status, 200);
    const worktreeBody = await worktreeRes.json();
    assert.equal(worktreeBody.scope.kind, 'worktree');
    assert.equal(worktreeBody.scope.nodeId, nodeApiId);

    // 5. Worktree scope without nodeId must be rejected with 400
    const missingNodeIdRes = await fetch(`${baseUrl}/api/projects/${projApiId}/github?scope=worktree`);
    assert.equal(missingNodeIdRes.status, 400);

    // 6. Duplicate query parameter must be rejected with 400
    const dupRes = await fetch(`${baseUrl}/api/projects/${projApiId}/github?scope=general&scope=worktree`);
    assert.equal(dupRes.status, 400);

    // 7. Invalid scope enum must be rejected with 400
    const badScopeRes = await fetch(`${baseUrl}/api/projects/${projApiId}/github?scope=other`);
    assert.equal(badScopeRes.status, 400);
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

  test('SSE sends cached snapshot before a blocked fresh collection finishes', async () => {
    await fetch(`${baseUrl}/api/projects/${projApiId}/snapshot`);
    let release!: () => void;
    graphGate = new Promise<void>((resolve) => { release = resolve; });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 1000);
    try {
      const res = await fetch(`${baseUrl}/api/projects/${projApiId}/events`, { signal: abort.signal });
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      assert.match(new TextDecoder().decode(value), /event: snapshot/);
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      graphGate = null;
      release();
      abort.abort();
    }
  });
});
