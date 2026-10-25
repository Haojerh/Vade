/** A PTY has one grid. The most recently focused/resized view controls it;
 * other views render that observed grid without locally reflowing the TUI. */
export class TerminalViewports<T> {
  readonly owners = new Set<T>();
  private sizes = new Map<T, { cols: number; rows: number }>();
  private applied?: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(private apply: (cols: number, rows: number) => Promise<void>) {}
  update(owner: T, cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) return Promise.reject(new Error('Invalid terminal dimensions'));
    this.owners.add(owner); this.sizes.delete(owner); this.sizes.set(owner, { cols, rows }); return this.sync();
  }
  remove(owner: T): Promise<void> { this.owners.delete(owner); this.sizes.delete(owner); return this.sync(); }
  private sync(): Promise<void> {
    const action = this.pending.catch(() => {}).then(async () => {
      if (!this.sizes.size) return;
      const { cols, rows } = [...this.sizes.values()].at(-1)!;
      const key = `${cols}:${rows}`;
      if (key === this.applied) return;
      await this.apply(cols, rows); this.applied = key;
    });
    this.pending = action; return action;
  }
}
