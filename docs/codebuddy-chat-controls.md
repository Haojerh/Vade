# CodeBuddy native chat settings

`server/runtime/codeBuddyChatControls.ts` targets the installed **CodeBuddy Code** CLI, not a separate WorkBuddy desktop application. It uses the owned terminal's native commands rather than changing settings in a different ACP session.

## Evidence

Read-only inspection of the shipped `@tencent-ai/codebuddy-code` 2.173.0 `dist/codebuddy.js` (SHA-256 `2af9a6c9cf7c9053c4a0e0a5d3e7df9d4b2428bbd51c013d8aebe71e654fcf49`) established:

- Around character 7,797,209, help generation calls `AgentManager.getModels` and appends the resulting IDs to `Currently supported: (...)`. ADE calls the fixed `--help` command, caps output at 1 MiB and execution at 15 seconds, and shares a one-minute catalog cache.
- Around character 8,323,500, `/model <id-or-name>` rejects missing or disabled models and calls the current session model transition. Around 12,778,039, that transition rejects a busy session, updates its runtime model, and returns `Switched model to <name>.` or a session-specific acknowledgement. A persistence warning still explicitly confirms the session change.
- Around character 8,484,000, `/effort <level>` checks the current model's capabilities, sets its thinking override, and reports `Model reasoning effort set to <level>.` Unsupported choices return an error instead.
- Around character 19,905,800, the native `/effort` panel resolves the current session's model capabilities and renders supported levels. It warns if resolution failed and supports Escape without applying a change. When native Dynamic Workflows are enabled, it appends the separate `ultracode` workflow mode; this is not an alias for an ordinary model effort.

## Mapping and Ultracode investigation, 2026-10-25

REA inspected the installed artifact above under Evidence `ev_615c759eba95ebf3a5f90c4092d8c46516d97d4d59dd088c63c185ffab51d8a1`. The full bundle's semantic pass hit its heap bound; that partial graph is not proof of complete behavior. A focused inert extraction of the complete native effort executor, model resolver and command-record method was also parsed with REA under `ev_53a8073db82637c1b50b78929437e10dbb5c7fb51717bdfd40c64b792221d5ac` (3 parsed files, no parse failures). Extraction wrappers only supply declarations; external dependencies remain unresolved. No installed CodeBuddy code was changed or executed by this analysis.

Observed source locations (byte offsets in the SHA-256-identified `dist/codebuddy.js` above): model resolver 7,547,280–7,547,508 checks exact IDs before names/aliases; effort executor 8,484,479–8,488,828 stores `session.meta.workflowEffortLevel = 'ultracode'` and returns distinct enter/exit reminders; command input method 17,759,923–17,760,344 records the exact command name and arguments. The user independently confirmed the native model selection was correct.

Vade's former display-name map retained only the last ID for a name. Duplicate names could therefore display the `-sg` model after selecting the other ID. Mapping now retains all IDs, disambiguates using the exact session's recorded `/model` argument or current-marker ID, and leaves ambiguous acknowledgements unknown. Ordinary chat, foreign sessions/workspaces and unconfirmed command arguments cannot establish a setting. Setting evidence uses a bounded 4 MiB backward scan with a 200-record selection limit so long tool records do not immediately hide command acknowledgements.

Ultracode is offered only when the native effort panel advertises it. Vade recognizes its exact enter/already-enabled/exit acknowledgement formats, preserves the observed mode across ordinary reasoning-effort metadata, and never treats a disabled-workflow error or an old acknowledgement as success. Focused regression tests cover both distinct DeepSeek IDs, ambiguous/foreign evidence, restoration and the special native acknowledgements. Static inspection and fixtures do not establish a live authenticated settings change.

The REA workflow was used for shipped-artifact analysis. Whole-bundle analysis had previously exceeded its tool time limit, so this pass used bounded direct inspection of the exact installed artifact. Source evidence establishes command behavior; authenticated interactive settings changes were not run.

## Fences and limitations

GET settings reads only the native help catalog and already observed model/effort. It never opens a menu or changes terminal state. Effort choices are initially unknown. An explicit POST loads the native effort menu under the same idle-process, empty-composer and input-lock fences as a settings change, records only rendered model effort labels, and closes it with Escape. A confirmed model change clears the old capabilities; the user can explicitly load choices for the new model. Capabilities are cached against a caller-supplied session/launch identity and its exact model, never globally across agents.

Only catalog IDs and the current session's recorded effort choices can be submitted. Confirmation must come from fresh native output after acquiring the input lock. A timeout never triggers a retry or a claimed setting change. Failed capability resolution leaves effort unavailable. Native model selection may also change the provider's global default, matching its own `/model` command semantics.

Model-list and setting acknowledgements use only fresh `skipRun` local-command stdout records in the exact verified CodeBuddy JSONL, captured after the operation's byte cursor. Reads are capped at 256 KiB and fenced to the same file identity, session and workspace. Clipped terminal screens, ANSI cursor movements, old command records and ordinary assistant text cannot confirm a change. Native command completion has a bounded twenty-second wait. These private command records are never projected into public Chat.

Callers must keep the launch identity stable within a process and change it on resume. Effort discovery uses the settings `providerPicker: open` POST automatically when the user opens an idle CodeBuddy settings picker or selects another model. There is no separate load button. A failed attempt is not automatically replayed; GET remains observational. No model or effort inventory is hardcoded.


CodeBuddy 2.173.0 module 485779 renders an empty focused placeholder with its first character undimmed and all remaining characters dim. Module 772740 adds inverse styling only off Windows. ADE recognizes this native placeholder styling without accepting undimmed draft text. The provider's idle timer emits Notification/idle_prompt after sixty seconds without activity; ADE ignores that reminder rather than replacing a recorded result with Waiting. Genuine question and permission events remain actionable.

The native IME caret marker (SGR 999, module 772740) records the logical composer position. ADE uses it for CodeBuddy empty-input checks even when a redraw leaves the physical terminal cursor on a footer. Screen parsing settles before checks, fenced against concurrent input. Native mouse/focus reports preserve draft tracking rather than becoming typed text.

Windows readiness also accepts the actual terminal cursor when no SGR 999 marker is present (including after resize). A recommendation counts as empty only with the caret before its first character and dim remaining text; a caret after a typed character or any other undimmed draft remains nonempty. Read-only observation of the owned terminal reproduced the missing-marker false draft with the dim `Pick up ADE runtime exploration` recommendation.

CodeBuddy sends wait up to five seconds for the newly pasted draft to render before submitting Enter once, instead of relying on the generic 300 ms delay. Native `[Pasted text #N: L lines]` capsules are accepted only for the expected line count within that owned, initially empty, input-locked composer. Submission then requires a cleared native composer or a fresh exact-session lifecycle observation. Timeout remains uncertain, never successful, and never repeats paste or Enter. Regression fixtures cover a paste that renders after 450 ms, Windows recommendations without markers, real drafts, native capsules and unconfirmed one-shot submission. These checks do not resend an existing Kanban task.
