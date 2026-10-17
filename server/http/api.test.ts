import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from './api.js';
import { CommandRunner } from '../integrations/cli.js';
import { SnapshotManager } from '../services/snapshot.js';
import { hashId, globalSourceMaps } from '../integrations/orca.js';
import { UsageCollector } from '../integrations/usage.js';

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
      if (cmd.includes('status')) {
        return {
          stdout: JSON.stringify({
            ok: true,
            result: {
              app: { running: true },
              runtime: {
                state: 'ready',
                appVersion: '1.4.224',
                capabilities: ['orchestration.contract.v1', 'orchestration.federation.v1'],
              },
            },
            _meta: { runtimeId: 'rt-api', appVersion: '1.4.224' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
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
      if (cmd.includes('terminal send')) {
        return {
          stdout: JSON.stringify({ ok: true, result: { sent: true } }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (
        cmd.includes('worktree rm') ||
        cmd.includes('terminal close') ||
        cmd.includes('terminal rename') ||
        cmd.includes('terminal create')
      ) {
        return {
          stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term_new' } } }),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '{}', stderr: '', exitCode: 0 };
    };

    const snapshotManager = new SnapshotManager(fakeRunner);
    server = createServer({ runner: fakeRunner, snapshotManager, checkCliSkillInstallation: () => true, usageCollector: new UsageCollector(async () => ({
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

  test('GET /api/prerequisites returns 200 with readiness status', async () => {
    const res = await fetch(`${baseUrl}/api/prerequisites`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.orcaApp, 'boolean');
    assert.equal(typeof body.orcaAppOpen, 'boolean');
    assert.equal(typeof body.orcaCli, 'boolean');
    assert.equal(typeof body.orchestrationSkill, 'boolean');
    assert.equal(typeof body.orcaCliSkill, 'boolean');
    assert.equal(typeof body.ready, 'boolean');
    assert.equal(body.orcaApp, true);
    assert.equal(body.orcaAppOpen, true);
    assert.equal(body.orcaCli, true);
    assert.equal(body.orchestrationSkill, true);
    assert.equal(body.orcaCliSkill, true);
    assert.equal(body.ready, true);
  });

  test('POST /api/prerequisites returns 405 Method Not Allowed', async () => {
    const res = await fetch(`${baseUrl}/api/prerequisites`, { method: 'POST' });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  test('GET /api/prerequisites with unexpected query returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/prerequisites?foo=bar`);
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
    for (const query of ['page=2', 'activity=other', 'activity=commits&page=0', 'activity=issues&page=10001']) {
      const response = await fetch(`${baseUrl}/api/projects/${projApiId}/github?${query}`);
      assert.equal(response.status, 400);
    }
    const paged = await fetch(`${baseUrl}/api/projects/${projApiId}/github?activity=commits&page=2`);
    assert.equal(paged.status, 200);
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

  test('POST /api/projects/:projectId/nodes/:nodeId/message sends message to agent terminal', async () => {
    const agentNodeId = hashId('node', 'term_test_agent');
    globalSourceMaps.nodeSourceMap.set(agentNodeId, { handle: 'term_test_agent' });

    const res = await fetch(`${baseUrl}/api/projects/${projApiId}/nodes/${agentNodeId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello agent, please review PR 1' }),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
  });

  test('image uploads bind to a local project agent, reject remote and invalid payloads, and stage before sending', async () => {
    const attachment = { name: 'test.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=' };
    let host = 'local';
    const calls: string[][] = [];
    globalSourceMaps.nodeSourceMap.set('upload_agent', { handle: 'term_upload_agent', worktreeId: 'wt-upload' });
    const uploadServer = createServer({
      snapshotManager: { getSnapshot: async () => ({ graph: { data: { nodes: [{ id: 'upload_agent', kind: 'agent', agentType: 'codex' }] } } }) } as any,
      runner: async (_exe, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ ok: true, result: args[1] === 'list'
          ? { terminals: [{ handle: 'term_upload_agent', connected: true, executionHostId: host }] }
          : { send: { accepted: true } } }), stderr: '', exitCode: 0 };
      },
    });
    await new Promise<void>((resolve) => uploadServer.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(uploadServer.address() as any).port}/api/projects/project/nodes/upload_agent/message`;
    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    try {
      assert.equal((await post({ message: '', attachments: [attachment] })).status, 200);
      assert.equal(calls.length, 4);
      assert.match(calls[1][5], /^\x1b\[200~/);
      assert.equal(calls[1].includes('--enter'), false);
      assert.equal(calls[2].includes('--enter'), false);
      assert.equal(calls[3].includes('--enter'), true);
      calls.length = 0;
      host = 'remote-host';
      assert.equal((await post({ message: 'Look', attachments: [attachment] })).status, 400);
      assert.equal(calls.some((args) => args[1] === 'send'), false);
      assert.equal((await post({ message: '', attachments: [{ ...attachment, dataBase64: 'bad!' }] })).status, 400);
      assert.equal((await post({ message: '', attachments: [] })).status, 400);
      assert.equal((await post({ message: 'Look', attachments: [attachment] }, { Origin: 'https://other.example' })).status, 403);
    } finally {
      globalSourceMaps.nodeSourceMap.delete('upload_agent');
      await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
    }
  });

  test('close-tab and delete-worktree endpoints execute and return 200', async () => {
    globalSourceMaps.nodeSourceMap.set('test_agent_node', { handle: 'term_test1', worktreeId: 'repo::path' });
    globalSourceMaps.nodeSourceMap.set('test_agent_node_rename', { handle: 'term_rename1', worktreeId: 'repo::path' });
    globalSourceMaps.nodeSourceMap.set('test_wt_node', { worktreeId: 'repo::path' });
    globalSourceMaps.nodeSourceMap.set('test_wt_node_create', { worktreeId: 'repo::path', worktreePath: 'C:/wt1' });
    try {
      // POST close-tab
      const closeRes = await fetch(`${baseUrl}/api/projects/proj1/nodes/test_agent_node/close-tab`, { method: 'POST' });
      assert.equal(closeRes.status, 200);
      const closeBody = await closeRes.json();
      assert.equal(closeBody.ok, true);

      // POST delete-worktree
      const delPostRes = await fetch(`${baseUrl}/api/projects/proj1/nodes/test_wt_node/delete-worktree`, { method: 'POST' });
      assert.equal(delPostRes.status, 200);
      const delPostBody = await delPostRes.json();
      assert.equal(delPostBody.ok, true);

      // Re-add for DELETE test
      globalSourceMaps.nodeSourceMap.set('test_wt_node_2', { worktreeId: 'repo::path2' });
      const delDeleteRes = await fetch(`${baseUrl}/api/projects/proj1/nodes/test_wt_node_2/worktree`, { method: 'DELETE' });
      assert.equal(delDeleteRes.status, 200);
      const delDeleteBody = await delDeleteRes.json();
      assert.equal(delDeleteBody.ok, true);

      // POST rename
      const renameRes = await fetch(`${baseUrl}/api/projects/proj1/nodes/test_agent_node_rename/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Renamed Tab' }),
      });
      assert.equal(renameRes.status, 200);
      const renameBody = await renameRes.json();
      assert.equal(renameBody.ok, true);
      assert.equal(renameBody.title, 'New Renamed Tab');

      // POST create-agent
      const createRes = await fetch(`${baseUrl}/api/projects/proj1/nodes/test_wt_node_create/create-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'codex', title: 'New Agent' }),
      });
      assert.equal(createRes.status, 200);
      const createBody = await createRes.json();
      assert.equal(createBody.ok, true);

      // Disallowed POST
      const badPost = await fetch(`${baseUrl}/api/projects/proj1/nodes/test_node/unsupported`, { method: 'POST' });
      assert.equal(badPost.status, 405);
    } finally {
      globalSourceMaps.nodeSourceMap.delete('test_agent_node');
      globalSourceMaps.nodeSourceMap.delete('test_agent_node_rename');
      globalSourceMaps.nodeSourceMap.delete('test_wt_node');
      globalSourceMaps.nodeSourceMap.delete('test_wt_node_create');
      globalSourceMaps.nodeSourceMap.delete('test_wt_node_2');
    }
  });

  test('GET /api/agents/catalog returns installed and available agents', async () => {
    const res = await fetch(`${baseUrl}/api/agents/catalog`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.installed));
    assert.ok(Array.isArray(body.available));
    assert.ok(body.installed.length + body.available.length >= 40);

    // Reject query params
    const badRes = await fetch(`${baseUrl}/api/agents/catalog?invalid=1`);
    assert.equal(badRes.status, 400);
  });
});
