import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AdeProvider, InboxItem, Project, TerminalShell } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';

export interface SessionRecord {
  id: string;
  projectId: string;
  worktreeId: string;
  cwd: string;
  provider: AdeProvider;
  title: string;
  createdAt: string;
  closed: boolean;
  providerThreadId?: string;
  sourceCwd?: string;
  bindingToken?: string;
  statusToken?: string;
  shell?: TerminalShell;
  workflowLaunch?: { model: string | null; effort: string | null };
  handoff?: import('../../shared/contracts.js').SessionHandoff & {
    prompt: string; launchToken: string | undefined;
    sourceThreadId: string | undefined; sourceLaunchToken: string | undefined;
    sourceWorktreeId?: string; sourceCwd?: string;
  };
}

export function adeDataDirectory(): string {
  return process.env.ADE_DATA_DIR || path.join(os.homedir(), '.ade');
}

export class AdeStore {
  readonly db: DatabaseSync;

  constructor(readonly directory = adeDataDirectory()) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'ade.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_results (id TEXT PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_attention (id TEXT PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS titles (id TEXT PRIMARY KEY, title TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS notification_states (scope TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_account_selection (provider TEXT PRIMARY KEY, account_id TEXT NOT NULL);`);
  }

  projects(): Project[] {
    return this.db.prepare('SELECT data FROM projects ORDER BY rowid LIMIT 200').all().map(row => JSON.parse(String(row.data)));
  }

  inboxItems(): InboxItem[] {
    const rows = this.db.prepare('SELECT data FROM (SELECT at, data, rowid AS sequence, 0 AS kind FROM turn_results UNION ALL SELECT at, data, rowid AS sequence, 1 AS kind FROM inbox_attention) ORDER BY at DESC, kind, sequence ASC LIMIT 400').all();
    const seen = new Set<string>(), items: InboxItem[] = [];
    for (const row of rows) {
      const item: InboxItem = JSON.parse(String(row.data));
      // Old redraw bugs wrote new IDs for the exact same native observation.
      // Keep its first stable entry; distinct timestamps/results remain separate.
      if (item.source === 'turn' && item.at && (item.nodeId || item.entityId)) {
        const key = JSON.stringify([item.projectId, item.nodeId ?? item.entityId, item.outcome, item.at]);
        if (seen.has(key)) continue; seen.add(key);
      }
      items.push(item); if (items.length === 200) break;
    }
    return items;
  }

  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id);
    if (!row) throw new CliError('PROJECT_NOT_FOUND', 'Project is not registered in ADE');
    return JSON.parse(String(row.data));
  }

  register(root: string, name?: string, kind: Project['kind'] = 'git'): Project {
    const existing = this.projects().find(project => project.paths[0] === root);
    if (existing) return kind === 'git' ? this.promoteGitProject(existing.id) : existing;
    if (this.projects().length >= 200) throw new CliError('INVALID_ARGUMENT', 'ADE supports up to 200 registered projects');
    const id = crypto.randomUUID();
    const project: Project = { id, name: name || path.basename(root) || root, kind, sourceProjectId: null, repoIds: kind === 'git' ? [id] : [], paths: [root], hostIds: ['local'] };
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, root, JSON.stringify(project));
    return project;
  }

  promoteGitProject(id: string): Project {
    const project = this.project(id);
    if (project.kind !== 'folder') return project;
    const updated: Project = { ...project, kind: 'git', repoIds: [project.id] };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)').run(`folder-git-root:${id}`, JSON.stringify(project.paths[0]));
      this.db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(JSON.stringify(updated), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return updated;
  }

  promotedFolderPath(id: string): string | null {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(`folder-git-root:${id}`);
    return row ? JSON.parse(String(row.value)) : null;
  }

  sessions(projectId: string): SessionRecord[] {
    return this.db.prepare('SELECT data FROM sessions WHERE project_id = ? ORDER BY rowid LIMIT 200').all(projectId).map(row => JSON.parse(String(row.data)));
  }

  saveSession(session: SessionRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(session.id, session.projectId, JSON.stringify(session));
  }

  deleteProject(projectId: string): void {
    this.project(projectId);
    if (this.db.prepare("SELECT id FROM workflow_runs WHERE json_extract(data, '$.projectId') = ? AND json_extract(data, '$.state') NOT IN ('completed','failed','cancelled') LIMIT 1").get(projectId)) throw new CliError('INVALID_ARGUMENT', 'Finish or cancel this project’s workflows before deleting it');
    if (this.sessions(projectId).some(session => !session.closed)) throw new CliError('INVALID_ARGUMENT', 'Close this project’s agent tabs before deleting the project');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM titles WHERE id IN (SELECT id FROM sessions WHERE project_id = ?)').run(projectId);
      this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId);
      this.db.prepare("DELETE FROM turn_results WHERE json_extract(data, '$.projectId') = ?").run(projectId);
      this.db.prepare("DELETE FROM inbox_attention WHERE json_extract(data, '$.projectId') = ?").run(projectId);
      this.db.prepare("DELETE FROM workflow_runs WHERE json_extract(data, '$.projectId') = ?").run(projectId);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      this.db.prepare('DELETE FROM preferences WHERE key = ?').run(`folder-git-root:${projectId}`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  title(id: string, fallback: string): string {
    return String(this.db.prepare('SELECT title FROM titles WHERE id = ?').get(id)?.title ?? fallback);
  }

  rename(id: string, title: string): void {
    this.db.prepare('INSERT OR REPLACE INTO titles VALUES (?, ?)').run(id, title);
  }

  close(): void { this.db.close(); }
}
