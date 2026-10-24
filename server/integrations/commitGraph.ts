import type { CommitGraphData } from '../../shared/contracts.js';
import { CliError } from './cli.js';

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
