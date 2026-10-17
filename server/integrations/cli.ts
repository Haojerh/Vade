import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Issue, ErrorCode } from '../../shared/contracts.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    maxStdout?: number;
    maxStderr?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    replaceEnv?: boolean;
  }
) => Promise<CommandResult>;

export class CliError extends Error {
  public issue: Issue;
  public exitCode?: number;
  public stderr?: string;

  constructor(code: ErrorCode, message: string, retryable: boolean = false, exitCode?: number, stderr?: string) {
    super(`[${code}] ${message}`);
    this.name = 'CliError';
    this.issue = { code, message, retryable };
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

// Global concurrency limiter (max 3 concurrent CLI spawns)
class ConcurrencyLimiter {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly maxConcurrency: number = 3) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

const limiter = new ConcurrencyLimiter(3);
const inFlightRequests = new Map<string, Promise<CommandResult>>();

export function resolveExecutable(envVar: string, defaultName: string, candidatePaths: string[] = []): string {
  if (process.env[envVar]) {
    return process.env[envVar]!;
  }
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return defaultName;
}

const localAppData = process.env.LOCALAPPDATA || '';
export const ORCA_PATH = resolveExecutable('ORCA_PATH', 'orca', [
  path.join(localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
]);
export const GIT_PATH = resolveExecutable('GIT_PATH', 'git');
export const GH_PATH = resolveExecutable('GH_PATH', 'gh');

export const defaultCommandRunner: CommandRunner = async (
  executable: string,
  args: string[],
  options = {}
): Promise<CommandResult> => {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxStdout = options.maxStdout ?? 4 * 1024 * 1024; // 4 MiB
  const maxStderr = options.maxStderr ?? 16 * 1024; // 16 KiB

  await limiter.acquire();
  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      const child = spawn(executable, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: options.replaceEnv ? options.env : options.env ? { ...process.env, ...options.env } : process.env,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length <= maxStdout) {
          stdout += chunk.toString('utf8');
        } else {
          stdout += chunk.subarray(0, Math.max(0, maxStdout - stdout.length)).toString('utf8');
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length + chunk.length <= maxStderr) {
          stderr += chunk.toString('utf8');
        } else {
          stderr += chunk.subarray(0, Math.max(0, maxStderr - stderr.length)).toString('utf8');
        }
      });

      child.on('error', (err: any) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new CliError('CLI_MISSING', `Executable '${executable}' not found`, false));
        } else {
          reject(new CliError('CLI_FAILED', `Failed to execute '${executable}': ${err.message}`, false));
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new CliError('CLI_TIMEOUT', `Command timed out after ${timeoutMs}ms`, true));
        } else {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          });
        }
      });
    });
  } finally {
    limiter.release();
  }
};

export async function runDeduplicatedCommand(
  executable: string,
  args: string[],
  options?: { timeoutMs?: number; maxStdout?: number; maxStderr?: number; cwd?: string; env?: NodeJS.ProcessEnv; replaceEnv?: boolean },
  runner: CommandRunner = defaultCommandRunner
): Promise<CommandResult> {
  const environmentKey = options?.env ? crypto.createHash('sha256').update(JSON.stringify(options.env)).digest('hex') : '';
  const cacheKey = `${executable}::${JSON.stringify(args)}::${options?.cwd ?? ''}::${options?.replaceEnv ?? false}::${environmentKey}`;
  const existing = inFlightRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = runner(executable, args, options).finally(() => {
    inFlightRequests.delete(cacheKey);
  });
  inFlightRequests.set(cacheKey, promise);
  return promise;
}

