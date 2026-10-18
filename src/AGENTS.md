# Frontend rules

Read the root AGENTS.md first.

- Keep feature panels and their helpers in `features/<feature>/`; compose them in `app/`.
- Fetch through `api/client.ts` using `shared/contracts.ts`. Never access provider logs, credentials, or runtime transports from the browser.
- Put reusable controls in `components/ui/`; use `components/providers/ProviderIcon` everywhere provider identity is shown.
- Reuse `Modal` and `DialogActions`/`DialogError` for dialogs, `Popover` for anchored overlays, `ContextMenu` for action menus, `Disclosure` for lazy collapsible sections, and `Select` for native select wrappers. Use `useConfirmationState`/`usePopoverState` for the shared exit lifecycle and `useDismissLayer` for topmost-layer dismissal. Avoid feature-local `showModal`, outside-click listeners, or copied overlay markup.
- Use `AgentPicker` and `useAgentCatalog` for agent choices. Installed choices come from the detected `/api/agents/catalog` response; never seed a hardcoded installed-agent list in the frontend.
- Use `features/workflow/MessageMarkdown` for conversation text. Keep local file references inert, raw HTML disabled, and external links safe. Never inject HTML from agent messages.
- Preserve explicit loading, empty, unavailable, and stale states. Do not turn failed reads into empty success.
- Bind previews and requests to project/node/run; abort obsolete requests. Modal close must not immediately reopen a hover preview.
- Unread activity clears only when its item is clicked. Persist seen/unread IDs in local storage, scoped by project/repository/activity type and branch where applicable, so reloads preserve notifications. Tab switching preserves unread state; only the count badge gets the orange unread treatment.
- Overlay opening and closing, refresh rotation, and tab indicator movement must respect reduced motion.
- Keep provider image attribution under `assets/providers/`. Relative `new URL(..., import.meta.url)` asset paths must be updated during moves as well as imports.
- Keep render/behavior tests in `tests/`. After UI changes, check the affected flow in the local app at `http://127.0.0.1:5173` and run the relevant checks from the root rules.
