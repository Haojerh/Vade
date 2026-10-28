import path from 'node:path';
import { CliError } from '../integrations/cli.js';
import { hashId } from '../providers/transcriptUtils.js';

/**
 * Cross-provider native conversation rewind.
 *
 * Only providers with verified native evidence are claimable. A public turn is mapped to a
 * provider-native anchor from the recorded row's own identity fields; positional or textual
 * matching is never used, so a rewritten, truncated or reordered transcript cannot retarget a
 * rewind. This module is pure planning/verification plus an injected native port: it never
 * mutates a session, never edits a log, never restores files and never replays a message.
 *
 * Root integration plan (root owns these call sites):
 *  1. Conversation read already produces opaque `message.id` plus `sourceIdentity`/`revision`.
 *  2. In `AdeConversations`, add a `rewindAnchor(record, line)` that calls
 *     `publicRewindTarget(record.provider, line, sourceIdentity)`; iterate the exact bound
 *     transcript rows (bounded) and stop at the row whose `messageId` equals the request.
 *     A row that yields no target is not rewindable, so never fall back to an ordinal.
 *  3. Build the Codex port once per operation with `createCodexRewindPort(request)` where
 *     `request` is the existing `codexRequest` transport and `resolveAgent('codex')`.
 *  4. `preflightProviderRewind(...)` before stopping anything. `routed-elsewhere` means keep
 *     using the existing DSH continuation path; every other `ok: false` is a refusal to show.
 *  5. Under the existing input lock, stop the owned terminal and confirm idle exit, then call
 *     `planCodexRewind` + `executeCodexRewind`. `plan` is side-effect free; only `execute`
 *     mutates. Persist `outcome.threadId` as the new `providerThreadId` only after
 *     `verifyCodexCut` confirms the cut; a failed verification keeps the original record.
 *  6. On `outcome-unknown`, keep the original record, tell the user to inspect Terminal, and
 *     never retry. `recoverCodexRewind` may confirm or clear that state later.
 *  7. `revert-before` rewrites the original native thread, so it needs
 *     `allowDestructive: true`; prefer `fork-before`, which leaves the source thread intact.
 */

export type RewindProvider =
  | 'codex' | 'dsh' | 'claude' | 'codebuddy' | 'antigravity'
  | 'opencode' | 'opencode2' | 'kilo' | 'kilocode';

export type RewindStrategy = 'fork-before' | 'revert-before' | 'native-continuation' | 'native-picker';

export interface RewindCapability {
  provider: RewindProvider;
  supported: boolean;
  /** Every native strategy this provider exposes, preferred first. */
  strategies: RewindStrategy[];
  /** True only when the preferred strategy leaves the original native session intact. */
  preservesOriginal: boolean;
  /** Exact installed evidence for this claim. */
  evidence: string;
  /** Why the provider is unavailable; null only when supported. */
  limitation: string | null;
  /** Which runtime owns the operation; root wires `existing-runtime` to its DSH path. */
  owner: 'provider-rewind' | 'existing-runtime' | 'none';
}

const CODEX_EVIDENCE = 'codex 0.164.0 app-server v2 protocol: thread/turns/list, thread/fork {beforeTurnId}, thread/revert {beforeTurnId}, thread/read';
const OPENCODE_LIMITATION = 'No verified owned-PTY rewind API for the installed opencode 2.1.4 CLI: its session subcommands are list/delete/export/import. Kilo and OpenCode 1 are distinct products and remain unverified here.';

