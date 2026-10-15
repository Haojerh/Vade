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

### Polling Cadence & Freshness
- Graph and runtime status are periodically polled by the backend snapshot manager (e.g., active worktree/agent processes every 3s, run tasks/workers every 5s, metadata and terminal joins every 15s, project inventory every 30s).
- The client receives real-time updates via Server-Sent Events (`/api/projects/:projectId/events`) or falls back to snapshot polling (`/api/projects/:projectId/snapshot`).
- **Polling is not instantaneous**: Displayed nodes, states, and activity represent periodically sampled evidence from the underlying CLI, marked with explicit source collection timestamps (`observedAt` / `attemptedAt`) and stale indicators.

### Graph & Node Details
- **Topology**: Compact agent cards sit inside worktree boxes; orchestrators sit outside. Terminal and shell nodes are excluded from the rendered graph. Relationships use one idle/active path, with blue delivery animation on active paths.
- **Status & Liveness**: Distinguishes agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from raw workspace statuses and terminal process liveness (`live`, `exited`, `unverifiable`).
- **Node Details**: Selecting a card opens an animated modal with provider identity and workspace facts. Agent/user conversation turns appear left/right with Read More for long messages. Worktrees have no conversation section; assigned tasks and terminal samples are not displayed.
- **Conversation Sources**: Supported worker transcripts use Orca's exact source binding. Codex coordinators and Antigravity sessions can use read-only provider logs resolved through exact Orca session metadata. Local reads are bounded; tool/thinking records are excluded before the chat limit. The UI requests 20 recent turns, merges newer turns by stable identity, and hides the newer action after an exhausted check. Refresh can discover later messages. Missing provider logs remain explicitly unsupported.
- **Model and Effort**: Cards show known effective launch/session values, including proven original launches for reused workers. Unavailable values are omitted rather than inferred from requested defaults.
- **Layout and Settings**: Left/right sidebars and the bottom progress/activity panel can be hidden and resized. Settings in the left footer control persistent neutral dark/light themes and optional state card coloring; reduced-motion preferences are respected.

### GitHub Section
- Inspects repository remotes resolved from local project Git configuration or registered metadata.
- Queries `gh api` for:
  - **Pull Requests**: Recent pull requests with open/closed/merged and draft states.
  - **Commits**: Recent commit history. Handles empty repositories (HTTP 409) gracefully.
  - **Issues**: Recent repository issues, excluding pull requests.
- **Scope**: General uses the repository default branch; worktree scope derives the branch from a discovered worktree. Commits and PRs indicate their branch coverage; issues stay repository-wide. Push events are not displayed.

## Project Structure

```text
├── package.json          # Dependencies and scripts (React 19, tsx, Vite, TypeScript)
├── vite.config.ts        # Vite configuration and /api proxy setup
├── scripts/
│   └── dev.mjs           # Concurrently launches dev server and client
├── shared/
│   └── contracts.ts      # Shared TypeScript data models, error codes, and API contracts
├── server/
│   ├── index.ts          # Server entry point on 127.0.0.1:4317
│   ├── api.ts            # HTTP request router, CORS/origin guard, and SSE handler
│   ├── cli.ts            # Bounded, allowlisted child_process CLI executor
│   ├── orca.ts           # Orca inventory collection and graph transformation
│   ├── github.ts         # GitHub repository remote resolution and gh API queries
│   └── snapshot.ts       # Polling snapshot manager, cache, and SSE subscriber broker
└── src/
    ├── main.tsx          # React application entry point
    ├── App.tsx           # Main dashboard layout and URL state binding
    ├── api.ts            # Client fetch wrappers and EventSource connection
    ├── useDashboard.ts   # Snapshot subscription and selection hook
    └── components/       # UI panels (ProjectSelector, WorkflowGraph, NodeDetails, etc.)
```
