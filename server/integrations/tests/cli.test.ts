import { test, describe, mock } from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import {
  runGit,
  runGh,
  runDeduplicatedCommand,
  CliError,
  CommandRunner,
  defaultCommandRunner,
} from '../cli.js';
import { validateGhEndpoint } from '../cliValidators.js';

test('command deadlines settle even when inherited streams never close',{timeout:1500}, async()=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,kill:()=>true});
  const spawn=mock.method(childProcess,'spawn',()=>child as unknown as childProcess.ChildProcess);syncBuiltinESMExports();
  try{await assert.rejects(defaultCommandRunner(process.execPath,['-e',''],{timeoutMs:40}),error=>error instanceof CliError&&error.issue.code==='CLI_TIMEOUT');}
  finally{spawn.mock.restore();syncBuiltinESMExports();child.stdout.destroy();child.stderr.destroy();}
});

test('waiting for a command execution slot respects the caller deadline',async()=>{
  const active=Array.from({length:3},()=>defaultCommandRunner(process.execPath,['-e','setTimeout(()=>{},450)'],{timeoutMs:3000}));
  try{await assert.rejects(defaultCommandRunner(process.execPath,['-e',''],{timeoutMs:50}),error=>error instanceof CliError&&error.issue.code==='CLI_TIMEOUT');}
  finally{await Promise.allSettled(active);}
});

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
});
