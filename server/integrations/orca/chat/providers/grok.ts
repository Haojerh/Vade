import type { TerminalChatAdapter } from './types.js';

export const grokChat: TerminalChatAdapter = { modelCommand: id => `/model ${id}`, effortCommand: value => `/effort ${value}` };
