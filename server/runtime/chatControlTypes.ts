/** Internal owned-terminal operations; never supplied by HTTP clients. */
export interface ChatControlIO {
  screen(): string;
  /** Only bytes received after this operation acquired the input lock. */
  output(): string;
  write(data: string): Promise<void>;
  waitFor(predicate: (screen: string) => boolean): Promise<string>;
}
