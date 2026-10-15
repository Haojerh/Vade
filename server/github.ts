import {
  Id,
  ISO,
  GitHubData,
  PullRequest,
  Commit,
  PushEvent,
  Section,
  SourceMeta,
  Project,
  Issue,
} from '../shared/contracts.js';
import { runGh, runGit, CommandRunner, defaultCommandRunner, CliError } from './cli.js';
import { toIsoOrNull } from './orca.js';

export interface ParsedRepo {
  owner: string;
  name: string;
  url: string;
  remoteName: string | null;
}

export function parseGitHubUrl(rawUrl: string, remoteName: string | null = null): ParsedRepo {
  const trimmed = rawUrl.trim();
  // Match HTTPS: https://github.com/owner/repo(.git)?
  // or SSH: git@github.com:owner/repo(.git)?
  // or ssh://git@github.com/owner/repo(.git)?
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      name: httpsMatch[2],
      url: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`,
      remoteName,
    };
  }

  const sshMatch = trimmed.match(/^(?:ssh:\/\/)?git@github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      name: sshMatch[2],
      url: `https://github.com/${sshMatch[1]}/${sshMatch[2]}`,
      remoteName,
    };
  }

  if (trimmed.includes('gitlab.com') || trimmed.includes('bitbucket.org') || trimmed.includes('azure.com')) {
    throw new CliError('REMOTE_UNSUPPORTED', `Host in remote URL '${trimmed}' is not supported; only github.com is supported.`);
  }

  throw new CliError('REMOTE_MISSING', `Invalid or non-GitHub remote URL: '${trimmed}'`);
}

export function parseGitRemoteOutput(output: string): ParsedRepo {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates: { remoteName: string; parsed: ParsedRepo }[] = [];

  for (const line of lines) {
    // origin  https://github.com/owner/repo.git (fetch)
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const remoteName = parts[0];
      const url = parts[1];
      try {
        const parsed = parseGitHubUrl(url, remoteName);
        if (!candidates.some((c) => c.parsed.owner === parsed.owner && c.parsed.name === parsed.name)) {
          candidates.push({ remoteName, parsed });
        }
      } catch (err: any) {
        if (err.issue?.code === 'REMOTE_UNSUPPORTED') {
          throw err;
        }
      }
    }
  }

  if (candidates.length === 0) {
    throw new CliError('REMOTE_MISSING', 'No usable GitHub remotes found in git remote output');
  }

  // Prefer origin
  const originCandidate = candidates.find((c) => c.remoteName === 'origin');
  if (originCandidate) {
    return originCandidate.parsed;
  }

  if (candidates.length === 1) {
    return candidates[0].parsed;
  }

  // Multiple candidates without a clear origin
  throw new CliError('REMOTE_AMBIGUOUS', 'Multiple conflicting GitHub remotes found without a clear origin');
}

export async function resolveProjectRepo(
  project: Project,
  runner: CommandRunner = defaultCommandRunner
): Promise<ParsedRepo> {
  if (project.kind !== 'git' && !project.paths.length) {
    throw new CliError('REMOTE_MISSING', 'Project has no registered Git repository or local path');
  }

  // If path exists, check git remote -v
  const localPath = project.paths[0];
  if (localPath) {
    try {
      const remoteStdout = await runGit(['remote', '-v'], localPath, runner);
      return parseGitRemoteOutput(remoteStdout);
    } catch (err: any) {
      if (err.issue?.code === 'REMOTE_UNSUPPORTED' || err.issue?.code === 'REMOTE_AMBIGUOUS') {
        throw err;
      }
      // If git remote -v fails, try fallback below
    }
  }

  // If project has sourceProjectId like github:owner/repo
  if (project.sourceProjectId?.startsWith('github:')) {
    const raw = project.sourceProjectId.replace('github:', '');
    const parts = raw.split('/');
    if (parts.length === 2) {
      return {
        owner: parts[0],
        name: parts[1],
        url: `https://github.com/${parts[0]}/${parts[1]}`,
        remoteName: 'origin',
      };
    }
  }

  throw new CliError('REMOTE_MISSING', `No GitHub remote could be resolved for project ${project.id}`);
}

