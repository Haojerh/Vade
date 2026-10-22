export const SESSION_DRAG_TYPE = 'application/x-vade-agent-session';
export interface HistoryDrag { id: string; title: string; provider: string }
export interface HistoryPlacement { targetId: string; position: 'before' | 'after' }
