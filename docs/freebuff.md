# Freebuff provider

Freebuff is a native terminal agent (`freebuff`, bundled as `freebuff.exe` on Windows). ADE launches it in an owned PTY, reads its recorded `chat-messages.json` history, and uses its own pickers for model and reasoning changes. No Freebuff runtime is bundled and no Orca dependency is used.

## Native storage

`~/.config/manicode/` (override with `FREEBUFF_CONFIG_DIR`):

- `settings.json` stores `freebuffModel` and `freebuffReasoningEfforts` (keyed by model ID). `freebuffModelDefaultMigration` is a migration marker, not the current selection.
- `projects/<basename>/chats/<chatId>/chat-messages.json` is the recorded conversation. `log.jsonl` is a pino diagnostic log, not history.
- `credentials.json` stores the account record (`id`, `name`, `email`, `tokenStore`). The token itself is kept in the OS keychain (`Bun.secrets` service `freebuff-cli`, name = the credentials path). On Windows that is a generic credential with target `freebuff-cli/<credentials path>`.

ADE reads the account record for display and the token only for the usage request. The token never reaches HTTP responses, logs, arguments, or cache keys.

## Model catalog and current settings

`server/providers/freebuff/freebuffCatalog.ts` mirrors the catalog bundled in Freebuff 0.2.35: the CLI's own IDs, display names, per-model reasoning efforts, defaults and context windows. The native picker only lists models the current connection can use, so applying a model the picker does not show fails explicitly instead of writing a guessed ID.

The running session's status line is authoritative for the current model and reasoning level:

```
 DeepSeek V4.1 Flash 10/17 • high · ~\path · /model to change · Chat: …
```

`freebuffFooterModel` parses that line, and the catalog resolves the display name to an ID. `settings.json` is only a fallback while the screen is not readable. With neither source, the current model stays unknown; no default is fabricated.

## Native controls

- `/model` opens the model picker (`↑↓ choose model · Tab reasoning · Enter select · Esc cancel`). ADE parses the rendered rows, walks the scrolling list until the requested model is visible, moves the native selection, presses Enter, then confirms the new model from the status line.
- `/reasoning` (aliases `effort`, `think`) opens the reasoning picker (`↑↓ choose · Enter save · Esc back`). ADE selects the requested level and confirms it from the status line.
- Freebuff has no `/compact`. It is not in `providerCompaction.ts`, so Chat hides `/compact` and the endpoint refuses.
- Freebuff has no `--model` or `--effort` launch flags. Workflow launches write the requested model/effort into `settings.json` immediately before spawning, which is how the CLI reads a new selection. Ordinary launches keep the user's current settings.

The native composer is a boxed prompt with a block cursor and dim placeholder. `terminalScreen.freebuffPromptReady()` recognizes the empty composer, rejects a typed draft, and rejects an open native picker. That keeps Chat settings from being blocked by a stale draft flag and keeps sends/queues from landing in a draft.

## Usage and accounts

Usage is `POST https://www.codebuff.com/api/v1/usage` with JSON `{ fingerprintId: "cli-usage", authToken }`. A bearer header is not accepted (405). The response carries `remainingBalance`, `balanceBreakdown` and `next_quota_reset`; it does not carry a cap, so the usage strip reports `Credits remaining: N` and marks a zero balance as exhausted instead of inventing hours or a total.

AI Providers shows the recorded Freebuff account (`name (email)`) when the native sign-in is detected. Sign-in itself stays in the native CLI (`freebuff login`).

## Evidence and limits

Observed against the installed Freebuff 0.2.35 Windows bundle: bundled model/effort constants, the status-line component, the `/model` and `/reasoning` handlers and pickers, `settings.json` writes, the `chat-messages.json` store, and the usage client. The picker driver was validated against the real TUI in an owned PTY (model list, Tab reasoning, selection, settings persistence) and in the unit suite with a rendered picker fixture.

Limits:

- The keychain read is implemented for Windows Credential Manager. On macOS/Linux, a keychain-only token is not read, so account connection and usage stay explicitly unavailable rather than guessed.
- Models absent from the current connection's picker cannot be selected; the error says so.
- Reasoning is offered only for models whose native picker advertises efforts. Some catalog entries expose none.
- Freebuff has no child-agent transcript format; subagents are projected only from recorded `spawn_agents` blocks.
- The status-line and picker parsers are version-bound to the observed TUI. A future UI change fails closed (explicit unknown or timeout) instead of writing an unverified setting.
