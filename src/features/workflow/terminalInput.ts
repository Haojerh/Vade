/** xterm emits protocol replies through onData while parsing output. They are not keyboard input.
 * The owned backend screen answers these once, including while no renderer is attached. */
export function isTerminalReply(data: string): boolean {
  return /^(?:\x1b\[[?>=]?[\d;:]*[cnRty]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/.test(data);
}
