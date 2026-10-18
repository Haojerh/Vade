import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Edge, Node, Run, Section, ToolActivity } from '../../../shared/contracts.js';
import { databaseToolActivity, transcriptToolActivity } from '../../providers/toolActivity.js';
import { openCodeDatabase } from '../../providers/opencode.js';
import { globalSourceMaps } from './state.js';
import { hashId, readBoundedTranscriptLines } from './utils.js';

const providers = ['claude', 'codex', 'pi', 'omp', 'opencode', 'kilo', 'kilocode'];

export async function collectToolActivity(node: Node, entry: any, allowed: (file: string) => boolean): Promise<void> {
  const now = new Date().toISOString();
  const section = (data: ToolActivity[] | null, failed = false): Section<ToolActivity[]> => ({ data, meta: {
    availability: failed ? 'unavailable' : data?.length ? 'ready' : 'empty', attemptedAt: now,
    observedAt: failed ? null : now, stale: false, partial: true,
    issue: failed ? { code: 'SOURCE_CHANGED', message: 'Tool activity could not be read from the bound provider session.', retryable: true } : null,
  } });
  if (!providers.includes(node.agentType || '')) return;
  if (typeof entry.providerSession?.id !== 'string' || !entry.providerSession.id.trim()) {
    node.toolActivity = section(null, true);
    return;
  }
  const session = entry.providerSession.id;
  try {
    let items: ToolActivity[];
    if (['opencode', 'kilo', 'kilocode'].includes(node.agentType!)) {
      const file = openCodeDatabase(node.agentType!, session, allowed);
      if (!file) { node.toolActivity = section(null, true); return; }
      items = databaseToolActivity(file, session);
    } else {
      const file = entry.providerSession.transcriptPath;
      if (typeof file !== 'string' || !allowed(file)) { node.toolActivity = section(null, true); return; }
      const recent = await readBoundedTranscriptLines(file, null, 200, 512 * 1024, false,
        (line) => transcriptToolActivity(node.agentType!, session, line).length > 0);
      items = recent.lines.flatMap((line) => transcriptToolActivity(node.agentType!, session, line));
    }
    node.toolActivity = section([...new Map(items.map((item) => [item.id, item])).values()].slice(-200));
  } catch { node.toolActivity = section(null, true); }
}

/** Fixed read-only toolkit mailbox query, scoped to an already associated run. */
export function collectOrchestrationMessages(run: Run | null, nodes: Node[], edges: Edge[]): void {
  if (!run) return;
  const file = path.join(process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '', 'orca', 'orchestration.db');
  if (!fs.existsSync(file)) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const addresses = new Map<string, string>();
    for (const node of nodes) {
      const source = globalSourceMaps.nodeSourceMap.get(node.id);
      if (source?.handle) addresses.set(source.handle, node.id);
      if (source?.paneKey) addresses.set(source.paneKey, node.id);
    }
    // Dispatch mailboxes have stable toolkit identities; resolve only this run's bindings.
    for (const [key, binding] of globalSourceMaps.dispatchMap) {
      const marker = `::${run.id}::`;
      if (!key.includes(marker) || binding.ambiguous || !binding.dispatchId) continue;
      const nodeId = key.slice(key.indexOf(marker) + marker.length);
      if (nodes.some((node) => node.id === nodeId)) addresses.set(`dispatch:${binding.dispatchId}`, nodeId);
    }
    const rows = db.prepare(`SELECT id, from_handle, to_handle, created_at FROM messages
      WHERE run_id = ? ORDER BY rowid DESC LIMIT 100`).all(run.sourceRunId);
    for (const row of rows.reverse()) {
      const source = addresses.get(String(row.from_handle));
      const target = addresses.get(String(row.to_handle));
      if (!source || !target || source === target) continue;
      const edge = edges.find((edge) => edge.kind !== 'contains' &&
        ((edge.source === source && edge.target === target) || (edge.source === target && edge.target === source)));
      const raw = String(row.created_at);
      const at = Date.parse(raw.endsWith('Z') || /[+-]\d\d:\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
      if (!edge || !Number.isFinite(at)) continue;
      (edge.messages ??= []).push({ id: hashId('mail', `${run.sourceRunId}:${row.id}`), source, target, at: new Date(at).toISOString() });
    }
  } catch { /* Schema/version gaps must not turn state changes into message events. */ }
  finally { db?.close(); }
}
