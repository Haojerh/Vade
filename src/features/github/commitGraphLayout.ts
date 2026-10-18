import type { CommitGraphEntry } from '../../../shared/contracts';

export interface GraphLane { sha: string; color: number }
export function layoutCommitGraph(commits: CommitGraphEntry[]) {
  let lanes: GraphLane[] = [];
  let nextColor = 0;
  return commits.map(commit => {
    let lane = lanes.findIndex(l => l.sha === commit.sha);
    const connected = lane >= 0;
    if (lane < 0) { lane = lanes.length; lanes.push({ sha: commit.sha, color: nextColor++ }); }
    const before = [...lanes];
    const color = before[lane].color;
    const after = lanes.filter(l => l.sha !== commit.sha);
    commit.parents.forEach((sha, i) => {
      if (!after.some(l => l.sha === sha)) after.splice(Math.min(lane + i, after.length), 0, { sha, color: i === 0 ? color : nextColor++ });
    });
    lanes = after;
    return { commit, lane, color, connected, before, after, width: Math.max(before.length, after.length) * 14 + 12 };
  });
}
