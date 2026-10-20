export interface TerminalChatAdapter {
  modelCommand?: (id: string) => string;
  effortCommand?: (value: string) => string;
  fastToggle?: string;
  modelPicker?: { command: string; typed: boolean };
}
