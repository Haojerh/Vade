import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  runOrca,
  runGit,
  runGh,
  runDeduplicatedCommand,
  CliError,
  CommandRunner,
  defaultCommandRunner,
} from './cli.js';
import { validateOrcaArgs, validateGhEndpoint } from './cliValidators.js';

describe('server/cli', () => {
  test('replacement environment does not restore inherited startup variables', async () => {
    const previous = process.env.ORCA_LAUNCH_ENV_TEST;
    process.env.ORCA_LAUNCH_ENV_TEST = 'inherited';
    try {
      const env = { ...process.env, LAUNCH_MARKER: 'isolated' };
      delete (env as NodeJS.ProcessEnv).ORCA_LAUNCH_ENV_TEST;
      const result = await defaultCommandRunner(process.execPath, [
        '-e', 'process.stdout.write(JSON.stringify({ inherited: process.env.ORCA_LAUNCH_ENV_TEST ?? null, marker: process.env.LAUNCH_MARKER }))',
      ], { env, replaceEnv: true });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.stdout), { inherited: null, marker: 'isolated' });
      assert.equal(process.env.ORCA_LAUNCH_ENV_TEST, 'inherited');
    } finally {
      if (previous === undefined) delete process.env.ORCA_LAUNCH_ENV_TEST;
      else process.env.ORCA_LAUNCH_ENV_TEST = previous;
    }
  });

  test('allows bounded GitHub pages and rejects extra or duplicate parameters', () => {
    assert.doesNotThrow(() => validateGhEndpoint('repos/owner/repo/commits?per_page=20&page=2'));
    for (const suffix of ['0', '-1', '10001', '2&page=3', '2&other=true']) {
      assert.throws(() => validateGhEndpoint(`repos/owner/repo/commits?per_page=20&page=${suffix}`));
    }
  });
  test('validates Orca allowlisted commands', () => {
    // Valid commands
    assert.doesNotThrow(() => validateOrcaArgs(['status', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['project', 'list', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['project', 'setups', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['repo', 'list', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['worktree', 'ps', '--limit', '200', '--json']));
    assert.doesNotThrow(() =>
      validateOrcaArgs(['worktree', 'list', '--repo', 'id:123', '--limit', '200', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs(['terminal', 'list', '--worktree', 'id:abc', '--limit', '100', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs(['terminal', 'list', '--worktree', 'id:abc', '--limit', '100', '--include-visual-layouts', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs(['terminal', 'read', '--terminal', 'term_123', '--limit', '100', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'terminal',
        'read',
        '--terminal',
        'term_123',
        '--cursor',
        'cur1',
        '--limit',
        '50',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs(['orchestration', 'run-list', '--limit', '50', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs(['orchestration', 'worker-list', '--run', 'run_123', '--limit', '100', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs(['orchestration', 'task-list', '--run', 'run_123', '--json'])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'orchestration',
        'worker-read',
        '--dispatch',
        'ctx_123',
        '--source',
        'transcript',
        '--limit',
        '100',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'orchestration',
        'worker-read',
        '--dispatch',
        'ctx_abc-123',
        '--source',
        'transcript',
        '--cursor',
        'server_cursor_1',
        '--limit',
        '50',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'terminal',
        'send',
        '--terminal',
        'term_abc-123',
        '--text',
        'fix the issue',
        '--enter',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'orchestration',
        'send',
        '--subject',
        'review prompt',
        '--body',
        'please check the code',
        '--to',
        'dispatch:ctx_abc123',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'terminal',
        'rename',
        '--terminal',
        'term_abc-123',
        '--title',
        'My Agent Tab',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'terminal',
        'rename',
        '--terminal',
        'term_abc-123',
        '--json',
      ])
    );
    assert.doesNotThrow(() =>
      validateOrcaArgs([
        'terminal',
        'create',
        '--worktree',
        'path:/some/worktree/path',
        '--command',
        'codex',
        '--title',
        'Codex Worker',
        '--json',
      ])
    );

    // Invalid commands / parameters
    assert.throws(() => validateOrcaArgs([]), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['orchestration', 'send']), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['terminal', 'write']), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['status', '; rm -rf /']), /INVALID_ARGUMENT/);
    assert.throws(
      () => validateOrcaArgs(['terminal', 'read', '--terminal', 'bad handle', '--json']),
      /INVALID_ARGUMENT/
    );
    assert.throws(
      () =>
        validateOrcaArgs([
          'orchestration',
          'worker-read',
          '--dispatch',
          'bad_id',
          '--source',
          'transcript',
          '--limit',
          '100',
          '--json',
        ]),
      /INVALID_ARGUMENT/
    );
    assert.throws(
      () =>
        validateOrcaArgs([
          'orchestration',
          'worker-read',
          '--dispatch',
          'ctx_123',
          '--source',
          'terminal',
          '--limit',
          '100',
          '--json',
        ]),
      /INVALID_ARGUMENT/
    );
    assert.throws(
      () =>
        validateOrcaArgs([
          'orchestration',
          'worker-read',
          '--dispatch',
          'ctx_123',
          '--source',
          'transcript',
          '--limit',
          '500',
          '--json',
        ]),
      /INVALID_ARGUMENT/
    );
  });

  test('runOrca handles valid and invalid envelopes', async () => {
    const fakeSuccessRunner: CommandRunner = async () => ({
      stdout: JSON.stringify({ ok: true, result: { projects: [] }, _meta: { runtimeId: 'rt1' } }),
      stderr: '',
      exitCode: 0,
    });

    const res = await runOrca(['project', 'list', '--json'], fakeSuccessRunner);
    assert.equal(res.ok, true);
    assert.equal(res._meta?.runtimeId, 'rt1');

    const fakeFailRunner: CommandRunner = async () => ({
      stdout: JSON.stringify({ ok: false, error: 'Internal failure' }),
      stderr: '',
      exitCode: 0,
    });

    await assert.rejects(
      () => runOrca(['status', '--json'], fakeFailRunner),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_UPSTREAM'
    );

    const fakeBadJsonRunner: CommandRunner = async () => ({
      stdout: 'not json',
      stderr: '',
      exitCode: 0,
    });

    await assert.rejects(
      () => runOrca(['status', '--json'], fakeBadJsonRunner),
      (err: any) => err instanceof CliError && err.issue.code === 'INVALID_UPSTREAM'
    );

    const fakeExitCodeRunner: CommandRunner = async () => ({
      stdout: '',
      stderr: 'Command failed',
      exitCode: 1,
    });

    await assert.rejects(
      () => runOrca(['status', '--json'], fakeExitCodeRunner),
      (err: any) => err instanceof CliError && err.issue.code === 'CLI_FAILED'
    );
  });

  test('runGit enforces allowlisted arguments', async () => {
    const fakeRunner: CommandRunner = async () => ({
      stdout: 'origin https://github.com/owner/repo.git (fetch)\n',
      stderr: '',
      exitCode: 0,
    });

    const out = await runGit(['remote', '-v'], undefined, fakeRunner);
    assert.match(out, /origin/);

    await assert.rejects(
      () => runGit(['status'], undefined, fakeRunner),
      (err: any) => err.issue.code === 'INVALID_ARGUMENT'
    );
  });

  test('runGh validates endpoint patterns and handles error codes', async () => {
    const fakeSuccessRunner: CommandRunner = async () => ({
      stdout: JSON.stringify([{ id: 1, title: 'Item 1' }]),
      stderr: '',
      exitCode: 0,
    });

    const out = await runGh(
      'repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=20',
      fakeSuccessRunner
    );
    assert.equal(out.length, 1);

    // Valid branch commits endpoint
    const commitOut = await runGh(
      'repos/owner/repo/commits?per_page=20&sha=feat%2Fmy-feature',
      fakeSuccessRunner
    );
    assert.equal(commitOut.length, 1);

    // Valid PR head endpoint
    const prOut = await runGh(
      'repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=20&head=owner%3Afeat%2Fmy-feature',
      fakeSuccessRunner
    );
    assert.equal(prOut.length, 1);

    // Valid issues endpoint
    const issuesOut = await runGh(
      'repos/owner/repo/issues?state=all&sort=updated&direction=desc&per_page=20',
      fakeSuccessRunner
    );
    assert.equal(issuesOut.length, 1);

    // Disallowed endpoints
    await assert.rejects(
      () => runGh('users/octocat', fakeSuccessRunner),
      (err: any) => err.issue.code === 'INVALID_ARGUMENT'
    );

    // Events endpoint is removed from allowlist
    await assert.rejects(
      () => runGh('repos/owner/repo/events?per_page=100', fakeSuccessRunner),
      (err: any) => err.issue.code === 'INVALID_ARGUMENT'
    );

    // Query injection / unencoded branch attempts
    await assert.rejects(
      () => runGh('repos/owner/repo/commits?per_page=20&sha=main&admin=true', fakeSuccessRunner),
      (err: any) => err.issue.code === 'INVALID_ARGUMENT'
    );

    // 409 empty repo
    const fakeEmptyRepoRunner: CommandRunner = async () => ({
      stdout: '',
      stderr: 'Git Repository is empty. (HTTP 409)',
      exitCode: 1,
    });

    await assert.rejects(
      () => runGh('repos/owner/repo/commits?per_page=20', fakeEmptyRepoRunner),
      (err: any) => err.issue.code === 'REMOTE_MISSING' && err.exitCode === 409
    );

    // 404 not found
    const fake404Runner: CommandRunner = async () => ({
      stdout: '',
      stderr: 'Not Found (HTTP 404)',
      exitCode: 1,
    });

    await assert.rejects(
      () => runGh('repos/owner/repo/commits?per_page=20', fake404Runner),
      (err: any) => err.issue.code === 'GITHUB_NOT_FOUND'
    );

    // 403 rate limit vs forbidden
    const fakeRateLimitRunner: CommandRunner = async () => ({
      stdout: '',
      stderr: 'API rate limit exceeded (HTTP 403)',
      exitCode: 1,
    });

    await assert.rejects(
      () => runGh('repos/owner/repo/commits?per_page=20', fakeRateLimitRunner),
      (err: any) => err.issue.code === 'RATE_LIMITED'
    );

    const fakeForbiddenRunner: CommandRunner = async () => ({
      stdout: '',
      stderr: 'Resource access forbidden (HTTP 403)',
      exitCode: 1,
    });

    await assert.rejects(
      () => runGh('repos/owner/repo/commits?per_page=20', fakeForbiddenRunner),
      (err: any) => err.issue.code === 'GITHUB_FORBIDDEN'
    );
  });

  test('runDeduplicatedCommand deduplicates concurrent identical executions', async () => {
    let callCount = 0;
    const slowRunner: CommandRunner = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { stdout: 'done', stderr: '', exitCode: 0 };
    };

    const [r1, r2] = await Promise.all([
      runDeduplicatedCommand('test-exe', ['arg1'], undefined, slowRunner),
      runDeduplicatedCommand('test-exe', ['arg1'], undefined, slowRunner),
    ]);

    assert.equal(r1.stdout, 'done');
    assert.equal(r2.stdout, 'done');
    assert.equal(callCount, 1);
  });

  test('validateOrcaArgs allows worktree rm and terminal close', () => {
    assert.doesNotThrow(() => validateOrcaArgs(['worktree', 'rm', '--worktree', 'id:repo-123::path/to/wt', '--force', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['worktree', 'rm', '--worktree', 'path:C:/path/to/wt', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['terminal', 'close', '--terminal', 'term_abc123', '--tab', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['terminal', 'close', '--terminal', 'term_xyz', '--json']));
    assert.doesNotThrow(() => validateOrcaArgs(['terminal', 'close', '--worktree', 'id:repo-123::path/to/wt', '--all', '--json']));

    // Rejects invalid forms
    assert.throws(() => validateOrcaArgs(['worktree', 'rm', '--worktree', '--malicious', '--json']), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['terminal', 'close', '--terminal', '; rm -rf /', '--tab', '--json']), /INVALID_ARGUMENT/);
  });
});