const CAPABILITIES: readonly RewindCapability[] = [
  { provider: 'codex', supported: true, strategies: ['fork-before', 'revert-before'], preservesOriginal: true, evidence: CODEX_EVIDENCE, limitation: null, owner: 'provider-rewind' },
  { provider: 'dsh', supported: true, strategies: ['native-continuation'], preservesOriginal: true, evidence: 'ADE DSH rewind opens a receipt-fenced native continuation from the exact recorded boundary', limitation: null, owner: 'existing-runtime' },
  { provider:'claude',supported:true,strategies:['native-continuation'],preservesOriginal:true,evidence:'Official storage-only forkSession with exact native parent UUID',limitation:null,owner:'existing-runtime' },
  { provider:'codebuddy',supported:true,strategies:['native-picker'],preservesOriginal:false,evidence:'Installed CodeBuddy /rewind picker and rewind API declarations',limitation:'Target selection remains in the native picker.',owner:'existing-runtime' },
  { provider:'antigravity',supported:true,strategies:['native-picker'],preservesOriginal:false,evidence:'Antigravity native /rewind picker',limitation:'Target selection remains in the native picker.',owner:'existing-runtime' },
  { provider: 'opencode', supported: false, strategies: [], preservesOriginal: false, evidence: 'opencode 2.1.4 session --help', limitation: OPENCODE_LIMITATION, owner: 'none' },
  { provider: 'opencode2', supported: false, strategies: [], preservesOriginal: false, evidence: 'opencode 2.1.4 session --help', limitation: OPENCODE_LIMITATION, owner: 'none' },
  { provider: 'kilo', supported: false, strategies: [], preservesOriginal: false, evidence: 'opencode 2.1.4 session --help', limitation: OPENCODE_LIMITATION, owner: 'none' },
  { provider: 'kilocode', supported: false, strategies: [], preservesOriginal: false, evidence: 'opencode 2.1.4 session --help', limitation: OPENCODE_LIMITATION, owner: 'none' },
];

/** Capability per provider, for hiding unsupported rewind actions in the UI. */
export function providerRewindCatalog(): RewindCapability[] {
  return CAPABILITIES.map(capability => ({ ...capability, strategies: [...capability.strategies] }));
}

export function providerRewindCapability(provider: string): RewindCapability {
  return providerRewindCatalog().find(capability => capability.provider === provider)
    ?? { provider: provider as RewindProvider, supported: false, strategies: [], preservesOriginal: false,
      evidence: 'no installed provider evidence', limitation: `ADE has no verified native rewind surface for ${provider}`, owner: 'none' };
}

/** Native identity of one recorded user turn. `field` records exactly where it came from. */
export interface NativeUserAnchor {
  provider: RewindProvider;
  nativeId: string;
  field: 'codex-item-id' | 'claude-entry-uuid' | 'dsh-native-seq';
}

const CODEX_ITEM_ID = /^(?:msg_[A-Za-z0-9_-]{1,200}|[0-9a-f]{8}-[0-9a-f-]{27})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function recordOf(line: string): Record<string, any> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function claudeFamilyAnchor(provider: RewindProvider, row: Record<string, any>): NativeUserAnchor | null {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || row.isSynthetic || row.isCompactSummary) return null;
  if (row.message?.role !== 'user') return null;
  const content = row.message.content;
  // A tool row carries recorded tool output; it is never a public user turn.
  if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result' || block?.type === 'tool_use')) return null;
  if (typeof row.uuid !== 'string' || !UUID.test(row.uuid)) return null;
  return { provider, nativeId: row.uuid, field: 'claude-entry-uuid' };
}

/** Exact native anchor for one recorded row, or null when the row cannot prove identity. */
export function resolveNativeUserAnchor(provider: string, line: string): NativeUserAnchor | null {
  const row = recordOf(line);
  if (!row) return null;
  switch (provider) {
    case 'codex': {
      if (row.type !== 'response_item' || row.payload?.type !== 'message' || row.payload?.role !== 'user') return null;
      const id = row.payload.id;
      return typeof id === 'string' && CODEX_ITEM_ID.test(id) ? { provider: 'codex', nativeId: id, field: 'codex-item-id' } : null;
    }
    case 'claude':
    case 'codebuddy':
      return claudeFamilyAnchor(provider, row);
    case 'dsh': {
      if (row.type !== 'response_item' || row.payload?.type !== 'message' || row.payload?.role !== 'user') return null;
      const seq = row.payload.nativeSeq;
      return Number.isSafeInteger(seq) && seq >= 0 ? { provider: 'dsh', nativeId: String(seq), field: 'dsh-native-seq' } : null;
    }
    default:
      return null;
  }
}

export interface PublicRewindTarget {
  /** Public conversation message id this row produced; equals `ConversationMessage.id`. */
  messageId: string;
  anchor: NativeUserAnchor;
}

