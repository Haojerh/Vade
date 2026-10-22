import type { ProjectShortcut, RunProjectShortcutResponse } from '../../shared/contracts.js';
import type { LocalRuntime } from './localRuntime.js';
import type { AdeStore } from './store.js';
import { CliError } from '../integrations/cli.js';
import { readAgentPreferences } from './agentPreferences.js';
import { antigravityPromptReady } from './programStatus.js';

export function projectShortcuts(store: AdeStore, projectId: string): ProjectShortcut[] {
  store.project(projectId);
  const row = store.db.prepare('SELECT value FROM preferences WHERE key = ?').get(`shortcuts:${projectId}`);
  return row ? JSON.parse(String(row.value)) : [];
}
export function saveProjectShortcuts(store: AdeStore, projectId: string, value: unknown): ProjectShortcut[] {
  store.project(projectId);
  const invalid = () => { throw new CliError('INVALID_ARGUMENT', 'Invalid shortcut label, command, action, agent, ID or Append Enter setting.'); };
  if (!Array.isArray(value) || value.length > 30) invalid();
  const rows = value as ProjectShortcut[], ids = new Set<string>();
  for (const row of rows) {
    if (!row || Object.keys(row).some(key => !['id', 'label', 'action', 'command', 'appendEnter', 'agent'].includes(key))
      || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id)
      || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 80 || /[\x00-\x1f\x7f]/.test(row.label)
      || typeof row.command !== 'string' || !row.command.trim() || row.command.length > 10000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.command)
      || !['terminal', 'agent'].includes(row.action) || !['codex', 'claude', 'antigravity'].includes(row.agent) || typeof row.appendEnter !== 'boolean') invalid();
    ids.add(row.id);
  }
  store.db.prepare('INSERT OR REPLACE INTO preferences VALUES (?, ?)').run(`shortcuts:${projectId}`, JSON.stringify(rows));
  return rows;
}
export async function runProjectShortcut(runtime: LocalRuntime, projectId: string, id: string, worktreeId: string): Promise<RunProjectShortcutResponse> {
  const shortcut = projectShortcuts(runtime.store, projectId).find(row => row.id === id);
  if (!shortcut) throw new CliError('INVALID_ARGUMENT', 'Shortcut no longer exists. Reopen the menu.');
  if (shortcut.action === 'agent' && !readAgentPreferences(runtime.store).providers[shortcut.agent].enabled) throw new CliError('INVALID_ARGUMENT', 'Enable this agent in Settings before running its shortcut.');
  const project = runtime.store.project(projectId), tree = await runtime.git.requireWorktree(project, worktreeId);
  const record = await runtime.sessions.launch(projectId, tree.id, tree.path, shortcut.action === 'terminal' ? 'terminal' : shortcut.agent, shortcut.label,
    shortcut.action === 'terminal' ? process.platform === 'win32' ? 'powershell' : 'bash' : undefined);
  for (let attempt = 0; attempt < 80; attempt++) {
    const page = runtime.sessions.page(projectId, record.id);
    const ready = shortcut.action === 'terminal'
      ? /(?:PS [^\r\n]*>|[$#])\s*$/.test(page.data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, ''))
      : ['idle', 'completed', 'failed', 'interrupted'].includes(runtime.sessions.status(projectId, record.id).data?.state ?? '')
        || (record.provider === 'antigravity' && antigravityPromptReady(page.data));
    if (ready) {
      try {
        if (shortcut.action === 'agent') await runtime.sessions.send(projectId, record.id, { message: shortcut.command }, false, shortcut.appendEnter);
        else {
          await runtime.sessions.input(projectId, record.id, `\x1b[200~${shortcut.command.replace(/\r\n?/g, '\n')}\x1b[201~`);
          if (shortcut.appendEnter) { await new Promise(resolve => setTimeout(resolve, 300)); await runtime.sessions.input(projectId, record.id, '\r'); }
        }
        return { nodeId: record.id, staged: true, message: shortcut.appendEnter ? 'Shortcut submitted.' : 'Shortcut staged. Press Enter in Terminal to run.' };
      } catch { return { nodeId: record.id, staged: false, message: 'Delivery could not be confirmed. Inspect the new terminal before trying again.' }; }
    }
    if (!page.live && attempt > 5) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { nodeId: record.id, staged: false, message: 'Terminal opened. Finish native setup, then enter the command manually; nothing was sent.' };
}
