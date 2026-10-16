import {
  Id,
  ISO,
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
import { runGh, runGit, CommandRunner, defaultCommandRunner, CliError } from './cli.js';
import { toIsoOrNull, collectGraph } from './orca.js';

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

export async function resolveWorktreeRepo(
  worktreePath: string,
  _project: Project,
  runner: CommandRunner = defaultCommandRunner
): Promise<ParsedRepo> {
  const remoteStdout = await runGit(['remote', '-v'], worktreePath, runner);
  return parseGitRemoteOutput(remoteStdout);
}

export async function collectGitHubData(
  project: Project,
  query: GitHubQuery = { scope: 'general' },
  runner: CommandRunner = defaultCommandRunner,
  preloadedGraph?: Graph
): Promise<GitHubData> {
  const attemptedAt = new Date().toISOString();

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
    initialScope.commits = 'unavailable';
    initialScope.pullRequests = 'unavailable';
    return {
      projectKind: project.kind,
      repository: null,
      auth: 'unknown',
      scope: initialScope,
      pullRequests: { data: null, meta: emptyMeta },
      commits: { data: null, meta: emptyMeta },
      issues: { data: null, meta: emptyMeta },
    };
  }

  const { owner, name } = repo;

  // Check if worktree scope has no branch
  if (query.scope === 'worktree' && !targetWorktreeNode?.branch) {
    const unavailableMeta: SourceMeta = {
      availability: 'unavailable',
      observedAt: null,
      attemptedAt,
      stale: false,
      partial: false,
      issue: {
        code: 'SCOPE_UNAVAILABLE',
        message: 'Worktree has no usable git branch',
        retryable: false,
      },
    };

    // Fetch repository issues
    let issuesSection: Section<GitHubIssue[]>;
    let authStatus: 'available' | 'required' | 'unknown' = 'unknown';

    try {
      const issuesEndpoint = `repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=20`;
      const issuesRes = await runGh(issuesEndpoint, runner);
      authStatus = 'available';
      if (!Array.isArray(issuesRes)) {
        issuesSection = {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt,
            stale: false,
            partial: false,
            issue: {
              code: 'INVALID_UPSTREAM',
              message: 'Malformed issues payload from upstream: expected array',
              retryable: false,
            },
          },
        };
      } else {
        const isMalformed = issuesRes.some((it) => !it || typeof it !== 'object' || typeof it.number !== 'number');
        if (isMalformed) {
          issuesSection = {
            data: null,
            meta: {
              availability: 'unavailable',
              observedAt: null,
              attemptedAt,
              stale: false,
              partial: false,
              issue: {
                code: 'INVALID_UPSTREAM',
                message: 'Malformed issue item in upstream response',
                retryable: false,
              },
            },
          };
        } else {
          const rawIssuesOnly = issuesRes.filter((it) => !it.pull_request);
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
          issuesSection = {
            data: issues,
            meta: {
              availability: issues.length > 0 ? 'ready' : 'empty',
              observedAt: attemptedAt,
              attemptedAt,
              stale: false,
              partial: issuesRes.length === 20,
              issue: null,
            },
          };
        }
      }
    } catch (err: any) {
      if (err.issue?.code === 'AUTH_REQUIRED') authStatus = 'required';
      issuesSection = {
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
      scope: initialScope,
      pullRequests: { data: null, meta: unavailableMeta },
      commits: { data: null, meta: unavailableMeta },
      issues: issuesSection,
    };
  }

  let pullsEndpoint: string;
  let commitsEndpoint: string;
  const issuesEndpoint = `repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=20`;

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
    runGh(pullsEndpoint, runner),
    runGh(commitsEndpoint, runner),
    runGh(issuesEndpoint, runner),
  ]);

  let authStatus: 'available' | 'required' | 'unknown' = 'unknown';

  // 1. Process Pull Requests
  let prSection: Section<PullRequest[]>;
  if (pullsRes.status === 'fulfilled') {
    authStatus = 'available';
    if (!Array.isArray(pullsRes.value)) {
      prSection = {
        data: null,
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: false,
          issue: {
            code: 'INVALID_UPSTREAM',
            message: 'Malformed pull requests payload from upstream: expected array',
            retryable: false,
          },
        },
      };
      initialScope.pullRequests = 'unavailable';
    } else {
      const rawPulls = pullsRes.value;
      const isMalformed = rawPulls.some((p) => !p || typeof p !== 'object' || typeof p.number !== 'number');
      if (isMalformed) {
        prSection = {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt,
            stale: false,
            partial: false,
            issue: {
              code: 'INVALID_UPSTREAM',
              message: 'Malformed pull request item in upstream response',
              retryable: false,
            },
          },
        };
        initialScope.pullRequests = 'unavailable';
      } else {
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
        prSection = {
          data: prs,
          meta: {
            availability: prs.length > 0 ? 'ready' : 'empty',
            observedAt: attemptedAt,
            attemptedAt,
            stale: false,
            partial: rawPulls.length === 20,
            issue: null,
          },
        };
      }
    }
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
    initialScope.pullRequests = 'unavailable';
  }

  // 2. Process Commits
  let commitSection: Section<Commit[]>;
  if (commitsRes.status === 'fulfilled') {
    authStatus = 'available';
    if (!Array.isArray(commitsRes.value)) {
      commitSection = {
        data: null,
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: false,
          issue: {
            code: 'INVALID_UPSTREAM',
            message: 'Malformed commits payload from upstream: expected array',
            retryable: false,
          },
        },
      };
      initialScope.commits = 'unavailable';
    } else {
      const rawCommits = commitsRes.value;
      const isMalformed = rawCommits.some((c) => !c || typeof c !== 'object' || typeof c.sha !== 'string' || !c.sha.trim());
      if (isMalformed) {
        commitSection = {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt,
            stale: false,
            partial: false,
            issue: {
              code: 'INVALID_UPSTREAM',
              message: 'Malformed commit item in upstream response',
              retryable: false,
            },
          },
        };
        initialScope.commits = 'unavailable';
      } else {
        const commits: Commit[] = rawCommits.map((c) => ({
          sha: c.sha,
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
            partial: rawCommits.length === 20,
            issue: null,
          },
        };
      }
    }
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
      let issueCode = err.issue?.code || 'CLI_FAILED';
      if (
        query.scope === 'worktree' &&
        (err.issue?.code === 'GITHUB_NOT_FOUND' || err.exitCode === 404 || err.exitCode === 422)
      ) {
        issueCode = 'REMOTE_MISSING';
      }
      commitSection = {
        data: null,
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: false,
          issue: {
            code: issueCode,
            message: err.issue?.message || err.message,
            retryable: err.issue?.retryable ?? false,
          },
        },
      };
      initialScope.commits = 'unavailable';
    }
  }

  // 3. Process Issues
  let issuesSection: Section<GitHubIssue[]>;
  if (issuesRes.status === 'fulfilled') {
    authStatus = 'available';
    if (!Array.isArray(issuesRes.value)) {
      issuesSection = {
        data: null,
        meta: {
          availability: 'unavailable',
          observedAt: null,
          attemptedAt,
          stale: false,
          partial: false,
          issue: {
            code: 'INVALID_UPSTREAM',
            message: 'Malformed issues payload from upstream: expected array',
            retryable: false,
          },
        },
      };
    } else {
      const rawItems = issuesRes.value;
      const isMalformed = rawItems.some((it) => !it || typeof it !== 'object' || typeof it.number !== 'number');
      if (isMalformed) {
        issuesSection = {
          data: null,
          meta: {
            availability: 'unavailable',
            observedAt: null,
            attemptedAt,
            stale: false,
            partial: false,
            issue: {
              code: 'INVALID_UPSTREAM',
              message: 'Malformed issue item in upstream response',
              retryable: false,
            },
          },
        };
      } else {
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
        issuesSection = {
          data: issues,
          meta: {
            availability: issues.length > 0 ? 'ready' : 'empty',
            observedAt: attemptedAt,
            attemptedAt,
            stale: false,
            partial: rawItems.length === 20,
            issue: null,
          },
        };
      }
    }
  } else {
    const err = issuesRes.reason;
    if (err.issue?.code === 'AUTH_REQUIRED') authStatus = 'required';
    issuesSection = {
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
    projectKind: project.kind,
    repository: repo,
    auth: authStatus,
    scope: initialScope,
    pullRequests: prSection,
    commits: commitSection,
    issues: issuesSection,
  };
}
