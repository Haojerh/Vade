import type { OrganizationConfig } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import type { AdeStore } from './store.js';

export const emptyOrganization = (): OrganizationConfig => ({ version: 1, enabled: false, isolatedWorktrees: false, nodes: [], edges: [] });
export function invalid(message: string): never { throw new CliError('INVALID_ARGUMENT', message); }
export function fields(value: any, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('Unexpected workflow fields');
}
export function bounded(value: unknown, max: number, label: string, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) invalid(`Invalid ${label}`);
  return value.trim();
}
export function validateOrganization(value: OrganizationConfig): OrganizationConfig {
  fields(value, ['version', 'enabled', 'isolatedWorktrees', 'nodes', 'edges', 'orchestratorPosition']);
  if (value.orchestratorPosition !== undefined) {
    fields(value.orchestratorPosition, ['x', 'y']);
    if (![value.orchestratorPosition.x, value.orchestratorPosition.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000)) invalid('Invalid orchestrator position');
  }
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.isolatedWorktrees !== 'boolean' || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 24 || value.edges.length > 100) invalid('Invalid workflow configuration or limits');
  const ids = new Set<string>();
  for (const node of value.nodes) {
    fields(node, ['id', 'title', 'prompt', 'provider', 'model', 'effort', 'x', 'y']);
    if (typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.id) || ids.has(node.id)) invalid('Node IDs must be unique');
    ids.add(node.id); bounded(node.title, 100, 'node title'); bounded(node.prompt, 4000, 'node role', true);
    if (!['codex', 'claude', 'antigravity', 'codebuddy', 'opencode', 'opencode2', 'kilo'].includes(node.provider)) invalid('Unsupported workflow provider');
    if (node.model !== null) bounded(node.model, 200, 'model');
    if (node.effort !== null) bounded(node.effort, 40, 'effort');
    if (node.effort && !node.model) invalid('Select a model before its effort');
    if (![node.x, node.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000)) invalid('Invalid node position');
  }
  const seen = new Set<string>();
  for (const edge of value.edges) {
    fields(edge, ['source', 'target']);
    const key = `${edge.source}:${edge.target}`;
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target || seen.has(key)) invalid('Connections must join two distinct existing nodes');
    seen.add(key);
  }
  const pending = new Set(ids);
  while (pending.size) {
    const ready = [...pending].filter(id => !value.edges.some(edge => edge.target === id && pending.has(edge.source)));
    if (!ready.length) invalid('Workflow connections must not contain a cycle');
    ready.forEach(id => pending.delete(id));
  }
  if (value.enabled && !value.nodes.length) invalid('Add at least one workflow node before enabling');
  return structuredClone(value);
}
export function readOrganization(store: AdeStore): OrganizationConfig {
  const row = store.db.prepare("SELECT value FROM preferences WHERE key = 'organization'").get();
  return row ? validateOrganization(JSON.parse(String(row.value))) : emptyOrganization();
}