// Allowlist validation for Orca
export function validateOrcaArgs(args: string[]): void {
  if (args.length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'Orca command arguments cannot be empty');
  }

  const sub = args[0];
  if (sub === 'status' && args.length === 2 && args[1] === '--json') return;
  if (sub === 'skills' && args[1] === 'installed' && args[2] === '--json' && args.length === 3) return;
  if (sub === 'project' && args[1] === 'list' && args[2] === '--json') return;
  if (sub === 'project' && args[1] === 'setups' && args[2] === '--json') return;
  if (sub === 'repo' && args[1] === 'list' && args[2] === '--json') return;

  if (sub === 'worktree' && args[1] === 'ps') {
    // allow --limit <n> --json
    if (args.length === 4 && args[2] === '--limit' && /^\d+$/.test(args[3])) return;
    if (args.length === 5 && args[2] === '--limit' && /^\d+$/.test(args[3]) && args[4] === '--json') return;
    if (args.length === 3 && args[2] === '--json') return;
  }

  if (sub === 'worktree' && args[1] === 'list') {
    // worktree list --repo id:<discoveredRepo> --limit 200 --json
    if (
      args[2] === '--repo' &&
      args[3].startsWith('id:') &&
      args[4] === '--limit' &&
      /^\d+$/.test(args[5]) &&
      args[6] === '--json'
    ) {
      return;
    }
  }

  if (sub === 'terminal' && args[1] === 'list') {
    // terminal list --worktree id:<discoveredFullId> --limit 100 --json
    if (
      args[2] === '--worktree' &&
      args[3].startsWith('id:') &&
      args[4] === '--limit' &&
      /^\d+$/.test(args[5]) &&
      args[6] === '--json'
    ) {
      return;
    }
  }

  if (sub === 'terminal' && args[1] === 'read') {
    // terminal read --terminal <discoveredHandle> [--cursor <issuedCursor>] --limit <bounded> --json
    if (args[2] === '--terminal' && /^term_[a-zA-Z0-9_-]+$/.test(args[3])) {
      let idx = 4;
      if (args[idx] === '--cursor' && idx + 1 < args.length) {
        idx += 2;
      }
      if (args[idx] === '--limit' && idx + 1 < args.length && /^\d+$/.test(args[idx + 1])) {
        idx += 2;
      }
      if (idx === args.length - 1 && args[idx] === '--json') {
        return;
      }
    }
  }

  if (sub === 'terminal' && args[1] === 'send') {
    if (args.length === 6 && args[2] === '--terminal' && /^term_[a-zA-Z0-9_-]+$/.test(args[3]) &&
      args[4] === '--enter' && args[5] === '--json') return;
    // terminal send --terminal <handle> --text <text> --enter --json
    if (
      args[2] === '--terminal' &&
      /^term_[a-zA-Z0-9_-]+$/.test(args[3]) &&
      args[4] === '--text' &&
      typeof args[5] === 'string' &&
      ((args[6] === '--enter' && args[7] === '--json' && args.length === 8) ||
        (args[6] === '--json' && args.length === 7))
    ) {
      return;
    }
  }

  if (sub === 'orchestration') {
    const verb = args[1];
    if (verb === 'run-list') {
      // run-list --limit 50 [--cursor <returnedCursor>] --json
      if (args[2] === '--limit' && /^\d+$/.test(args[3])) {
        let idx = 4;
        if (args[idx] === '--cursor' && idx + 1 < args.length) {
          idx += 2;
        }
        if (idx === args.length - 1 && args[idx] === '--json') {
          return;
        }
      }
    }

    if (verb === 'worker-list') {
      // worker-list --run <discoveredRun> --limit 100 [--cursor <returnedCursor>] --json
      if (args[2] === '--run' && /^run_[a-zA-Z0-9_-]+$/.test(args[3]) && args[4] === '--limit' && /^\d+$/.test(args[5])) {
        let idx = 6;
        if (args[idx] === '--cursor' && idx + 1 < args.length) {
          idx += 2;
        }
        if (idx === args.length - 1 && args[idx] === '--json') {
          return;
        }
      }
    }

    if (verb === 'task-list') {
      // task-list --run <associatedRun> --json
      if (args[2] === '--run' && /^run_[a-zA-Z0-9_-]+$/.test(args[3]) && args[4] === '--json') {
        return;
      }
    }

    if (verb === 'worker-show') {
      // orchestration worker-show --dispatch <discovered ctx_ID> --json
      if (args[2] === '--dispatch' && /^ctx_[a-zA-Z0-9_-]+$/.test(args[3]) && args[4] === '--json') {
        return;
      }
    }

    if (verb === 'worker-read') {
      // orchestration worker-read --dispatch <discovered ctx_ID> --source transcript [--cursor <server-stored upstream cursor>] --limit <1..200> --json
      if (
        args[2] === '--dispatch' &&
        /^ctx_[a-zA-Z0-9_-]+$/.test(args[3]) &&
        args[4] === '--source' &&
        args[5] === 'transcript'
      ) {
        let idx = 6;
        if (args[idx] === '--cursor') {
          const cursorVal = args[idx + 1];
          if (
            typeof cursorVal !== 'string' ||
            cursorVal.length === 0 ||
            cursorVal.length > 512 ||
            cursorVal.startsWith('--')
          ) {
            throw new CliError('INVALID_ARGUMENT', 'Invalid cursor argument');
          }
          idx += 2;
        }
        if (args[idx] === '--limit') {
          const limitVal = args[idx + 1];
          if (/^\d+$/.test(limitVal)) {
            const parsed = parseInt(limitVal, 10);
            if (parsed >= 1 && parsed <= 200) {
              idx += 2;
              if (idx === args.length - 1 && args[idx] === '--json') {
                return;
              }
            }
          }
        }
      }
    }

    if (verb === 'send') {
      // orchestration send --subject <subject> --body <body> --to <target> [--run <run_id>] --json
      if (
        args[2] === '--subject' &&
        typeof args[3] === 'string' &&
        args[4] === '--body' &&
        typeof args[5] === 'string' &&
        args[6] === '--to' &&
        typeof args[7] === 'string'
      ) {
        let idx = 8;
        if (args[idx] === '--run' && idx + 1 < args.length && /^run_[a-zA-Z0-9_-]+$/.test(args[idx + 1])) {
          idx += 2;
        }
        if (idx === args.length - 1 && args[idx] === '--json') {
          return;
        }
      }
    }
  }

  throw new CliError('INVALID_ARGUMENT', `Orca command arguments not in allowlist: ${args.join(' ')}`);
}

