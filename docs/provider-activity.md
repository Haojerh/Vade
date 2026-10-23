# Provider errors and reasoning activity

`server/providers/providerActivity.ts` reads bounded exact-session native errors separately from public conversation. OpenCode/Kilo assistant errors and OpenCode 2 error records appear in Chat even when the failed message has no text parts. Codex, Claude and CodeBuddy structured error records use the same activity display. These errors do not establish task outcomes.

A later recorded public assistant response retires earlier error banners. A new user request alone, reasoning, synthetic errors and tool output do not clear them.

Native OpenCode-family model and effort controls use a monotonic PTY output cursor and the full bounded viewport. Picker parsing crops to the overlaid widget, excluding background composer text and Kilo's details column. Slash commands wait for the native composer render before Enter; search and selection wait for native focus/filter effects. Duplicate Recent/Recommended rows for the same uniquely identified model are permitted. Model and effort changes still require native footer/current-marker confirmation.

Effort reads prefer observed native footers for Codex, Antigravity and the OpenCode family, and recorded local-command acknowledgements for Claude and CodeBuddy. Standalone effort changes are read independently of the latest model record, so a previous turn's effort cannot hide a newer manual change.

Reasoning activity exposes presence only, never reasoning text, encrypted content or summaries. Saved reasoning blocks remain backend evidence and do not leave labels in Chat. Chat displays one set of three dots throughout a confirmed live, fresh working turn, independently of transcript flushes. As in Orca's active-turn label logic, native working status supplies a general activity fallback when no live reasoning block is available. The accessible label is Agent working; it becomes Reasoning only with explicit active reasoning evidence. Completed, failed, waiting, stopped, unknown and stale agents show no dots. Reduced motion keeps the dots static. Antigravity has the working fallback but no speculative reasoning phase.

Reference: https://github.com/stablyai/orca/blob/main/src/shared/native-chat-turn-status.ts

Ended workflow agents accept ordinary chat even while Workflow settings remain enabled; continuing them does not create another workflow. Active workflow membership and checkout ownership still block conflicting input. Cancellation revokes workflow authority and stops worker processes; stopped workers require explicit Resume before chat can send.
## Manual interruptions

OpenCode/Kilo's typed `MessageAbortedError` is cancellation metadata, not a provider-error alert. Its exact-session hook emits a separate `SessionAborted` observation and prevents a later idle event from reporting completion. The runtime confirms Interrupted only when that observation follows recent interruption input on an active owned turn. Focus, pointer and key-release events do not erase that input fence. Completed/Failed/Interrupted remain latched until new observed activity, including when a late normal end report arrives. Genuine provider errors remain visible.
