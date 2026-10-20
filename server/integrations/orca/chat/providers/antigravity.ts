import type { TerminalChatAdapter } from './types.js';

export const antigravityChat: TerminalChatAdapter = {
  modelPicker: { command: '/model', typed: false },
  effortCommand: value => `/effort ${value}`,
};
