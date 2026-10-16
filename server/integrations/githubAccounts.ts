import { GH_PATH, runGh, type CommandRunner } from './cli.js';

const accessErrors = new Set(['AUTH_REQUIRED', 'GITHUB_FORBIDDEN', 'GITHUB_NOT_FOUND']);
const storedAccountEnvironment = { GH_TOKEN: '', GITHUB_TOKEN: '', GH_DEBUG: '', GH_HOST: 'github.com' };

// Credentials stay in backend memory and child-process environments. Never switch
// gh's global active account, place tokens in argv, or return them to the browser.
export function createGitHubAccountReader(runner: CommandRunner) {
  let accountsPromise: Promise<string[]> | undefined;
  const tokens = new Map<string, Promise<string | null>>();
  const accounts = () => accountsPromise ??= (async () => {
    try {
      const result = await runner(GH_PATH, ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], {
        timeoutMs: 12000, maxStdout: 64 * 1024, maxStderr: 1024, env: storedAccountEnvironment,
      });
      if (result.exitCode !== 0) return [];
      const entries = JSON.parse(result.stdout).hosts?.['github.com'];
      if (!Array.isArray(entries)) return [];
      return [...new Set(entries.filter((entry) => entry.state === 'success' &&
        typeof entry.login === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(entry.login))
        .sort((a, b) => Number(a.active) - Number(b.active)).map((entry) => entry.login as string))].slice(0, 10);
    } catch { return []; }
  })();
  const tokenFor = (login: string) => {
    if (!tokens.has(login)) tokens.set(login, (async () => {
      try {
        const result = await runner(GH_PATH, ['auth', 'token', '--hostname', 'github.com', '--user', login], {
          timeoutMs: 5000, maxStdout: 4096, maxStderr: 1024, env: storedAccountEnvironment,
        });
        const token = result.stdout.trim();
        return result.exitCode === 0 && token.length > 0 && token.length <= 2048 && !/\s/.test(token) ? token : null;
      } catch { return null; }
    })());
    return tokens.get(login)!;
  };
  return async (endpoint: string): Promise<any> => {
    try { return await runGh(endpoint, runner); }
    catch (original: any) {
      if (!accessErrors.has(original.issue?.code)) throw original;
      for (const login of await accounts()) {
        const token = await tokenFor(login);
        if (!token) continue;
        try { return await runGh(endpoint, runner, token); }
        catch (error: any) {
          if (!accessErrors.has(error.issue?.code)) throw error;
        }
      }
      throw original;
    }
  };
}
