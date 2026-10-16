# Orca Visualization

A read-only local dashboard for inspecting Orca multi-agent workflows, worktree relationships, agent and terminal execution, and associated GitHub repository activity.

The dashboard runs locally alongside the user's installed Orca runtime. It displays projects, worktree groups, orchestrators, worker agents, task progress, bounded activity feeds, and GitHub pull requests, commits, and issues.

## Prerequisites

- **Node.js**: Node.js 22.13+ with built-in `node:sqlite` support.
- **Orca CLI**: Locally installed Orca CLI binary accessible via `PATH` or discovered automatically at `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` (can also be customized via `ORCA_PATH` environment variable). All Orca interactions are read-only and restricted to a fixed internal command allowlist.
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

Serve the built frontend from `dist/` and expose the read-only HTTP API on `http://127.0.0.1:4317`:

```sh
npm start
```

### Testing

Run backend node:test suites using `tsx`:

```sh
npm test
```

## System Architecture & Features

### Read-Only Orca CLI Integration
- Executes only fixed, allowlisted read commands, including `orchestration worker-show` for effective launch metadata and `worker-read --source transcript` for supported conversation sources.
- Spawns CLI commands directly with `shell: false`, bounded execution timeouts (8s for Orca, 12s for Git/gh), stdout caps (4 MiB), and global concurrency limits (maximum 3 concurrent processes).
- Never performs mutations, sends orchestration messages, creates runs, or modifies runtime metadata.
- **Provider usage**: The bottom of the left sidebar shows compact usage percentages; clicking opens quota windows, model pools, and reset times. `/api/usage` reads Orca's local `accounts.list` snapshot with `refreshUsage: false` over its authenticated local pipe/socket. Only normalized quotas reach the browser; account credentials and identities are omitted. Reads are capped at 1 MiB, time out after 5s, and are cached for 10s. The UI rereads every minute, independent of project switches; Orca owns provider polling. Missing or failed observations stay unavailable or stale.

### Polling Cadence & Freshness
- Graph and runtime status are periodically polled by the backend snapshot manager (e.g., active worktree/agent processes every 3s, run tasks/workers every 5s, metadata and terminal joins every 15s, project inventory every 30s).
- The client receives real-time updates via Server-Sent Events (`/api/projects/:projectId/events`) or falls back to snapshot polling (`/api/projects/:projectId/snapshot`).
- **Polling is not instantaneous**: Displayed nodes, states, and activity represent periodically sampled evidence from the underlying CLI, marked with explicit source collection timestamps (`observedAt` / `attemptedAt`) and stale indicators.

### Graph & Node Details
- **Topology**: Compact agent cards sit inside worktree boxes; orchestrators sit outside. Terminal and shell nodes are excluded from the rendered graph. Relationships use one idle/active path, with blue delivery animation on active paths.
- **Status & Liveness**: Distinguishes agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from raw workspace statuses and terminal process liveness (`live`, `exited`, `unverifiable`).
- **Node Details**: Selecting a card opens an animated modal with provider identity and workspace facts. Agent/user conversation turns appear left/right with Read More for long messages. Worktrees have no conversation section; assigned tasks and terminal samples are not displayed.
- **Conversation Sources**: Supported worker transcripts use Orca's exact source binding. Codex, Claude, Pi/OMP, and Antigravity sessions can use read-only provider logs resolved through exact Orca session metadata. OpenCode and Kilo-compatible SQLite readers require an exact provider session ID; they never guess sessions by recency. Local reads are bounded; tool/thinking records are excluded before the chat limit. The UI requests 20 recent turns, merges newer turns by stable identity, and hides the newer action after an exhausted check. Refresh can discover later messages. Missing provider logs remain explicitly unsupported.
- **Model and Effort**: Cards show known effective launch/session values, including proven original launches for reused workers. Claude reads recorded model/effort from real assistant turns; Codex searches a bounded larger window when long tool output pushes turn settings outside the small tail. Unavailable values are omitted rather than inferred from requested defaults.
- **Layout and Settings**: Left/right sidebars and the bottom progress/activity panel can be hidden and resized. Settings in the left footer control persistent neutral dark/light themes and optional state card coloring; reduced-motion preferences are respected.

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
