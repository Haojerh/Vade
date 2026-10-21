import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AdeProvider, Project } from '../../shared/contracts.js';
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
  bindingToken?: string;
  statusToken?: string;
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
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS titles (id TEXT PRIMARY KEY, title TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS provider_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_account_selection (provider TEXT PRIMARY KEY, account_id TEXT NOT NULL);`);
  }

  projects(): Project[] {
    return this.db.prepare('SELECT data FROM projects ORDER BY rowid LIMIT 200').all().map(row => JSON.parse(String(row.data)));
  }

  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id);
    if (!row) throw new CliError('PROJECT_NOT_FOUND', 'Project is not registered in ADE');
    return JSON.parse(String(row.data));
  }

  register(root: string, name?: string, kind: Project['kind'] = 'git'): Project {
    const existing = this.projects().find(project => project.paths[0] === root);
    if (existing) return existing;
    if (this.projects().length >= 200) throw new CliError('INVALID_ARGUMENT', 'ADE supports up to 200 registered projects');
    const id = crypto.randomUUID();
    const project: Project = { id, name: name || path.basename(root) || root, kind, sourceProjectId: null, repoIds: kind === 'git' ? [id] : [], paths: [root], hostIds: ['local'] };
    this.db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, root, JSON.stringify(project));
    return project;
  }

  sessions(projectId: string): SessionRecord[] {
    return this.db.prepare('SELECT data FROM sessions WHERE project_id = ? ORDER BY rowid LIMIT 200').all(projectId).map(row => JSON.parse(String(row.data)));
  }

  saveSession(session: SessionRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(session.id, session.projectId, JSON.stringify(session));
  }

  deleteProject(projectId: string): void {
    this.project(projectId);
    if (this.sessions(projectId).some(session => !session.closed)) throw new CliError('INVALID_ARGUMENT', 'Close this project’s agent tabs before deleting the project');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM titles WHERE id IN (SELECT id FROM sessions WHERE project_id = ?)').run(projectId);
      this.db.prepare('DELETE FROM sessions WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
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
