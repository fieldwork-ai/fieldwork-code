import xterm from "@xterm/headless";
import type { Terminal } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const palette = ["#171b20", "#db7474", "#91c592", "#dcc58a", "#8eb4d9", "#bc9ecb", "#91cbd1", "#dce1e7", "#8a929d", "#ef9494", "#b4dcb4", "#f0dbab", "#aac9e7", "#d3b8df", "#b6e1e4", "#ffffff"];
const background = palette[0], foreground = palette[7];
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function color(value: number, rgb: boolean, indexed: boolean, fallback: string) {
  if (rgb) return `#${value.toString(16).padStart(6, "0")}`;
  if (!indexed) return fallback;
  if (value < 16) return palette[value];
  if (value >= 232) { const level = (8 + (value - 232) * 10).toString(16).padStart(2, "0"); return `#${level.repeat(3)}`; }
  const n = value - 16, levels = [0, 95, 135, 175, 215, 255];
  return `#${[levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Consume the real renderer's ANSI output; never reconstruct the view from component state. */
export class ScreenTerminal implements Terminal {
  readonly emulator: InstanceType<typeof xterm.Terminal>;
  input?: (data: string) => void;
  onResize?: () => void;
  private writes = Promise.resolve();
  private revision = 0;
  constructor(public columns = 100, public rows = 32) {
    this.emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
  }
  get kittyProtocolActive() { return false; }
  start(onInput: (data: string) => void, onResize: () => void) { this.input = onInput; this.onResize = onResize; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(data: string) { this.revision++; this.writes = this.writes.then(() => new Promise<void>(resolve => this.emulator.write(data, resolve))); }
  moveBy(lines: number) { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`); }
  hideCursor() { this.write("\x1b[?25l"); }
  showCursor() { this.write("\x1b[?25h"); }
  clearLine() { this.write("\x1b[2K"); }
  clearFromCursor() { this.write("\x1b[J"); }
  clearScreen() { this.write("\x1b[2J\x1b[H"); }
  setTitle() {}
  setProgress() {}
  async flush() { await this.writes; }
  async settled() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const revision = this.revision;
      await new Promise(resolve => setTimeout(resolve, 25));
      await this.flush();
      if (revision === this.revision) return;
    }
    throw new Error("The terminal did not reach a stable frame");
  }
  key(data: string) { if (!this.input) throw new Error("TUI is not running"); this.input(data); }
  type(text: string) { for (const character of text) this.key(character); }
  async resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.emulator.resize(columns, rows); this.onResize?.(); await this.settled(); }
  lines() {
    const buffer = this.emulator.buffer.active;
    return Array.from({ length: this.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  }
  async screenshot(name: string) {
    await this.settled();
    const capturedLines = this.lines();
    const directory = path.resolve(process.env.TUI_SCREENSHOT_DIR ?? "../../.logs/tui-screenshots");
    await mkdir(directory, { recursive: true });
    const cellWidth = 9, cellHeight = 19, padding = 16;
    const width = this.columns * cellWidth + padding * 2, height = this.rows * cellHeight + padding * 2;
    const elements = [`<rect width="${width}" height="${height}" fill="${background}"/>`];
    const buffer = this.emulator.buffer.active;
    for (let row = 0; row < this.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      for (let col = 0; col < this.columns; col++) {
        const cell = line?.getCell(col);
        if (!cell || cell.getWidth() === 0) continue;
        let fg = color(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), foreground);
        let bg = color(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), background);
        if (cell.isInverse()) [fg, bg] = [bg, fg];
        const x = padding + col * cellWidth, y = padding + row * cellHeight;
        if (bg !== background) elements.push(`<rect x="${x}" y="${y}" width="${cell.getWidth() * cellWidth}" height="${cellHeight}" fill="${bg}"/>`);
        if (cell.getChars()) elements.push(`<text x="${x}" y="${y + 14}" fill="${fg}" opacity="${cell.isDim() ? 0.7 : 1}" font-weight="${cell.isBold() ? 700 : 400}">${escape(cell.getChars())}</text>`);
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="Liberation Mono, monospace" font-size="15">${elements.join("")}</g></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(directory, `${name}.png`));
    await writeFile(path.join(directory, `${name}.txt`), capturedLines.join("\n") + "\n");
  }
  dispose() { this.emulator.dispose(); }
}
