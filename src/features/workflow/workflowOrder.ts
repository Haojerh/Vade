import type { Node } from '../../../shared/contracts';

export function compareWorkflowNodes(a: Node, b: Node): number {
  const key = (node: Node) => node.kind === 'worktree'
    ? (node.path || node.worktreeId || node.id).replace(/\\/g, '/').toLowerCase()
    : node.id;
  return key(a).localeCompare(key(b)) || a.id.localeCompare(b.id);
}
