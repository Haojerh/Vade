# DeepSeek Harness

The `dsh` provider detects `dsh-tui` and its required `dsh` runtime, reusing the existing DeepSeek Harness icon. It supports Add Agent, project shortcuts, Hand Off and workflows. Native setup, credentials, permissions and complex questions remain in Terminal.

## Ownership and Chat

`runtime/dsh.ts` creates an owned launch patch without editing user profiles or replacing hooks. Its observer binds root `session/created` and `session/event` observations to an exact session, workspace and fresh launch token. Child sessions and other workspaces are excluded.

Chat projects direct human messages, assistant text, recorded tool-call inputs and observed model/effort metadata. It excludes injected context, reasoning, tool results and credentials. Replay takes at most 2,000 native events; the projection rotates after 16 MiB, retaining a complete-line tail. Source-bound cursors reset after rotation, and Chat explicitly reports bounded coverage. The reader does not mutate native history.

Vade-owned conversations appear in agent history. The observer checks native persistence metadata: an in-memory empty session without a saved artifact is excluded from resumable history and refused on resume. Resume uses the exact native session in its original workspace. Moving a DSH session to another checkout is refused; Hand Off can create a new session there. This adapter does not import sessions started outside Vade.

Changing the native TUI to another session or replacing its channel revokes Chat send readiness. Vade does not silently rebind its existing conversation to the new session.

## Status and input

Native turn boundaries and tool events establish working, question, completion, failure and explicit user interruption. Initial replay establishes idle without replaying completion notifications. Process exits, submitted input and OSC reports from embedded CLIs cannot establish outcomes. The shared work clock and Inbox consume these observations.

Chat requires the native channel's `ready` flag plus an empty rendered composer. This excludes the launchpad and setup guide. The optional native `⌸` session-browser button is excluded from draft text, as is the expand button. Paste must render before one Enter is submitted, and fresh native submission evidence must follow. Uncertain delivery is not retried. Stop sends one Ctrl+C to the owned working session. Manual launch mode preserves native permission behavior; Auto and Yolo are not advertised.

## Models and workflows

The observer reads the installed TUI's registered channel, models, model-specific effort levels and current selection. Generic fallback effort ladders are excluded. Changes use native slash commands under the input lock; both the rendered command and resulting channel state must confirm the change.

Workflow model discovery uses the shipped metadata-only `dsh-tui cli models list --output-format json` command. Model-specific efforts come from an observed Vade-owned session; offline catalog rows do not invent support. Explicit workflow settings are confirmed before dispatch. Setup can block dispatch until completed in Terminal. Fast mode and subscription quotas are not claimed.

## Evidence

Reference implementation: Orca's MIT-licensed [DSH configuration](https://github.com/stablyai/orca/blob/main/src/shared/tui-agent-config.ts), [hook adapter](https://github.com/stablyai/orca/blob/main/src/shared/agent-hook-listener/providers/dsh-events.ts), and [startup captures](https://github.com/stablyai/orca/tree/main/src/main/runtime/__fixtures__/dsh-tui-0.17). No Orca runtime is required.

Artifacts inspected: `dsh-tui` 0.17.0 and `@deepseek-ai/dsh` 0.2.1-rc.3. REA analysis of exact copied shipped modules is retained as Evidence `ev_0874b84e3829636c26491972daa6ca7f0eb72af0667a0c3f321d118b0cf67f81`, artifact SHA-256 `66151f738ea92ba396040fa04c249eb8aa5f2f36dd60b48b6c5a310f4a139b15`. This is static evidence, not execution evidence.

Real startup verified binding, current model/effort and 65 native model choices on the development host. Its credential guide prevented a live generation test. Controlled PTY tests cover sending, readiness refusal and interruption; event-contract tests cover public projection, exact identity and explicit outcomes. Missing or incompatible native evidence degrades to Terminal.
