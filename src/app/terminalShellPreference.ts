import type { TerminalShell } from '../../shared/contracts';

const KEY = 'ade-terminal-shell';

export const TERMINAL_SHELL_OPTIONS: { id: TerminalShell; label: string }[] = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'Command Prompt' },
  { id: 'bash', label: 'Bash' },
];

export function readTerminalShell(): TerminalShell {
  try {
    const value = localStorage.getItem(KEY);
    if (TERMINAL_SHELL_OPTIONS.some(option => option.id === value)) return value as TerminalShell;
  } catch { /* Storage unavailable. */ }
  return 'powershell';
}

export function writeTerminalShell(shell: TerminalShell): void {
  try { localStorage.setItem(KEY, shell); } catch { /* Storage unavailable. */ }
}