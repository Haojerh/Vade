import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { AgentCatalogEntry, AgentCatalogResponse } from '../../shared/contracts';

export interface AgentDefinition {
  id: string;
  name: string;
  detectCmd: string;
  detectCmdAliases?: string[];
  launchCmd?: string;
  defaultFlags?: string;
  provider: string;
  isDefault?: boolean;
  homepageUrl?: string;
}

export const KNOWN_AGENTS: AgentDefinition[] = [
  {
    id: 'claude',
    name: 'Claude',
    detectCmd: 'claude',
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'claude',
    homepageUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    detectCmd: 'codex',
    defaultFlags: '--dangerously-bypass-approvals-and-sandbox',
    provider: 'codex',
    isDefault: true,
    homepageUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    detectCmd: 'opencode',
    provider: 'opencode',
    homepageUrl: 'https://github.com/sst/ion',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    detectCmd: 'agy',
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'antigravity',
    homepageUrl: 'https://antigravity.google',
  },
  {
    id: 'kilo',
    name: 'Kilocode',
    detectCmd: 'kilo',
    provider: 'kilo',
    homepageUrl: 'https://kilocode.ai',
  },
  {
    id: 'claude-agent-teams',
    name: 'Claude Agent Teams',
    detectCmd: 'orca',
    launchCmd: process.platform === 'win32' ? 'orca.cmd claude-teams' : 'orca claude-teams',
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'claude',
  },
  {
    id: 'openclaude',
    name: 'OpenClaude',
    detectCmd: 'openclaude',
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'claude',
  },
  {
    id: 'grok',
    name: 'Grok',
    detectCmd: 'grok',
    defaultFlags: '--permission-mode bypassPermissions',
    provider: 'grok',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    detectCmd: 'copilot',
    defaultFlags: '--yolo',
    provider: 'copilot',
  },
  {
    id: 'opencode2',
    name: 'OpenCode 2',
    detectCmd: 'opencode2',
    launchCmd: 'opencode2 --standalone',
    provider: 'opencode',
  },
  {
    id: 'mimo-code',
    name: 'MiMo Code',
    detectCmd: 'mimo',
    provider: 'mimo-code',
  },
  {
    id: 'ante',
    name: 'Ante',
    detectCmd: 'ante',
    defaultFlags: '--yolo',
    provider: 'ante',
  },
  {
    id: 'trae',
    name: 'Trae',
    detectCmd: 'traecli',
    defaultFlags: '--yolo',
    provider: 'trae',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    detectCmd: 'gemini',
    defaultFlags: '--yolo',
    provider: 'gemini',
  },
  {
    id: 'pi',
    name: 'Pi',
    detectCmd: 'pi',
    provider: 'pi',
  },
  {
    id: 'omp',
    name: 'OMP',
    detectCmd: 'omp',
    provider: 'omp',
  },
  {
    id: 'prime-agent',
    name: 'Prime Agent',
    detectCmd: 'prime-agent',
    provider: 'prime-agent',
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    detectCmd: 'qodercli',
    detectCmdAliases: ['qoder'],
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'qoder',
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CLI China',
    detectCmd: 'qoderclicn',
    detectCmdAliases: ['qodercn'],
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'qoder-cn',
  },
  {
    id: 'aider',
    name: 'Aider',
    detectCmd: 'aider',
    defaultFlags: '--yes-always',
    provider: 'aider',
  },
  {
    id: 'goose',
    name: 'Goose',
    detectCmd: 'goose',
    provider: 'goose',
  },
  {
    id: 'amp',
    name: 'Amp',
    detectCmd: 'amp',
    defaultFlags: '--dangerously-allow-all',
    provider: 'amp',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    detectCmd: 'kiro-cli',
    launchCmd: 'kiro-cli chat --tui',
    defaultFlags: '--trust-all-tools',
    provider: 'kiro',
  },
  {
    id: 'crush',
    name: 'Charm',
    detectCmd: 'crush',
    defaultFlags: '--yolo',
    provider: 'crush',
  },
  {
    id: 'aug',
    name: 'Auggie',
    detectCmd: 'auggie',
    provider: 'aug',
  },
  {
    id: 'autohand',
    name: 'Autohand Code',
    detectCmd: 'autohand',
    defaultFlags: '--unrestricted',
    provider: 'autohand',
  },
  {
    id: 'cline',
    name: 'Cline',
    detectCmd: 'cline',
    defaultFlags: '--auto-approve true',
    provider: 'cline',
  },
  {
    id: 'freebuff',
    name: 'Freebuff',
    detectCmd: 'freebuff',
    provider: 'freebuff',
  },
  {
    id: 'codebuff',
    name: 'Codebuff',
    detectCmd: 'codebuff',
    provider: 'codebuff',
  },
  {
    id: 'command-code',
    name: 'Command Code',
    detectCmd: 'command-code',
    launchCmd: 'command-code --trust',
    defaultFlags: '--yolo',
    provider: 'command-code',
  },
  {
    id: 'continue',
    name: 'Continue',
    detectCmd: 'cn',
    defaultFlags: '--allow "*"',
    provider: 'continue',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detectCmd: 'cursor-agent',
    defaultFlags: '--yolo',
    provider: 'cursor',
  },
  {
    id: 'droid',
    name: 'Droid',
    detectCmd: 'droid',
    defaultFlags: '--auto high',
    provider: 'droid',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    detectCmd: 'kimi',
    detectCmdAliases: ['kimi-code'],
    defaultFlags: '--yolo',
    provider: 'kimi',
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    detectCmd: 'vibe',
    detectCmdAliases: ['mistral-vibe'],
    defaultFlags: '--agent auto-approve',
    provider: 'mistral-vibe',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    detectCmd: 'qwen',
    defaultFlags: '--approval-mode yolo',
    provider: 'qwen-code',
  },
  {
    id: 'rovo',
    name: 'Rovo Dev',
    detectCmd: 'acli',
    launchCmd: 'acli rovodev run',
    defaultFlags: '--yolo',
    provider: 'rovo',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    detectCmd: 'hermes',
    launchCmd: 'hermes --tui',
    defaultFlags: '--yolo',
    provider: 'hermes',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    detectCmd: 'openclaw',
    provider: 'openclaw',
  },
  {
    id: 'muse',
    name: 'Muse',
    detectCmd: 'muse',
    launchCmd: 'muse --trust-workspace',
    defaultFlags: '--yolo',
    provider: 'muse',
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    detectCmd: 'dsh-tui',
    detectCmdAliases: ['dst'],
    launchCmd: 'dsh-tui .',
    provider: 'dsh',
  },
  {
    id: 'zcode',
    name: 'ZCode',
    detectCmd: 'zcode',
    defaultFlags: '--mode yolo',
    provider: 'zcode',
  },
  {
    id: 'devin',
    name: 'Devin',
    detectCmd: 'devin',
    defaultFlags: '--permission-mode bypass --respect-workspace-trust false',
    provider: 'devin',
  },
  {
    id: 'jcode',
    name: 'Jcode',
    detectCmd: 'jcode',
    launchCmd: 'jcode',
    provider: 'jcode',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    detectCmd: 'codebuddy',
    detectCmdAliases: ['cbc'],
    defaultFlags: '--dangerously-skip-permissions',
    provider: 'codebuddy',
  },
];

