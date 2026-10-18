import { CliError } from './cli.js';

type CommandValidator = (args: string[]) => boolean;

function validateFixedJson(args: string[]): boolean {
  return args.length === 3 && args[2] === '--json';
}

function validateStatus(args: string[]): boolean {
  return args.length === 2 && args[1] === '--json';
}

function validateSkillsInstalled(args: string[]): boolean {
  return args.length === 3 && args[2] === '--json';
}

function validateWorktreePs(args: string[]): boolean {
  if (args.length === 3 && args[2] === '--json') return true;
  if (args.length === 4 && args[2] === '--limit' && /^\d+$/.test(args[3])) return true;
  if (args.length === 5 && args[2] === '--limit' && /^\d+$/.test(args[3]) && args[4] === '--json') return true;
  return false;
}

function validateWorktreeList(args: string[]): boolean {
  return (
    args.length === 7 &&
    args[2] === '--repo' &&
    args[3].startsWith('id:') &&
    args[4] === '--limit' &&
    /^\d+$/.test(args[5]) &&
    args[6] === '--json'
  );
}

function validateWorktreeRm(args: string[]): boolean {
  if (
    args[2] === '--worktree' &&
    typeof args[3] === 'string' &&
    args[3].length > 0 &&
    args[3].length <= 512 &&
    !args[3].startsWith('--')
  ) {
    if (args.length === 5 && args[4] === '--json') return true;
    if (args.length === 6 && args[4] === '--force' && args[5] === '--json') return true;
  }
  return false;
}

function validateTerminalList(args: string[]): boolean {
  if (
    args[2] === '--worktree' &&
    args[3].startsWith('id:') &&
    args[4] === '--limit' &&
    /^\d+$/.test(args[5])
  ) {
    if (args.length === 7 && args[6] === '--json') return true;
    if (args.length === 8 && args[6] === '--include-visual-layouts' && args[7] === '--json') return true;
  }
  return false;
}

function validateTerminalRead(args: string[]): boolean {
  if (args[2] !== '--terminal' || !/^term_[a-zA-Z0-9_-]+$/.test(args[3])) return false;
  let idx = 4;
  if (args[idx] === '--cursor' && idx + 1 < args.length) idx += 2;
  if (args[idx] === '--limit' && idx + 1 < args.length && /^\d+$/.test(args[idx + 1])) idx += 2;
  return idx === args.length - 1 && args[idx] === '--json';
}

function validateTerminalSend(args: string[]): boolean {
  if (
    args.length === 6 &&
    args[2] === '--terminal' &&
    /^term_[a-zA-Z0-9_-]+$/.test(args[3]) &&
    args[4] === '--enter' &&
    args[5] === '--json'
  ) {
    return true;
  }
  if (
    args[2] === '--terminal' &&
    /^term_[a-zA-Z0-9_-]+$/.test(args[3]) &&
    args[4] === '--text' &&
    typeof args[5] === 'string'
  ) {
    if (args.length === 7 && args[6] === '--json') return true;
    if (args.length === 8 && args[6] === '--enter' && args[7] === '--json') return true;
  }
  return false;
}

function validateTerminalClose(args: string[]): boolean {
  if (args[2] === '--terminal' && /^term_[a-zA-Z0-9_-]+$/.test(args[3])) {
    if (args.length === 5 && args[4] === '--json') return true;
    if (args.length === 6 && args[4] === '--tab' && args[5] === '--json') return true;
  }
  if (
    args.length === 6 &&
    args[2] === '--worktree' &&
    typeof args[3] === 'string' &&
    args[3].length > 0 &&
    args[3].length <= 512 &&
    !args[3].startsWith('--') &&
    args[4] === '--all' &&
    args[5] === '--json'
  ) {
    return true;
  }
  return false;
}