export interface OrcaEnvelope<T> {
  id?: string;
  ok: boolean;
  result: T;
  _meta?: {
    runtimeId?: string;
  };
}

export function cleanErrorMessage(msg: string): string {
  if (!msg || typeof msg !== 'string') return '';
  let cleaned = msg.trim();
  while (/^\[?[A-Z_]+\]?:?\s*/.test(cleaned)) {
    const match = cleaned.match(/^\[?([A-Z_]+)\]?:?\s*(.*)$/);
    if (
      match &&
      [
        'CLI_FAILED',
        'CONVERSATION_UNSUPPORTED',
        'SOURCE_CHANGED',
        'INVALID_UPSTREAM',
        'CLI_TIMEOUT',
        'CLI_MISSING',
        'INTERNAL',
      ].includes(match[1])
    ) {
      cleaned = match[2].trim();
    } else {
      break;
    }
  }
  return cleaned || msg;
}

export interface RunOrcaOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  replaceEnv?: boolean;
}

export async function runOrca<T = any>(
  args: string[],
  runner: CommandRunner = defaultCommandRunner,
  options?: RunOrcaOptions
): Promise<OrcaEnvelope<T>> {
  validateOrcaArgs(args);

  const timeoutMs = options?.timeoutMs ?? 8000;
  const res = await runDeduplicatedCommand(ORCA_PATH, args, {
    timeoutMs,
    ...(options?.env ? { env: options.env, replaceEnv: options.replaceEnv } : {}),
  }, runner);

  if (res.exitCode !== 0) {
    let msg = `Orca CLI exited with code ${res.exitCode}`;
    let issueCode: ErrorCode = 'CLI_FAILED';
    try {
      const parsed = JSON.parse(res.stdout);
      if (parsed && typeof parsed.error === 'string') {
        msg = parsed.error;
      } else if (parsed && parsed.error && typeof parsed.error.message === 'string') {
        msg = parsed.error.message;
        if (parsed.error.code === 'source_changed' || parsed.error.data?.reason === 'source_changed') {
          issueCode = 'SOURCE_CHANGED';
        } else if (
          parsed.error.code === 'transcript_required' ||
          parsed.error.data?.reason === 'provider_unsupported' ||
          parsed.error.data?.reason === 'session_not_reported' ||
          parsed.error.data?.reason === 'release_completed'
        ) {
          issueCode = 'CONVERSATION_UNSUPPORTED';
        }
      } else if (parsed && typeof parsed.message === 'string') {
        msg = parsed.message;
      }
    } catch {
      if (res.stderr.trim()) {
        msg = res.stderr.trim().slice(0, 500);
      }
    }
    msg = cleanErrorMessage(msg);
    throw new CliError(issueCode, msg, false, res.exitCode, res.stderr);
  }

  try {
    const envelope = JSON.parse(res.stdout);
    if (!envelope || typeof envelope !== 'object') {
      throw new Error('Expected JSON object');
    }
    if (envelope.ok !== true || envelope.result === undefined) {
      const msg = cleanErrorMessage(
        envelope.error?.message || envelope.message || 'Orca command reported failure'
      );
      const isUnsupported =
        envelope.error?.code === 'transcript_required' ||
        envelope.error?.data?.reason === 'provider_unsupported' ||
        envelope.error?.data?.reason === 'session_not_reported';
      throw new CliError(isUnsupported ? 'CONVERSATION_UNSUPPORTED' : 'INVALID_UPSTREAM', msg, false);
    }
    return envelope as OrcaEnvelope<T>;
  } catch (err: any) {
    if (err instanceof CliError) throw err;
    throw new CliError('INVALID_UPSTREAM', `Failed to parse Orca JSON response: ${err.message}`, false);
  }
}

