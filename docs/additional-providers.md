# Additional standalone providers

CodeBuddy, OpenCode, OpenCode 2 and Kilo Code participate in agent preferences, project shortcuts, workflow workers, graph nodes and right-sidebar history. Existing preferences receive enabled Manual entries for these providers. Fixed native/npm entry points are detected; arbitrary launch commands and flags remain forbidden.

## Ownership, status and history

CodeBuddy receives an assigned UUID through `--session-id`, and resumes only that ID through `--resume`. Its `.codebuddy/projects` JSONL must independently confirm the session and original workspace. Public history projects its top-level message/content format, excluding synthetic `skipRun` records, reasoning and function results. Function-call inputs supply separate bounded tool disclosures.

OpenCode/Kilo use native `ses_â€¦` identities. A new launch briefly starts an owned, password-protected loopback native server, creates an empty session through `POST /session`, stops that server and launches the interactive CLI with `--session <exact ID>`. No model prompt is sent during binding. SQLite collection is read-only; Vade never writes provider SQL rows or selects a session by latest activity or terminal title. Existing sessions must match the original workspace.

The history index reads at most 500 root sessions per SQLite provider alongside bounded JSONL discovery. Opaque sidebar IDs are revalidated before resume, retaining the existing running-session conflict checks. Opening a backend-lost terminal recovers its exact session once; an observed exit requires explicit Resume. Input is never replayed.

Public SQLite messages and tool inputs reuse the shared bounded readers. Forward cursors include a native update revision so changes to an existing assistant message reach Chat. Backward pagination keeps its separate cursor direction. Database/WAL watches retain the polling fallback. Thinking, tool output and inferred tool success remain excluded.

CodeBuddy uses native command hooks while preserving existing hooks. OpenCode/Kilo receive a process-local status plugin through native inline configuration, preserving other plugins and permissions. Only the assigned root session can publish under the fresh launch token. Child completion cannot finish the root; startup idle creates no Inbox completion. Native turn end after a recent owned interruption request can confirm Interrupted. Process exit alone establishes no outcome.

CodeBuddy's Stop hook omits an interruption flag in 2.173.0. ADE correlates native turn end or the native interruption marker with a recent interrupt request in that exact owned terminal, preserving the interrupted result against late Stop events. REPL child calls come only from recorded `replToolCalls.calls` inputs, bounded to 20 children; their output and success flags are not projected. Chat groups those calls under REPL, and graph activity uses their stable recorded IDs.

OpenCode 2 is a separate `opencode2` agent, matching Orca. ADE verifies its major version, creates the exact session through its authenticated `/api/session` route, then launches with `--standalone --session` so status belongs to that terminal's private server. Its read-only `session_v2` / `session_message` readers exclude synthetic messages, reasoning and tool results, and migrated v1 twins do not create duplicate sidebar entries. The v2 object/setup plugin observes exact-session execution and permission/form events; non-user interruption reasons remain unknown. The live catalog comes from bounded `/api/model` reads on an owned temporary native server, and model selection is confirmed in the exact TUI. Auto and Yolo are unavailable for v2 because no verified fixed permission mapping is implemented. Its skills use the existing official `opencode` installation target.

CodeBuddy supports Manual, Auto and Yolo through advertised flags. OpenCode/Kilo support Manual and native `--auto` as Yolo; the separate automatic-reviewer mode is unavailable. Native sign-in, trust prompts and provider policies remain in Terminal. The official bundled skill installer includes the new `codebuddy`, `opencode` and `kilo` targets; reinstall workflow components after this update to create their skill links.

## Attachments and accounts

| Provider | Images | PDFs / other files | Sign-in |
| --- | --- | --- | --- |
| CodeBuddy | Local file references | Local file references | Native `codebuddy` UI |
| OpenCode | Native image parts from an isolated path paste | Native PDF parts; references for other files | `opencode auth login` |
| Kilo Code | Native image parts from an isolated path paste | Native PDF parts; references for other files | `kilo auth login` |

Uploads remain validated, bounded server-owned files. References do not claim binary content reached the model. The composer describes the transport. Delivery is staged once under the input lock; uncertain sends are never retried automatically.

