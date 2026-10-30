import type { Node } from '../../../../shared/contracts';

export function compareWorkflowNodes(a: Node, b: Node): number {
  const key = (node: Node) => node.kind === 'worktree'
    ? (node.path || node.worktreeId || node.id).replace(/\\/g, '/').toLowerCase()
    : (node.label || node.id).toLowerCase();
  return key(a).localeCompare(key(b)) || a.id.localeCompare(b.id);
}

export function placeWorkflowMember(ids: string[], agentId: string, targetId: string, position: 'before' | 'after'): string[] {
  if (agentId === targetId) return ids;
  const next = ids.filter(id => id !== agentId);
  const target = targetId ? next.indexOf(targetId) : next.length;
  if (target < 0) return ids;
  next.splice(targetId && position === 'after' ? target + 1 : target, 0, agentId);
  return next;
}
