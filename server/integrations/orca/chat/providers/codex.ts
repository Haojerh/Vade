import type { TerminalChatAdapter } from './types.js';

// Installed terminal sessions may submit inline /model arguments as ordinary prompts.
// Only expose the interactive picker until a direct settings channel is verified.
export const codexChat: TerminalChatAdapter = {
  modelPicker: { command: '/model', typed: true },
};
