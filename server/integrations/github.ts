import {
  GitHubData,
  GitHubQuery,
  GitHubScope,
  PullRequest,
  Commit,
  GitHubIssue,
  Section,
  SourceMeta,
  Project,
  Issue,
  Node,
  Graph,
} from '../../shared/contracts.js';
import { runGit, CommandRunner, defaultCommandRunner, CliError } from './cli.js';
import { createGitHubAccountReader } from './githubAccounts.js';
import { toIsoOrNull } from './orca/utils.js';
import { collectGraph } from './orca/graph.js';

export interface ParsedRepo {
  owner: string;
  name: string;
  url: string;
  remoteName: string | null;
}

export function parseGitHubUrl(rawUrl: string, remoteName: string | null = null): ParsedRepo {
  const trimmed = rawUrl.trim();
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
        if (process.env.NODE_ENV !== 'test') {
          console.debug(`[parseGitRemoteOutput] Skipping remote '${remoteName}' (${url}): ${err.message || err}`);
        }
      }
    }
  }

  if (candidates.length === 0) {
    throw new CliError('REMOTE_MISSING', 'No usable GitHub remotes found in git remote output');
  }

  const originCandidate = candidates.find((c) => c.remoteName === 'origin');
  if (originCandidate) {
    return originCandidate.parsed;
  }

  if (candidates.length === 1) {
    return candidates[0].parsed;
  }

  throw new CliError('REMOTE_AMBIGUOUS', 'Multiple conflicting GitHub remotes found without a clear origin');
}

