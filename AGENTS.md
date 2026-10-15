# AGENTS.md

Conventions, architecture patterns, and interface contracts for agents contributing to the `orca-visualization` project.

## Project Scope & Conventions

- **Application Type**: Local React 19 + TypeScript frontend with a lightweight native Node HTTP backend.
- **Read-Only Nature**: The dashboard is strictly observational. No mutations, run injections, mail sends, task status modifications, or git pushes are performed.
- **Contract-First Design**: The backend and frontend communicate through normative types defined in [`shared/contracts.ts`](file:///C:/Users/inter/orca/orca-visualization/shared/contracts.ts). Any updates to data models must originate or be mirrored in `shared/contracts.ts`.
- **Zero Raw CLI Passthrough**: The server strictly validates all CLI invocation arguments against an internal allowlist in [`server/cli.ts`](file:///C:/Users/inter/orca/orca-visualization/server/cli.ts). Never accept arbitrary command flags or user inputs as executable commands.
- **Localhost & Origin Constraints**:
  - Backend runs on `127.0.0.1:4317`.
  - Frontend development runs on `127.0.0.1:5173`.
  - CORS and origin checks permit only loopback origins (`127.0.0.1` and `localhost` on ports `4317` and `5173`). Wildcard CORS is prohibited.
- **Truthful Data & Degradation**:
  - No fabricated states, progress estimates, or synthetic orchestrators.
  - Failures in upstream dependencies (Orca CLI or `gh`) are communicated via explicit `Section<T>` envelopes containing `SourceMeta` and `Issue` structures.
  - Distinguish agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from workspace status and terminal process liveness.
  - Push events are finite, bounded historical records (up to 100 entries) from GitHub, not real-time git pushes or whole-history logs.

## HTTP Endpoints & API Contract

Implemented in [`server/api.ts`](file:///C:/Users/inter/orca/orca-visualization/server/api.ts). All requests use `GET` or `HEAD`. Mutation methods (`POST`, `PUT`, `DELETE`, `PATCH`) return `405 METHOD_NOT_ALLOWED`.

| Endpoint | Query Parameters | Response / Behavior | Description |
|---|---|---|---|
| `GET /api/health` | None | `HealthResponse` (`{ status: 'ok', readOnly: true }`) | Process liveness check for backend server. |
| `GET /api/projects` | None | `Section<Inventory>` | Lists registered Orca projects (Git repos and folder workspaces). |
| `GET /api/projects/:projectId/snapshot` | `runId` (optional) | `DashboardSnapshot` | Full project dashboard graph, runtime metadata, nodes, edges, tasks, progress, and activity. |
| `GET /api/projects/:projectId/events` | `runId` (optional) | SSE stream (`text/event-stream`) | Pushes full snapshot updates as `event: snapshot` with `id: <revision>` on collection changes. 15s comment heartbeats (`: heartbeat`). |
| `GET /api/projects/:projectId/nodes/:nodeId` | `cursor` (optional, <= 512 chars), `limit` (optional, 1..200, default 100) | `NodeDetails` | Inspects node metadata, tool invocation, associated tasks, activity, and terminal output sample. |
| `GET /api/projects/:projectId/github` | None | `GitHubData` | Pull requests, commit history, and push events for the resolved project repository. |

## Error Responses

All error payloads conform to `ApiError` from [`shared/contracts.ts`](file:///C:/Users/inter/orca/orca-visualization/shared/contracts.ts):

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

1. **Do Not Touch Production Git Remotes**: Never execute `git push`, create remote branches, or perform PR actions during agent tasks.
2. **Observe Concurrency Boundaries**:
   - Backend files: [`server/`](file:///C:/Users/inter/orca/orca-visualization/server/), [`shared/contracts.ts`](file:///C:/Users/inter/orca/orca-visualization/shared/contracts.ts), [`scripts/`](file:///C:/Users/inter/orca/orca-visualization/scripts/).
   - Frontend files: [`src/`](file:///C:/Users/inter/orca/orca-visualization/src/), [`index.html`](file:///C:/Users/inter/orca/orca-visualization/index.html).
   - Documentation files: [`README.md`](file:///C:/Users/inter/orca/orca-visualization/README.md), [`AGENTS.md`](file:///C:/Users/inter/orca/orca-visualization/AGENTS.md).
   - Shared coordination files: [`.orca/runs/live-dashboard/`](file:///C:/Users/inter/orca/orca-visualization/.orca/runs/live-dashboard/).
3. **Preserve Ongoing Work**: Respect concurrent worker edits and review findings tracked in `.orca/runs/live-dashboard/review-findings.json`.
4. **Lifecycle Communication**: Send timely heartbeats and check the Orca orchestration mailbox at natural task boundaries.