function validateTerminalRename(args: string[]): boolean {
  if (args[0] !== 'terminal' || args[1] !== 'rename') return false;
  let idx = 2;
  let hasTerminal = false;
  let hasJson = false;
  while (idx < args.length) {
    if (args[idx] === '--terminal') {
      const handle = args[idx + 1];
      if (!handle || !/^term_[a-zA-Z0-9_-]+$/.test(handle)) return false;
      hasTerminal = true;
      idx += 2;
    } else if (args[idx] === '--title') {
      const title = args[idx + 1];
      if (
        typeof title !== 'string' ||
        title.length > 100 ||
        title.includes('\n') ||
        title.includes('\r') ||
        title.startsWith('--')
      )
        return false;
      idx += 2;
    } else if (args[idx] === '--json') {
      hasJson = true;
      idx += 1;
    } else {
      return false;
    }
  }
  return hasTerminal && hasJson;
}

function validateTerminalCreate(args: string[]): boolean {
  if (args[0] !== 'terminal' || args[1] !== 'create') return false;
  let idx = 2;
  let hasWorktree = false;
  let hasJson = false;
  while (idx < args.length) {
    if (args[idx] === '--worktree') {
      const wt = args[idx + 1];
      if (!wt || wt.length > 512 || wt.startsWith('--')) return false;
      hasWorktree = true;
      idx += 2;
    } else if (args[idx] === '--command') {
      const cmd = args[idx + 1];
      if (
        typeof cmd !== 'string' ||
        cmd.length === 0 ||
        cmd.length > 200 ||
        cmd.includes('\n') ||
        cmd.includes('\r') ||
        cmd.startsWith('--')
      )
        return false;
      idx += 2;
    } else if (args[idx] === '--title') {
      const title = args[idx + 1];
      if (
        typeof title !== 'string' ||
        title.length > 100 ||
        title.includes('\n') ||
        title.includes('\r') ||
        title.startsWith('--')
      )
        return false;
      idx += 2;
    } else if (args[idx] === '--focus') {
      idx += 1;
    } else if (args[idx] === '--json') {
      hasJson = true;
      idx += 1;
    } else {
      return false;
    }
  }
  return hasWorktree && hasJson;
}

function validateOrchestrationRunList(args: string[]): boolean {
  if (args[2] !== '--limit' || !/^\d+$/.test(args[3])) return false;
  let idx = 4;
  if (args[idx] === '--cursor' && idx + 1 < args.length) idx += 2;
  return idx === args.length - 1 && args[idx] === '--json';
}

function validateOrchestrationWorkerList(args: string[]): boolean {
  if (args[2] !== '--run' || !/^run_[a-zA-Z0-9_-]+$/.test(args[3])) return false;
  if (args[4] !== '--limit' || !/^\d+$/.test(args[5])) return false;
  let idx = 6;
  if (args[idx] === '--cursor' && idx + 1 < args.length) idx += 2;
  return idx === args.length - 1 && args[idx] === '--json';
}

function validateOrchestrationTaskList(args: string[]): boolean {
  return (
    args.length === 5 &&
    args[2] === '--run' &&
    /^run_[a-zA-Z0-9_-]+$/.test(args[3]) &&
    args[4] === '--json'
  );
}

function validateOrchestrationWorkerShow(args: string[]): boolean {
  return (
    args.length === 5 &&
    args[2] === '--dispatch' &&
    /^ctx_[a-zA-Z0-9_-]+$/.test(args[3]) &&
    args[4] === '--json'
  );
}

function validateOrchestrationWorkerRead(args: string[]): boolean {
  if (
    args[2] !== '--dispatch' ||
    !/^ctx_[a-zA-Z0-9_-]+$/.test(args[3]) ||
    args[4] !== '--source' ||
    args[5] !== 'transcript'
  ) {
    return false;
  }
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
        return idx === args.length - 1 && args[idx] === '--json';
      }
    }
  }
  return false;
}

