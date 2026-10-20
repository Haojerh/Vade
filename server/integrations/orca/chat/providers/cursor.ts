import type { TerminalChatAdapter } from './types.js';

export const cursorChat: TerminalChatAdapter = { modelCommand: id => `/model ${id}` };
