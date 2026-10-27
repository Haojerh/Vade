import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/** A bounded terminal screen, not an ANSI-stripped recording of redraw operations. */
export class TerminalScreen {
  dimensions(): { cols: number; rows: number } { return { cols: this.terminal.cols, rows: this.terminal.rows }; }
  private serializer = new SerializeAddon();
  private parsedCursor = 0;
  private mouseEncoding = 0;
  private nativeCaret?: { row: number; column: number };
  private terminal = new headless.Terminal({ cols: 100, rows: 28, scrollback: 3000, allowProposedApi: true,
    theme: { foreground: '#ededed', background: '#181818' } });
  constructor(reply: (data: string) => void, parsed: () => void) {
    this.terminal.loadAddon(this.serializer);
    this.terminal.onData(reply);
    this.terminal.onWriteParsed(parsed);
    // CodeBuddy marks its logical input caret with SGR 999. Its physical
    // terminal cursor may finish a redraw on a footer instead of that input.
    this.terminal.parser.registerCsiHandler({ final: 'm' }, params => {
      if (params.length === 1 && params[0] === 999) {
        const buffer = this.terminal.buffer.active;
        this.nativeCaret = { row: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
      }
      return false;
    });
    // SerializeAddon restores tracking but omits SGR/SGR-pixel encoding.
    // Observe parsed modes so checkpoint replay cannot turn native wheel input
    // into legacy mouse bytes that fullscreen TUIs interpret as text.
    for (const final of ['h', 'l']) this.terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
      for (const mode of params) if (mode === 1006 || mode === 1016) this.mouseEncoding = final === 'h' ? mode : 0;
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => { this.mouseEncoding = 0; return false; });
    // Headless xterm has no renderer color service. Answer the fixed host theme here.
    for (const [code, color] of [[10, 'eded/eded/eded'], [11, '1818/1818/1818'], [12, 'eded/eded/eded']] as const) {
      this.terminal.parser.registerOscHandler(code, value => {
        if (value !== '?') return false;
        reply(`\x1b]${code};rgb:${color}\x1b\\`); return true;
      });
    }
  }
  write(data: string): void { this.terminal.write(data, () => { this.parsedCursor += data.length; }); }
  settled(): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 150);
      this.terminal.write('', () => { clearTimeout(timer); resolve(); });
    });
  }
  checkpoint(): { data: string; cursor: number; cols: number; rows: number } | null {
    if (!this.parsedCursor) return null;
    for (const scrollback of [3000, 1000, 300, 100, 0]) {
      const data = this.serializer.serialize({ scrollback }) + (this.mouseEncoding ? `\x1b[?${this.mouseEncoding}h` : '');
      if (data.length <= 524288) return { data, cursor: this.parsedCursor, cols: this.terminal.cols, rows: this.terminal.rows };
    }
    return null;
  }
  resize(cols: number, rows: number): void { this.nativeCaret = undefined; this.terminal.resize(cols, rows); }
  openCodePromptReady(): boolean {
    const buffer = this.terminal.buffer.active;
    if (buffer.type !== 'alternate') return false;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const textAt = (row: number) => buffer.getLine(row)?.translateToString(true) ?? '';
    // Native OpenCode/Kilo omit placeholders when no examples are configured.
    // Identify their actual input frame: left rail, agent/model footer, then
    // the split bottom border. A dialog's input or an old transcript line is
    // not the composer, even if it contains "Ask anything".
    for (let bottom = cursorRow + 2; bottom < Math.min(buffer.baseY + this.terminal.rows, cursorRow + 14); bottom++) {
      const border = /^(\s*)╹▀{3,}/.exec(textAt(bottom));
      if (!border) continue;
      const column = border[1].length;
      const right = border[0].length;
      const content = (row: number): string | null => {
        const text = textAt(row);
        return text.slice(0, column).trim() === '' && text[column] === '┃' ? text.slice(column + 1, right).trim() : null;
      };
      const footer = content(bottom - 1);
      if (!footer || /^shell\b/i.test(footer) || !/^\S+\s+\S/.test(footer)) return false;
      if (buffer.cursorX < column + 2 || buffer.cursorX > column + 4) return false;
      let foundCursor = false;
      for (let row = bottom - 2; row >= buffer.baseY; row--) {
        const value = content(row);
        if (value === null) break;
        if (row === cursorRow) foundCursor = true;
        if (value && !(row === cursorRow && /^Ask anything(?:\u2026|\.{3})(?:\s|$)/.test(value))) return false;
      }
      return foundCursor;
    }
    return false;
  }
  /** Native composer placeholders are dim; typed text must never be overwritten. */
  codeBuddyPromptReady(): boolean {
    const screen = this.viewportText();
    return /\? for shortcuts|← for agents/.test(screen) && !/(?:Esc to cancel|Select model|Select effort|Keyboard:.*(?:Select|Navigate))/i.test(screen)
      && this.composerEmpty(false, true);
  }

  dshPromptReady(): boolean {
    const screen = this.viewportText();
    return !/Welcome to dsh|Step \d of \d|skip the guide|starting|session browser/i.test(screen)
      && this.dshComposerText() === '';
  }

  private dshComposerText(): string | null {
    const buffer = this.terminal.buffer.active, cursor = buffer.baseY + buffer.cursorY;
    const rows: string[] = [];
    for (let row = cursor; row >= Math.max(buffer.baseY, cursor - 100); row--) {
      const line = buffer.getLine(row)?.translateToString(true) ?? '';
      if (/^\s*╭─{3,}/.test(line)) {
        const first = rows[0];
          if (!first || !/^\s*(?:⌸\s*)?❯/.test(first)) return null;
          return rows.join('\n').replace(/^\s*(?:⌸\s*)?❯\s?/, '').replace(/\s+/g, ' ').trim();
      }
      if (/^\s*╰─{3,}/.test(line)) return null;
      rows.unshift(line.replace(/\s*⛶\s*$/, '').replace(/^\s*│|│\s*$/g, ''));
    }
    return null;
  }

  dshComposerHasText(expected: string): boolean {
    return this.dshComposerText() === expected.replace(/\s+/g, ' ').trim();
  }

  composerEmpty(antigravity = false, codebuddy = false): boolean {
    const buffer = this.terminal.buffer.active;
    const row = codebuddy && this.nativeCaret ? this.nativeCaret.row : buffer.baseY + buffer.cursorY;
    if (row < buffer.baseY || row >= buffer.baseY + this.terminal.rows) return false;
    const line = buffer.getLine(row);
    if (!line) return false;
    // Codex redraws its prompt after a full-width blank spacer, retaining xterm's
    // wrapped flag. A nonempty preceding line still means a multiline draft.
    if (line.isWrapped && buffer.getLine(row - 1)?.translateToString(true).trim()) return false;
    const text = line.translateToString(true), marker = /^\s*[›❯>]/.exec(text);
    if (!marker) return false;
    // Antigravity 1.4.5 uses an undimmed mode hint, leaving its cursor before it.
    if (antigravity && buffer.cursorX <= marker[0].length + 1 && /^> [A-Za-z-]+ mode: [^\r\n]+\(shift\+tab to cycle\)$/.test(text)) return true;
    const placeholderStart = marker[0].length + (text.slice(marker[0].length).match(/^\s*/)?.[0].length ?? 0);
    // CodeBuddy's empty focused input draws an undimmed first placeholder
    // character (inverse off Windows) followed by dim text. Actual drafts
    // retain undimmed text, so every remaining cell must still pass below.
    const caret = this.nativeCaret ?? { row: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
    const codeBuddyPlaceholder = codebuddy && caret.row === row
      && caret.column === placeholderStart
      && Boolean(line.getCell(placeholderStart + 1)?.isDim());
    for (let column = marker[0].length; column < line.length; column++) {
      const cell = line.getCell(column);
      if (codeBuddyPlaceholder && column === placeholderStart) continue;
      if (cell?.getChars().trim() && !cell.isDim()) return false;
    }
    return true;
  }
  /** A rendered pasted draft, not a dim recommendation or an old transcript row. */
  codeBuddyComposerHasText(expected: string): boolean {
    if (this.composerEmpty(false, true)) return false;
    const buffer = this.terminal.buffer.active;
    const caret = this.nativeCaret ?? { row: buffer.baseY + buffer.cursorY, column: buffer.cursorX };
    if (caret.row < buffer.baseY || caret.row >= buffer.baseY + this.terminal.rows || caret.column < 2) return false;
    const line = buffer.getLine(caret.row);
    if (!line) return false;
    const normalized = expected.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const tail = normalized.split('\n').at(-1)?.split('\t').at(-1)?.trimEnd();
    const suffix = tail?.slice(-Math.min(48, this.terminal.cols - 4));
    const rendered = line.translateToString(false, 0, caret.column).trimEnd();
    // Native CodeBuddy replaces large/multiline pastes with this exact capsule.
    const capsule = rendered.match(/\[Pasted text #\d+: (\d+) lines\]$/);
    const compressed = capsule && Number(capsule[1]) === Math.max(1, normalized.split('\n').length);
    if (!compressed && (!suffix || !rendered.endsWith(suffix))) return false;
    for (let row = caret.row; row >= Math.max(buffer.baseY, caret.row - 50); row--) {
      if (/^\s*>/.test(buffer.getLine(row)?.translateToString(true) ?? '')) return true;
    }
    return false;
  }
  /** Codex's current composer, including its native large-paste capsule. */
  codexComposerHasText(expected: string): boolean {
    if (this.composerEmpty()) return false;
    const buffer = this.terminal.buffer.active, row = buffer.baseY + buffer.cursorY;
    const line = buffer.getLine(row);
    if (!line) return false;
    const rendered = line.translateToString(false, 0, buffer.cursorX).trimEnd();
    const normalized = expected.replace(/\r\n?/g, '\n');
    const capsule = rendered.match(/\[Pasted Content (\d+) chars\]$/);
    const tail = normalized.split('\n').at(-1)?.split('\t').at(-1)?.trimEnd().slice(-Math.min(48, this.terminal.cols - 4));
    if (capsule ? ![normalized.length, Array.from(normalized).length].includes(Number(capsule[1])) : !tail || !rendered.endsWith(tail)) return false;
    for (let current = row; current >= Math.max(buffer.baseY, row - 50); current--) {
      if (/^\s*[\u203a\u276f>]/.test(buffer.getLine(current)?.translateToString(true) ?? '')) return true;
    }
    return false;
  }
  text(): string | null {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buffer.length - 28); i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').trim().slice(-16384) || null;
  }
  /** Full bounded current viewport for native widgets; excludes scrollback. */
  viewportText(): string {
    const buffer = this.terminal.buffer.active, lines: string[] = [];
    for (let row = buffer.baseY; row < buffer.baseY + Math.min(this.terminal.rows, 200); row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    return lines.join('\n').slice(0, 80200);
  }
  dispose(): void { this.terminal.dispose(); }
}
