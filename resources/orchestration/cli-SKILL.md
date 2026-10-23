---
name: vade-cli
description: Use Vade's local workflow CLI when an assignment supplies a run-scoped CLI prefix. Inspect context, delegate configured nodes, exchange messages, and report explicit results.
---

# Vade CLI awareness

Vade is a standalone local application. Its CLI controls only the workflow run and owned sessions identified in the assignment. It is not the Orca CLI and does not provide shell passthrough.

Use the exact `node <vade.cjs> --identity <file>` prefix supplied by Vade. On PowerShell put `&` before a quoted executable and single-quote JSON arguments. Without an injected assignment, use Vade's UI; do not guess paths or create an identity.

Append one command and, when needed, one JSON object argument. Start with `context`, which returns your role, assignment, graph, readiness, results and mailbox.

| Command | Purpose |
| --- | --- |
| `context` | Read your exact run and authorized context. |
| `wait` | Read-only bounded wait for changes. |
| `plan` | Coordinator selects participating nodes and optional independent streams. |
| `dispatch` | Coordinator starts a ready configured node with a bounded task. |
| `message` | Queue a message for an authorized participant. |
| `result` | Worker reports completed, failed or interrupted with evidence. |
| `integrate` | Coordinator integrates clean committed isolated streams. |
| `finish` | Coordinator explicitly completes or fails the run. |
| `cancel` | Coordinator cancels the run and revokes worker capabilities. |

Read the accompanying `vade-orchestration` skill for role-specific payloads and dependency rules before mutations. The assignment supplies its exact path.

The identity file is a secret capability: never print, copy or share its contents. Keep provider sign-in, trust and approvals in the owned terminal. A timeout does not establish whether a mutation succeeded: inspect `context` and the terminal instead of retrying uncertain delivery. Process exit and provider turn-end do not prove completion. Report only observed changes and checks.

The standalone runtime supports Codex, Claude Code, Antigravity, CodeBuddy, OpenCode and Kilo Code. Use only the run-scoped CLI prefix supplied in your assignment, regardless of provider.
