import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PrerequisitesStatus } from '../../../shared/contracts.js';
import { runOrca, CommandRunner, defaultCommandRunner, ORCA_PATH } from '../cli.js';

function existsAnyPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore filesystem errors
    }
  }
  return null;
}

export function resolveOrcaAppExecutable(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';

  return existsAnyPath([
    // Windows standard locations
    path.join(localAppData, 'Programs', 'orca', 'Orca.exe'),
    path.join(programFiles, 'Orca', 'Orca.exe'),
    path.join(programFilesX86, 'Orca', 'Orca.exe'),
    // Relative to ORCA_PATH if ORCA_PATH is inside an installed bundle
    path.resolve(path.dirname(ORCA_PATH), '..', '..', 'Orca.exe'),
    // macOS standard locations
    '/Applications/Orca.app',
    path.join(homeDir, 'Applications', 'Orca.app'),
    // Linux standard locations
    '/usr/bin/orca-app',
    '/opt/Orca/orca',
    '/opt/orca/orca',
    path.join(homeDir, '.local', 'share', 'orca', 'orca'),
  ]);
}

function hasWindowsOrcaExecutableInEntries(entries: string[]): boolean {
  return entries.some((entry) => {
    if (!entry) return false;
    try {
      return fs.existsSync(path.join(entry, 'orca.exe')) || fs.existsSync(path.join(entry, 'orca.cmd'));
    } catch {
      return false;
    }
  });
}

export function isCliOnPath(): boolean {
  try {
    if (process.platform === 'win32') {
      const pathEnv = process.env.PATH || process.env.Path || '';
      const pathEntries = pathEnv.split(';').map((p) => p.trim());
      if (hasWindowsOrcaExecutableInEntries(pathEntries)) return true;

      try {
        const whereOut = child_process.execSync('where.exe orca', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2000,
        });
        if (whereOut && whereOut.trim().length > 0) return true;
      } catch {}

      try {
        const regOut = child_process.execSync('reg query "HKCU\\Environment" /v Path', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 2000,
        });
        const match = regOut.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
        if (match && match[1]) {
          const userPathEntries = match[1].split(';').map((p) => p.trim());
          return hasWindowsOrcaExecutableInEntries(userPathEntries);
        }
      } catch {}
      return false;
    }

    const pathEnv = process.env.PATH || '';
    const pathEntries = pathEnv.split(':').map((p) => p.trim());
    const isOnPath = pathEntries.some((entry) => {
      if (!entry) return false;
      try {
        return fs.existsSync(path.join(entry, 'orca'));
      } catch {
        return false;
      }
    });
    if (isOnPath) return true;

    try {
      const whichOut = child_process.execSync('which orca', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return Boolean(whichOut && whichOut.trim().length > 0);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export function detectOrcaCliInstallation(): boolean {
  return isCliOnPath();
}

export function detectOrcaAppInstallation(): boolean {
  return resolveOrcaAppExecutable() !== null;
}

export function detectOrcaCliSkillInstallation(): boolean {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return (
    existsAnyPath([
      path.join(homeDir, '.claude', 'skills', 'orca-cli'),
      path.join(homeDir, '.agents', 'skills', 'orca-cli'),
      path.join(homeDir, '.codex', 'skills', 'orca-cli'),
      path.join(homeDir, '.gemini', 'config', 'skills', 'orca-cli'),
      path.join(homeDir, '.gemini', 'skills', 'orca-cli'),
      path.join(homeDir, '.cursor', 'skills', 'orca-cli'),
      path.join(homeDir, '.skills', 'orca-cli'),
      path.join(homeDir, '.orca', 'skills', 'orca-cli'),
    ]) !== null
  );
}

export function detectOrchestrationSkillInstallation(): boolean {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return (
    existsAnyPath([
      path.join(homeDir, '.codex', 'skills', 'orchestration'),
      path.join(homeDir, '.agents', 'skills', 'orchestration'),
      path.join(homeDir, '.claude', 'skills', 'orchestration'),
      path.join(homeDir, '.gemini', 'config', 'skills', 'orchestration'),
      path.join(homeDir, '.gemini', 'skills', 'orchestration'),
      path.join(homeDir, '.cursor', 'skills', 'orchestration'),
      path.join(homeDir, '.config', 'opencode', 'skills', 'orchestration'),
      path.join(homeDir, '.factory', 'skills', 'orchestration'),
      path.join(homeDir, '.continue', 'skills', 'orchestration'),
      path.join(homeDir, '.trae-cn', 'skills', 'orchestration'),
      path.join(homeDir, '.grok', 'skills', 'orchestration'),
      path.join(homeDir, '.augment', 'skills', 'orchestration'),
      path.join(homeDir, '.config', 'muse', 'skills', 'orchestration'),
      path.join(homeDir, '.zcode', 'skills', 'orchestration'),
      path.join(homeDir, '.skills', 'orchestration'),
      path.join(homeDir, '.orca', 'skills', 'orchestration'),
    ]) !== null
  );
}

export function isOrcaAppProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = child_process.execSync('tasklist /FI "IMAGENAME eq Orca.exe" /FO CSV', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 2000,
      });
      const lines = out.split('\n').filter((l) => l.toLowerCase().includes('"orca.exe"'));
      if (lines.length === 0) return false;
      // Headless daemon-host is 1 or 2 processes with modest memory. The desktop app spawns 6+ processes.
      if (lines.length > 2) return true;
      for (const line of lines) {
        const match = line.match(/"([\d,]+)\s*K"/i);
        if (match) {
          const memK = parseInt(match[1].replace(/,/g, ''), 10);
          if (memK > 120000) return true;
        }
      }
      return false;
    }

    const cmd =
      process.platform === 'darwin'
        ? 'pgrep -x "Orca" || pgrep -f "Orca.app"'
        : 'pgrep -x "orca-app" || pgrep -x "orca"';
    const out = child_process.execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface CheckPrerequisitesOptions {
  checkAppInstallation?: () => boolean;
  checkAppOpen?: () => Promise<boolean> | boolean;
  checkCliInstallation?: () => boolean;
  checkCliSkillInstallation?: () => boolean;
  checkOrchestrationSkillInstallation?: () => boolean;
}

