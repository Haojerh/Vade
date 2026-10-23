# Chat drafts and question alerts

`src/hooks/useAgentDraft.ts` keeps unsent text per project and node across overlay disposal, selection changes and reloads. Browser storage holds at most 100 drafts, with an in-memory fallback. Confirmed successful sends clear only their matching draft. Failed or uncertain sends retain it. File attachments are not persisted.

Native `waiting` status with explicit `question` attention creates a separate bounded `inbox_attention` observation. These entries have `source: attention` and `outcome: waiting`; they are not turn results or Kanban task outcomes. Repeated reads do not notify again, and restored waiting state does not emit fresh system alerts. Completion and question notifications share the existing General notification, sound and system preferences. Notification clicks open the exact project/node.

The desktop utility process emits fresh question events through `subscribeAttention`, separately from completed-turn `subscribeResults`. The web Inbox merges bounded attention records with turn results. Handling and clearing remain browser-local.
