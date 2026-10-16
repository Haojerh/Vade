# Orca Visualization

A local dashboard for inspecting Orca multi-agent workflows, worktree relationships, agent and terminal execution, and associated GitHub repository activity, with explicit messaging to agents.

The dashboard runs locally alongside the user's installed Orca runtime. It displays projects, worktree groups, orchestrators, worker agents, task progress, bounded activity feeds, and GitHub pull requests, commits, and issues.

## Quick Start

Start Orca, then run these commands from the project directory:

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173** and select an Orca project. For GitHub activity, install the GitHub CLI and run `gh auth login` first. GitHub authentication is separate from Orca's provider accounts.

## Prerequisites

- **Node.js**: Node.js 22.13+ with built-in `node:sqlite` support.
- **Orca CLI**: Locally installed Orca CLI binary accessible via `PATH` or discovered automatically at `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` (can also be customized via `ORCA_PATH` environment variable). Commands are restricted to an internal allowlist; writes are limited to explicit agent messaging.
- **Git**: Installed `git` binary (can also be specified via `GIT_PATH`).
- **GitHub CLI (`gh`)**: Installed `gh` binary (can also be specified via `GH_PATH`).
  - **Authentication Prerequisite**: Run `gh auth login` in your terminal prior to running the application to grant read access to target repositories. No tokens, secrets, or credential values are configured or exposed in the app. If unauthenticated, GitHub panels report authentication required without failing the Orca graph collection.

## Ports & Localhost Topology

- **Backend API & Production Server**: `http://127.0.0.1:4317`
- **Vite Development Server**: `http://127.0.0.1:5173` (configured with `strictPort: true` and proxies `/api` requests to port `4317`)

## Installation & Commands

Install project dependencies:

```sh
npm install
```

### Development

Run both the backend API server and Vite client concurrently:

```sh
npm run dev
```

Or run each service separately:

```sh
# Start backend API server with watch mode (http://127.0.0.1:4317)
npm run dev:server

# Start Vite frontend dev server (http://127.0.0.1:5173)
npm run dev:client
```

### Type Checking & Build

```sh
# Typecheck TypeScript sources without emitting files
npm run typecheck

# Full production build (runs typecheck and vite build into dist/)
npm run build
```

### Production Start

Build first, then serve the frontend from `dist/` and expose the read-only HTTP API on `http://127.0.0.1:4317`:

```sh
npm run build
npm start
```

### Testing

Run the frontend behavior tests and backend `node:test` suites using `tsx`:

```sh
npm test
```

## System Architecture & Features

### Read-Only Orca CLI Integration
- Executes only fixed, allowlisted read commands, including `orchestration worker-show` for effective launch metadata and `worker-read --source transcript` for supported conversation sources.
- Spawns CLI commands directly with `shell: false`, bounded execution timeouts (8s for Orca, 12s for Git/gh), stdout caps (4 MiB), and global concurrency limits (maximum 3 concurrent processes).
- Collection never creates runs or changes task status. The explicit message composer can send user-authored text and attachments to an agent.
- **Provider usage**: The bottom of the left sidebar shows compact usage percentages; clicking opens quota windows, model pools, and reset times. `/api/usage` reads Orca's local `accounts.list` snapshot with `refreshUsage: false` over its authenticated local pipe/socket. Only normalized quotas reach the browser; account credentials and identities are omitted. Reads are capped at 1 MiB, time out after 5s, and are cached for 10s. The UI rereads every minute, independent of project switches; Orca owns provider polling. Missing or failed observations stay unavailable or stale.

### Polling Cadence & Freshness
- While subscribed, the backend snapshot manager checks for graph updates every 3 seconds. Collection duration and cached upstream reads can delay visible changes.
- The client receives snapshot updates via Server-Sent Events (`/api/projects/:projectId/events`) or falls back to snapshot polling every 5 seconds (`/api/projects/:projectId/snapshot`). GitHub activity refreshes every minute.
- **Polling is not instantaneous**: Displayed nodes, states, and activity represent periodically sampled evidence from the underlying CLI, marked with explicit source collection timestamps (`observedAt` / `attemptedAt`) and stale indicators.

### Graph & Node Details
- **Topology**: Compact agent cards sit inside worktree boxes; orchestrators sit outside. Terminal and shell nodes are excluded from the rendered graph. Relationships use one idle/active path, with blue delivery animation on active paths.
- **Stable ordering**: Worktree groups are sorted by normalized path, and agent cards by stable node identity, so changes in inventory order or activity do not rearrange them.
- **Orchestrators**: A coordinator appears when Orca records it in a run. Sending a prompt directly to a terminal does not create a coordinator or a structured run.
- **Status & Liveness**: Distinguishes agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from raw workspace statuses and terminal process liveness (`live`, `exited`, `unverifiable`).
- **Node Details**: Selecting a card opens an animated modal with provider identity and workspace facts. Agent/user conversation turns appear left/right with Read More for long messages. Worktrees have no conversation section; assigned tasks and terminal samples are not displayed.
- **Conversation Sources**: Supported worker transcripts use Orca's exact source binding. Codex, Claude, Pi/OMP, and Antigravity sessions can use read-only provider logs resolved through exact Orca session metadata. OpenCode and Kilo-compatible SQLite readers require an exact provider session ID; they never guess sessions by recency. Local reads are bounded; tool/thinking records are excluded before the chat limit. The UI requests 20 recent turns, merges newer turns by stable identity, and hides the newer action after an exhausted check. Refresh can discover later messages. Missing provider logs remain explicitly unsupported.
- **Model and Effort**: Cards show known effective launch/session values, including proven original launches for reused workers. Claude reads recorded model/effort from real assistant turns; Codex searches a bounded larger window when long tool output pushes turn settings outside the small tail. Unavailable values are omitted rather than inferred from requested defaults.
- **Latest message**: Hovering an agent previews its latest public message. The node details modal also includes a latest-message card and formatted conversation history.
- **Progress**: The bar measures completed tasks divided by all tasks recorded for the selected run. Failed tasks do not count as completed. It does not estimate agent work or time remaining; incomplete coverage, unknown task states, or no recorded tasks leave the percentage unavailable.
- **Layout and Settings**: Left/right sidebars and the bottom progress/activity panel can be hidden and resized. Settings in the left footer control persistent neutral dark/light themes and optional state card coloring; reduced-motion preferences are respected.