export async function checkPrerequisites(
  runner: CommandRunner = defaultCommandRunner,
  options?: CheckPrerequisitesOptions
): Promise<PrerequisitesStatus> {
  const checkApp = options?.checkAppInstallation ?? detectOrcaAppInstallation;
  const checkCli = options?.checkCliInstallation ?? detectOrcaCliInstallation;
  const checkCliSkill = options?.checkCliSkillInstallation ?? detectOrcaCliSkillInstallation;
  const checkOrchSkill = options?.checkOrchestrationSkillInstallation ?? detectOrchestrationSkillInstallation;

  let orcaApp = checkApp();
  let orcaAppOpen = false;
  let orcaCli = checkCli();
  let orchestrationSkill = false;
  let orcaCliSkill = false;
  let version: string | null = null;
  const issues: string[] = [];

  let statusResult: any = null;
  try {
    const res = await runOrca<any>(['status', '--json'], runner);
    statusResult = res?.result;
    const meta = res?._meta as any;
    if (meta?.appVersion || statusResult?.runtime?.appVersion) {
      version = meta?.appVersion || statusResult?.runtime?.appVersion || null;
    }
    if (statusResult?.app?.running === true || statusResult?.app) {
      orcaApp = true;
    }
  } catch (err: any) {
    if (
      err?.issue?.code === 'CLI_MISSING' ||
      (err?.message &&
        (err.message.includes('ENOENT') || err.message.includes('not found') || err.message.includes('not recognized')))
    ) {
      orcaCli = false;
    }
  }

  // Check Skills: Authoritatively from Orca daemon if CLI runnable, otherwise fallback to user home dirs
  if (orcaCli) {
    const capabilities = statusResult?.runtime?.capabilities;
    const runtimeHasOrch = Array.isArray(capabilities)
      ? capabilities.some((cap: string) => typeof cap === 'string' && cap.startsWith('orchestration.'))
      : true;

    if (runtimeHasOrch) {
      let queriedSkills = false;
      try {
        const skillsRes = await runOrca<any>(['skills', 'installed', '--json'], runner);
        if (skillsRes?.result?.skills && Array.isArray(skillsRes.result.skills)) {
          queriedSkills = true;
          const installedSkills: any[] = skillsRes.result.skills;
          const isHomeOrBundled = (s: any) => s.sourceKind === 'home' || s.sourceKind === 'bundled';
          const hasOrch = installedSkills.some(
            (s: any) => (s.name === 'orchestration' || s.id === 'orchestration') && isHomeOrBundled(s)
          );
          const hasCli = installedSkills.some(
            (s: any) => (s.name === 'orca-cli' || s.id === 'orca-cli') && isHomeOrBundled(s)
          );
          orchestrationSkill = options?.checkOrchestrationSkillInstallation
            ? options.checkOrchestrationSkillInstallation()
            : hasOrch;
          orcaCliSkill = options?.checkCliSkillInstallation ? options.checkCliSkillInstallation() : hasCli;
        }
      } catch {
        // Fall through to file-based check
      }

      if (!queriedSkills) {
        orchestrationSkill = checkOrchSkill();
        orcaCliSkill = checkCliSkill();
      }
    } else {
      orchestrationSkill = false;
      orcaCliSkill = checkCliSkill();
    }
  } else {
    orchestrationSkill = false;
    orcaCliSkill = checkCliSkill();
  }

  // Determine if Orca desktop application is currently running / open
  if (options?.checkAppOpen) {
    orcaAppOpen = await Promise.resolve(options.checkAppOpen());
  } else if (statusResult?.app?.desktopWindowStatus === 'available') {
    orcaAppOpen = true;
  } else if (
    typeof statusResult?.app?.desktopWindowStatus === 'string' &&
    statusResult.app.desktopWindowStatus !== 'available'
  ) {
    orcaAppOpen = false;
  } else if (statusResult?.app?.running === true) {
    orcaAppOpen = true;
  } else if (statusResult?.app?.running === false) {
    orcaAppOpen = false;
  } else if (orcaApp) {
    orcaAppOpen = isOrcaAppProcessRunning();
  }

  if (!orcaApp) {
    issues.push('Orca desktop application is not installed.');
  } else if (!orcaAppOpen) {
    issues.push('Orca desktop application is closed / not running.');
  }

  if (!orcaCli) {
    issues.push('Orca CLI is not installed or not in PATH.');
  }
  if (!orchestrationSkill) {
    issues.push('Orca Orchestration skill is not installed.');
  }
  if (!orcaCliSkill) {
    issues.push('Orca CLI skill (orca-cli) is not installed.');
  }

  const ready = orcaApp && orcaAppOpen && orcaCli && orchestrationSkill && orcaCliSkill;

  return {
    orcaApp,
    orcaAppOpen,
    orcaCli,
    orchestrationSkill,
    orcaCliSkill,
    ready,
    version,
    ...(issues.length > 0 ? { issues } : {}),
  };
}
