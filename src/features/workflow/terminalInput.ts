/** xterm emits protocol replies through onData while parsing output. They are not keyboard input.
 * The owned backend screen answers these once, including while no renderer is attached. */
export function isTerminalReply(data: string): boolean {
  return /^(?:\x1b\[[?>=]?[\d;:]*[cnRty]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/.test(data);
}

/** Preserve native paste/copy even when a CLI enables Kitty keyboard encoding. */
export function isTerminalClipboardShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'key'>, hasSelection: boolean): boolean {
  const modifier = event.ctrlKey || event.metaKey;
  return !event.altKey && ((modifier && (event.key.toLowerCase() === 'v' || (event.key.toLowerCase() === 'c' && hasSelection))) || (event.shiftKey && event.key === 'Insert'));
}
