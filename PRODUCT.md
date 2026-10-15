# Orca Visualization

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the user: React and TypeScript with a small Node backend, served on localhost. User chose direct implementation in code.

## Users

An Orca user monitoring development across projects, worktrees, and agents.

## Product Purpose

Make the actual Orca workflow visible as a live graph/tree with status, progress, and inspectable node details.

## Operating Context

Runs locally alongside the user's Orca runtime. The selected project's GitHub repository supplies PR and commit activity when available.

## Capabilities and Constraints

- Select a project; inspect orchestrator, real worktrees, and existing agents.
- Highlight active connections; show working, waiting, blocked, completed, failed, and unknown states from evidence.
- Select nodes for current tasks, recent output, and reported progress.
- Show GitHub PRs, commit history, and available push events distinctly.
- V1 is read-only. No fabricated roles, percentages, or successful synchronization.
- Missing runtime, authentication, repository, or event history must be visible.

## Evidence on Hand

Empty Git checkout with origin Haojerh/orca-visualization. Installed Orca runtime is reachable. No existing visual assets or interface.