/**
 * Public id plus native anchor for one recorded row. Rows without a native identity field
 * yield null, so an ordinal or position can never become a rewind target.
 */
export function publicRewindTarget(provider: string, line: string, sourceIdentity: string): PublicRewindTarget | null {
  if (!sourceIdentity) return null;
  const anchor = resolveNativeUserAnchor(provider, line);
  return anchor ? { messageId: hashId('msg', `${sourceIdentity}:${anchor.nativeId}`), anchor } : null;
}

export type RewindRefusal =
  | 'unsupported-provider'
  | 'stale-source'
  | 'foreign-target'
  | 'target-not-found'
  | 'history-not-paginated'
  | 'history-limit'
  | 'not-turn-opener'
  | 'busy'
  | 'destructive-not-allowed'
  | 'routed-elsewhere'
  | 'provider-refused'
  | 'outcome-unknown';

export interface RewindPreflightInput {
  provider: string;
  /** Source identity the client read; must equal the live binding. */
  sourceIdentity: string;
  expectedSourceIdentity: string;
  anchor: NativeUserAnchor | null;
  /** Requested strategy; defaults to the catalog's preferred strategy. */
  strategy?: RewindStrategy;
  /** A revert rewrites the original native session, so it needs explicit consent. */
  allowDestructive?: boolean;
  /** Observed native state: active turn ids or a pending dispatch. */
  activeTurns?: number;
  /** Root sets this after confirming the owned process is idle and the composer empty. */
  idle?: boolean;
  /** The thread's persisted history contract, when the provider reports one. */
  historyMode?: string | null;
}

export type RewindPreflightResult =
  | { ok: true; provider: RewindProvider; strategy: RewindStrategy; anchor: NativeUserAnchor; preservesOriginal: boolean }
  | { ok: false; reason: RewindRefusal; message: string };

/** Pure admission check. Runs before root stops or relaunches anything. */
export function preflightProviderRewind(input: RewindPreflightInput): RewindPreflightResult {
  const capability = providerRewindCapability(input.provider);
  if (capability.owner === 'existing-runtime') {
    return { ok: false, reason: 'routed-elsewhere', message: `${capability.provider} rewind stays on the existing runtime continuation path.` };
  }
  if (!capability.supported || capability.strategies.length === 0) {
    return { ok: false, reason: 'unsupported-provider', message: capability.limitation ?? `Native rewind is unavailable for ${input.provider}` };
  }
  const strategy = input.strategy ?? capability.strategies[0]!;
  if (!capability.strategies.includes(strategy)) {
    return { ok: false, reason: 'unsupported-provider', message: `${capability.provider} does not expose the ${strategy} strategy` };
  }
  // `revert-before` rewrites the original native history, so it is never implicit.
  if (strategy === 'revert-before' && input.allowDestructive !== true) {
    return { ok: false, reason: 'destructive-not-allowed', message: 'Rewinding in place rewrites the original native session. Confirm a fork instead.' };
  }
  if (!input.sourceIdentity || input.sourceIdentity !== input.expectedSourceIdentity) {
    return { ok: false, reason: 'stale-source', message: 'Conversation changed. Refresh before rewinding.' };
  }
  if (!input.anchor || input.anchor.provider !== capability.provider) {
    return { ok: false, reason: 'foreign-target', message: 'This message does not belong to the bound provider session.' };
  }
  if (input.historyMode === 'legacy') {
    return { ok: false, reason: 'history-not-paginated', message: 'This native session predates paginated history; rewind is unavailable.' };
  }
  if (input.idle === false || (input.activeTurns ?? 0) > 0) {
    return { ok: false, reason: 'busy', message: 'The agent is still working. Wait for it to finish before rewinding.' };
  }
  return { ok: true, provider: capability.provider, strategy, anchor: input.anchor,
    preservesOriginal: strategy !== 'revert-before' };
}

export interface RewindAvailability {
  available: boolean;
  reason: RewindRefusal | null;
  message: string | null;
  /** Strategy root should use; null when unavailable. */
  strategy: RewindStrategy | null;
}

/**
 * UI-facing availability for one provider, without a target message. Pass the observed native
 * `historyMode`/`status` when known so a legacy or running thread hides the action before any
 * planning, process stop or relaunch.
 */