AI Providers supports named OpenCode Go usage profiles with confirmed removal and System default selection. Create a profile, copy its sign-in command, then enter the Go API key in the visible native CLI. Credentials stay backend-only in native file/SQLite storage; no API key is accepted through HTTP. Selection changes usage display and leaves agent accounts unchanged. The fixed Go usage endpoint reports 5-hour, weekly and optional monthly windows; ordinary Zen/other-provider keys cannot establish Go quota. CodeBuddy and Kilo retain native sign-in without managed usage profiles. OpenCode/Kilo model selection uses their live verbose CLI catalogs and the exact owned idle TUI picker; identical display names across providers require native Terminal selection rather than guessing. Model changes are confirmed against the native footer, not submission alone. Effort choices load automatically from each native model's variants. Changes use the owned idle TUI's `/variants` picker, then reopen it to verify its current-selection marker before returning success. Models without native variants expose no effort control. Observed settings still appear on nodes and in Chat. Workflow catalogs read native `models` output or CodeBuddy's advertised CLI model list without hardcoded inventories.

CodeBuddy international personal-account credits are available through the native sign-in; see [usage evidence and account limits](codebuddy-usage.md). No browser cookies or credentials are accepted by the frontend.

CodeBuddy native model and effort controls are described in [chat settings evidence](codebuddy-chat-controls.md). Model choices use its live CLI catalog; effort choices load only after an explicit user action reads the owned idle terminal's native menu. Credit summaries use short pool names, with full credit amounts retained in the detailed view.

CodeBuddy questions keep their identity across unrelated screen redraws while retaining launch, input-revision, question and option fences. Its displayed numbers are not shortcuts: ADE observes arrow selection, enters the answer, verifies the native review page and submits only its confirmed answer summary. Each subsequent question requires a separate user answer; native multi-select remains in Terminal.

## Evidence and validation limits

Sources examined: installed CodeBuddy 2.173.0, OpenCode 1.19.2 and Kilo 7.8.15 help, shipped code and native storage schemas. The shipped OpenCode/Kilo paste handlers construct base64-backed image/PDF parts. CodeBuddy's actual JSONL differs from Claude's. Orca's bounded SQLite and status patterns informed the implementation without an Orca runtime dependency.

Primary references: [Orca](https://github.com/stablyai/orca), [OpenCode CLI](https://opencode.ai/docs/cli/), [Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli), [CodeBuddy CLI](https://www.codebuddy.ai/docs/cli/overview). Authenticated provider conversations and application interactions were not exercised. Test suites were not run, as requested; build checks validate compilation and packaging only.

Terminal checkpoints preserve observed SGR/SGR-pixel mouse encoding as well as tracking. Renderer wheel events retain native coordinates and use bounded line-mode reports for fullscreen OpenCode/Kilo scrolling. Windows transcript/workspace binding compares filesystem paths without treating drive-letter case as a different checkout.

OpenCode 2 compatibility was checked against [official source revision 4617210](https://github.com/anomalyco/opencode/tree/4617210) and Orca's v2 adapters. This host has OpenCode 1.19.2, so native v2 launch, sign-in and interactive behavior have not been exercised. Build verification does not establish runtime compatibility across later v2 releases.

Effort evidence on 2026-10-23: bounded read-only `models --verbose` output from installed OpenCode 1.19.4 and Kilo 7.8.17 contains per-model variants. OpenCode 2 uses the official protocol's variant array IDs. The shipped OpenCode TUI registers `/variants`; Kilo 7.8.17 contains the same command and native Default/variant selection handler in its UTF-16 embedded source. Kilo artifact SHA-256 `85a279267af4ecca810eaceddaf428846eca851a57a53fdd449cc0c4306833a2`, dialog handler bytes 172193444?172194160. REA analyzed that faithfully extracted complete function as inert JavaScript; its partial static graph leaves external handlers unresolved and does not establish interactive runtime success. Exact native current-marker verification remains required. No authenticated interaction or tests were run.

Read-only observation on 2026-10-23 captured an owned OpenCode 1.19.4 alternate screen with an empty composer and no placeholder: left rail on rows 19–22, input cursor at column 5 / row 20, native agent/model footer on row 22, and split bottom border on row 23. The native prompt source returns no placeholder when the example list is empty. Readiness now requires the cursor inside that composer frame and no draft content across its input rows; shell mode and dialog inputs remain excluded. Message sends settle pending screen parsing and fence concurrent input before checking readiness. This observation did not send a message or run a test.
