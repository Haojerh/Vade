# OpenCode package detection

The OpenCode 2 npm package `@opencode/cli` exposes both `opencode` and `opencode2`; on Windows both shims target `bin/opencode.exe`. The previous Vade resolver only inspected `opencode-ai`, so upgrading to the scoped package made both installed command aliases disappear from Vade.

The resolver now recognizes the fixed `node_modules/@opencode/cli/bin/opencode.exe` path (or `bin/opencode` on other hosts) for both aliases, while retaining existing PATH and legacy package discovery. It requires a real file and does not execute PowerShell or cmd shims, read arbitrary manifest commands, install packages or change provider preferences.

Both aliases were verified against the locally installed `@opencode/cli` 2.1.4 binary using the bounded `--version` probe. A fixture test covers both aliases and rejects missing paths and directories.

Vade still uses the explicit OpenCode 2 provider for 2.x sessions, including its standalone launch and `session_v2` provenance. Existing OpenCode 1 sessions are not silently rebound to the v2 database. Use OpenCode 2 for new 2.x sessions; a saved v1 session requires its compatible CLI.

Orca reference: its [agent catalog](https://github.com/stablyai/orca/blob/main/src/renderer/src/lib/agent-catalog-entries-primary.ts) lists the two command aliases separately, and its [TUI configuration](https://github.com/stablyai/orca/blob/main/src/shared/tui-agent-config.ts) launches `opencode2 --standalone`. Command alias detection does not establish that two different major-version binaries are installed.

The intermittent blank-screen report was not reproduced conclusively. The user cancelled that investigation; no blank-screen-specific workaround, error boundary or speculative fix was added.

## Empty input before the first turn

The send guard previously recognized the OpenCode/Kilo native empty composer but still required lifecycle-hook status to be known. Before the first invocation, that status can be unavailable or unknown. This produced the misleading input-not-ready error despite a verified empty composer. Antigravity and CodeBuddy already had a native-readiness fallback; OpenCode, OpenCode 2 and Kilo were missing from it.

Both ordinary sends and idle-only workflow/queue readiness now accept a verified native empty OpenCode-family composer when lifecycle status is unknown. Known working agents remain ineligible for idle-only sends. Waiting/blocked prompts, native setup, shell mode, nonempty drafts, stopped processes and input races retain their existing fences. There is no readiness based on process liveness alone and no automatic prompt approval or uncertain-send retry.

A regression using the actual headless terminal frame reproduced the exact input-not-ready exception before the change and passes for all three providers after it, including one paste/Enter per accepted send and no writes for rejected cases.

## Native frame and lifecycle verification

Current owned terminal checkpoints identified two additional readiness mismatches: Kilo's model/cost sidebar extends across the same rows as its empty composer, and CodeBuddy's footer can show `← for agents` without `? for shortcuts`. Composer parsing now stops at the native bottom-border width instead of counting the sidebar as draft text. CodeBuddy uses the complete bounded viewport and recognizes both observed footer forms. Drafts, shell mode and native settings dialogs remain rejected.

Controlled probes of the installed OpenCode 2.1.4 native executable, in disposable configuration/data directories, showed that the legacy inline plugin list did not load the status plugin. A `.js` drop-in in the native `plugins` directory published the expected initial idle event. A Kilo 7.8.18 server probe also loaded the directory plugin and published initial idle; its model-list probe endpoint did not return ready, so that probe does not establish model API support. No model prompt was submitted in either probe.

Owned launches now install a managed `vade-agent-status.js` drop-in in the detected native configuration directory, preserving other files and the existing inline configuration. A conflicting unrelated file or symlink is refused. The plugin is inactive without Vade's workspace/session/token environment. Normal CLI launches cannot publish Vade status. Existing native terminals must be explicitly restarted/resumed to load the updated plugin; collection does not restart them.

The native event regression exercises v1 busy/idle events and v2 prompt admission/execution completion, exact-session exclusion, work-clock start/end and preservation of user configuration. Working indicators and elapsed time remain derived from these verified native events, never from sending input or from process liveness.

REA statically inspected the installed CodeBuddy permission-method extracts under parent Evidence `ev_94ae4108ba8f52f817bd86d3a6a2ccdfa3fcf42f36be7d44567fb4c184657c9d`. That analysis has unresolved dynamic dependencies and does not establish live lifecycle delivery. The readiness fixes above were confirmed separately against current rendered terminal checkpoints; raw captures remain ignored local QA artifacts.

### Resumed Kilo history in another checkout

A later check found a Kilo record launched in a selected checkout while its exact native session retained the original directory recorded in `sourceCwd`. The plugin's workspace gate accepted only the selected checkout, so it returned without even publishing SessionStart. The native database independently confirmed the original directory; this was not inferred from terminal text.

Owned launches now pass the backend-verified original directory as `ADE_STATUS_SOURCE_CWD`, clearing any inherited value when absent. The plugin accepts only an exact normalized match to the selected checkout or that verified source directory. Session-ID and fresh launch-token fences remain unchanged. A regression reproduces the missing status before the change and verifies busy/idle timing after it, while an unrelated directory and foreign session remain rejected. Existing processes need an explicit restart/resume to receive the new environment.
