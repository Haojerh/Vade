import type { TerminalChatAdapter } from './types.js';

// Orca's terminal-backed Claude controls dispatch these provider commands.
export const claudeChat: TerminalChatAdapter = {
  modelCommand: id => `/model ${id}`,
  effortCommand: value => `/effort ${value}`,
  fastToggle: '/fast',
};