export async function resolveProjectRepo(
  project: Project,
  runner: CommandRunner = defaultCommandRunner
): Promise<ParsedRepo> {
  if (project.kind !== 'git' && !project.paths.length) {
    throw new CliError('REMOTE_MISSING', 'Project has no registered Git repository or local path');
  }

  const localPath = project.paths[0];
  if (localPath) {
    try {
      const remoteStdout = await runGit(['remote', '-v'], localPath, runner);
      return parseGitRemoteOutput(remoteStdout);
    } catch (err: any) {
      if (err.issue?.code === 'REMOTE_UNSUPPORTED' || err.issue?.code === 'REMOTE_AMBIGUOUS') {
        throw err;
      }
    }
  }

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

export async function resolveWorktreeRepo(
  worktreePath: string,
  _project: Project,
  runner: CommandRunner = defaultCommandRunner
): Promise<ParsedRepo> {
  const remoteStdout = await runGit(['remote', '-v'], worktreePath, runner);
  return parseGitRemoteOutput(remoteStdout);
}

function unavailableSection<T>(attemptedAt: string, issue: Issue): Section<T> {
  return {
    data: null,
    meta: {
      availability: 'unavailable',
      observedAt: null,
      attemptedAt,
      stale: false,
      partial: false,
      issue,
    },
  };
}

function readyOrEmptySection<T>(data: T[], attemptedAt: string, partial: boolean): Section<T[]> {
  return {
    data,
    meta: {
      availability: data.length > 0 ? 'ready' : 'empty',
      observedAt: attemptedAt,
      attemptedAt,
      stale: false,
      partial,
      issue: null,
    },
  };
}

function buildPullRequestsSection(
  res: PromiseSettledResult<any>,
  owner: string,
  name: string,
  attemptedAt: string
): { section: Section<PullRequest[]>; auth: 'available' | 'required' | null; valid: boolean } {
  if (res.status === 'fulfilled') {
    if (!Array.isArray(res.value)) {
      return {
        section: unavailableSection(attemptedAt, {
          code: 'INVALID_UPSTREAM',
          message: 'Malformed pull requests payload from upstream: expected array',
          retryable: false,
        }),
        auth: 'available',
        valid: false,
      };
    }
    const rawPulls = res.value;
    if (rawPulls.some((p) => !p || typeof p !== 'object' || typeof p.number !== 'number')) {
      return {
        section: unavailableSection(attemptedAt, {
          code: 'INVALID_UPSTREAM',
          message: 'Malformed pull request item in upstream response',
          retryable: false,
        }),
        auth: 'available',
        valid: false,
      };
    }
    const prs: PullRequest[] = rawPulls.map((p) => {
      const mergedAt = toIsoOrNull(p.merged_at);
      const state: 'open' | 'closed' | 'merged' = mergedAt ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
      return {
        number: p.number,
        title: p.title || '',
        url: p.html_url || `https://github.com/${owner}/${name}/pull/${p.number}`,
        state,
        draft: Boolean(p.draft),
        author: p.user?.login || null,
        updatedAt: toIsoOrNull(p.updated_at),
        mergedAt,
        headRef: p.head?.ref || null,
        baseRef: p.base?.ref || null,
      };
    });
    return {
      section: readyOrEmptySection(prs, attemptedAt, rawPulls.length === 20),
      auth: 'available',
      valid: true,
    };
  }

  const err = res.reason;
  return {
    section: unavailableSection(
      attemptedAt,
      err.issue || { code: 'CLI_FAILED', message: err.message, retryable: true }
    ),
    auth: err.issue?.code === 'AUTH_REQUIRED' ? 'required' : null,
    valid: false,
  };
}

function buildCommitsSection(
  res: PromiseSettledResult<any>,
  owner: string,
  name: string,
  scopeKind: 'general' | 'worktree',
  attemptedAt: string
): { section: Section<Commit[]>; auth: 'available' | 'required' | null; valid: boolean } {
  if (res.status === 'fulfilled') {
    if (!Array.isArray(res.value)) {
      return {
        section: unavailableSection(attemptedAt, {
          code: 'INVALID_UPSTREAM',
          message: 'Malformed commits payload from upstream: expected array',
          retryable: false,
        }),
        auth: 'available',
        valid: false,
      };
    }
    const rawCommits = res.value;
    if (rawCommits.some((c) => !c || typeof c !== 'object' || typeof c.sha !== 'string' || !c.sha.trim())) {
      return {
        section: unavailableSection(attemptedAt, {
          code: 'INVALID_UPSTREAM',
          message: 'Malformed commit item in upstream response',
          retryable: false,
        }),
        auth: 'available',
        valid: false,
      };
    }
    const commits: Commit[] = rawCommits.map((c) => ({
      sha: c.sha,
      message: (c.commit?.message || '').split('\n')[0].slice(0, 200),
      url: c.html_url || `https://github.com/${owner}/${name}/commit/${c.sha}`,
      author: c.commit?.author?.name || c.author?.login || null,
      committedAt: toIsoOrNull(c.commit?.author?.date || c.commit?.committer?.date),
    }));
    return {
      section: readyOrEmptySection(commits, attemptedAt, rawCommits.length === 20),
      auth: 'available',
      valid: true,
    };
  }

  const err = res.reason;
  if (err.exitCode === 409 || err.httpStatus === 409 || err.issue?.message?.includes('empty')) {
    return {
      section: readyOrEmptySection<Commit>([], attemptedAt, false),
      auth: null,
      valid: true,
    };
  }

  let issueCode = err.issue?.code || 'CLI_FAILED';
  if (
    scopeKind === 'worktree' &&
    (err.issue?.code === 'GITHUB_NOT_FOUND' || err.exitCode === 404 || err.exitCode === 422)
  ) {
    issueCode = 'REMOTE_MISSING';
  }
  return {
    section: unavailableSection(attemptedAt, {
      code: issueCode,
      message: err.issue?.message || err.message,
      retryable: err.issue?.retryable ?? false,
    }),
    auth: err.issue?.code === 'AUTH_REQUIRED' ? 'required' : null,
    valid: false,
  };
}

function buildIssuesSection(
  res: PromiseSettledResult<any>,
  owner: string,
  name: string,
  attemptedAt: string
): { section: Section<GitHubIssue[]>; auth: 'available' | 'required' | null } {
  if (res.status === 'fulfilled') {
    if (!Array.isArray(res.value)) {
      return {
        section: unavailableSection(attemptedAt, {
          code: 'INVALID_UPSTREAM',
          message: 'Malformed issues payload from upstream: expected array',
          retryable: false,
        }),
        auth: 'available',
      };
    }
    const rawItems = res.value;
    if (rawItems.some((it) => !it || typeof it !== 'object' || typeof it.number !== 'number')) {
      return {
        section: unavailableSection(attemptedAt, {
          code: 'INVALID_UPSTREAM',
          message: 'Malformed issue item in upstream response',
          retryable: false,
        }),
        auth: 'available',
      };
    }
    const rawIssuesOnly = rawItems.filter((it) => !it.pull_request);
    const issues: GitHubIssue[] = rawIssuesOnly.map((it) => ({
      number: it.number,
      title: it.title || '',
      url: it.html_url || `https://github.com/${owner}/${name}/issues/${it.number}`,
      state: it.state === 'closed' ? 'closed' : 'open',
      author: it.user?.login || null,
      updatedAt: toIsoOrNull(it.updated_at),
      labels: Array.isArray(it.labels)
        ? it.labels.map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean)
        : [],
    }));
    return {
      section: readyOrEmptySection(issues, attemptedAt, rawItems.length === 20),
      auth: 'available',
    };
  }

  const err = res.reason;
  return {
    section: unavailableSection(
      attemptedAt,
      err.issue || { code: 'CLI_FAILED', message: err.message, retryable: true }
    ),
    auth: err.issue?.code === 'AUTH_REQUIRED' ? 'required' : null,
  };
}

