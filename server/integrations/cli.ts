import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Issue, ErrorCode } from '../../shared/contracts.js';
import { validateGhEndpoint } from './cliValidators.js';

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
  private queue: {grant:()=>void}[] = [];

  constructor(private readonly maxConcurrency: number = 3) {}

  async acquire(timeoutMs:number): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve,reject) => {
      const entry={grant:()=>{clearTimeout(timer);resolve();}};
      const timer=setTimeout(()=>{const index=this.queue.indexOf(entry);if(index>=0)this.queue.splice(index,1);reject(new CliError('CLI_TIMEOUT','Command timed out waiting for an execution slot',true));},timeoutMs);
      this.queue.push(entry);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.active = Math.max(0, this.active - 1);
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

  const deadline=Date.now()+timeoutMs;
  await limiter.acquire(timeoutMs);
  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled=false;
      const finish=(error?:Error,result?:CommandResult)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result!);};

      const child = spawn(executable, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: options.replaceEnv ? options.env : options.env ? { ...process.env, ...options.env } : process.env,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        finish(new CliError('CLI_TIMEOUT',`Command timed out after ${timeoutMs}ms`,true));
        // A descendant can keep inherited pipes open after its parent exits.
        // Settle on the deadline independently of the eventual close event.
        if(process.platform==='win32'&&child.pid&&child.exitCode===null&&child.signalCode===null){
          const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          const stop=setTimeout(()=>killer.kill(),1500);stop.unref();killer.once('error',()=>clearTimeout(stop));killer.once('exit',()=>clearTimeout(stop));killer.unref();
        }
        child.kill('SIGTERM');
        const force=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);force.unref();
        child.stdout?.destroy();child.stderr?.destroy();
      }, Math.max(1,deadline-Date.now()));

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
          finish(new CliError('CLI_MISSING', `Executable '${executable}' not found`, false));
        } else {
          finish(new CliError('CLI_FAILED', `Failed to execute '${executable}': ${err.message}`, false));
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          finish(new CliError('CLI_TIMEOUT', `Command timed out after ${timeoutMs}ms`, true));
        } else {
          finish(undefined,{
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

export async function runGit(args:string[],cwd?:string,runner:CommandRunner=defaultCommandRunner):Promise<string>{
  if(args.length!==2||args[0]!=='remote'||args[1]!=='-v')throw new CliError('INVALID_ARGUMENT',`Git command arguments not allowed: ${args.join(' ')}`);
  const result=await runDeduplicatedCommand(GIT_PATH,args,{cwd,timeoutMs:12000},runner);
  if(result.exitCode!==0)throw new CliError('CLI_FAILED',`git remote exited with code ${result.exitCode}: ${result.stderr.slice(0,300)}`);
  return result.stdout;
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
