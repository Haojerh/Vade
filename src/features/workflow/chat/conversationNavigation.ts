import type { ConversationMessage } from '../../../../shared/contracts';

export interface ConversationPosition { id: string; text: string; reply: string; at: string | null }

/** Visible message area, excluding facts above it and the composer below it. */
export function conversationViewport(top: number, bottom: number, historyTop: number, composerTop?: number) {
  const start = Math.max(top, Math.min(bottom, historyTop));
  const end = Math.max(start, Math.min(bottom, composerTop ?? bottom));
  return { top:start, bottom:end, height:end-start, center:start+(end-start)/2 };
}

/** Build navigation only from public user turns in this exact loaded history. */
export function conversationPositions(messages: ConversationMessage[]): ConversationPosition[] {
  const positions: ConversationPosition[] = [];
  let current: ConversationPosition | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      current = { id: message.id, text: message.text.slice(0, 500), reply: '', at: message.at };
      positions.push(current);
    } else if (current && !current.reply && message.text.trim()) current.reply = message.text.slice(0, 500);
  }
  return positions;
}

/** Long histories retain evenly spaced ticks plus the active and keyboard-focused turn. */
export function conversationPositionTicks(items: ConversationPosition[], activeId: string | null, focusedId: string | null, limit = 48): ConversationPosition[] {
  if (items.length <= limit) return items;
  const indices = new Set<number>([0, items.length - 1]);
  for (const id of [activeId, focusedId]) {
    const index = items.findIndex(item => item.id === id);
    if (index >= 0) indices.add(index);
  }
  const slots = Math.max(2, limit - indices.size + 2);
  for (let step = 1; step < slots - 1; step++) indices.add(Math.round(step * (items.length - 1) / (slots - 1)));
  return [...indices].sort((a, b) => a - b).map(index => items[index]);
}

export function conversationPositionKey(key: string, index: number, count: number): number | null {
  if (!count) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return Math.min(count - 1, Math.max(0, index + 1));
  if (key === 'ArrowUp') return Math.max(0, index - 1);
  return null;
}

/** Scroll only this chat pane; never scroll the modal's page or another session. */
export function jumpToConversationPosition(container: HTMLElement, row: HTMLElement, reducedMotion: boolean): void {
  container.scrollTo({ top: container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - 16, behavior: reducedMotion ? 'auto' : 'smooth' });
  row.focus({ preventScroll: true });
}
