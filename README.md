# ADE

### Local workspace controls

The Source Control sidebar supports per-file or all-file stage/unstage, staged commits, commit and push/sync, fetch, publish, push, pull, fast-forward, rebase and force-with-lease push. Click a changed file for its staged or working-tree diff; **View all** opens lazy multi-file review with inline/side-by-side, wrapping and whitespace controls. The options menu switches between list/tree and selects the branch comparison base. Feature branches expose **Create PR** here and in the PR tab, with title/body review before submission. See [Source control](docs/source-control.md).

**Settings → Voice dictation** selects Browser speech recognition or Local speech. Desktop defaults to Local because Electron does not provide the browser speech service. Choose a microphone and download a speech model once; local recognition then works offline. Toggle/Hold modes use Ctrl+E in the focused Chat composer, and the Dictate button remains available. Final speech is appended to the draft, never submitted automatically. Local audio stays in memory, is bounded to one minute, and is discarded on cancellation or pane changes. Recognition runs in an isolated native process, kept warm for one minute after use. Model downloads use pinned revisions, file sizes and SHA-256 checks, with progress and cancellation. Models are stored in `~/.ade/speech-models` (or `ADE_DATA_DIR`). Model catalogs/configuration were adapted from [Orca](https://github.com/stablyai/orca/tree/main/src/main/speech); its MIT notice is in `docs/licenses/orca-speech-LICENSE.txt`.

The agent composer includes a searchable model picker with provider-reported effort and speed controls. Codex navigates its native model/effort menus and uses session-only settings where offered; Claude uses its native model, effort and fast-mode controls; Antigravity uses its reported model/effort variants. Changes require an idle agent with an empty Terminal prompt, share the input lock with messages and typing, and never retry uncertain input. Current settings remain unknown until observed or acknowledged. See [Antigravity investigation and verification limits](docs/antigravity-chat-controls.md).

Agent completion alerts appear as in-app popups while Vade is focused and native system notifications while the desktop app is in the background or minimized. Click an alert to open its agent. General settings controls completion alerts, system notifications and sound separately. Browser mode requires notification permission (enable it with the System notifications toggle in General settings) and checks for new results in the background while the page remains open. Alerts use fresh observed provider turn completion, never terminal text or process exits; completion does not imply task success. Existing Inbox history is not replayed on startup. Resource Manager process groups start collapsed.

Inbox handled state and GitHub/local Git unread state are stored in Vade's local backend, so desktop, browser and phone views share the same badges and clear actions. Existing browser-local notification state is imported once; notification sync failure is shown with an explicit retry action.

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

### Automatic Kanban

Enable **Settings → Workspace → Automatic Kanban** (off by default); the board provides a direct Settings link. When adding a task, choose **Assign later**, an **Existing agent**, or a **New session** with a detected provider and worktree. Assigned tasks wait in creation order for an empty native agent prompt; busy/stopped agents and occupied worktrees keep work queued. New sessions use the saved agent permission settings. Finish native setup/trust prompts in Terminal. Turning the setting off pauses queued work without interrupting submitted tasks.

The queue and attachments stay in this browser's IndexedDB and run while Vade is open, including when the board is closed. A single dispatcher coordinates windows on the same origin. Assignment and session-launch claims are saved before dispatch; uncertain sends/launches are never automatically repeated. Task details can remove a task from the queue for manual assignment. Agent tabs, history and worktrees remain available after tasks finish. Workflow confirmation rules still apply; queued messages cannot silently start configured workflows.

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

Codex and Claude Code history requires matching session and workspace metadata. Antigravity history requires its exact hook-bound conversation, a matching trajectory database and a vendor transcript log. Chat opens at the newest 20 public turns, loads older turns on demand, and receives bounded two-second live updates. Tool output, thinking and injected messages are excluded. Missing evidence is explicit. New Codex and Claude Code agents have persisted session bindings; Antigravity acquires its binding from a provider conversation hook. Bound sessions support recovery after an ADE restart; older unbound sessions cannot resume automatically. Terminal bytes never become structured chat. Agent state remains unknown without provider evidence; process exit never implies task success. PR/issue worktree sources and setup hooks remain unsupported. Automatic Kanban is opt-in and described above.

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

Worktree deletion refuses main, locked or dirty checkouts and open ADE sessions. It never forces removal or deletes branches. Source Control exposes explicit validated Git actions and PR creation; background collection never performs them.

Use the trash icon beside a project to delete its ADE registration after confirming. Close its agent tabs first. Project folders, files and Git worktrees remain on disk.

`server/runtime/` owns SQLite (`store.ts`), bounded Git (`git.ts`), fixed provider discovery and PTYs (`sessions.ts` with isolated `ptyHost.cjs` helpers), and graphs (`localRuntime.ts`). `server/http/localRoutes.ts` owns standalone API routing. `RegisterProject.tsx` provides onboarding; `AgentTerminal.tsx` provides ordered input and explicit reconnect without input replay. `desktop/main.cjs` owns the desktop renderer/backend lifecycle. Shared contracts remain in `shared/contracts.ts`.

The retired Orca dashboard adapters, transports, collectors and discovery code have been removed. Standalone routes use ADE-owned services only. Bounded transcript helpers and cursor validation live under `server/providers/`. HTTP input cannot select arbitrary executables or launch flags; terminal input goes only to a selected owned process.

The MIT-licensed [Orca source](https://github.com/stablyai/orca), snapshots `411b5c024abef11dcc269779377bc7d3aefa897c` and `45ee56e1a54bd032ce5bf7bda0c4bc8c9a02f307`, is a provider integration and terminal rendering reference. ADE uses original runtime code and adopts bounded output delivery, render acknowledgements, accelerated rendering, guarded sends and provider-specific attachment staging. Conversation history uses exact persisted bindings and validated provider transcripts.

---
# Phone access

Desktop Settings → **Connect phone** enables opt-in access through your existing Tailscale network. See [phone connection setup](docs/phone-connection.md) for the command, exact HTTPS address and access controls.