export function providerRewindAvailability(provider: string, observed: {
  historyMode?: string | null;
  activeTurns?: number;
} = {}): RewindAvailability {
  const capability = providerRewindCapability(provider);
  if (capability.owner === 'existing-runtime') {
    return { available: false, reason: 'routed-elsewhere', message: `${capability.provider} rewind stays on the existing runtime continuation path.`, strategy: null };
  }
  if (!capability.supported || capability.strategies.length === 0) {
    return { available: false, reason: 'unsupported-provider', message: capability.limitation, strategy: null };
  }
  if (observed.historyMode === 'legacy') {
    return { available: false, reason: 'history-not-paginated', message: 'This native session predates paginated history; rewind is unavailable.', strategy: null };
  }
  if ((observed.activeTurns ?? 0) > 0) {
    return { available: false, reason: 'busy', message: 'The agent is still working. Wait for it to finish before rewinding.', strategy: null };
  }
  return { available: true, reason: null, message: null, strategy: capability.strategies[0]! };
}

export interface CodexTurnSummary {
  id: string;
  items?: { id?: string; type?: string }[];
}
export interface CodexThreadSummary {
  id: string;
  /** Native recorded workspace root; compared against the bound session before any cut. */
  cwd?: string | null;
  forkedFromId?: string | null;
  historyMode?: string;
  status?: { type?: string } | null;
}
export interface CodexTurnPage {
  data: CodexTurnSummary[];
  nextCursor?: string | null;
}

/** Fixed native surface. Root supplies the transport; tests supply a deterministic fake. */
export interface CodexRewindPort {
  readThread(threadId: string): Promise<CodexThreadSummary>;
  listTurns(threadId: string, cursor: string | null, limit: number): Promise<CodexTurnPage>;
  forkBefore(threadId: string, beforeTurnId: string): Promise<{ thread: CodexThreadSummary }>;
  revertBefore(threadId: string, beforeTurnId: string): Promise<{ thread: CodexThreadSummary }>;
}

export const CODEX_TURN_PAGE_LIMIT = 50;
export const CODEX_MAX_TURN_PAGES = 20;

export interface CodexTurnLocation {
  /** Turn containing the recorded user item. */
  turnId: string;
  /** Turn immediately before it in recorded order; null when the target is the first turn. */
  keepTurnId: string | null;
  /** True only when the recorded item opens its turn. Mid-turn sends never rewind. */
  opensTurn: boolean;
  /** Turns examined while scanning, for bounded diagnostics. */
  scanned: number;
}

export type CodexTurnSearch =
  | { found: true; location: CodexTurnLocation }
  /** `not-found`: history ended without the item. `history-limit`: the bounded scan ran out. */
  | { found: false; reason: 'not-found' | 'history-limit' };

/** First user message recorded in a turn, which is the only rewindable anchor. */
function turnOpenerId(turn: CodexTurnSummary): string | null {
  const opener = (turn.items ?? []).find(item => item?.type === 'userMessage' && typeof item.id === 'string' && item.id);
  return opener?.id ?? null;
}

/**
 * Locate the turn holding an exact recorded user item id.
 *
 * Pages newest-first. The retained boundary is the turn immediately OLDER than the target,
 * which is the next turn encountered after it — possibly on a later page — and is null only
 * when the target is the oldest recorded turn. Turns visited before the target are newer and
 * are discarded by the cut, so they can never be the boundary.
 */
