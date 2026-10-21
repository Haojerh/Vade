import headless from '@xterm/headless';

/** A bounded terminal screen, not an ANSI-stripped recording of redraw operations. */
export class TerminalScreen {
  private terminal = new headless.Terminal({ cols: 100, rows: 28, scrollback: 100, allowProposedApi: true,
    theme: { foreground: '#ededed', background: '#181818' } });
  constructor(reply: (data: string) => void, parsed: () => void) {
    this.terminal.onData(reply);
    this.terminal.onWriteParsed(parsed);
    // Headless xterm has no renderer color service. Answer the fixed host theme here.
    for (const [code, color] of [[10, 'eded/eded/eded'], [11, '1818/1818/1818'], [12, 'eded/eded/eded']] as const) {
      this.terminal.parser.registerOscHandler(code, value => {
        if (value !== '?') return false;
        reply(`\x1b]${code};rgb:${color}\x1b\\`); return true;
      });
    }
  }
  write(data: string): void { this.terminal.write(data); }
  resize(cols: number, rows: number): void { this.terminal.resize(cols, rows); }
  text(): string | null {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buffer.length - 28); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').trim().slice(-2000) || null;
  }
  dispose(): void { this.terminal.dispose(); }
}
