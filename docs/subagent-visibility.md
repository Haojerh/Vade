# Native child agents (subagents) in Chat and Topology

Vade surfaces the child agents that a provider harness records for one exact session. Nothing
here is inferred from terminal output, process liveness, or message text: a child appears only
when that provider's own records link it to the parent session.

## What is shown

- **Chat tray** (`src/features/workflow/SubagentTray.tsx`): a chevron section directly above the
  composer listing the session's child agents, their state, role and last activity. It renders
  only when at least one child is recorded. Expanding it polls
  `GET /api/projects/:projectId/nodes/:nodeId/subagents` every five seconds while open.
- **Topology stack** (`src/features/workflow/WorkflowNodeCard.tsx`): the same children render as
  small cards under the parent agent card, connected by a CSS rail. The rail is CSS, not the
  canvas edge layer, so child cards never disturb measured node geometry or edge routing.
- **Child details** (`SubagentDetailsDialog`): recorded public turns of that child, with older
  paging. When the provider keeps no separate child transcript the dialog states why instead of
  rendering an empty conversation. Child agents have no PTY, so no Terminal view is offered.

## Provider coverage

| Provider | Discovery | Child transcript |
|---|---|---|
| Codex | child rollout files with `session_meta.parent_thread_id` (also `source.subagent.thread_spawn`) | the child rollout file, read with the normal public projector |
| OpenCode v1 / Kilo | `session.parent_id` in the provider database | child `message`/`part` rows |
| OpenCode v2 | `session_v2.parent_id` | child `session_message` rows |
| Claude Code | `<project>/<sessionId>/subagents/**/agent-<agentId>.jsonl` | that child file (sidechain rows) |
| CodeBuddy | sibling `agent-*.jsonl` whose recorded `session-meta` names `parentSessionId` | that child file |
| DSH | session headers with `parentSession` (`origin: "subagent"`) | unavailable: compressed native sessions are not decoded for chat |
| Antigravity | not projected yet (child trajectories live inside one cascade database) | unavailable |

Claude removes a child's transcript directory when the child finishes, so only running children
appear there. Finished Claude children leave only the parent's tool result, and Vade does not
reconstruct turns for them.

A provider that records no child agents renders nothing: there is no empty chevron or
"unsupported" row in the composer. Antigravity currently has no projected child agents at all.

## Finished children

Whether a completed child stays visible depends on the provider, never on Vade:

- **Codex, OpenCode v1/v2, Kilo, DSH** keep the child record after completion, so finished
  children stay listed with their observed terminal state.
- **CodeBuddy** keeps the child only if its `agent-*.jsonl` session file persists.
- **Claude Code** deletes the child transcript directory on completion, so a finished child
  disappears from the list entirely. Only running children are visible.

## Contract

`shared/contracts.ts` defines `Subagent` and adds `subagents?: Section<Subagent[]>` to `Node`.
`Subagent.transcript` is `available` or `unavailable`; `reason` explains an unavailable one.
`state` is `working | waiting | idle | completed | failed | unknown`, and `unknown` is a real
answer when the provider records no completion signal.

Endpoints:

- `GET /api/projects/:projectId/nodes/:nodeId/subagents` → `Section<Subagent[]>`
- `GET /api/projects/:projectId/nodes/:nodeId/subagents/:subagentId/conversation?cursor&limit&direction` → `Section<ConversationPage>`

Subagent IDs are opaque server-issued hashes bound to the provider, the parent thread and the
child identity. Transcript paths never reach the browser; the server re-resolves the recorded
child from its own in-process handle table and answers `unavailable` when the handle is gone.

## State evidence

- **Codex**: `task_started` newer than `task_complete`/`turn_aborted` in the child rollout tail.
- **OpenCode v1 / Kilo**: the child's last assistant message is unfinished (`time.completed` absent).
- **Claude**: presence of the child transcript directory, which the CLI removes on completion.
- **CodeBuddy / DSH / Antigravity**: `unknown` unless the record carries an explicit status.

Never derive a child's state from the parent's state, from liveness, or from elapsed time.

## Bounded reads

Discovery caches per provider/thread/root signature for eight seconds. Codex scans at most 400
rollout headers at depth three; Claude lists at most fifty `agent-*.jsonl` files at depth three;
CodeBuddy lists at most fifty sibling files; DSH decompresses at most forty session headers under
a 1 MiB output cap and skips files over 4 MiB; OpenCode issues one bounded query. Child
transcripts page backwards through at most 1 MiB per read.

## Extending

Add a provider by returning a `Section<Subagent[]>` from `compute()` in
`server/runtime/subagents.ts` and registering a `Handle` for each child so
`readSubagentTranscript` can resolve it. Register a test in `server/runtime/subagents.test.ts`
with recorded fixtures; do not add a provider whose linkage is unverified — return `unsupported`
with the reason instead.

