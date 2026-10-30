/** Internal owned-terminal operations; never supplied by HTTP clients. */
export interface ChatControlIO {
  screen(): string;
  /** Only bytes received after this operation acquired the input lock. */
  output(): string;
  /** Monotonic owned PTY output position, independent of the retained tail size. */
  outputCursor?(): number;
  /** Current rendered native composer, including provider placeholders. */
  promptEmpty?(): boolean;
  /** Fresh exact-session native acknowledgement for this fixed operation. */
  settingConfirmed?():boolean;
  write(data: string): Promise<void>;
  waitFor(predicate: (screen: string) => boolean): Promise<string>;
}