export async function collectGitHubData(
  project: Project,
  query: GitHubQuery = { scope: 'general' },
  runner: CommandRunner = defaultCommandRunner,
  preloadedGraph?: Graph
): Promise<GitHubData> {
  const attemptedAt = new Date().toISOString();
  const readAccount = createGitHubAccountReader(runner);
  const pagination: NonNullable<GitHubData['pagination']> = {
    commits: { nextPage: null },
    prs: { nextPage: null },
    issues: { nextPage: null },
  };
  const page = query.page ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 10000 || (query.page !== undefined && !query.activity)) {
    throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub page');
  }
  const readGitHub = async (endpoint: string) => {
    const activity = endpoint.includes('/commits?')
      ? 'commits'
      : endpoint.includes('/pulls?')
        ? 'prs'
        : 'issues';
    if (query.activity && activity !== query.activity) return [];
    const result = await readAccount(endpoint + (page > 1 ? `&page=${page}` : ''));
    if (Array.isArray(result) && result.length === 20 && page < 10000) pagination[activity].nextPage = page + 1;
    return result;
  };

  let targetWorktreeNode: Node | null = null;
  if (query.scope === 'worktree') {
    if (!query.nodeId || typeof query.nodeId !== 'string') {
      throw new CliError('INVALID_ARGUMENT', 'Query parameter nodeId must be provided for worktree scope');
    }
    const graph = preloadedGraph ?? (await collectGraph(project.id, null, runner)).graph;
    const foundNode = graph.nodes.find((n) => n.id === query.nodeId);
    if (!foundNode) {
      throw new CliError('NODE_NOT_FOUND', `Worktree node ${query.nodeId} not found`);
    }
    if (foundNode.kind !== 'worktree') {
      throw new CliError('INVALID_ARGUMENT', `Node ${query.nodeId} is not a worktree`);
    }
    targetWorktreeNode = foundNode;
  }

  const initialScope: GitHubScope =
    query.scope === 'general'
      ? {
          kind: 'general',
          nodeId: null,
          branch: null,
          commits: 'default-branch',
          pullRequests: 'repository',
          issues: 'repository',
        }
      : {
          kind: 'worktree',
          nodeId: query.nodeId,
          branch: targetWorktreeNode?.branch ?? null,
          commits: targetWorktreeNode?.branch ? 'branch' : 'unavailable',
          pullRequests: targetWorktreeNode?.branch ? 'head-branch' : 'unavailable',
          issues: 'repository',
        };

  let repo: ParsedRepo | null = null;
  try {
    if (query.scope === 'worktree') {
      if (!targetWorktreeNode?.path) {
        throw new CliError('REMOTE_MISSING', 'Worktree has no registered path to resolve remote repository');
      }
      repo = await resolveWorktreeRepo(targetWorktreeNode.path, project, runner);
    } else {
      repo = await resolveProjectRepo(project, runner);
    }
  } catch (err: any) {
    const emptySection = unavailableSection<any>(attemptedAt, {
      code: err.issue?.code || 'REMOTE_MISSING',
      message: err.message || 'Remote configuration missing or unsupported',
      retryable: false,
    });
    initialScope.commits = 'unavailable';
    initialScope.pullRequests = 'unavailable';
    return {
      projectKind: project.kind,
      repository: null,
      auth: 'unknown',
      scope: initialScope,
      pullRequests: emptySection,
      commits: emptySection,
      issues: emptySection,
    };
  }

  const { owner, name } = repo;
  const issuesEndpoint = `repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=20`;

  // Worktree scope without a usable git branch
  if (query.scope === 'worktree' && !targetWorktreeNode?.branch) {
    const unavailableBranchSection = unavailableSection<any>(attemptedAt, {
      code: 'SCOPE_UNAVAILABLE',
      message: 'Worktree has no usable git branch',
      retryable: false,
    });
    const [issuesRes] = await Promise.allSettled([readGitHub(issuesEndpoint)]);
    const { section: issuesSection, auth: issuesAuth } = buildIssuesSection(issuesRes, owner, name, attemptedAt);

    return {
      repository: repo,
      auth: issuesAuth ?? 'unknown',
      scope: initialScope,
      pullRequests: unavailableBranchSection,
      commits: unavailableBranchSection,
      issues: issuesSection,
      pagination,
    };
  }

  let pullsEndpoint: string;
  let commitsEndpoint: string;

  if (query.scope === 'worktree' && targetWorktreeNode?.branch) {
    const branch = targetWorktreeNode.branch;
    const encodedBranch = encodeURIComponent(branch);
    const encodedHead = encodeURIComponent(`${owner}:${branch}`);
    commitsEndpoint = `repos/${owner}/${name}/commits?per_page=20&sha=${encodedBranch}`;
    pullsEndpoint = `repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc&per_page=20&head=${encodedHead}`;
  } else {
    commitsEndpoint = `repos/${owner}/${name}/commits?per_page=20`;
    pullsEndpoint = `repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc&per_page=20`;
  }

  const [pullsRes, commitsRes, issuesRes] = await Promise.allSettled([
    readGitHub(pullsEndpoint),
    readGitHub(commitsEndpoint),
    readGitHub(issuesEndpoint),
  ]);

  let authStatus: 'available' | 'required' | 'unknown' = 'unknown';

  const prBuilt = buildPullRequestsSection(pullsRes, owner, name, attemptedAt);
  if (prBuilt.auth) authStatus = prBuilt.auth;
  if (!prBuilt.valid) initialScope.pullRequests = 'unavailable';

  const commitBuilt = buildCommitsSection(commitsRes, owner, name, query.scope, attemptedAt);
  if (commitBuilt.auth) authStatus = commitBuilt.auth;
  if (!commitBuilt.valid) initialScope.commits = 'unavailable';

  const issueBuilt = buildIssuesSection(issuesRes, owner, name, attemptedAt);
  if (issueBuilt.auth) authStatus = issueBuilt.auth;

  return {
    projectKind: project.kind,
    repository: repo,
    auth: authStatus,
    scope: initialScope,
    pullRequests: prBuilt.section,
    commits: commitBuilt.section,
    issues: issueBuilt.section,
    pagination,
  };
}
