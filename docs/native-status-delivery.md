# Native approval, interruption and submission evidence

## CodeBuddy approval checks

Vade previously treated every native PermissionRequest hook as a visible approval. In CodeBuddy, permission checking and prompt presentation are separate stages. The REPL permission checker dispatches the hook and may return without requesting a security approval; native prompt creation happens separately. A previously approved session scope can therefore produce permission-related events without a user-facing choice.

CodeBuddy approval status now requires the current owned terminal to display its native confirmation heading, selected numbered option and allow/reject choices. The raw hook remains available so rendering the prompt publishes waiting immediately; clearing it publishes working. Question/auth states are separate. No choice is automatically approved and no native permission setting is changed.

REA analyzed inert complete method/function extracts from installed CodeBuddy Code 2.173.0, artifact SHA-256 `2af9a6c9cf7c9053c4a0e0a5d3e7df9d4b2428bbd51c013d8aebe71e654fcf49`. Character ranges: permission checker 14060390-14061672, permission hook dispatcher 14062483-14062797, and security prompt request 14054296-14054625. Parent Evidence: `ev_28c6d6c75786318267874a83aa14d82a8218a9000a175f604455a5ef78cb75e0`. Three extracts parsed without failures. Wrappers only provide class declarations; external dependencies and dynamic behavior remain unresolved. This establishes the separate native stages, not a live reproduction of the user's session-specific approval cache. Regression tests exercise the observed English native widget format without approving a real request.

## Interruption and Inbox

The Antigravity terminal redraw callback formerly passed an older PreToolUse hook into the result observer merely to ask whether an approval widget was visible. That changed the turn from interrupted to working. A subsequent status read restored the same interruption under a new turn ID. The callback now uses a pure attention projection. Terminal outcomes stay latched across late tool/bookkeeping hooks until a fresh invocation.

An observed installed database contained nine interrupted rows for one exact node/timestamp (`2026-10-26T08:13:08.318Z`). The Inbox reader keeps the first stable entry for the same project, node, outcome and timestamp. It leaves underlying rows untouched and preserves separate timestamps and workflow task results. New regression coverage exercises thirteen redraw/status cycles, a genuine next invocation, and historical duplicates.

## Codex Enter recovery

The first Enter follows a rendered exact-text or native paste-capsule witness. Submission requires fresh native activity or a fresh empty composer. At the user's request, one additional Enter is allowed when a new post-submit redraw remains stable for at least 600 ms, at least one second has elapsed, the exact draft is still present, and the exact owned terminal is confirmed idle without queued/interrupt UI. The assignment is never pasted again. Write failures, no fresh output, changed drafts, busy/setup states and unconfirmed delivery remain uncertain. The same input lock/process fences apply to both Enter writes.

## Subsequent workflows and parallelism

After a completed run, a new message to its original coordinator follows the normal explicit workflow-confirmation flow and can create a fresh run. Active coordinator follow-ups stay within their run; former workers remain ordinary chats. Failed/cancelled-run follow-up behavior is preserved.

Parallel dispatch requires independent isolated streams with Isolated Worktrees enabled. A shared checkout always has one writer, so frontend/backend tasks in that checkout run sequentially even without a graph edge. The coordinator dispatches ready independent streams before waiting and must respect all predecessor and integration gates.
