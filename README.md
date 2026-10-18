# Orca Visualization

A local dashboard for inspecting Orca multi-agent workflows, worktree relationships, agent and terminal execution, and associated GitHub repository activity, with explicit messaging to agents.

The dashboard runs locally alongside the user's installed Orca runtime. It displays projects, worktree groups, orchestrators, worker agents, task progress, bounded activity feeds, and GitHub pull requests, commits, and issues.

**Settings → Live Tool Nodes** (enabled by default) shows tool-call labels near their agent with a green connector and one delivery packet. Claude, Codex, Pi, OMP, OpenCode and Kilo Code use exact pane/session bindings from Orca hooks. Collection is bounded to recent transcript records or database parts; calls outside that window or without an exact session cannot be displayed. Initial history establishes a baseline rather than replaying old calls. Tool output, reasoning and file contents are excluded. Motion respects reduced-motion preferences.

Blue orchestration packets represent newly observed Orca CLI toolkit mailbox messages in the associated run, including replies in the reverse direction. Working state alone never emits packets. The adapter reads bounded message metadata from Orca's local database in read-only mode; unsupported schemas or unresolved endpoints produce no inferred packets.

Create worktrees with **Add Worktree** beside Reset Layout or by right-clicking empty topology space. The dialog supports a name, branch/PR/issue source, optional installed agent, setup policy, and Create more. It creates an independent worktree in the selected Git project using Orca's repository default base unless a base is supplied. Open Inspect Worktree and use its edit icon to rename the display name; the checkout path and Git branch stay unchanged.

Both agent dialogs share a searchable picker with provider icons. Its installed choices come from host detection in `server/integrations/agents.ts` through `/api/agents/catalog`; the frontend has no hardcoded installed-agent fallback. Detection failures expose retry controls.

The GitHub sidebar always shows repository activity. For checkout-specific commits and pull requests, open **Inspect Worktree → Branch History**. That section loads on expansion and reuses the activity panel and pagination logic; issues remain in the repository sidebar. Branch history includes inherited ancestors, not just commits created after the checkout was made. Create Worktree initializes its optional agent from Orca's active-profile default, and preserves manual selections.

**Settings → Commit Graph History** shows colored branch and merge lanes in the Commits tab and is enabled by default. Saved preferences persist locally. History reads up to 200 local Git commits, including unpushed commits, without requiring GitHub authentication; repository scope includes all local refs and worktree scope follows that checkout's HEAD. Expand a commit for its hash, author and date. Refresh and retry are explicit; no Git fetch is performed.

New local commits turn the Commits count orange and show a bell on unread rows. Tracking persists per project/repository/worktree/branch; the first successful load establishes a baseline. Clicking a commit clears only that commit in both graph and list views, including after refresh or reload. The graph refreshes every minute even while another activity tab is selected, and the GitHub Activity refresh button reloads it immediately.

Worktree actions use `POST /api/projects/:projectId/worktrees` and `POST /api/projects/:projectId/nodes/:nodeId/rename-worktree`; local commit history uses `GET /api/projects/:projectId/commit-graph` with an optional discovered worktree `nodeId`. Repository and checkout selectors come from project discovery, with fixed allowlisted command arguments.

## Quick Start

Start Orca, then run these commands from the project directory:

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173** and select an Orca project. For GitHub activity, install the GitHub CLI and run `gh auth login` first. GitHub authentication is separate from Orca's provider accounts.

## Prerequisites

The prerequisite gate verifies that the Orca desktop application is installed and running, the CLI is available on `PATH`, and required agent skills are installed. If Orca is closed, launch the Orca desktop application on your computer to unlock the dashboard.