function validateOrchestrationSend(args: string[]): boolean {
  if (
    args[2] !== '--subject' ||
    typeof args[3] !== 'string' ||
    args[4] !== '--body' ||
    typeof args[5] !== 'string' ||
    args[6] !== '--to' ||
    typeof args[7] !== 'string'
  ) {
    return false;
  }
  let idx = 8;
  if (args[idx] === '--run' && idx + 1 < args.length && /^run_[a-zA-Z0-9_-]+$/.test(args[idx + 1])) {
    idx += 2;
  }
  return idx === args.length - 1 && args[idx] === '--json';
}

const safeWorktreeText = (value: string | undefined, max: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !value.startsWith('-') &&
  !/[\x00-\x1f\x7f]/.test(value);

function validateWorktreeSet(args: string[]): boolean {
  return (
    args.length === 7 &&
    args[2] === '--worktree' &&
    safeWorktreeText(args[3], 1024) &&
    args[4] === '--display-name' &&
    typeof args[5] === 'string' &&
    args[5].length <= 100 &&
    !args[5].startsWith('-') &&
    !/[\x00-\x1f\x7f]/.test(args[5]) &&
    args[6] === '--json'
  );
}

function validateWorktreeCreate(args: string[]): boolean {
  if (
    args[2] !== '--repo' ||
    !safeWorktreeText(args[3], 512) ||
    args[4] !== '--name' ||
    !safeWorktreeText(args[5], 100) ||
    args[6] !== '--no-parent'
  )
    return false;
  const seen = new Set<string>();
  let i = 7;
  for (; i < args.length - 1; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (seen.has(flag) || !safeWorktreeText(value, 256)) return false;
    seen.add(flag);
    if (flag === '--setup') {
      if (!['inherit', 'run', 'skip'].includes(value)) return false;
    } else if (flag === '--agent') {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return false;
    } else if (flag === '--pr' || flag === '--issue') {
      if (!/^[1-9][0-9]{0,8}$/.test(value)) return false;
    } else if (flag !== '--base-branch') return false;
  }
  return i === args.length - 1 && args[i] === '--json' && !(seen.has('--pr') && seen.has('--issue'));
}

const ORCA_COMMAND_VALIDATORS: Record<string, CommandValidator> = {
  status: validateStatus,
  'skills installed': validateSkillsInstalled,
  'project list': validateFixedJson,
  'project setups': validateFixedJson,
  'repo list': validateFixedJson,
  'worktree ps': validateWorktreePs,
  'worktree list': validateWorktreeList,
  'worktree rm': validateWorktreeRm,
  'worktree set': validateWorktreeSet,
  'worktree create': validateWorktreeCreate,
  'terminal list': validateTerminalList,
  'terminal read': validateTerminalRead,
  'terminal send': validateTerminalSend,
  'terminal close': validateTerminalClose,
  'terminal rename': validateTerminalRename,
  'terminal create': validateTerminalCreate,
  'orchestration run-list': validateOrchestrationRunList,
  'orchestration worker-list': validateOrchestrationWorkerList,
  'orchestration task-list': validateOrchestrationTaskList,
  'orchestration worker-show': validateOrchestrationWorkerShow,
  'orchestration worker-read': validateOrchestrationWorkerRead,
  'orchestration send': validateOrchestrationSend,
};

export function validateOrcaArgs(args: string[]): void {
  if (args.length === 0) {
    throw new CliError('INVALID_ARGUMENT', 'Orca command arguments cannot be empty');
  }

  const twoWordKey = args.length >= 2 ? `${args[0]} ${args[1]}` : args[0];
  const validator = ORCA_COMMAND_VALIDATORS[twoWordKey] ?? ORCA_COMMAND_VALIDATORS[args[0]];

  if (validator && validator(args)) {
    return;
  }

  throw new CliError('INVALID_ARGUMENT', `Orca command arguments not in allowlist: ${args.join(' ')}`);
}

export function validateGhEndpoint(endpoint: string): void {
  const paged = endpoint.match(/^(.*)&page=([1-9][0-9]{0,4})$/);
  if (paged && !paged[1].includes('&page=') && Number(paged[2]) <= 10000) {
    validateGhEndpoint(paged[1]);
    return;
  }

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
