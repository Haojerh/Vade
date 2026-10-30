import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubAccountReader } from '../githubAccounts.js';
import { runDeduplicatedCommand, type CommandRunner } from '../cli.js';

const endpoint = 'repos/example/private/commits?per_page=20';
test('GitHub access falls back to a saved account without switching global auth or exposing credentials', async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  let statuses = 0;
  const runner: CommandRunner = async (_exe, args, options) => {
    calls.push({ args, env: options?.env });
    if (args[0] === 'auth' && args[1] === 'status') {
      statuses++;
      return { stdout: JSON.stringify({ hosts: { 'github.com': [
        { login: 'primary', active: true, state: 'success' },
        { login: 'secondary', active: false, state: 'success' },
      ] } }), stderr: '', exitCode: 0 };
    }
    if (args[0] === 'auth' && args[1] === 'token') {
      assert.equal(args.at(-1), 'secondary');
      assert.equal(options?.env?.GH_TOKEN, '');
      return { stdout: 'private-token-secondary\n', stderr: '', exitCode: 0 };
    }
    if (options?.env?.GH_TOKEN === 'private-token-secondary') return { stdout: '[{"sha":"ok"}]', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: 'HTTP 404 Not Found', exitCode: 1 };
  };
  const read = createGitHubAccountReader(runner);
  const results = await Promise.all([read(endpoint), read('repos/example/private/issues?state=all&sort=updated&direction=desc&per_page=20')]);
  assert.equal(statuses, 1);
  assert.equal(calls.filter((call) => call.args[1] === 'token').length, 1);
  assert.equal(results[0][0].sha, 'ok');
  assert.equal(JSON.stringify(results).includes('private-token-secondary'), false);
  assert.ok(calls.every((call) => !call.args.includes('switch') && !call.args.some((arg) => arg.includes('private-token-secondary'))));
});

test('successful active-account reads do not enumerate accounts and rate limits do not trigger fallback', async () => {
  let calls = 0;
  assert.deepEqual(await createGitHubAccountReader(async () => {
    calls++; return { stdout: '[]', stderr: '', exitCode: 0 };
  })(endpoint), []);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => createGitHubAccountReader(async () => {
    calls++; return { stdout: '', stderr: 'HTTP 403 rate limit exceeded', exitCode: 1 };
  })(endpoint), (error: any) => error.issue?.code === 'RATE_LIMITED');
  assert.equal(calls, 1);
});

test('request deduplication keeps credentials isolated between accounts', async () => {
  let calls = 0;
  const runner: CommandRunner = async (_exe, _args, options) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { stdout: options?.env?.GH_TOKEN || '', stderr: '', exitCode: 0 };
  };
  const [a, b] = await Promise.all([
    runDeduplicatedCommand('gh', ['api', 'test'], { env: { GH_TOKEN: 'account-a' } }, runner),
    runDeduplicatedCommand('gh', ['api', 'test'], { env: { GH_TOKEN: 'account-b' } }, runner),
  ]);
  assert.equal(calls, 2);
  assert.equal(a.stdout, 'account-a');
  assert.equal(b.stdout, 'account-b');
});

test('account credentials are redacted from upstream failures', async () => {
  const { runGh } = await import('../cli.js');
  await assert.rejects(() => runGh(endpoint, async () => ({ stdout: '', stderr: 'Failure sensitive-credential', exitCode: 1 }), 'sensitive-credential'),
    (error: Error) => !error.message.includes('sensitive-credential'));
  await assert.rejects(() => runGh(endpoint, async () => ({ stdout: 'sensitive-credential', stderr: '', exitCode: 0 }), 'sensitive-credential'),
    (error: Error) => !error.message.includes('sensitive-credential'));
});
