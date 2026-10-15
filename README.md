# Orca Visualization

A read-only local dashboard for inspecting Orca multi-agent workflows, worktree relationships, agent and terminal execution, and associated GitHub repository activity.

The dashboard runs locally alongside the user's installed Orca runtime. It displays projects, worktrees, orchestrators, worker agents, terminals, task progress, bounded activity feeds, and GitHub pull requests, commits, and push events.

## Prerequisites

- **Node.js**: Node.js runtime supporting ES modules (v20+ recommended).
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
- Executes only fixed, allowlisted read commands (`status`, `project list`, `project setups`, `repo list`, `worktree ps`, `worktree list`, `terminal list`, `terminal read`, `orchestration run-list`, `worker-list`, `task-list`).
- Spawns CLI commands directly with `shell: false`, bounded execution timeouts (8s for Orca, 12s for Git/gh), stdout caps (4 MiB), and global concurrency limits (maximum 3 concurrent processes).
- Never performs mutations, sends orchestration messages, creates runs, or modifies runtime metadata.

### Polling Cadence & Freshness
- Graph and runtime status are periodically polled by the backend snapshot manager (e.g., active worktree/agent processes every 3s, run tasks/workers every 5s, metadata and terminal joins every 15s, project inventory every 30s).
- The client receives real-time updates via Server-Sent Events (`/api/projects/:projectId/events`) or falls back to snapshot polling (`/api/projects/:projectId/snapshot`).
- **Polling is not instantaneous**: Displayed nodes, states, and activity represent periodically sampled evidence from the underlying CLI, marked with explicit source collection timestamps (`observedAt` / `attemptedAt`) and stale indicators.

### Graph & Node Details
- **Nodes**: Worktree workspaces, orchestrators, worker agents, and terminals are organized hierarchically with containment and delegation edges.
- **Status & Liveness**: Distinguishes agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from raw workspace statuses and terminal process liveness (`live`, `exited`, `unverifiable`).
- **Node Details**: Selecting a node inspects associated tasks, active tool invocations (`currentTool`), recent activity, and tail terminal output. Terminal output lines are bounded, sanitized, and labeled with source metadata (e.g. `screen` samples).

### GitHub Section
- Inspects repository remotes resolved from local project Git configuration or registered metadata.
- Queries `gh api` for:
  - **Pull Requests**: Recent pull requests with open/closed and draft states.
  - **Commits**: Recent commit history. Handles empty repositories (HTTP 409) gracefully.
  - **Push Events**: Filtered `PushEvent` items from the repository event feed.
- **Finite Event History**: Push events reflect a finite recent activity window (capped at 100 events by the API) and do not represent complete git audit history or immediate push notifications.

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