export function isCommandInstalled(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!name || typeof name !== 'string') return false;
  const rawPath = env.PATH || env.Path || '';
  if (!rawPath) return false;

  const pathDirs = rawPath.split(path.delimiter).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const pathExts = isWindows
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1').split(';').map((x) => x.toLowerCase())
    : [''];

  for (const dir of pathDirs) {
    for (const ext of ['', ...pathExts]) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full)) {
          fs.accessSync(full, fs.constants.X_OK);
          return true;
        }
      } catch {
        // ignore errors
      }
    }
  }
  return false;
}

export interface OrcaUserSettings {
  defaultTuiAgent: string | null;
  agentDefaultArgs?: Record<string, string>;
  agentCmdOverrides?: Record<string, string>;
}

export function getOrcaUserSettings(userDataDir?: string): OrcaUserSettings {
  try {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    let baseDir = userDataDir || process.env.ORCA_USER_DATA_PATH || '';
    if (baseDir) {
      // Match the active Orca profile when its runtime supplies a user-data root.
    } else if (isWin) {
      baseDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming', 'orca');
      if (!baseDir.toLowerCase().endsWith('orca')) {
        baseDir = path.join(baseDir, 'orca');
      }
    } else if (isMac) {
      baseDir = path.join(os.homedir(), 'Library', 'Application Support', 'orca');
    } else {
      baseDir = process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'orca')
        : path.join(os.homedir(), '.config', 'orca');
    }

    if (!fs.existsSync(baseDir)) {
      return { defaultTuiAgent: null };
    }

    let activeProfileId = 'local-default';
    const profileIndexPath = path.join(baseDir, 'orca-profile-index.json');
    if (fs.existsSync(profileIndexPath)) {
      try {
        const raw = fs.readFileSync(profileIndexPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed?.activeProfileId === 'string') {
          activeProfileId = parsed.activeProfileId;
        }
      } catch {
        // Fall back to local-default
      }
    }

    const dbPath = path.join(baseDir, 'profiles', activeProfileId, 'profile-state.db');
    if (!fs.existsSync(dbPath)) {
      return { defaultTuiAgent: null };
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT payload FROM profile_state_documents WHERE domain = 'settings'").get() as
        | { payload?: Buffer | string }
        | undefined;
      if (row?.payload) {
        if (row.payload.length > 1024 * 1024) return { defaultTuiAgent: null };
        const str = typeof row.payload === 'string' ? row.payload : row.payload.toString('utf8');
        const settings = JSON.parse(str);
        return {
          defaultTuiAgent: typeof settings.defaultTuiAgent === 'string' ? settings.defaultTuiAgent : null,
          agentDefaultArgs:
            settings.agentDefaultArgs && typeof settings.agentDefaultArgs === 'object'
              ? settings.agentDefaultArgs
              : undefined,
          agentCmdOverrides:
            settings.agentCmdOverrides && typeof settings.agentCmdOverrides === 'object'
              ? settings.agentCmdOverrides
              : undefined,
        };
      }
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // Graceful degradation when Orca DB is locked or unavailable
  }
  return { defaultTuiAgent: null };
}

