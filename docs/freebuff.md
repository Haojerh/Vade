# Freebuff provider

Freebuff is a native terminal agent (`freebuff`, bundled as `freebuff.exe` on Windows). ADE launches it in an owned PTY, reads its recorded `chat-messages.json` history, and uses its own pickers for model and reasoning changes. No Freebuff runtime is bundled and no Orca dependency is used.

## Native storage

`~/.config/manicode/` (override with `FREEBUFF_CONFIG_DIR`):

- `settings.json` stores `freebuffModel` and `freebuffReasoningEfforts` (keyed by model ID). `freebuffModelDefaultMigration` is a migration marker, not the current selection.
- `projects/<basename>/chats/<chatId>/chat-messages.json` is the recorded conversation. `log.jsonl` is a pino diagnostic log, not history.
- `credentials.json` stores the account record (`id`, `name`, `email`, `tokenStore`). The token itself is kept in the OS keychain (`Bun.secrets` service `freebuff-cli`, name = the credentials path). On Windows that is a generic credential with target `freebuff-cli/<credentials path>`.

ADE reads the account record for display and the token only for the usage request. The token never reaches HTTP responses, logs, arguments, or cache keys.

## Model catalog and current settings

The catalog is **not** a fixed list. `GET https://www.codebuff.com/api/v1/freebuff/models` (bearer token plus `x-freebuff-catalog-protocol: 1`, `x-freebuff-client: cli`) returns the models this account may actually use, with their native keys, display names, efforts, default effort, context windows, picker section/order and an `access` flag. ADE maps that response (`freebuffModelsFromCatalog`), drops `access: "locked"` rows because the native picker refuses them, and keeps the rest in the provider's order (standard → premium → powerful).

That response is cached in `ADE_DATA_DIR/freebuff-catalog.json` with the response's own `refreshAt` (clamped to 5–30 minutes) and refreshed in the background. A cached copy is served immediately; only a cold start waits briefly. When the request cannot be made (offline, signed out, rejected) the catalog the CLI itself bundles is used instead — `FREEBUFF_BUNDLED_MODELS`, a transcription of that bundled table. That fallback is a snapshot, so it may list a model the account cannot select; applying such a model fails explicitly at the native picker rather than writing a guess.

Model IDs are the catalog row's `key` (`m-…`), which is what the picker stores. Older releases stored provider-style IDs (`deepseek/deepseek-v4-flash`); `freebuffResolveStored` maps those through the bundled table's display name to the current key.

The running session's status line is authoritative for the current model and reasoning level:

```
 DeepSeek V4.1 Flash 10/17 • high · ~\path · /model to change · Chat: …
```

`freebuffFooterModel` parses that line and resolves the display name against the live catalog. `settings.json` is only a fallback while the screen is not readable. With neither source, the current model stays unknown; no default is fabricated.

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

Observed against the installed Freebuff 0.2.35 Windows bundle: the `/api/v1/freebuff/models` catalog client and its response schema, the bundled model/effort constants, the status-line component, the `/model` and `/reasoning` handlers and pickers, `settings.json` writes, the `chat-messages.json` store, and the usage client. The live catalog was read with this account's token (9 selectable rows out of 15; the rest are subscription-locked). The picker driver was validated against the real TUI in an owned PTY (model list, Tab reasoning, selection, settings persistence) and in the unit suite with a rendered picker fixture.

Limits:

- The catalog request is slow on some networks (observed 1–13 s). A cached copy is served immediately and refreshed in the background; only a cold start waits, and it falls back to the bundled table rather than blocking the picker.
- The bundled fallback can list a model this account cannot select. Selecting it fails at the native picker with an explicit message instead of writing a guess.
- The keychain read is implemented for Windows Credential Manager. On macOS/Linux, a keychain-only token is not read, so the live catalog, account connection and usage stay explicitly unavailable rather than guessed.
- Reasoning is offered only for models whose catalog row advertises efforts. Several rows expose none.
- Freebuff has no child-agent transcript format; subagents are projected only from recorded `spawn_agents` blocks.
- The status-line and picker parsers are version-bound to the observed TUI. A future UI change fails closed (explicit unknown or timeout) instead of writing an unverified setting.
