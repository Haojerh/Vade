import type { AgentPermissionMode, AgentPreferences } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import type { AdeStore } from './store.js';

export const permissionArgs = {
  codex: { manual: ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'], auto: ['--approve-for-me'], yolo: ['--dangerously-bypass-approvals-and-sandbox'] },
  claude: { manual: ['--permission-mode', 'default'], auto: ['--permission-mode', 'auto'], yolo: ['--dangerously-skip-permissions'] },
  antigravity: { manual: [], auto: null, yolo: ['--dangerously-skip-permissions'] },
} satisfies Record<string, Record<AgentPermissionMode, string[] | null>>;

export function readAgentPreferences(store: AdeStore): AgentPreferences {
  const row = store.db.prepare("SELECT value FROM preferences WHERE key = 'agents'").get();
  return row ? JSON.parse(String(row.value)) : { defaultAgent: 'codex', providers: {
    codex: { enabled: true, mode: 'yolo' }, claude: { enabled: true, mode: 'yolo' }, antigravity: { enabled: true, mode: 'yolo' },
  } };
}

export function saveAgentPreferences(store: AdeStore, value: AgentPreferences): void {
  if (!value || Object.keys(value).some(key => !['defaultAgent', 'providers'].includes(key)) || !value.providers || Object.keys(value.providers).length !== 3
    || !Object.hasOwn(permissionArgs, value.defaultAgent)) throw new CliError('INVALID_ARGUMENT', 'Invalid agent preferences');
  for (const provider of ['codex', 'claude', 'antigravity'] as const) {
    const row = value.providers[provider];
    if (!row || Object.keys(row).some(key => !['enabled', 'mode'].includes(key)) || typeof row.enabled !== 'boolean'
      || !Object.hasOwn(permissionArgs[provider], row.mode) || permissionArgs[provider][row.mode] === null) throw new CliError('INVALID_ARGUMENT', 'This permission mode is not supported by the selected agent');
  }
  if (!value.providers[value.defaultAgent].enabled) throw new CliError('INVALID_ARGUMENT', 'The default agent must be enabled');
  store.db.prepare("INSERT OR REPLACE INTO preferences VALUES ('agents', ?)").run(JSON.stringify(value));
}