export async function locateCodexTurn(
  port: Pick<CodexRewindPort, 'listTurns'>,
  threadId: string,
  itemId: string
): Promise<CodexTurnSearch> {
  const seen = new Set<string>();
  let cursor: string | null = null;
  let scanned = 0;
  let target: { turnId: string; opensTurn: boolean } | null = null;
  for (let page = 0; page < CODEX_MAX_TURN_PAGES; page++) {
    const result = await port.listTurns(threadId, cursor, CODEX_TURN_PAGE_LIMIT);
    const turns = Array.isArray(result?.data) ? result.data : [];
    for (const turn of turns) {
      if (typeof turn?.id !== 'string' || !turn.id) throw new CliError('INVALID_UPSTREAM', 'Codex returned a turn without an id');
      scanned++;
      if (target) {
        // First turn older than the target is exactly the history the cut keeps.
        return { found: true, location: { turnId: target.turnId, keepTurnId: turn.id, opensTurn: target.opensTurn, scanned } };
      }
      // A colliding non-user item id is not a rewind anchor.
      const holds = Array.isArray(turn.items) && turn.items.some(item => item?.id === itemId && item.type === 'userMessage');
      if (holds) target = { turnId: turn.id, opensTurn: turnOpenerId(turn) === itemId };
    }
    const next = result.nextCursor ?? null;
    if (!next) {
      // History is exhausted: the target, when found, is the oldest recorded turn.
      return target
        ? { found: true, location: { turnId: target.turnId, keepTurnId: null, opensTurn: target.opensTurn, scanned } }
        : { found: false, reason: 'not-found' };
    }
    if (seen.has(next)) throw new CliError('INVALID_UPSTREAM', 'Codex repeated a turn cursor');
    seen.add(next);
    cursor = next;
  }
  // A bounded scan cannot prove absence, so the caller must not report "not found".
  return { found: false, reason: 'history-limit' };
}

export interface CodexRewindPlan {
  strategy: 'fork-before' | 'revert-before';
  sourceThreadId: string;
  beforeTurnId: string;
  keepTurnId: string | null;
}

export type CodexRewindPlanResult =
  | { ok: true; plan: CodexRewindPlan }
  | { ok: false; reason: RewindRefusal; message: string };

function codexAdmission(thread: CodexThreadSummary | null | undefined, threadId: string, allowedCwds?: readonly string[]): RewindRefusal | null {
  if (!thread || thread.id !== threadId) return 'foreign-target';
  if (allowedCwds && allowedCwds.length && thread.cwd && !sameWorkspace(thread.cwd, allowedCwds)) return 'foreign-target';
  if (thread.historyMode === 'legacy') return 'history-not-paginated';
  // A separate read-only app-server connection reports persisted TUI threads as
  // notLoaded. This describes this reader, not activity in the owned terminal.
  // The caller separately fences that terminal's idle composer and input lock.
  if (thread.status && thread.status.type && !['idle','notLoaded'].includes(thread.status.type)) return 'busy';
  return null;
}

/** Compare a native recorded workspace root with the session's own observed roots. */
export function sameWorkspace(nativeCwd: string, allowedCwds: readonly string[]): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = normalize(nativeCwd);
  return allowedCwds.some(cwd => cwd && normalize(cwd) === target);
}

/** Resolve the exact native turn boundary before any mutation happens. */
export async function planCodexRewind(port: CodexRewindPort, input: {
  threadId: string; anchor: NativeUserAnchor; strategy?: 'fork-before' | 'revert-before';
  /** The bound session's own cwd/sourceCwd; a native thread from another workspace is refused. */
  allowedCwds?: readonly string[];
}): Promise<CodexRewindPlanResult> {
  if (input.anchor.provider !== 'codex' || input.anchor.field !== 'codex-item-id') {
    return { ok: false, reason: 'foreign-target', message: 'This message has no Codex-native turn anchor.' };
  }
  const thread = await port.readThread(input.threadId);
  const admission = codexAdmission(thread, input.threadId, input.allowedCwds);
  if (admission) return { ok: false, reason: admission, message: codexMessage(admission) };
  const search = await locateCodexTurn(port, input.threadId, input.anchor.nativeId);
  if (!search.found) {
    return search.reason === 'history-limit'
      ? { ok: false, reason: 'history-limit', message: 'This thread is longer than the bounded rewind scan; open an earlier turn first.' }
      : { ok: false, reason: 'target-not-found', message: codexMessage('target-not-found') };
  }
  // Only a turn's opening user message can cut history; mid-turn sends have a different native order.
  if (!search.location.opensTurn) {
    return { ok: false, reason: 'not-turn-opener', message: 'Only the message that started a turn can be rewound to.' };
  }
  // Re-read after the scan so a turn that started mid-scan cannot be reverted.
  const current = await port.readThread(input.threadId);
  const drift = codexAdmission(current, input.threadId, input.allowedCwds);
  if (drift) return { ok: false, reason: drift, message: codexMessage(drift) };
  return { ok: true, plan: {
    strategy: input.strategy ?? 'fork-before',
    sourceThreadId: input.threadId,
    beforeTurnId: search.location.turnId,
    keepTurnId: search.location.keepTurnId,
  } };
}

