# Backend rules

Read the root AGENTS.md first.

- Keep `index.ts` as the process entry; route/validate in `http/`, access fixed upstream sources in `integrations/`, decode provider formats in `providers/`, and manage snapshots in `services/`.
- Keep tests beside their implementation. Include new suites in the root `npm test` command.
- Collection endpoints remain GET/HEAD only with loopback origin restrictions. Only explicit agent messaging permits POST. No arbitrary executable, flags, RPC method, transcript path, or SQL may come from HTTP input.
- Attachments are validated bytes, never client filesystem paths. Bound file count/size and local storage, verify the exact project agent and local terminal before writing, and stage provider-specific references before submitting. Keep uploaded files available for asynchronous reads; do not retry uncertain sends automatically.
- Provider histories must resolve an exact discovered pane and session. Validate path roots and cursor project/node/run/source identity. Never scan for the newest conversation as a substitute for provenance.
- Local files, SQLite rows, message parts, response bytes, and subprocess execution must remain bounded. Open provider databases read-only and close handles in `finally`.
- Public conversation turns exclude thinking, tool I/O, injected prompts, local command records, and synthetic API errors. Apply those filters before the public message limit.
- Model and effort are observed effective values. Do not substitute defaults, infer effort from model capability, or use `<synthetic>` as a model. Include regression cases for resumed sessions and long Codex turns.
- Quotas come from Orca's cached `accounts.list` read only. Do not expose credentials/account identities or trigger provider polling.
- Preserve source errors, last-good snapshots, and stale markers. Do not replace unavailable observations with fresh empty data.
