// A small full-screen renderer: a grid of single-width cells, drawn into an alternate screen buffer with diffed
// redraws (only changed cells are written). Colour is 24-bit, with 256- and 16-colour fallbacks and a monochrome mode
// (NO_COLOR) in which the layout and glyphs alone carry the meaning.

export type RGB = readonly [number, number, number];
export interface Style { fg?: RGB | null; bg?: RGB | null; bold?: boolean; dim?: boolean; inverse?: boolean }
export interface Cell { ch: string; fg: RGB | null; bg: RGB | null; bold: boolean; dim: boolean; inverse: boolean }
export type Depth = 24 | 256 | 16 | 0;

const blank = (bg: RGB | null): Cell => ({ ch: " ", fg: null, bg, bold: false, dim: false, inverse: false });

export class Screen {
  readonly w: number;
  readonly h: number;
  readonly cells: Cell[];
  readonly bg: RGB | null;
  constructor(w: number, h: number, bg: RGB | null = null) {
    this.w = w; this.h = h; this.bg = bg;
    this.cells = Array.from({ length: w * h }, () => blank(bg));
  }
  /** Writes text at (x, y), clipped to the screen and to `max` cells. Returns the x after the last cell written. */
  put(x: number, y: number, text: string, style: Style = {}, max = Infinity): number {
    if (y < 0 || y >= this.h) return x + Math.min([...text].length, max);
    let n = 0;
    for (const ch of text) {
      if (n >= max) break;
      if (x >= 0 && x < this.w) {
        const c = this.cells[y * this.w + x];
        c.ch = ch;
        if (style.fg !== undefined) c.fg = style.fg;
        if (style.bg !== undefined) c.bg = style.bg;
        c.bold = !!style.bold; c.dim = !!style.dim; c.inverse = !!style.inverse;
      }
      x++; n++;
    }
    return x;
  }
  fill(x: number, y: number, w: number, h: number, ch = " ", style: Style = {}): void {
    for (let r = y; r < y + h; r++) this.put(x, r, ch.repeat(Math.max(0, w)), style);
  }
  /** Sets only the background of a region (keeps the glyphs). */
  shade(x: number, y: number, w: number, bg: RGB): void {
    if (y < 0 || y >= this.h) return;
    for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.cells[y * this.w + i].bg = bg;
  }
  /** The plain characters, one string per row (tests and the monochrome check read this). */
  lines(): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) out.push(this.cells.slice(y * this.w, (y + 1) * this.w).map((c) => c.ch).join(""));
    return out;
  }
}

// ── colour ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const ANSI16: RGB[] = [[0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255]];
const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
export function to256(c: RGB): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const lv = [0, 95, 135, 175, 215, 255];
  const [r, g, b] = c.map(q);
  const cube = 16 + 36 * r + 6 * g + b, cubeRgb: RGB = [lv[r], lv[g], lv[b]];
  const grey = Math.round((c[0] + c[1] + c[2]) / 3), gi = Math.max(0, Math.min(23, Math.round((grey - 8) / 10))), greyRgb: RGB = [8 + gi * 10, 8 + gi * 10, 8 + gi * 10];
  return dist(c, greyRgb) < dist(c, cubeRgb) ? 232 + gi : cube;
}
export function to16(c: RGB): number {
  let best = 0;
  for (let i = 1; i < 16; i++) if (dist(c, ANSI16[i]) < dist(c, ANSI16[best])) best = i;
  return best;
}
function sgrColor(c: RGB, depth: Depth, bg: boolean): string {
  if (depth === 24) return `${bg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}`;
  if (depth === 256) return `${bg ? 48 : 38};5;${to256(c)}`;
  const i = to16(c);
  return String((i < 8 ? (bg ? 40 : 30) : (bg ? 100 : 90)) + (i % 8));
}
function sgr(c: Cell, depth: Depth): string {
  const p = ["0"];
  if (c.bold) p.push("1");
  if (c.dim) p.push("2");
  if (depth === 0) { if (c.inverse) p.push("7"); return `\x1b[${p.join(";")}m`; }
  if (c.inverse) p.push("7");
  if (c.fg) p.push(sgrColor(c.fg, depth, false));
  if (c.bg) p.push(sgrColor(c.bg, depth, true));
  return `\x1b[${p.join(";")}m`;
}
const sameRgb = (a: RGB | null, b: RGB | null) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
const sameStyle = (a: Cell, b: Cell) => a.bold === b.bold && a.dim === b.dim && a.inverse === b.inverse && sameRgb(a.fg, b.fg) && sameRgb(a.bg, b.bg);
const sameCell = (a: Cell, b: Cell) => a.ch === b.ch && sameStyle(a, b);

/** The bytes that turn `prev` (or a cleared screen) into `next`: whole frame when there is no comparable previous one,
 *  else only the runs of changed cells. */
export function frame(next: Screen, prev: Screen | null, depth: Depth): string {
  const full = !prev || prev.w !== next.w || prev.h !== next.h;
  let out = full ? "\x1b[0m\x1b[2J" : "";
  let last: Cell | null = null;
  for (let y = 0; y < next.h; y++) {
    let x = 0;
    while (x < next.w) {
      const i = y * next.w + x;
      if (!full && sameCell(next.cells[i], prev!.cells[i])) { x++; continue; }
      out += `\x1b[${y + 1};${x + 1}H`;
      while (x < next.w) {
        const j = y * next.w + x, c = next.cells[j];
        if (!full && sameCell(c, prev!.cells[j])) break;
        if (!last || !sameStyle(c, last)) { out += sgr(c, depth); last = c; }
        out += c.ch;
        x++;
      }
    }
  }
  return out + "\x1b[0m";
}

/** The colour depth this terminal supports: NO_COLOR wins, then COLORTERM, then TERM. */
export function detectDepth(env: NodeJS.ProcessEnv): Depth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return 24;
  if (/256/.test(env.TERM ?? "")) return 256;
  if (!env.TERM || env.TERM === "dumb") return 0;
  return 16;
}

export const ALT_ON = "\x1b[?1049h\x1b[?25l", ALT_OFF = "\x1b[0m\x1b[?25h\x1b[?1049l";

/** One frame as plain lines with colour (no cursor movement): for --once, capture and tests. */
export function dump(s: Screen, depth: Depth): string {
  const out: string[] = [];
  for (let y = 0; y < s.h; y++) {
    let line = "", last: Cell | null = null;
    for (let x = 0; x < s.w; x++) {
      const c = s.cells[y * s.w + x];
      if (depth !== 0 && (!last || !sameStyle(c, last))) { line += sgr(c, depth); last = c; }
      else if (depth === 0 && (!last || !sameStyle(c, last))) { line += sgr(c, 0); last = c; }
      line += c.ch;
    }
    out.push(line + "\x1b[0m");
  }
  return out.join("\n") + "\n";
}
