import type { TerminalChatAdapter } from './providers/types.js';
import { claudeChat } from './providers/claude.js';
import { codexChat } from './providers/codex.js';
import { antigravityChat } from './providers/antigravity.js';
import { geminiChat } from './providers/gemini.js';
import { cursorChat } from './providers/cursor.js';
import { grokChat } from './providers/grok.js';

export function terminalChatAdapter(provider: string): TerminalChatAdapter {
  switch (provider) {
    case 'claude': return claudeChat;
    case 'codex': return codexChat;
    case 'antigravity': return antigravityChat;
    case 'gemini': return geminiChat;
    case 'cursor': return cursorChat;
    case 'grok': return grokChat;
    default: return {};
  }
}
