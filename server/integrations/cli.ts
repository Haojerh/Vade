import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Issue, ErrorCode } from '../../shared/contracts.js';
import { validateOrcaArgs, validateGhEndpoint } from './cliValidators.js';

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

      const child = spawn(executable, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: options.replaceEnv ? options.env : options.env ? { ...process.env, ...options.env } : process.env,
      });

      const timer = setTimeout(() => {
        timedOut = true;
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
  options?: {
    timeoutMs?: number;
    maxStdout?: number;
    maxStderr?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    replaceEnv?: boolean;
  },
  runner: CommandRunner = defaultCommandRunner
): Promise<CommandResult> {
  const environmentKey = options?.env
    ? crypto.createHash('sha256').update(JSON.stringify(options.env)).digest('hex')
    : '';
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
  const res = await runDeduplicatedCommand(
    ORCA_PATH,
    args,
    {
      timeoutMs,
      ...(options?.env ? { env: options.env, replaceEnv: options.replaceEnv } : {}),
    },
    runner
  );

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
  if (args.length !== 2 || args[0] !== 'remote' || args[1] !== '-v') {
    throw new CliError('INVALID_ARGUMENT', `Git command arguments not allowed: ${args.join(' ')}`);
  }

  const res = await runDeduplicatedCommand(GIT_PATH, args, { cwd, timeoutMs: 12000 }, runner);
  if (res.exitCode !== 0) {
    throw new CliError('CLI_FAILED', `git remote exited with code ${res.exitCode}: ${res.stderr.slice(0, 300)}`);
  }
  return res.stdout;
}

export async function runGh(
  endpoint: string,
  runner: CommandRunner = defaultCommandRunner,
  accountToken?: string
): Promise<any> {
  validateGhEndpoint(endpoint);

  const args = ['api', '--method', 'GET', endpoint];
  const res = await runDeduplicatedCommand(
    GH_PATH,
    args,
    {
      timeoutMs: 12000,
      ...(accountToken
        ? { env: { GH_TOKEN: accountToken, GITHUB_TOKEN: '', GH_HOST: 'github.com', GH_DEBUG: '' } }
        : {}),
    },
    runner
  );

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
    throw new CliError(
      'INVALID_UPSTREAM',
      accountToken ? 'Failed to parse GitHub JSON' : `Failed to parse GitHub JSON: ${err.message}`,
      false
    );
  }
}