export function getAgentCatalog(env: NodeJS.ProcessEnv = process.env): AgentCatalogResponse {
  const installed: AgentCatalogEntry[] = [];
  const available: AgentCatalogEntry[] = [];
  const orcaSettings = getOrcaUserSettings();
  const configuredDefaultId = orcaSettings.defaultTuiAgent;

  for (const agent of KNOWN_AGENTS) {
    // In Orca, claude-agent-teams has detectUnsupportedRuntimes: ['win32', 'wsl']
    const isUnsupportedRuntime = process.platform === 'win32' && agent.id === 'claude-agent-teams';
    const isInstalled =
      !isUnsupportedRuntime &&
      (isCommandInstalled(agent.detectCmd, env) ||
        (agent.detectCmdAliases ? agent.detectCmdAliases.some((alias) => isCommandInstalled(alias, env)) : false));

    const flags = orcaSettings.agentDefaultArgs?.[agent.id] ?? agent.defaultFlags;
    const baseCmd = orcaSettings.agentCmdOverrides?.[agent.id] ?? (agent.launchCmd || agent.detectCmd);
    const command = `${baseCmd}${flags ? ' ' + flags : ''}`;

    const entry: AgentCatalogEntry = {
      id: agent.id,
      name: agent.name,
      command,
      detectCmd: agent.detectCmd,
      provider: agent.provider,
      installed: isInstalled,
      isDefault: false,
      homepageUrl: agent.homepageUrl,
    };

    if (entry.installed) {
      installed.push(entry);
    } else {
      available.push(entry);
    }
  }

  // Authoritative default selection:
  // 1. If configured default from Orca is installed, use it!
  // 2. Otherwise if configured default is in available list, set it if no installed, or prefer first installed.
  let defaultAgentId: string | null = null;
  if (configuredDefaultId && installed.some((a) => a.id === configuredDefaultId)) {
    defaultAgentId = configuredDefaultId;
  } else if (installed.length > 0) {
    const codexInstalled = installed.find((a) => a.id === 'codex');
    defaultAgentId = codexInstalled ? codexInstalled.id : installed[0].id;
  } else if (configuredDefaultId) {
    defaultAgentId = configuredDefaultId;
  } else {
    defaultAgentId = 'codex';
  }

  // Update isDefault flag on items to match authoritative default
  for (const item of [...installed, ...available]) {
    item.isDefault = item.id === defaultAgentId;
  }

  return {
    installed,
    available,
    defaultAgentId,
  };
}
