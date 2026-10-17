# AGENTS.md

Conventions, architecture patterns, and interface contracts for agents contributing to the `orca-visualization` project.

## Project Scope & Conventions

- **Application Type**: Local React 19 + TypeScript frontend with a lightweight native Node HTTP backend.
- **Runtime scope**: Collection is observational. The explicit agent-message endpoint may send user-authored messages and attachments to discovered agent terminals. Never create runs or modify task status from the dashboard.
- **Contract-First Design**: The backend and frontend communicate through normative types defined in [`shared/contracts.ts`](shared/contracts.ts). Any updates to data models must originate or be mirrored in `shared/contracts.ts`.
- **Zero Raw CLI Passthrough**: The server strictly validates all CLI invocation arguments against an internal allowlist in [`server/integrations/cli.ts`](server/integrations/cli.ts). Never accept arbitrary command flags or user inputs as executable commands.
- **Localhost & Origin Constraints**:
  - Backend runs on `127.0.0.1:4317`.
  - Frontend development runs on `127.0.0.1:5173`.
  - CORS and origin checks permit only loopback origins (`127.0.0.1` and `localhost` on ports `4317` and `5173`). Wildcard CORS is prohibited.
- **Truthful Data & Degradation**:
  - No fabricated states, progress estimates, or synthetic orchestrators.
  - Failures in upstream dependencies (Orca CLI or `gh`) are communicated via explicit `Section<T>` envelopes containing `SourceMeta` and `Issue` structures.
  - Distinguish agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from workspace status and terminal process liveness.
  - GitHub activity includes bounded commits, pull requests and repository-wide issues. Push events are excluded. Worktree scope must derive branch/path from discovered metadata, never executable user input.
  - GitHub pagination fetches 20 upstream entries per page, independently per activity. Advance issue pages using the raw upstream count before excluding PRs. Bind accumulated pages to project/repository/scope, cancel obsolete requests, deduplicate stable IDs, and preserve loaded history during first-page refreshes.
  - GitHub badges represent loaded items, with `+` while more pages are available; never imply an exact repository total. Historical pages extend notification baselines without creating unread arrivals. Loading uses shimmer skeletons with a reduced-motion fallback and explicit retry after errors.
  - GitHub account fallback is request-local through saved `gh` accounts. Never switch global active accounts or expose tokens through arguments, API responses, logs, or plaintext cache keys.
  - Conversation history contains public agent/user turns only, never tool output or internal thinking. Resolve exact provider/session provenance, bound file reads, and bind opaque cursors to project/node/run/source. Model/effort fields contain observed effective metadata only.

## HTTP Endpoints & API Contract

Implemented in [`server/http/api.ts`](server/http/api.ts). Collection uses `GET` or `HEAD`. Only the explicit agent-message endpoint permits `POST`; other mutations return `405 METHOD_NOT_ALLOWED`.

| Endpoint | Query Parameters | Response / Behavior | Description |
|---|---|---|---|
| `GET /api/health` | None | `HealthResponse` (`{ status: 'ok', readOnly: true }`) | Process liveness check for backend server. |
| `GET /api/prerequisites` | None | `PrerequisitesStatus` | Verifies local Orca installation: desktop application, CLI, and orchestration skill. |
| `GET /api/usage` | None | `Section<UsageData>` | Normalized host-wide provider quota windows and buckets, read from Orca's cached runtime snapshot; no account identities or credentials. |
| `GET /api/projects` | None | `Section<Inventory>` | Lists registered Orca projects (Git repos and folder workspaces). |
| `GET /api/projects/:projectId/snapshot` | `runId` (optional) | `DashboardSnapshot` | Full project dashboard graph, runtime metadata, nodes, edges, tasks, progress, and activity. |
| `GET /api/projects/:projectId/events` | `runId` (optional) | SSE stream (`text/event-stream`) | Pushes full snapshot updates as `event: snapshot` with `id: <revision>` on collection changes. 15s comment heartbeats (`: heartbeat`). |
| `GET /api/projects/:projectId/nodes/:nodeId` | `runId` (optional), `cursor` (optional, <= 512 chars), `limit` (optional, 1..200, default 100; UI requests 20) | `NodeDetails` | Node facts, tool/tasks/activity metadata and a source-bound conversation section. Worktrees and terminal nodes do not expose conversation history. |
| `GET /api/projects/:projectId/github` | `scope=general` (default) or `scope=worktree&nodeId=<discovered worktree node>`; optional `activity=commits\|prs\|issues`, `page=1..10000` (requires activity) | `GitHubData` | Initial 20-entry windows or a selected activity page, scoped coverage and per-activity `pagination.nextPage` values. |
| `POST /api/projects/:projectId/nodes/:nodeId/message` | JSON `SendMessageRequest` | `SendMessageResponse` | User-authored text and optional bounded base64 attachments. Uploads require a discovered agent and a connected local terminal; never accept client-supplied host paths. |