function codexMessage(reason: RewindRefusal): string {
  switch (reason) {
    case 'foreign-target': return 'This conversation is not the bound Codex thread.';
    case 'history-not-paginated': return 'This Codex thread uses legacy history; native rewind is unavailable.';
    case 'history-limit': return 'This thread is longer than the bounded rewind scan; open an earlier turn first.';
    case 'not-turn-opener': return 'Only the message that started a turn can be rewound to.';
    case 'busy': return 'Codex is still working. Wait for it to finish before rewinding.';
    case 'target-not-found': return 'Codex no longer retains this turn. Reload the conversation.';
    default: return 'Native rewind is unavailable for this conversation.';
  }
}

export type CodexRewindOutcome =
  | { ok: true; strategy: 'fork-before' | 'revert-before'; sourceThreadId: string; threadId: string; beforeTurnId: string; keepTurnId: string | null }
  | { ok: false; reason: RewindRefusal; message: string; uncertain: boolean };

/**
 * Apply one plan. A fork keeps the original thread untouched; a revert rewrites it in place
 * and is only reachable when the caller explicitly chose it. A lost reply is reported as
 * `outcome-unknown` and never retried here.
 */
export async function executeCodexRewind(port: CodexRewindPort, plan: CodexRewindPlan): Promise<CodexRewindOutcome> {
  const uncertain = (message: string): CodexRewindOutcome => ({ ok: false, reason: 'outcome-unknown', message, uncertain: true });
  try {
    if (plan.strategy === 'fork-before') {
      const response = await port.forkBefore(plan.sourceThreadId, plan.beforeTurnId);
      const thread = response?.thread;
      if (!thread || typeof thread.id !== 'string' || !thread.id) return uncertain('Codex did not confirm the new thread. Inspect Terminal; this rewind will not be retried.');
      if (thread.id === plan.sourceThreadId) return uncertain('Codex returned the original thread for a fork. Inspect Terminal; this rewind will not be retried.');
      if (thread.forkedFromId !== undefined && thread.forkedFromId !== null && thread.forkedFromId !== plan.sourceThreadId) {
        return { ok: false, reason: 'foreign-target', message: 'Codex forked an unrelated thread. No rewind was applied.', uncertain: false };
      }
      return { ok: true, strategy: plan.strategy, sourceThreadId: plan.sourceThreadId, threadId: thread.id, beforeTurnId: plan.beforeTurnId, keepTurnId: plan.keepTurnId };
    }
    const response = await port.revertBefore(plan.sourceThreadId, plan.beforeTurnId);
    const thread = response?.thread;
    if (!thread || thread.id !== plan.sourceThreadId) {
      return { ok: false, reason: 'foreign-target', message: 'Codex reverted an unrelated thread. No rewind was applied.', uncertain: false };
    }
    return { ok: true, strategy: plan.strategy, sourceThreadId: plan.sourceThreadId, threadId: thread.id, beforeTurnId: plan.beforeTurnId, keepTurnId: plan.keepTurnId };
  } catch {
    return uncertain('Codex did not answer the rewind request. Inspect Terminal before retrying; the rewind may have applied.');
  }
}

export type CodexCutVerification =
  | { ok: true; empty: boolean }
  | { ok: false; reason: 'outcome-unknown' | 'provider-refused' | 'target-not-found'; message: string };

/**
 * Confirm the recorded history now ends at the kept turn and excludes the cut turn.
 *
 * A rewind removes the target and everything newer, so the target — if still recorded — sits
 * at or before the kept turn. Seeing the kept turn as the newest turn therefore proves absence
 * without walking the whole thread. A bounded scan that runs out with a cursor still pending
 * proves nothing and is reported as `outcome-unknown`.
 */
