/** Native conversation compaction.
 *
 *  Each listed provider exposes its own `/compact` slash command inside its TUI: Claude
 *  renders a "Compacting conversation" hint and records a `compact_boundary` row, Codex
 *  reports "Compacting context" / "Context compacted" and a `thread/compacted` event,
 *  CodeBuddy prints "Compacting context", Antigravity prints "Compacting conversation",
 *  the OpenCode family (including Kilo) emits `compacting` / `compacted` session events,
 *  and the DeepSeek Harness TUI documents `/compact` as a manual session compaction that
 *  it rejects mid-turn. Providers without that evidence stay unsupported rather than
 *  receiving a guessed command; a provider that rejects the token is reported as such. */
const COMPACT_COMMANDS: Readonly<Record<string, string>> = {
  antigravity: '/compact',
  claude: '/compact',
  codebuddy: '/compact',
  codex: '/compact',
  dsh: '/compact',
  freebuff: '/compact',
  kilo: '/compact',
  kilocode: '/compact',
  opencode: '/compact',
  opencode2: '/compact',
};

export function compactCommand(provider: string): string | null {
  return Object.hasOwn(COMPACT_COMMANDS, provider) ? COMPACT_COMMANDS[provider] : null;
}

const ACKNOWLEDGEMENT = /(?:^|[^a-z])(?:compacting|compacted)\b/gi;
const REJECTION = /(?:unknown|invalid|unrecognized|unsupported|unavailable)\s+(?:slash\s+)?command|command\s+(?:not\s+found|unknown)/i;

/** Count native compaction acknowledgements. Counting lets a caller compare the rendered
 *  screen before and after its own command instead of trusting the command echo. */
export function compactionSignals(text: string): number {
  return (text.match(ACKNOWLEDGEMENT) ?? []).length;
}

export type CompactionOutcome = 'confirmed' | 'rejected' | 'pending';

/** Only a new native acknowledgement or a native rejection is evidence. Silence, an
 *  echoed command, or ordinary prose that mentions compaction stay pending. */
export function compactionOutcome(observed: { fresh: string; before: string; after: string }): CompactionOutcome {
  if (REJECTION.test(observed.fresh) && !REJECTION.test(observed.before)) return 'rejected';
  return compactionSignals(observed.after) > compactionSignals(observed.before) ? 'confirmed' : 'pending';
}