## Error Responses

All error payloads conform to `ApiError` from [`shared/contracts.ts`](shared/contracts.ts):

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Query parameter limit must be an integer between 1 and 200",
    "retryable": false
  },
  "requestId": "uuid"
}
```

Standard error codes:
`INVALID_ARGUMENT` (400), `FORBIDDEN_ORIGIN` (403), `PROJECT_NOT_FOUND` / `RUN_NOT_FOUND` / `NODE_NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405), `RATE_LIMITED` (429), `CLI_MISSING` / `CLI_TIMEOUT` / `CLI_FAILED` / `INVALID_UPSTREAM` / `INTERNAL` (500).

## Development Conventions for Agents

1. **Git scope**: Do not push, create remote branches, or perform PR actions unless the user explicitly requests them. Application runtime code must never perform these actions.
2. **Observe Concurrency Boundaries**:
   - Backend files: [`server/`](server/), [`shared/contracts.ts`](shared/contracts.ts), [`scripts/`](scripts/).
   - Frontend files: [`src/`](src/), [`index.html`](index.html).
   - Documentation files: [`README.md`](README.md), [`AGENTS.md`](AGENTS.md).
   - Shared coordination files: [`.orca/runs/live-dashboard/`](.orca/runs/live-dashboard/).
3. **Preserve Ongoing Work**: Respect concurrent worker edits and review findings tracked in `.orca/runs/live-dashboard/review-findings.json`.
4. **Lifecycle Communication**: Give concise progress updates. Check an Orca mailbox only when working in an explicitly assigned orchestration task.

## Source Layout and Change Rules

- `src/app/`: dashboard composition, selection, subscriptions, and state.
- `src/api/`: typed HTTP and SSE clients; no provider filesystem access.
- `src/features/`: workflow, GitHub, usage, projects, and activity UI with feature-specific helpers.
- `src/components/ui/` and `src/components/providers/`: reusable controls and the shared provider icon system.
- `src/hooks/`, `src/styles/`, `src/assets/`: common hooks, styles, and attributed assets.
- `server/http/`: request validation, routing, loopback/origin constraints, and response envelopes.
- `server/integrations/`: fixed read-only Orca, GitHub, CLI, and usage adapters.
- `server/providers/`: exact-session transcript parsers and effective model/effort readers.
- `server/services/`: snapshot collection, caching, and subscriptions. `server/index.ts` stays the process entry.
- `shared/contracts.ts` stays dependency-free and shared by both layers.
- Keep backend tests next to their modules; frontend behavior/render tests live in `src/tests/`.
- Read the scoped `src/AGENTS.md` or `server/AGENTS.md` before changes in that layer.
- Prefer direct imports. Do not add barrel exports, compatibility forwarding files, or parallel provider registries for routine moves.
- A provider icon does not imply transcript or quota support. Claim support only with exact-session evidence; never choose the newest transcript globally.
- Treat local command XML, synthetic API errors, tool output, and thinking as non-conversation content. Render public text with the shared safe Markdown component.
- Codex settings may precede lengthy tool records: preserve bounded recent-turn lookup and regression coverage beyond the small tail window.
- Run `npm test` and `npm run build` after cross-layer changes or file moves. Update this map, README, imports, asset URLs, and test discovery when paths change.