export async function verifyCodexCut(port: Pick<CodexRewindPort, 'listTurns'>, input: {
  threadId: string; beforeTurnId: string; keepTurnId: string | null;
}): Promise<CodexCutVerification> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    if (pages >= CODEX_MAX_TURN_PAGES) {
      return { ok: false, reason: 'outcome-unknown', message: 'The bounded verification scan ran out before it could prove the cut.' };
    }
    const result = await port.listTurns(input.threadId, cursor, CODEX_TURN_PAGE_LIMIT);
    pages++;
    const turns = Array.isArray(result?.data) ? result.data : [];
    for (const turn of turns) {
      if (typeof turn?.id !== 'string' || !turn.id) return { ok: false, reason: 'provider-refused', message: 'Codex returned a turn without an id.' };
      if (turn.id === input.beforeTurnId) return { ok: false, reason: 'provider-refused', message: 'The cut turn is still recorded; rewind did not apply.' };
      if (input.keepTurnId === null) {
        return { ok: false, reason: 'provider-refused', message: 'Rewinding the first turn must leave no recorded turns.' };
      }
      if (turn.id === input.keepTurnId) return { ok: true, empty: false };
    }
    const next = result.nextCursor ?? null;
    if (input.keepTurnId === null) {
      // Empty history is provable only when the first page is empty and nothing follows it.
      return turns.length === 0 && !next
        ? { ok: true, empty: true }
        : { ok: false, reason: 'outcome-unknown', message: 'History is not empty, so the first-turn cut cannot be confirmed.' };
    }
    if (!next) return { ok: false, reason: 'outcome-unknown', message: 'Recorded history does not end at the expected turn. Inspect Terminal.' };
    if (seen.has(next)) return { ok: false, reason: 'provider-refused', message: 'Codex repeated a turn cursor.' };
    seen.add(next);
    cursor = next;
  }
}

/** Confirm a lost rewind reply: applied only when history ends at the expected kept turn. */
export async function recoverCodexRewind(port: Pick<CodexRewindPort, 'listTurns'>, input: {
  beforeTurnId: string; keepTurnId: string | null; threadId: string;
}): Promise<{ ok: true } | { ok: false; reason: RewindRefusal; message: string }> {
  const verification = await verifyCodexCut(port, input);
  if (verification.ok) return { ok: true };
  if (verification.reason === 'provider-refused') return { ok: false, reason: 'target-not-found', message: 'The rewind did not apply; the original session is unchanged.' };
  return { ok: false, reason: 'outcome-unknown', message: verification.message };
}

/** Default port over the fixed app-server transport. Root passes its resolved Codex CLI. */
export function createCodexRewindPort(
  request: (method: string, params: object) => Promise<any>
): CodexRewindPort {
  const thread = (value: any): CodexThreadSummary => {
    const candidate = value?.thread;
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id) throw new CliError('INVALID_UPSTREAM', 'Codex returned no thread');
    return {
      id: candidate.id,
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : null,
      forkedFromId: typeof candidate.forkedFromId === 'string' ? candidate.forkedFromId : null,
      historyMode: typeof candidate.historyMode === 'string' ? candidate.historyMode : undefined,
      status: candidate.status && typeof candidate.status === 'object' ? { type: typeof candidate.status.type === 'string' ? candidate.status.type : undefined } : null,
    };
  };
  return {
    async readThread(threadId) {
      return thread(await request('thread/read', { threadId, includeTurns: false }));
    },
    async listTurns(threadId, cursor, limit) {
      const page = await request('thread/turns/list', { threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full' });
      if (!page || !Array.isArray(page.data)) throw new CliError('INVALID_UPSTREAM', 'Codex returned no turn page');
      return {
        data: page.data.map((turn: any) => ({
          id: typeof turn?.id === 'string' ? turn.id : '',
          items: Array.isArray(turn?.items) ? turn.items.map((item: any) => ({ id: typeof item?.id === 'string' ? item.id : undefined, type: typeof item?.type === 'string' ? item.type : undefined })) : [],
        })),
        nextCursor: typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null,
      };
    },
    async forkBefore(threadId, beforeTurnId) {
      return { thread: thread(await request('thread/fork', { threadId, beforeTurnId, excludeTurns: true })) };
    },
    async revertBefore(threadId, beforeTurnId) {
      return { thread: thread(await request('thread/revert', { threadId, beforeTurnId })) };
    },
  };
}
