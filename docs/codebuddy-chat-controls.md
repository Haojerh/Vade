# CodeBuddy native chat settings

`server/runtime/codeBuddyChatControls.ts` targets the installed **CodeBuddy Code** CLI, not a separate WorkBuddy desktop application. It uses the owned terminal's native commands rather than changing settings in a different ACP session.

## Evidence

Read-only inspection of the shipped `@tencent-ai/codebuddy-code` 2.173.0 `dist/codebuddy.js` (SHA-256 `2af9a6c9cf7c9053c4a0e0a5d3e7df9d4b2428bbd51c013d8aebe71e654fcf49`) established:

- Around character 7,797,209, help generation calls `AgentManager.getModels` and appends the resulting IDs to `Currently supported: (...)`. ADE calls the fixed `--help` command, caps output at 1 MiB and execution at 15 seconds, and shares a one-minute catalog cache.
- Around character 8,323,500, `/model <id-or-name>` rejects missing or disabled models and calls the current session model transition. Around 12,778,039, that transition rejects a busy session, updates its runtime model, and returns `Switched model to <name>.` or a session-specific acknowledgement. A persistence warning still explicitly confirms the session change.
- Around character 8,484,000, `/effort <level>` checks the current model's capabilities, sets its thinking override, and reports `Model reasoning effort set to <level>.` Unsupported choices return an error instead.
- Around character 19,905,800, the native `/effort` panel resolves the current session's model capabilities and renders the supported levels. It warns if resolution failed, supports Escape without applying a change, and excludes workflow-only `ultracode` from ordinary model effort.

The REA workflow was used for shipped-artifact analysis. Whole-bundle analysis had previously exceeded its tool time limit, so this pass used bounded direct inspection of the exact installed artifact. Source evidence establishes command behavior; authenticated interactive settings changes were not run.

## Fences and limitations

GET settings reads only the native help catalog and already observed model/effort. It never opens a menu or changes terminal state. Effort choices are initially unknown. An explicit POST loads the native effort menu under the same idle-process, empty-composer and input-lock fences as a settings change, records only rendered model effort labels, and closes it with Escape. A confirmed model change clears the old capabilities; the user can explicitly load choices for the new model. Capabilities are cached against a caller-supplied session/launch identity and its exact model, never globally across agents.

Only catalog IDs and the current session's recorded effort choices can be submitted. Confirmation must come from fresh native output after acquiring the input lock. A timeout never triggers a retry or a claimed setting change. Failed capability resolution leaves effort unavailable. Native model selection may also change the provider's global default, matching its own `/model` command semantics.

Model-list and setting acknowledgements use only fresh `skipRun` local-command stdout records in the exact verified CodeBuddy JSONL, captured after the operation's byte cursor. Reads are capped at 256 KiB and fenced to the same file identity, session and workspace. Clipped terminal screens, ANSI cursor movements, old command records and ordinary assistant text cannot confirm a change. Native command completion has a bounded twenty-second wait. These private command records are never projected into public Chat.

Callers must keep the launch identity stable within a process and change it on resume. Effort discovery uses the settings `providerPicker: open` POST automatically when the user opens an idle CodeBuddy settings picker or selects another model. There is no separate load button. A failed attempt is not automatically replayed; GET remains observational. No model or effort inventory is hardcoded.


CodeBuddy 2.173.0 module 485779 renders an empty focused placeholder with its first character undimmed and all remaining characters dim. Module 772740 adds inverse styling only off Windows. ADE recognizes this native placeholder styling without accepting undimmed draft text. The provider's idle timer emits Notification/idle_prompt after sixty seconds without activity; ADE ignores that reminder rather than replacing a recorded result with Waiting. Genuine question and permission events remain actionable.

The native IME caret marker (SGR 999, module 772740) records the logical composer position. ADE uses it for CodeBuddy empty-input checks even when a redraw leaves the physical terminal cursor on a footer. Screen parsing settles before checks, fenced against concurrent input. Native mouse/focus reports preserve draft tracking rather than becoming typed text.