export async function collectGitHubData(
  project: Project,
  runner: CommandRunner = defaultCommandRunner
): Promise<GitHubData> {
  const attemptedAt = new Date().toISOString();

  let repo: ParsedRepo | null = null;
  try {
    repo = await resolveProjectRepo(project, runner);
  } catch (err: any) {
    const issue: Issue = {
      code: err.issue?.code || 'REMOTE_MISSING',
      message: err.message || 'Remote configuration missing or unsupported',
      retryable: false,
    };
    const emptyMeta: SourceMeta = {
      availability: 'unavailable',
      observedAt: null,
      attemptedAt,
      stale: false,
      partial: false,
      issue,
    };
    return {
      repository: null,
      auth: 'unknown',
      pullRequests: { data: null, meta: emptyMeta },
      commits: { data: null, meta: emptyMeta },
      pushEvents: { data: null, meta: emptyMeta },
    };
  }

  const { owner, name } = repo;
  const pullsEndpoint = `repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc&per_page=20`;
  const commitsEndpoint = `repos/${owner}/${name}/commits?per_page=20`;
  const eventsEndpoint = `repos/${owner}/${name}/events?per_page=100`;

  const [pullsRes, commitsRes, eventsRes] = await Promise.allSettled([
    runGh(pullsEndpoint, runner),
    runGh(commitsEndpoint, runner),
    runGh(eventsEndpoint, runner),
  ]);

  let authStatus: 'available' | 'required' | 'unknown' = 'unknown';

  // 1. Process Pull Requests
  let prSection: Section<PullRequest[]>;
  if (pullsRes.status === 'fulfilled') {
    authStatus = 'available';
    const rawPulls: any[] = Array.isArray(pullsRes.value) ? pullsRes.value : [];
    const prs: PullRequest[] = rawPulls.map((p) => ({
      number: p.number,
      title: p.title || '',
      url: p.html_url || `https://github.com/${owner}/${name}/pull/${p.number}`,
      state: p.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(p.draft),
      author: p.user?.login || null,
      updatedAt: toIsoOrNull(p.updated_at) || attemptedAt,
    }));
    prSection = {
      data: prs,
      meta: {
        availability: prs.length > 0 ? 'ready' : 'empty',
        observedAt: attemptedAt,
        attemptedAt,
        stale: false,
        partial: prs.length === 20,
        issue: null,
      },
    };
  } else {
    const err = pullsRes.reason;
    if (err.issue?.code === 'AUTH_REQUIRED') authStatus = 'required';
    prSection = {
      data: null,
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: false,
        issue: err.issue || { code: 'CLI_FAILED', message: err.message, retryable: true },
      },
    };
  }

  // 2. Process Commits
  let commitSection: Section<Commit[]>;
  if (commitsRes.status === 'fulfilled') {
    authStatus = 'available';
    const rawCommits: any[] = Array.isArray(commitsRes.value) ? commitsRes.value : [];
    const commits: Commit[] = rawCommits.map((c) => ({
      sha: c.sha || '',
      message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
      url: c.html_url || `https://github.com/${owner}/${name}/commit/${c.sha}`,
      author: c.commit?.author?.name || c.author?.login || null,
      committedAt: toIsoOrNull(c.commit?.author?.date || c.commit?.committer?.date),
    }));
    commitSection = {
      data: commits,
      meta: {
        availability: commits.length > 0 ? 'ready' : 'empty',
        observedAt: attemptedAt,
        attemptedAt,
        stale: false,
        partial: commits.length === 20,
        issue: null,
      },
    };
  } else {
    const err = commitsRes.reason;
    if (err.exitCode === 409 || err.httpStatus === 409 || err.issue?.message?.includes('empty')) {
      commitSection = {
        data: [],
        meta: {
          availability: 'empty',
          observedAt: attemptedAt,
          attemptedAt,
          stale: false,
          partial: false,
          issue: null,
        },
      };
    } else {
      if (err.issue?.code === 'AUTH_REQUIRED') authStatus = 'required';
      commitSection = {
        data: null,
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: false,
          issue: err.issue || { code: 'CLI_FAILED', message: err.message, retryable: true },
        },
      };
    }
  }

  // 3. Process Events
  let eventSection: Section<PushEvent[]>;
  if (eventsRes.status === 'fulfilled') {
    authStatus = 'available';
    const rawEvents: any[] = Array.isArray(eventsRes.value) ? eventsRes.value : [];
    const pushEvents: PushEvent[] = rawEvents
      .filter((e) => e.type === 'PushEvent')
      .map((e) => ({
        id: String(e.id),
        actor: e.actor?.login || null,
        ref: e.payload?.ref || null,
        before: e.payload?.before || null,
        head: e.payload?.head || null,
        at: toIsoOrNull(e.created_at) || attemptedAt,
      }));
    eventSection = {
      data: pushEvents,
      meta: {
        availability: pushEvents.length > 0 ? 'ready' : 'empty',
        observedAt: attemptedAt,
        attemptedAt,
        stale: false,
        partial: rawEvents.length === 100,
        issue: null,
      },
    };
  } else {
    const err = eventsRes.reason;
    if (err.issue?.code === 'AUTH_REQUIRED') authStatus = 'required';
    eventSection = {
      data: null,
      meta: {
        availability: 'unavailable',
        observedAt: null,
        attemptedAt,
        stale: false,
        partial: false,
        issue: err.issue || { code: 'CLI_FAILED', message: err.message, retryable: true },
      },
    };
  }

  return {
    repository: repo,
    auth: authStatus,
    pullRequests: prSection,
    commits: commitSection,
    pushEvents: eventSection,
  };
}
