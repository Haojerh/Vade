# ADE

### Local workspace controls

**Settings → Voice dictation** selects Browser speech recognition or Local speech. Desktop defaults to Local because Electron does not provide the browser speech service. Choose a microphone and download a speech model once; local recognition then works offline. Toggle/Hold modes use Ctrl+E in the focused Chat composer, and the Dictate button remains available. Final speech is appended to the draft, never submitted automatically. Local audio stays in memory, is bounded to one minute, and is discarded on cancellation or pane changes. Recognition runs in an isolated native process, kept warm for one minute after use. Model downloads use pinned revisions, file sizes and SHA-256 checks, with progress and cancellation. Models are stored in `~/.ade/speech-models` (or `ADE_DATA_DIR`). Model catalogs/configuration were adapted from [Orca](https://github.com/stablyai/orca/tree/main/src/main/speech); its MIT notice is in `docs/licenses/orca-speech-LICENSE.txt`.

The agent composer includes a searchable model picker with provider-reported effort and speed controls. Codex navigates its native model/effort menus and uses session-only settings where offered; Claude uses its native model, effort and fast-mode controls; Antigravity uses its reported model/effort variants. Changes require an idle agent with an empty Terminal prompt, share the input lock with messages and typing, and never retry uncertain input. Current settings remain unknown until observed or acknowledged. See [Antigravity investigation and verification limits](docs/antigravity-chat-controls.md).

Agent completion alerts appear as in-app popups while Vade is focused and native system notifications while the desktop app is in the background or minimized. Click an alert to open its agent. General settings controls completion alerts, system notifications and sound separately. Browser mode requires notification permission (enable it with the System notifications toggle in General settings) and checks for new results in the background while the page remains open. Alerts use fresh observed provider turn completion, never terminal text or process exits; completion does not imply task success. Existing Inbox history is not replayed on startup. Resource Manager process groups start collapsed.

The topology's **Commands** menu saves project-specific terminal commands or agent prompts. Add, edit, remove with confirmation, or drag a shortcut onto a worktree to launch it at that position. Append Enter controls immediate submission; uncertain delivery is never replayed. Codex launches use inline mode to preserve terminal scrollback.

The bottom-right bar includes **Ports**, **Keep computer awake**, and **Resource Manager** (click RAM). Keep-awake offers On, Agent and Off, also in General settings; Agent mode requires observed working status. Native blockers are released when Vade exits. Resource details group observed process memory, private memory and sampled CPU by owned session and Vade; standalone web mode excludes browser processes. Ports groups owned project shell/development servers separately from external listeners; coding-agent RPC and service ports count as external. It opens loopback URLs, copies URLs, and confirms process termination. Stopping requires fresh ownership and process-start identity; external or unverified listeners cannot be stopped. Windows exposes that identity; platforms without it retain read-only port controls.

History reuses a bounded saved index across restarts while refreshing changed transcripts in the background. Initial reads use skeleton rows, and refreshes preserve the previous list.

### Agent session history

The right sidebar switches between Source Control and Agents. Agents indexes local Codex, Claude Code and Antigravity transcripts, with Workspace, Project and All scopes, search, project totals, public message previews/counts, observed models and last-interaction times. Expand a session to resume manually in the selected worktree, or drag a stopped session onto a graph worktree and drop on **Move here**. This reuses its exact provider identity and moves its Vade workspace association; it does not move project files or rewrite transcripts. A session running in another Vade worktree must be stopped first.

Discovery is cached for 30 seconds and bounded to 20,000 directory entries, 2,000 newest transcript files and 64 MiB of new reads per scan. Each transcript reads at most 4 MiB, retaining its beginning and newest end for large files. Truncated counts show +. Project badges show matching / project totals when a scope or search narrows the list. Provider read failures appear as warnings. Only public conversation turns enter previews; tools and thinking are excluded. Antigravity workspace attribution uses exact saved conversation IDs from native history/cache metadata or Vade's owned session records.

APIs: `GET /api/agent-history` accepts bounded scope/projectId/worktreeId/search/offset/refresh queries. `POST /api/projects/:projectId/resume-history` accepts only an opaque indexed sessionId and a discovered worktreeId. The backend revalidates source identity before using fixed provider resume arguments, uses the selected worktree as cwd and refuses duplicate live writers.

### Workspace explorer and editor

Open **Explorer** (folder icon) in the right sidebar and select a project worktree. **Names** filters the folder tree; **Contents** groups highlighted matches by file with case, whole-word, regex and include/exclude filters. The options menu controls dotfiles/ignored files and opens the discovered worktree in VS Code or the system file manager. Native ripgrep accelerates searches when installed; name indexes and directory data are bounded and cached.

Files open in a locally bundled Monaco editor with find/replace, undo/redo, multi-cursor, syntax highlighting and **Ctrl/Cmd+S**. Project diagnostics are disabled because this surface does not load the project's language-server context. Git diff supports editable split/inline views and previous/next change navigation, preserving the source editor's undo history. Git baselines load only for changes view. Markdown opens in an editable Tiptap view with formatting controls, lists, task lists, tables, links and code blocks; Code mode preserves source syntax. Large Markdown files and documents with embedded HTML/frontmatter use source editing to avoid lossy conversion. Image references remain inert.

**Settings → General → Editor autosave** controls idle/blur saves (on by default). There is no Save button or shortcut footer. Version-checked atomic saves reject stale edits; closing or reloading unsaved files asks before discarding them. File reads and cached reopen are independent of Git-baseline reads. Text files are limited to 2 MiB; symlinks, private runtime data, Git metadata and binary files are not editable. Loading uses the shared skeleton and reduced-motion fallback.

### Workflow / Organization

Settings → Installation / Setup installs and verifies Vade's bundled CLI and both orchestration skills. With Workflow disabled, ask an agent to spawn workers with a requested provider/model and task; that contacted agent defines and coordinates the team through the CLI without changing Settings. New or resumed agents receive the private CLI environment. Independent parallel work uses isolated Git worktrees; shared checkouts run workers sequentially.

With Workflow enabled, new task submissions require explicit confirmation to use the saved provider/model/effort graph. Chat offers **Continue with workflow** or the user can disable Workflow in Settings. Agents cannot disable it through the CLI. Raw terminal typing and approval/question answers remain direct input. Mode is off by default.

Workers explicitly report results; dependency stages cannot start from a terminal exit or a provider turn ending. Shared work is serialized. Optional Isolated Worktrees lets the orchestrator split two or more independent workstreams, then integrate committed changes through a separate integration checkout before updating the source. Conflicts pause execution and preserve work. The settings run list shows plans, results and cancellation. No Orca process/service is required. See [execution protocol, limits and architectural references](docs/workflow-runtime.md).

### Agent settings, Inbox and attention prompts

Settings → Agents configures the default agent, enabled launchers and per-provider permission mode. Preferences are stored in the local SQLite registry and apply to new/resumed sessions; live processes keep their launch flags. Manual uses provider permission prompts; Codex Auto uses `--approve-for-me`, Claude Code Auto uses `--permission-mode auto`, and Yolo uses their permission-bypass flags. Antigravity supports Manual and Yolo here; Auto is explicitly unavailable. These fixed mappings follow the [Orca TUI permission table](https://github.com/stablyai/orca/blob/main/src/shared/tui-agent-permissions.ts). No client command strings or arbitrary flags are accepted.

Inbox stores up to 200 observed completed, failed and interrupted agent turns across projects, survives restarts, and retains browser-local handled/unread controls. “Turn completed” describes the provider returning a turn result, not task success. Text, tool failures and process exits do not create results, and these turn observations cannot complete Kanban tasks as explicit task successes.

Question and Approval badges distinguish waiting attention. In Chat, recognized numbered single-choice prompts expose their current options; supported Other rows accept free text. Answers go once to the exact owned terminal under the existing input lock, fenced to the current prompt and launch. Stale cards, changed terminal input and duplicate answers are rejected. Approval cards show bounded visible command context. Authentication, multi-select and unrecognized native dialogs keep an explicit Open Terminal fallback. No answer is automatically retried or treated as proof that the agent resumed.

RAM includes backend/desktop processes, owned terminal helpers, agent processes and their descendants. A bounded OS process snapshot sums each PID once, with a five-second cache; browser memory is excluded in web mode. If process enumeration fails, the tooltip explicitly identifies the smaller backend/desktop-only fallback.

Agent preferences save automatically. The settings page groups detected agents separately from agents requiring installation and displays the fixed permission-mode command. Terminal reattachment restores a bounded current-screen checkpoint before streaming new output; clipboard shortcuts use native clipboard text and xterm bracketed paste. Handled Inbox results can be cleared locally.

New standalone APIs: `GET/POST /api/agents/settings`, `GET/POST /api/projects/:projectId/nodes/:nodeId/interaction`, observed-turn `GET /api/inbox`, and process-tree `GET /api/resources`. All preserve loopback origin checks and server-side validation.

Standalone local agent development environment for the browser and Electron desktop. The production entry uses ADE's own runtime; Orca does not need to be installed or running.

## Standalone v1 increment

- Register local Git repositories in ADE's SQLite registry.
- Discover and create real Git worktrees, rename display names and inspect commit history.
- Launch installed Codex, Claude Code and Antigravity (`agy`) in managed interactive terminals.
- Type prompts, answer authentication/permission prompts, resize and close sessions.
- Retain GitHub activity through authenticated `gh`.

**Chat supports messages, attachments and browser dictation for Codex, Claude Code and Antigravity.** Messages are staged into the exact owned terminal and submitted once, with no automatic retry. Working agents accept follow-ups through their own terminal queue. Authentication and permission prompts stay in Terminal; stopped sessions or agents awaiting input refuse Chat sends. Antigravity's native composer footer establishes readiness before its first conversation hook; missing lifecycle status alone does not block the first prompt or become a fabricated agent state. Finish provider authentication/setup in Terminal when needed. Attach up to eight files, 5 MiB each and 20 MiB combined; images become native attachment chips for Codex/Claude, while Antigravity receives file mentions. Uploads stay in ADE's bounded attachment store for asynchronous reads and expire after 24 hours. Dictation appends final speech to the draft without sending; it requires browser speech recognition support and microphone permission, and reports unsupported speech services explicitly, including desktop runtimes without one.

Codex and Claude Code history requires matching session and workspace metadata. Antigravity history requires its exact hook-bound conversation, a matching trajectory database and a vendor transcript log. Chat opens at the newest 20 public turns, loads older turns on demand, and receives bounded two-second live updates. Tool output, thinking and injected messages are excluded. Missing evidence is explicit. New Codex and Claude Code agents have persisted session bindings; Antigravity acquires its binding from a provider conversation hook. Bound sessions support recovery after an ADE restart; older unbound sessions cannot resume automatically. Terminal bytes never become structured chat. Agent state remains unknown without provider evidence; process exit never implies task success. Task outcomes, automatic Kanban dispatch, orchestration, PR/issue worktree sources and setup hooks remain unsupported.

### Start web or desktop

Opening a stopped, bound terminal automatically attempts recovery once. Failed recovery stays visible and requires an explicit retry; intentional exits while the terminal is open do not trigger a restart loop. Chat/Terminal uses a single view toggle, and terminal status appears beneath the terminal.

Requirements: Node.js 22.13+ with `node:sqlite` (Node 24 recommended), Git on PATH, and the desired agent CLIs installed/authenticated. GitHub panels optionally use `gh`.

```sh
npm install
npm run dev
```

Open **https://127.0.0.1:5173**. In Projects, add an absolute local Git repository path. Inspect its worktree, choose **Add Agent**, then open the agent's Terminal.

- Production web: `npm run build`, then `npm start`; open **http://127.0.0.1:4317**.
- Desktop: `npm run desktop`. Electron builds and starts the same frontend/backend. Stop a separately running ADE backend first; both use port 4317 and desktop refuses collisions. Its renderer is sandboxed, isolated and has Node integration disabled.
- Unpacked desktop distribution: `npm run package:desktop`, output in a timestamped folder under `release/` so running copies are not overwritten. Installers, signing, updates and cross-platform verification are not included yet. Development is on Windows.
- Checks: `npm test` and `npm run build:desktop`.

### Standalone storage and architecture

Metadata lives at `~/.ade/ade.sqlite`; new checkouts live under `~/.ade/worktrees/<project-id>/`. Set `ADE_DATA_DIR` to override. Web and desktop share storage by default. Session records survive restarts; live processes and bounded scrollback do not. Resume a stopped bound session from its Terminal; closing its tab removes that ADE recovery entry. Closing desktop closes owned terminals. Permission preferences initially retain the existing Yolo behavior; Settings → Agents changes the fixed launch mapping for new and resumed sessions. Authentication and workspace/hook trust remain native provider requirements. Already-running terminals retain their launch settings until restarted/resumed. Terminal lifecycle events immediately publish a fresh project snapshot so resumed cards return to live without waiting for the periodic refresh.

Codex binding uses fixed local app-server methods (`initialize`, `thread/start`, `thread/name/set`, `thread/read`) without submitting a model turn. ADE saves the returned UUID and starts `codex resume <exact-id>`. Recovery checks the saved thread ID and working directory and refuses duplicate starts. It never uses `--last`, guesses from terminal text, scans other conversations, or accepts a client-supplied thread ID. A Codex installation that cannot establish this binding reports an explicit startup failure.

Claude Code starts with a generated `--session-id` and recovers with `--resume <exact-id>`. Antigravity's `ade-session-identity` bundle is installed alongside existing hooks in `~/.gemini/config/hooks.json`, with a backup before the first change. The bounded hook records only `conversationId` after checking its launch token and workspace; it does not retain prompts or change tool permissions. Recovery uses `agy --conversation <exact-id>`. An empty Antigravity terminal needs a provider conversation event before it can recover. Claude command contracts are tested; live Claude verification requires a local Claude Code installation.

Terminal output and input use a persistent, origin-checked WebSocket. Output is delivered on PTY events in bounded chunks with renderer acknowledgements; input is batched for 4ms and never replayed after uncertain delivery. xterm uses WebGL where available and its default renderer otherwise. This replaces the previous 200ms output polling and per-keystroke HTTP requests.

Agent activity uses exact-session provider hooks and root OSC 7501 reports from Codex and Claude Code. An untouched session is Idle; a provider-reported return to idle after activity ends the turn as Completed. Explicit provider errors show Failed. Interrupted requires a provider cancellation hook, or an Escape during work followed promptly by native idle/interrupt confirmation; input alone does not establish an outcome. Outcomes persist until new activity. Antigravity's fully idle Stop ends a turn, including `NO_TOOL_CALL`; late bookkeeping cannot restart it before the next invocation. Codex reports update while hooks await normal trust. Missing evidence stays unknown; terminal exit never establishes an outcome. Hooks retain only status metadata, preserve existing settings with a backup, and use fresh launch tokens to reject pre-resume events. Start or resume a session to load the hooks. Status changes publish snapshots immediately, and confirmed terminal liveness changes refresh the card without a manual page refresh. A completed turn does not mark a Kanban task successful. Claude Code behavior is fixture-tested; a live smoke check requires a local installation.

Worktree deletion refuses main, locked or dirty checkouts and open ADE sessions. It never forces removal or deletes branches. No project action pushes or creates a PR.

Use the trash icon beside a project to delete its ADE registration after confirming. Close its agent tabs first. Project folders, files and Git worktrees remain on disk.

`server/runtime/` owns SQLite (`store.ts`), bounded Git (`git.ts`), fixed provider discovery and PTYs (`sessions.ts` with isolated `ptyHost.cjs` helpers), and graphs (`localRuntime.ts`). `server/http/localRoutes.ts` owns standalone API routing. `RegisterProject.tsx` provides onboarding; `AgentTerminal.tsx` provides ordered input and explicit reconnect without input replay. `desktop/main.cjs` owns the desktop renderer/backend lifecycle. Shared contracts remain in `shared/contracts.ts`.

Legacy Orca adapters and regression tests remain during migration. Standalone routes never fall back to Orca. HTTP input cannot select arbitrary executables or launch flags; terminal input goes only to a selected owned process.

The MIT-licensed [Orca source](https://github.com/stablyai/orca), snapshots `411b5c024abef11dcc269779377bc7d3aefa897c` and `45ee56e1a54bd032ce5bf7bda0c4bc8c9a02f307`, is a provider integration and terminal rendering reference. ADE uses original runtime code and adopts bounded output delivery, render acknowledgements, accelerated rendering, guarded sends and provider-specific attachment staging. Conversation history uses exact persisted bindings and validated provider transcripts.

---

## Legacy Orca dashboard reference

The following describes the retained Orca adapter implementation, not the standalone launch above.

A local dashboard for inspecting Orca multi-agent workflows, worktree relationships, agent and terminal execution, and associated GitHub repository activity, with explicit messaging to agents.

The dashboard runs locally alongside the user's installed Orca runtime. It displays projects, worktree groups, orchestrators, worker agents, task progress, bounded activity feeds, and GitHub pull requests, commits, and issues.




**Inbox** in the top bar collects observed agent completions and structured task results across projects. It refreshes every 30 seconds while the page is visible, retains up to 200 results in backend memory, and checks at most 10 recent runs. Unavailable or bounded sources are labeled. Click a result or **Mark all handled** to clear unread markers; handled IDs persist in browser local storage. The separate arrow opens the exact agent's node details without handling its result; it is disabled when the agent is no longer available. A red project edge marks an unhandled explicit failure from the last 24 hours, until handled or superseded by a newer success for that agent/run. Message text, individual tool/test failures, and disconnected terminals do not imply a failed task. Task outcomes come from Orca's structured `worker_done --outcome succeeded|failed` reports.

**Settings â†’ Live Tool Nodes** (enabled by default) shows tool-call labels near their agent with a green connector and one delivery packet. Claude, Codex, Pi, OMP, OpenCode, Kilo Code and Antigravity use exact pane/session bindings from Orca hooks. Collection is bounded to recent transcript records or database parts; calls outside that window or without an exact session cannot be displayed. Antigravity reads tool-call metadata from the bound conversation's protobuf database, verifies its cascade ID, and scans at most 200 recent steps within an 8 MiB page budget. Initial history establishes a baseline rather than replaying old calls. Edit hovers show bounded red/green previews from recorded patch or replacement arguments, with a file path and line number or patch context when available. Previews cover at most two files/chunks and 16 lines per preview; they describe the recorded request, not confirmed application success. Calls without edit text retain the path-only view. Tool output, reasoning, and read-file contents are excluded. Motion respects reduced-motion preferences.

Blue orchestration packets represent newly observed Orca CLI toolkit mailbox messages in the associated run, including replies in the reverse direction. Working state alone never emits packets. The adapter reads bounded message metadata from Orca's local database in read-only mode; unsupported schemas or unresolved endpoints produce no inferred packets.

Live tool cards use neutral colors, avoid other worktrees and keep stable placement while visible. Green connectors route around occupied worktrees with rounded bends and use the same one-shot packet component as blue orchestration connections. Hover or focus a card for a bounded full command/path (up to 2,000 characters) and its observed timestamp; the card stays visible while its details are open.

For Kilo/OpenCode on Orca versions without provider hooks, tool collection accepts a provider-prefixed live terminal title only when exactly one database session matches that full title and the discovered checkout directory. Custom display names, fuzzy titles, truncated titles, and ambiguous matches do not select a session. Tool collection runs even if the agent's model is already known; `kilo` and `kilocode` hook identities are treated as aliases.

Create worktrees with **Add Worktree** beside Reset Layout or by right-clicking empty topology space. The dialog supports a name, branch/PR/issue source, optional installed agent, setup policy, and Create more. It creates an independent worktree in the selected Git project using Orca's repository default base unless a base is supplied. Open Inspect Worktree and use its edit icon to rename the display name; the checkout path and Git branch stay unchanged.

New worktree groups appear in a free area of the current topology viewport when they fit. Placement respects the current scroll position and existing groups, and persists like a manually dragged position. If the viewport is full or the new group is too large, it is placed in the nearest free area and the canvas scrolls to reveal it. Initial loading and reconnecting existing worktrees preserve their layout.

Both agent dialogs share a searchable picker with provider icons. Its installed choices come from host detection in `server/integrations/agents.ts` through `/api/agents/catalog`; the frontend has no hardcoded installed-agent fallback. Detection failures expose retry controls.

The GitHub sidebar always shows repository activity. For checkout-specific commits and pull requests, open **Inspect Worktree â†’ Branch History**. That section loads on expansion and reuses the activity panel and pagination logic; issues remain in the repository sidebar. Branch history includes inherited ancestors, not just commits created after the checkout was made. Create Worktree initializes its optional agent from Orca's active-profile default, and preserves manual selections.

**Settings â†’ Commit Graph History** shows colored branch and merge lanes in the Commits tab and is enabled by default. Saved preferences persist locally. History reads up to 200 local Git commits, including unpushed commits, without requiring GitHub authentication; repository scope includes all local refs and worktree scope follows that checkout's HEAD. Expand a commit for its hash, author and date. Refresh and retry are explicit; no Git fetch is performed.

New local commits turn the Commits count orange and show a bell on unread rows. Tracking persists per project/repository/worktree/branch; the first successful load establishes a baseline. Clicking a commit clears only that commit in both graph and list views, including after refresh or reload. The graph refreshes every minute even while another activity tab is selected, and the GitHub Activity refresh button reloads it immediately.

Worktree actions use `POST /api/projects/:projectId/worktrees` and `POST /api/projects/:projectId/nodes/:nodeId/rename-worktree`; local commit history uses `GET /api/projects/:projectId/commit-graph` with an optional discovered worktree `nodeId`. Repository and checkout selectors come from project discovery, with fixed allowlisted command arguments.

## Quick Start

Start Orca, then run these commands from the project directory:

```sh
npm install
npm run dev
```

Open **https://127.0.0.1:5173** and select an Orca project. For GitHub activity, install the GitHub CLI and run `gh auth login` first. GitHub authentication is separate from Orca's provider accounts.

## Prerequisites

The prerequisite gate verifies that the Orca desktop application is installed and running, the CLI is available on `PATH`, and required agent skills are installed. Checks continue every 3 seconds while the dashboard is open, with an immediate recheck when the window regains focus or the tab becomes visible. Failed checks return to the gate; recovery unlocks and refreshes the dashboard. Checks never overlap, and detection time includes the upstream CLI response time. If Orca is closed, launch the Orca desktop application on your computer to unlock the dashboard.

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
- **Vite Development Server**: `https://127.0.0.1:5173` (configured with `strictPort: true` and proxies `/api` requests to port `4317`)

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

# Start Vite frontend dev server (https://127.0.0.1:5173)
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
- Collection never creates runs or changes task status. With Workflow disabled, the composer sends directly to the selected agent, which may use its private CLI for explicitly requested delegation. With Workflow enabled, confirmed new task submissions start the saved graph.
- **Provider usage**: The bottom of the left sidebar shows compact usage percentages; clicking opens quota windows, model pools, and reset times. `/api/usage` reads Orca's local `accounts.list` snapshot with `refreshUsage: false` over its authenticated local pipe/socket. Only normalized quotas reach the browser; account credentials and identities are omitted. Reads are capped at 1 MiB, time out after 5s, and are cached for 10s. The UI rereads every minute, independent of project switches; Orca owns provider polling. Missing or failed observations stay unavailable or stale.

### Polling Cadence & Freshness
- While subscribed, the backend snapshot manager checks for graph updates every 3 seconds. Collection duration and cached upstream reads can delay visible changes.
- The client receives snapshot updates via Server-Sent Events (`/api/projects/:projectId/events`) or falls back to snapshot polling every 5 seconds (`/api/projects/:projectId/snapshot`). GitHub activity refreshes every minute.
- **Polling is not instantaneous**: Displayed nodes, states, and activity represent periodically sampled evidence from the underlying CLI, marked with explicit source collection timestamps (`observedAt` / `attemptedAt`) and stale indicators.

### Graph & Node Details
- **Agent chat metadata**: The agent-details composer displays the observed model and effort as read-only text. There are no model, effort, or speed pickers and no settings requests when the composer opens. Unknown values are omitted.
- **Live conversation**: The agent overlay receives public transcript turns through SSE, backed by bounded two-second source reads. Reconnects resume with a forward cursor and deduplicate stable message IDs, while older history keeps its separate Load more cursor. Reading earlier messages preserves the scroll position; viewers near the bottom follow new turns. Hidden pages pause the stream. This observes recorded turns rather than guaranteeing token-by-token output.
- **Kanban**: Open Kanban in the topbar to manage a project-specific centered modal: To-do (blue), Pending (orange), Completed (green), and Failed (red). Escape, the close button, or a backdrop click dismisses it without resizing the topology. During a card drag, the modal temporarily reveals the topology for dropping onto an agent. Add a title, prompt, and optional pasted/uploaded attachments, then drag a To-do or Failed card onto an agent to open its composer with the prompt and attachments. Review or edit them, then click Send to dispatch; dropping alone never sends or changes the card status. Click any card (or press Enter/Space) to view its complete task details, attachment previews, status and assignment. Assigned tasks offer an Open agent action. Failed tasks can be reassigned for a fix. Cards and attachment bytes persist in this browser's IndexedDB, separately from Orca tasks; removing cards or clearing the board does not cancel agents.
- **Board outcomes**: Dispatch moves cards to Pending. The board observes an agent working and then explicitly completing/failing, or a fresh timestamped Inbox agent result after dispatch (including work completed between polls). Old results, stale sources, tool failures and message text do not count. One board task may be active per agent. Status checks run while the app is visible and resume after reload; unavailable evidence leaves a card pending. Delivery uncertainty is shown without automatically resending.
- **Mobile controls**: The topbar separates project/actions from the full-width run picker, with compact icon controls and touch-sized targets. Pinch with two fingers anywhere on the Project topology to zoom around their midpoint; starting a pinch cancels node/background dragging and suppresses the gesture's accidental tap. Mouse wheel/touchpad zoom and existing one-finger dragging remain available.
- **Topology**: Compact agent cards sit inside worktree boxes; orchestrators sit outside. Terminal and shell nodes are excluded from the rendered graph. Relationships use one idle/active path, with blue delivery animation on active paths.
- **Stable ordering**: Worktree groups are sorted by normalized path, and agent cards by stable node identity, so changes in inventory order or activity do not rearrange them.
- **Orchestrators**: A coordinator appears when Orca records it in a run. Sending a prompt directly to a terminal does not create a coordinator or a structured run.
- **Status & Liveness**: Distinguishes agent state (`working`, `waiting`, `blocked`, `completed`, `failed`, `idle`, `unknown`) from raw workspace statuses and terminal process liveness (`live`, `exited`, `unverifiable`).
- **Node Details**: Selecting an agent opens a conversation-focused animated modal with provider identity and a message composer. Agent/user turns appear left/right with Read More for long messages. Worktrees show Status & Workspace facts and branch history. On mobile, the close button stays in the header's top-right corner.
- **Conversation Sources**: Codex, Claude, Pi/OMP and Antigravity history uses read-only provider logs resolved through exact Orca session metadata. OpenCode and Kilo-compatible SQLite readers require an exact provider session ID; they never guess sessions by recency. The view opens at the newest messages and loads 20 older public turns at a time when scrolling to the top or selecting **Load more**. Older pages prepend without shifting the reading position, are deduplicated by message ID, and remain bound to project/node/run/source. Refresh starts again at the newest window. Reads remain bounded; tool/thinking records are excluded before the chat limit. Missing provider logs remain explicitly unsupported.
- **Dictation**: The agent-details composer has a Dictate/Stop microphone control using the browser's Web Speech recognition service, not Orca's local speech models. Audio may be processed by the browser vendor. Final speech appends to the existing draft without sending; interim words remain a preview. Recording stops on close, node/run changes, page hiding, or after 60 seconds. Use a supporting browser on HTTPS or localhost; insecure mobile LAN URLs cannot enable dictation. Microphone permission, unavailable-service, and network errors keep the draft intact.
- **Model and Effort**: Cards show known effective launch/session values, including proven original launches for reused workers. Claude reads recorded model/effort from real assistant turns; Codex searches a bounded larger window when long tool output pushes turn settings outside the small tail. Unavailable values are omitted rather than inferred from requested defaults.
- **Latest message**: Hovering an agent previews its latest public message; node details provide paginated, formatted conversation history.
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
- Pagination requests use `activity=commits|prs|issues&page=N` on the GitHub endpoint, with pages bounded to 1â€“10000. The response includes per-activity `pagination.nextPage` values. Counts describe loaded results rather than a separately fetched repository total.
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
- **Usage does not change immediately**: Standalone ADE caches provider quota reads for up to one minute. Missing or stale readings remain explicit. Legacy Orca adapters continue to read Orca's cached snapshot.

### Standalone connections and status bar

Settings > Integrations detects GitHub CLI installation and authentication, with official installation links, native sign-in instructions and re-check. Settings > AI Provider Accounts supports separate Codex/Claude profiles: Add account starts native browser OAuth, then select the saved profile or System default for usage. Sign-in expires after ten minutes; an explicit sign-in button retries failed attempts. Hover a saved profile to delete it with confirmation. Deleting the selected profile returns usage to System default. Profiles live under `~/.ade/accounts/<provider>/<id>`; metadata and selection live in SQLite, not credentials. Profile directories are private (0700 on Unix; user/SYSTEM ACL on Windows). Codex profiles use its file credential store; native provider CLIs write authentication. Selection invalidates quota caches and never switches running agents. Windows, WSL and remote hosts have separate logins.

Add New Agent also offers Terminal, using detected PowerShell on Windows or Bash on Unix. Cards display the last observed shell command; hovering shows bounded recent terminal output separately from agent conversation history. Terminal sessions do not report task outcomes or resume provider conversations.

Terminal previews use a bounded headless xterm screen to resolve cursor movement and redraws. The backend answers terminal queries once, so opening a renderer cannot replay old query responses into the agent or shell. Stopped shell tabs reopen automatically once when opened, in their registered working folder; prior commands, shell variables and exited processes are not restored. A shell that exits again is not restarted in a loop. Agent processes that exited during the current backend lifetime require explicit Resume; automatic agent recovery applies only after backend restart. Antigravity recovery requires an exact saved conversation database. Before its first reported conversation ID, chat explains how to establish history instead of showing a transcript failure.

The usage refresh button requests a fresh native quota read (`GET /api/usage?refresh=1`), bypassing the normal quota cache while sharing in-flight requests. Background polling remains cached and failed reads preserve the last good quota observation.

Native chat also displays recorded commands and tool calls in chronological order beside public turns. Edit previews open by default, with Show more/Show less; other tool disclosures begin collapsed. Diffs contain bounded recorded edit arguments, not current file contents or inferred execution results.

The bottom bar reads subscription quotas from fixed Codex and Claude usage endpoints and Antigravity's structured `/usage` command (agy >= 1.1.11). Reads are bounded, deduplicated and cached. Failed reads retain stale observations. Claude supports credentials-file OAuth logins; keychain-only and API-key accounts may not expose subscription quotas. No credentials are sent to the frontend.

Desktop RAM sums Electron-reported process working sets, excluding agents. Web reports backend resident memory as Server RAM, excluding browser and agent processes. Read-only endpoints are `GET /api/connections`, `GET /api/usage` and `GET /api/resources`, under the existing loopback and origin checks.

Provider quota contracts were adapted from [Orca](https://github.com/stablyai/orca); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Unread markers disappear**: They are stored in browser local storage. Use the same browser profile and origin; `localhost` and `127.0.0.1` have separate storage. Clearing site data resets notifications.
- **Port already in use**: Stop the process using port `4317` or `5173`, then restart. The development frontend requires port `5173` and will not silently select another port.
- **Phone or another computer cannot connect**: Both servers bind to loopback and permit only local origins. Remote access requires additional networking and origin configuration; it is not enabled by this setup.

### Additional coding agents

CodeBuddy, OpenCode, OpenCode 2 and Kilo Code are supported by the standalone launch, status, history, resume and message paths. See [provider capabilities and limits](docs/additional-providers.md) for attachment transport, native sign-in and configuration details, including the OpenCode 2 runtime verification limits.
## Session handoff

Use **Hand Off** in an agent overlay to continue in a fresh agent session in the same worktree. Choose Focused handoff or Full session transcript. The original session stays unchanged. If native setup is needed, finish it in Terminal and select **Send handoff context**. Uncertain sends are never repeated automatically. See [session handoff](docs/session-handoff.md).

## Desktop updates

Settings → **Installation / Setup** starts with the desktop version and update check. Packaged apps check `Haojerh/ADE` GitHub Releases at startup and show a persistent, dismissible update notice. **Update & restart** downloads, installs and relaunches Vade. `npm run package:release` creates update-ready artifacts; the release workflow publishes Windows installers and metadata on matching stable version tags. See [desktop updates](docs/desktop-updates.md) for release requirements.
