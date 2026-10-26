import type { OrganizationConfig } from '../../../shared/contracts';

export function connectionCreatesCycle(config: OrganizationConfig, source: string, target: string): boolean {
  const visited = new Set<string>();
  const visit = (id: string): boolean => id === source || (!visited.has(id) && (visited.add(id), config.edges.filter(edge => edge.source === id).some(edge => visit(edge.target))));
  return visit(target);
}

export function arrangeOrganization(config: OrganizationConfig): OrganizationConfig {
  const levels = new Map<string, number>(), pending = new Set(config.nodes.map(node => node.id));
  for (let pass = 0; pending.size && pass < config.nodes.length; pass++) {
    for (const id of pending) {
      const predecessors = config.edges.filter(edge => edge.target === id).map(edge => edge.source);
      if (predecessors.some(source => !levels.has(source))) continue;
      levels.set(id, Math.max(0, ...predecessors.map(source => levels.get(source)!)) + 1); pending.delete(id);
    }
  }
  if (pending.size) return config;
  const rows = new Map<number, number>();
  return { ...config, orchestratorPosition: { x: 36, y: 36 }, nodes: config.nodes.map(node => {
    const level = levels.get(node.id)!, row = rows.get(level) ?? 0; rows.set(level, row + 1);
    return { ...node, x: 36 + level * 300, y: 36 + row * 160 };
  }) };
}
