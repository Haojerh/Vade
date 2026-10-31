import type { AgentSkillSummary } from '../../../../shared/contracts';

/** Chat composer references. Codex invokes skills with `$name`; every other provider
 *  uses `/name`, which is also where its built-in commands live. Codex accepts both
 *  prefixes so `/` still lists its commands, while a skill token stays `$name`. */
export type ComposerPrefix = '$' | '/';

/** Prefixes that arm the menu for this provider. */
export function composerPrefixes(provider: string | null | undefined): ComposerPrefix[] {
  return provider === 'codex' ? ['/', '$'] : ['/'];
}

/** Prefix a skill reference is inserted with. */
export function skillPrefix(provider: string | null | undefined): ComposerPrefix {
  return provider === 'codex' ? '$' : '/';
}

/** The prefix shown in the composer hint. */
export function composerPrefix(provider: string | null | undefined): ComposerPrefix {
  return skillPrefix(provider);
}

export type ComposerCommandId = 'context' | 'model' | 'effort' | 'compact';

export interface ComposerCommand {
  id: ComposerCommandId;
  token: string;
  label: string;
  description: string;
}

/** Built-in commands act on Chat itself, so they exist only under `/`. A `$` provider
 *  lists skills alone rather than inventing a second command vocabulary. */
export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { id: 'context', token: '/context', label: '/context', description: 'Show conversation context usage' },
  { id: 'model', token: '/model', label: '/model', description: 'Choose the model' },
  { id: 'effort', token: '/effort', label: '/effort', description: 'Choose reasoning effort' },
  { id: 'compact', token: '/compact', label: '/compact', description: 'Compact the conversation to free context' },
];

/** Capabilities observed for the selected session. `/compact` appears only when the
 *  provider exposes a verified native compaction command. */
export interface ComposerCapabilities { compact?: boolean }

export type ComposerEntry =
  | { kind: 'command'; key: string; token: string; label: string; description: string; command: ComposerCommandId }
  | { kind: 'skill'; key: string; token: string; label: string; description: string; skill: AgentSkillSummary };

export interface ComposerTrigger { prefix: ComposerPrefix; query: string; start: number }

/** The menu is armed only by a prefix at the very start of the draft, followed by a
 *  single run of non-whitespace characters. Ordinary prose and pasted paths never
 *  open it, and a submitted message is unchanged by this detection. */
export function composerTrigger(draft: string, prefixes: ComposerPrefix | readonly ComposerPrefix[]): ComposerTrigger | null {
  const allowed = typeof prefixes === 'string' ? [prefixes] : prefixes;
  const prefix = allowed.find(candidate => draft.startsWith(candidate));
  if (!prefix) return null;
  const rest = draft.slice(1);
  if (/[\s]/.test(rest)) return null;
  return { prefix, query: rest, start: 0 };
}

/** Names match as substrings; descriptions match on word prefixes so a two-letter
 *  query cannot match an unrelated word in the middle of a sentence. */
function matches(name: string, description: string, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (name.toLowerCase().includes(needle)) return true;
  return description.toLowerCase().split(/[^a-z0-9]+/).some(word => word.startsWith(needle));
}

/** Freebuff's native reasoning control is `/reasoning`, not `/effort`. The command
 *  still opens the same Chat picker; only the token the provider understands differs. */
export function composerCommands(provider?: string | null): readonly ComposerCommand[] {
  if (provider !== 'freebuff') return COMPOSER_COMMANDS;
  return COMPOSER_COMMANDS.map(command => command.id === 'effort'
    ? { ...command, token: '/reasoning', label: '/reasoning', description: 'Choose reasoning effort' }
    : command);
}

/** Commands first, then installed skills, filtered by the typed query. Skills always
 *  use the provider's own reference prefix, even when `/` armed the menu on Codex. */
export function composerEntries(trigger: ComposerTrigger, skills: readonly AgentSkillSummary[], provider?: string | null, capabilities?: ComposerCapabilities): ComposerEntry[] {
  const entries: ComposerEntry[] = [];
  if (trigger.prefix === '/') {
    for (const command of composerCommands(provider)) {
      if (command.id === 'compact' && capabilities?.compact !== true) continue;
      if (!matches(command.token, command.description, trigger.query)) continue;
      entries.push({ kind: 'command', key: `command:${command.id}`, token: command.token, label: command.label, description: command.description, command: command.id });
    }
  }
  // Without an explicit provider the trigger prefix is the best available evidence.
  const prefix = provider === undefined || provider === null ? trigger.prefix : skillPrefix(provider);
  for (const skill of skills) {
    const token = `${prefix}${skill.name}`;
    if (!matches(skill.name, skill.description, trigger.query)) continue;
    entries.push({ kind: 'skill', key: `skill:${skill.name}`, token, label: token, description: skill.description, skill });
  }
  return entries;
}

/** Replacement draft after choosing a skill reference, with a trailing space so the
 *  user can keep typing the request. Commands clear the draft instead. */
export function applySkillReference(token: string): string {
  return `${token} `;
}

/** A leading reference token in a submitted message, for backends that want it split. */
export function leadingReference(draft: string, prefix: ComposerPrefix): { token: string; rest: string } | null {
  const match = new RegExp(`^\\${prefix}([a-z0-9][a-z0-9._-]{0,63})(?:\\s|$)`).exec(draft);
  if (!match) return null;
  return { token: `${prefix}${match[1]}`, rest: draft.slice(match[0].length) };
}