Provider icons, conversation readers, and usage quotas have separate support. An icon does not guarantee conversation or quota availability. Conversation and model metadata require an exact session binding and accessible provider records; effort is shown only when recorded. Usage depends on the quota data exposed by Orca's local account snapshot.

### Agent Messages and Attachments

Both the node-details composer and the inline card composer accept clipboard images, files dropped from Explorer/Downloads, and files chosen with **Attach**. Files show removable previews and are uploaded only when **Send** is pressed. Attach and Send share one action row. Dropping files onto an agent card opens its draft without sending.

- Up to 8 files per message, 5 MiB each, 20 MiB combined. Supported images: PNG, JPEG, GIF, and WebP. Other files are delivered as file references. Browser drags that expose only a remote URL are not downloaded automatically.
- Uploaded bytes are stored in a private temporary directory on the dashboard host; original client paths are never trusted. Storage is capped at 200 MiB/256 files. Files are retained for asynchronous agent reads, and files older than 24 hours are removed on later uploads.
- Delivery requires an exact discovered project agent and a connected local terminal. Remote upload/host transfer is not implemented; WSL path translation is unverified.
- The backend follows [Orca's image paste handling](https://github.com/stablyai/orca/blob/main/src/shared/agent-image-paste.ts): Codex, Claude/OpenClaude, Gemini, Cursor, Copilot, Droid, and Grok receive bracketed raw-path image pastes that their TUIs recognize as attachments. Antigravity, OpenCode/Kilo, Pi/OMP, and other agents receive `@file` references. Actual image understanding depends on the provider, selected model, and file-reading tools. Codex image delivery has been tested end to end; the remaining routes have source and unit-test coverage.
- An attachment-only message is supported. Failed sends preserve the draft. If delivery becomes uncertain after files are staged, inspect the agent before resending to avoid duplicates.

### GitHub Section
- Unread notifications persist locally across page reloads and browser restarts, scoped to their repository and history scope. Clicking an item marks only that item read; switching tabs does not. Clearing browser site data resets this history.
- Inspects repository remotes resolved from local project Git configuration or registered metadata.
- Queries `gh api` for:
  - **Pull Requests**: Recent pull requests with open/closed/merged and draft states.
  - **Commits**: Recent commit history. Handles empty repositories (HTTP 409) gracefully.
  - **Issues**: Recent repository issues, excluding pull requests.
- **Scope**: General uses the repository default branch; worktree scope derives the branch from a discovered worktree. Commits and PRs indicate their branch coverage; issues stay repository-wide. Push events are not displayed.

## Project Structure

```text
shared/contracts.ts          # Normative API types
server/
  index.ts                   # Backend process entry
  http/                      # Read-only routing and request validation
  integrations/              # Orca/CLI, GitHub, and usage adapters
  providers/                 # Exact-session transcripts and model metadata
  services/                  # Snapshot caching and subscriptions
src/
  main.tsx                   # React entry
  app/                       # Dashboard shell and application state
  api/                       # Typed fetch and SSE clients
  features/                  # workflow, github, usage, projects, activity
  components/ui/             # Shared controls
  components/providers/      # Shared Orca provider icons
  hooks/                     # Shared interaction hooks
  styles/                    # Global and message/activity styles
  assets/                    # Attributed provider assets
  tests/                     # Frontend behavior/render tests
scripts/dev.mjs              # Local development launcher
```

## Troubleshooting

- **No projects or runtime unavailable**: Confirm Orca is running and has registered projects. Check that the Orca executable is available, or set `ORCA_PATH` before starting the backend.
- **GitHub authentication required**: Run `gh auth status` and, if needed, `gh auth login` on the same machine and user account that runs the backend.
- **Missing model, effort, or history**: The provider may not have recorded the field, or the dashboard may lack an exact session binding or accessible transcript. Resumed sessions can display metadata when the original session evidence is available.
- **Usage does not change immediately**: The dashboard rereads Orca's cached usage every minute. Its refresh control does not force a provider-side quota request; Orca manages that polling.
- **Unread markers disappear**: They are stored in browser local storage. Use the same browser profile and origin; `localhost` and `127.0.0.1` have separate storage. Clearing site data resets notifications.
- **Port already in use**: Stop the process using port `4317` or `5173`, then restart. The development frontend requires port `5173` and will not silently select another port.
- **Phone or another computer cannot connect**: Both servers bind to loopback and permit only local origins. Remote access requires additional networking and origin configuration; it is not enabled by this setup.
