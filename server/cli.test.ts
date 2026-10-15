import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOrcaArgs,
  runOrca,
  runGit,
  runGh,
  runDeduplicatedCommand,
  CliError,
  CommandRunner,
} from './cli.js';

describe('server/cli', () => {
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

    // Invalid commands / parameters
    assert.throws(() => validateOrcaArgs([]), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['orchestration', 'send']), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['terminal', 'write']), /INVALID_ARGUMENT/);
    assert.throws(() => validateOrcaArgs(['status', '; rm -rf /']), /INVALID_ARGUMENT/);
    assert.throws(
      () => validateOrcaArgs(['terminal', 'read', '--terminal', 'bad handle', '--json']),
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
      stdout: JSON.stringify([{ id: 1, title: 'PR 1' }]),
      stderr: '',
      exitCode: 0,
    });

    const out = await runGh(
      'repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=20',
      fakeSuccessRunner
    );
    assert.equal(out.length, 1);

    // Disallowed endpoint
    await assert.rejects(
      () => runGh('users/octocat', fakeSuccessRunner),
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
      () => runGh('repos/owner/repo/events?per_page=100', fake404Runner),
      (err: any) => err.issue.code === 'GITHUB_NOT_FOUND'
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
});