export async function runGit(
  args: string[],
  cwd?: string,
  runner: CommandRunner = defaultCommandRunner
): Promise<string> {
  // Only allow remote -v or similar read-only git queries
  if (args.length !== 2 || args[0] !== 'remote' || args[1] !== '-v') {
    throw new CliError('INVALID_ARGUMENT', `Git command arguments not allowed: ${args.join(' ')}`);
  }

  const res = await runDeduplicatedCommand(GIT_PATH, args, { cwd, timeoutMs: 12000 }, runner);
  if (res.exitCode !== 0) {
    throw new CliError('CLI_FAILED', `git remote exited with code ${res.exitCode}: ${res.stderr.slice(0, 300)}`);
  }
  return res.stdout;
}

export function validateGhEndpoint(endpoint: string): void {
  const paged = endpoint.match(/^(.*)&page=([1-9][0-9]{0,4})$/);
  if (paged && !paged[1].includes('&page=') && Number(paged[2]) <= 10000) {
    validateGhEndpoint(paged[1]);
    return;
  }
  // Allowed templates:
  // repos/{owner}/{repo}/commits?per_page=20
  // repos/{owner}/{repo}/commits?per_page=20&sha={encodedDiscoveredBranch}
  // repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=20
  // repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=20&head={encodedOwnerColonBranch}
  // repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&per_page=20

  const commitsNoSha = endpoint.match(/^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/commits\?per_page=20$/);
  if (commitsNoSha) return;

  const commitsSha = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/commits\?per_page=20&sha=([^&]+)$/
  );
  if (commitsSha) {
    const rawSha = commitsSha[3];
    try {
      const decoded = decodeURIComponent(rawSha);
      if (
        decoded.length > 0 &&
        decoded.length <= 256 &&
        !/[\x00-\x1F\x7F]/.test(decoded) &&
        encodeURIComponent(decoded) === rawSha
      ) {
        return;
      }
    } catch {}
  }

  const pullsNoHead = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pulls\?state=all&sort=updated&direction=desc&per_page=20$/
  );
  if (pullsNoHead) return;

  const pullsHead = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pulls\?state=all&sort=updated&direction=desc&per_page=20&head=([^&]+)$/
  );
  if (pullsHead) {
    const rawHead = pullsHead[3];
    try {
      const decoded = decodeURIComponent(rawHead);
      if (
        decoded.length > 0 &&
        decoded.length <= 256 &&
        !/[\x00-\x1F\x7F]/.test(decoded) &&
        encodeURIComponent(decoded) === rawHead
      ) {
        return;
      }
    } catch {}
  }

  const issuesPattern = endpoint.match(
    /^repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\?state=all&sort=updated&direction=desc&per_page=20$/
  );
  if (issuesPattern) return;

  throw new CliError('INVALID_ARGUMENT', `GitHub endpoint pattern not allowed: ${endpoint}`);
}

export async function runGh(
  endpoint: string,
  runner: CommandRunner = defaultCommandRunner,
  accountToken?: string
): Promise<any> {
  validateGhEndpoint(endpoint);

  const args = ['api', '--method', 'GET', endpoint];
  const res = await runDeduplicatedCommand(GH_PATH, args, { timeoutMs: 12000,
    ...(accountToken ? { env: { GH_TOKEN: accountToken, GITHUB_TOKEN: '', GH_HOST: 'github.com', GH_DEBUG: '' } } : {}),
  }, runner);

  if (res.exitCode !== 0) {
    const rawError = (res.stderr || res.stdout).trim();
    const errText = accountToken ? rawError.replaceAll(accountToken, '[redacted]') : rawError;
    if (errText.includes('409') && (errText.includes('Git Repository is empty') || errText.includes('empty repository'))) {
      const err = new CliError('REMOTE_MISSING', 'Git Repository is empty.', false, 409);
      (err as any).httpStatus = 409;
      throw err;
    }
    if (errText.includes('404') || errText.includes('Not Found') || errText.includes('422')) {
      throw new CliError('GITHUB_NOT_FOUND', 'GitHub repository or resource not found', false, 404);
    }
    if (errText.includes('403') || errText.toLowerCase().includes('rate limit')) {
      if (errText.toLowerCase().includes('rate limit')) {
        throw new CliError('RATE_LIMITED', 'GitHub rate limit exceeded', true, 403);
      }
      throw new CliError('GITHUB_FORBIDDEN', 'GitHub access forbidden', false, 403);
    }
    if (errText.includes('401') || errText.includes('authentication') || errText.includes('auth login')) {
      throw new CliError('AUTH_REQUIRED', 'GitHub authentication required', false, 401);
    }
    throw new CliError('CLI_FAILED', `gh api failed: ${errText.slice(0, 300)}`, false, res.exitCode);
  }

  try {
    return JSON.parse(res.stdout);
  } catch (err: any) {
    throw new CliError('INVALID_UPSTREAM', accountToken ? 'Failed to parse GitHub JSON' : `Failed to parse GitHub JSON: ${err.message}`, false);
  }
}