- **Node.js**: Node.js 22.13+ with built-in `node:sqlite` support.
- **Orca Desktop Application**: Locally installed Orca desktop application (available from [https://www.onorca.dev/](https://www.onorca.dev/)). If Orca is not detected on webapp startup, access is blocked and users are directed to download Orca from the official website.
- **Orca CLI (`orca-cli`)**: Locally installed Orca CLI binary accessible via `PATH` or discovered automatically at `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` (can also be customized via `ORCA_PATH` environment variable). If missing, install it through the Orca desktop app (`Settings > CLI`).
- **Orca Orchestration Skill**: Required for multi-agent run and task observation. If missing, install it through the Orca desktop app (`Skills > Orchestration`).
- **Git**: Installed `git` binary (can also be specified via `GIT_PATH`).
- **GitHub CLI (`gh`)**: Installed `gh` binary (can also be specified via `GH_PATH`).
  - **Authentication Prerequisite**: Run `gh auth login` in your terminal prior to running the application to grant read access to target repositories. No tokens, secrets, or credential values are configured or exposed in the app. If unauthenticated, GitHub panels report authentication required without failing the Orca graph collection.
  - **Multiple accounts**: The dashboard tries the active `github.com` account first. On authentication/access failures, it tries other successful accounts already saved in `gh` (up to 10). Credentials are read from `gh` into backend memory and passed only through child-process environments. It never logs out, signs in, or changes the global active account. Tokens never reach the browser. Rate-limit and unrelated server errors do not trigger account fallback.

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
- **Conversation Sources**: Supported worker transcripts use Orca's exact source binding. Codex, Claude, Pi/OMP, and Antigravity sessions can use read-only provider logs resolved through exact Orca session metadata. OpenCode and Kilo-compatible SQLite readers require an exact provider session ID; they never guess sessions by recency. Local reads are bounded; tool/thinking records are excluded before the chat limit. The UI shows the latest 20 public messages without a load-more action. Refresh replaces this window with the latest messages. Missing provider logs remain explicitly unsupported.
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
- Commits, PRs, and issues load in batches of 20, with subsequent pages fetched as you scroll. Loaded history is retained during the minute refresh; historical pages do not create unread notifications. Count badges show loaded items with `+` while more pages are available. GitHub issue pages may contain fewer than 20 issues because PR entries are excluded.
- Additional pages show animated shimmer skeletons while loading, or static placeholders with reduced motion enabled. A **Load 20 more** button also supports manual loading; failed requests retain existing results and offer **Retry loading**. Changing project or scope discards the previous pagination context.
- Pagination requests use `activity=commits|prs|issues&page=N` on the GitHub endpoint, with pages bounded to 1–10000. The response includes per-activity `pagination.nextPage` values. Counts describe loaded results rather than a separately fetched repository total.
- Unread notifications persist locally across page reloads and browser restarts, scoped to their repository and history scope. Clicking an item marks only that item read; switching tabs does not. Clearing browser site data resets this history.
- Inspects repository remotes resolved from local project Git configuration or registered metadata.
- Queries `gh api` for:
  - **Pull Requests**: Recent pull requests with open/closed/merged and draft states.
  - **Commits**: Recent commit history. Handles empty repositories (HTTP 409) gracefully.
  - **Issues**: Recent repository issues, excluding pull requests.
- **Scope**: The sidebar stays repository-wide; GitHub commits use the default branch, or all local refs with Commit Graph History enabled. Inspect Worktree provides checkout-scoped commits and PRs from discovered metadata. Issues stay in the repository sidebar. Push events are not displayed.

## Project Structure

```text
shared/contracts.ts          # Normative API types
server/
  index.ts                   # Backend process entry
  http/                      # Read-only routing and request validation
  integrations/              # CLI, GitHub, agents, worktrees, and usage adapters
    orca/                    # Inventory, graph, node details, actions, and prerequisites
  providers/                 # Exact-session transcripts and model metadata
  services/                  # Snapshot caching and subscriptions
src/
  main.tsx                   # React entry
  app/                       # Dashboard shell and application state
  api/                       # Typed fetch and SSE clients
  features/                  # workflow, github, usage, projects, activity
  components/ui/             # Modal, Popover, ContextMenu, Select, AgentPicker, Disclosure and shared controls
  components/providers/      # Shared Orca provider icons
  hooks/                     # Shared interaction hooks
  styles/                    # Domain stylesheets (tokens, base, layout, workflow, panels, modals, markdown)
  assets/                    # Attributed provider assets
  tests/                     # Frontend behavior/render tests (github, notifications, workflow, dialogsAndUi, commitGraph)
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
