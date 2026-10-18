import type { CommitGraphData, Section } from '../../shared/contracts.js';
import { CliError, GIT_PATH, defaultCommandRunner, type CommandRunner } from './cli.js';
import { requireProject, requireWorktree } from './worktrees.js';

export const COMMIT_GRAPH_ARGS = ['log', '--all', '--topo-order', '--max-count=201', '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00%D', '--'];

export function parseCommitGraph(output: string): CommitGraphData {
  const lines = output.trim().split('\n').filter(Boolean);
  const commits = lines.slice(0, 200).map(line => {
    const [sha, parents, message, author, committedAt, refs] = line.replace(/\r$/, '').split('\0');
    if (!/^[a-f0-9]{40,64}$/.test(sha) || parents === undefined || refs === undefined ||
        (parents && !parents.split(' ').every(p => /^[a-f0-9]{40,64}$/.test(p)))) throw new CliError('INVALID_UPSTREAM', 'Invalid Git history');
    return { sha, parents: parents ? parents.split(' ') : [], message, author, committedAt, refs: refs ? refs.split(', ') : [] };
  });
  return { commits, truncated: lines.length > 200 };
}

export async function collectCommitGraph(projectId: string, nodeId?: string, runner: CommandRunner = defaultCommandRunner): Promise<Section<CommitGraphData>> {
  const attemptedAt = new Date().toISOString();
  const project = await requireProject(projectId, runner);
  const wt = nodeId ? await requireWorktree(project, nodeId, runner) : null;
  if (project.kind !== 'git') return { data: null, meta: { availability: 'unsupported', attemptedAt, observedAt: null, stale: false, partial: false, issue: null } };
  const cwd = wt?.path ?? project.paths[0];
  try {
    if (!cwd) throw new CliError('SCOPE_UNAVAILABLE', 'No local checkout discovered');
    // Worktree scope follows HEAD in the exact discovered checkout. General shows all local refs.
    const args = nodeId ? COMMIT_GRAPH_ARGS.filter(a => a !== '--all') : COMMIT_GRAPH_ARGS;
    const result = await runner(GIT_PATH, [...args], { cwd, timeoutMs: 12000, maxStdout: 2 * 1024 * 1024, maxStderr: 4096 });
    if (result.exitCode !== 0) throw new CliError('CLI_FAILED', 'Local Git history could not be read', true);
    const data = parseCommitGraph(result.stdout);
    return { data, meta: { availability: data.commits.length ? 'ready' : 'empty', attemptedAt, observedAt: new Date().toISOString(), stale: false, partial: data.truncated, issue: null } };
  } catch (err) {
    const issue = err instanceof CliError ? err.issue : { code: 'INTERNAL' as const, message: 'Local history unavailable', retryable: true };
    return { data: null, meta: { availability: 'unavailable', attemptedAt, observedAt: null, stale: false, partial: false, issue } };
  }
}
