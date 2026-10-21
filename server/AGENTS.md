# Backend rules

Read the root AGENTS.md first.

- Standalone runtime lives in `runtime/` and routes through `http/localRoutes.ts`. Never fall back to Orca from standalone routes. Preserve provider authentication; user-requested permission bypass flags apply to new and resumed terminals and stay fixed server-side.

- Keep `index.ts` as the process entry; route/validate in `http/`, access fixed upstream sources in `integrations/`, decode provider formats in `providers/`, and manage snapshots in `services/`.
- Keep tests beside their implementation. Include new suites in the root `npm test` command.
- Collection endpoints remain GET/HEAD only with loopback origin restrictions. Explicit actions listed in root AGENTS.md permit POST, including creating worktrees and renaming display names. No arbitrary executable, flags, RPC method, transcript path, or SQL may come from HTTP input.
- Attachments are validated bytes, never client filesystem paths. Bound file count/size and local storage, verify the exact project agent and local terminal before writing, and stage provider-specific references before submitting. Keep uploaded files available for asynchronous reads; do not retry uncertain sends automatically.
- Provider histories must resolve an exact discovered pane and session. Validate path roots and cursor project/node/run/source identity. Never scan for the newest conversation as a substitute for provenance.
- Local files, SQLite rows, message parts, response bytes, and subprocess execution must remain bounded. Open provider databases read-only and close handles in `finally`.
- Public conversation turns exclude thinking, tool I/O, injected prompts, local command records, and synthetic API errors. Apply those filters before the public message limit.
- Model and effort are observed effective values. Do not substitute defaults, infer effort from model capability, or use `<synthetic>` as a model. Include regression cases for resumed sessions and long Codex turns.
- Standalone quotas come from bounded provider-native reads in `runtime/connections.ts` (Codex/Claude fixed usage endpoints; version-gated Antigravity `/usage`). Deduplicate and cache reads; keep credentials backend-only. Legacy Orca quotas remain read-only cached `accounts.list` observations.
- GitHub account fallback uses saved `gh` accounts for individual requests. Never switch global auth or put tokens in argv, response payloads, error messages, or deduplication keys; use child-process environment variables and hash credential context for request isolation.
- GitHub pages contain 20 raw upstream entries. Validate activity and bounded page numbers at the HTTP boundary and allowlist only fixed paged endpoint templates. Derive issue continuation before filtering PR entries; subsequent requests fetch only the selected activity.
- Preserve source errors, last-good snapshots, and stale markers. Do not replace unavailable observations with fresh empty data.
