import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { WorkflowSetupStatus } from '../../shared/contracts.js';
import { AdeStore } from './store.js';
import { AdeSessions, executableOnPath } from './sessions.js';
import { CliError } from '../integrations/cli.js';

export const WORKFLOW_VERSION = '1.0.0';
export class WorkflowSetup {
  readonly directory: string;
  skillsDirectory = path.join(os.homedir(), '.agents', 'skills');
  private terminalStore?: AdeStore;
  private sessions?: AdeSessions;
  private owner?: { projectId: string; nodeId: string };
  private preparing = false;
  constructor(readonly store: AdeStore) { this.directory = path.join(store.directory, 'orchestration'); }
  source(name: string): string { return path.resolve(process.env.ADE_ORCHESTRATION_RESOURCES ?? 'resources/orchestration', name); }
  file(name: string): string { return path.join(this.directory, name); }
  status(): WorkflowSetupStatus {
    let cli = false, skill = false, cliSkill = false, error: string | null = null;
    try {
      const matches = (name: string) => fs.existsSync(this.file(name)) && crypto.createHash('sha256').update(fs.readFileSync(this.source(name))).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(this.file(name))).digest('hex');
      const installedSkill = (name: string, source: string) => {
        const file = path.join(this.skillsDirectory, name, 'SKILL.md');
        return fs.existsSync(file) && fs.statSync(file).size <= 262144 && fs.readFileSync(file).equals(fs.readFileSync(this.source(source)));
      };
      cli = Boolean(executableOnPath('node')) && matches('vade.cjs');
      skill = matches('SKILL.md') && installedSkill('vade-orchestration', 'SKILL.md');
      cliSkill = matches('cli-SKILL.md') && installedSkill('vade-cli', 'cli-SKILL.md');
      if (!cli || !skill || !cliSkill) error = 'Install the CLI and both agent skills. Node.js and npx must be available on PATH.';
    } catch { error = 'The bundled orchestration files could not be verified. Reinstall or rebuild Vade.'; }
    return { ready: cli && skill && cliSkill, cli, skill, cliSkill, cliPath: this.file('vade.cjs'), version: WORKFLOW_VERSION, error };
  }
  install(): WorkflowSetupStatus {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const name of ['vade.cjs', 'SKILL.md', 'cli-SKILL.md']) {
      const temp = this.file(`${name}.tmp`); fs.writeFileSync(temp, fs.readFileSync(this.source(name)), { mode: 0o600 }); fs.renameSync(temp, this.file(name));
    }
    return this.status();
  }
  async prepareTerminal(): Promise<{ projectId: string; nodeId: string; command: string }> {
    if (this.preparing) throw new CliError('RATE_LIMITED', 'An installation terminal is already opening');
    this.preparing = true;
    try {
      const node = executableOnPath('node'); if (!node) throw new CliError('CLI_MISSING', 'Install Node.js and restart Vade before opening the installation terminal.');
      this.closeTerminal();
      const bundle = this.file('bundle'); fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
      for (const name of ['vade.cjs', 'SKILL.md', 'cli-SKILL.md', 'install.cjs']) fs.writeFileSync(path.join(bundle, name), fs.readFileSync(this.source(name)), { mode: 0o600 });
      this.terminalStore ??= new AdeStore(this.file('terminal'));
      this.sessions ??= new AdeSessions(this.terminalStore);
      this.terminalStore.db.exec('DELETE FROM sessions; DELETE FROM titles;');
      const project = this.terminalStore.register(bundle, 'Orchestration setup', 'folder');
      const shell = process.platform === 'win32' ? 'powershell' as const : 'bash' as const;
      const record = await this.sessions.launch(project.id, 'setup', bundle, 'terminal', 'Orchestration setup', shell);
      this.owner = { projectId: project.id, nodeId: record.id };
      const quote = (value: string) => shell === 'powershell' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
      const command = `${shell === 'powershell' ? '& ' : ''}${quote(node)} ${quote(path.join(bundle, 'install.cjs'))} --data-dir ${quote(this.store.directory)}`;
      if (/[\x00-\x1f\x7f]/.test(command)) throw new CliError('INVALID_ARGUMENT', 'Installation paths must not contain terminal control characters');
      // Wait for shell output before staging once. Enter always belongs to the user.
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const output = this.sessions.page(project.id, record.id).data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
        if (shell === 'powershell' ? /PS [^\r\n]*>\s*$/.test(output) : /[$#]\s*$/.test(output)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!ready) throw new CliError('CLI_TIMEOUT', 'The installation shell did not become ready. Try opening it again.');
      await this.sessions.input(project.id, record.id, command);
      return { ...this.owner, command };
    } catch (error) { this.closeTerminal(); throw error; } finally { this.preparing = false; }
  }
  terminalSessions(projectId: string, nodeId: string): AdeSessions {
    if (!this.sessions || this.owner?.projectId !== projectId || this.owner.nodeId !== nodeId) throw new CliError('NODE_NOT_FOUND', 'Installation terminal is not active');
    return this.sessions;
  }
  closeTerminal(projectId?: string, nodeId?: string): void {
    if (projectId !== undefined && (this.owner?.projectId !== projectId || this.owner.nodeId !== nodeId)) return;
    if (this.owner && this.sessions) this.sessions.closeSession(this.owner.projectId, this.owner.nodeId);
    this.owner = undefined;
  }
  close(): void { this.sessions?.close(); this.terminalStore?.close(); this.sessions = undefined; this.terminalStore = undefined; this.owner = undefined; }
}
