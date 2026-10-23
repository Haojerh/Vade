---
name: vade-cli
description: Use Vade's local CLI when asked to spawn agents, delegate work, or coordinate workers in Vade, or when receiving a Vade workflow assignment. Discover context and models, create an agent-directed run, dispatch workers, exchange messages, and report explicit results.
---

# Vade CLI awareness

Vade is a standalone local application. Its CLI controls only the workflow run and owned sessions identified in the assignment. It is not the Orca CLI and does not provide shell passthrough.

For an injected assignment, use its exact `node <vade.cjs> --identity <file>` prefix. Otherwise Vade-owned coding agents receive `VADE_CLI_PATH` and `VADE_IDENTITY_FILE` in their environment. Invoke `node "$env:VADE_CLI_PATH" context` in PowerShell or `node "$VADE_CLI_PATH" context` in POSIX shells; the CLI reads its identity from the environment. Single-quote JSON arguments. If these variables are absent, ask the user to install/update the skills and resume the agent in Vade. Never guess paths or create an identity.

Append one command and, when needed, one JSON object argument. Start with `context`, which returns your role, assignment, graph, readiness, results and mailbox.

| Command | Purpose |
| --- | --- |
| `context` | Read your exact run and authorized context. |
| `models` | Discover a provider's current catalog: `{"provider":"kilo"}`. |
| `begin` | With Workflow disabled, define workers for an explicit user request. |
| `wait` | Read-only bounded wait for changes. |
| `plan` | Coordinator selects participating nodes and optional independent streams. |
| `dispatch` | Coordinator starts a ready configured node with a bounded task. |
| `message` | Queue a message for an authorized participant. |
| `result` | Worker reports completed, failed or interrupted with evidence. |
| `integrate` | Coordinator integrates clean committed isolated streams. |
| `finish` | Coordinator explicitly completes or fails the run. |
| `cancel` | Coordinator cancels the run and revokes worker capabilities. |

Read the accompanying `vade-orchestration` skill for begin payloads, role-specific commands and dependency rules before mutations. With Workflow enabled, do not begin an ad hoc run or change Settings: tell the user "Workflow enabled, confirm to continue implementation with workflow or disable settings yourself". The Chat confirmation starts the saved workflow.

The identity file is a secret capability: never print, copy or share its contents. Keep provider sign-in, trust and approvals in the owned terminal. A timeout does not establish whether a mutation succeeded: inspect `context` and the terminal instead of retrying uncertain delivery. Process exit and provider turn-end do not prove completion. Report only observed changes and checks.

The standalone runtime supports Codex, Claude Code, Antigravity, CodeBuddy, OpenCode, OpenCode v2 and Kilo Code. Choose installed providers and exact model/effort IDs returned by context/models, regardless of the orchestrator's own provider.
