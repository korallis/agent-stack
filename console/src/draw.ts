// Drawing primitives on a Screen: rounded panels with their title set into the border (btop), block-digit numbers,
// braille graphs with a value-axis gradient, sparklines and meters. Every glyph is one terminal cell.
import type { RGB, Screen, Style } from "./term.ts";
import { gradient, type Theme } from "./theme.ts";

export function panel(s: Screen, t: Theme, x: number, y: number, w: number, h: number, title = "", opt: { color?: RGB; right?: string; titleColor?: RGB } = {}): void {
  if (w < 4 || h < 2) return;
  const b: Style = { fg: opt.color ?? t.border };
  s.put(x, y, "╭" + "─".repeat(w - 2) + "╮", b);
  for (let r = y + 1; r < y + h - 1; r++) { s.put(x, r, "│", b); s.put(x + w - 1, r, "│", b); }
  s.put(x, y + h - 1, "╰" + "─".repeat(w - 2) + "╯", b);
  if (title) { s.put(x + 2, y, " ", b); const e = s.put(x + 3, y, title, { fg: opt.titleColor ?? opt.color ?? t.title, bold: true }, w - 8); s.put(e, y, " ", b); }
  if (opt.right) { const r = ` ${opt.right} `; s.put(x + w - 2 - r.length, y, r, { fg: t.dim }); }
}

/** Fits text into exactly n cells: cut with an ellipsis, or padded. */
export function fit(text: string, n: number): string {
  const c = [...text];
  if (c.length <= n) return text + " ".repeat(n - c.length);
  return n <= 1 ? c.slice(0, n).join("") : c.slice(0, n - 1).join("") + "…";
}
export const rpad = (v: string | number, n: number) => { const s = String(v); return s.length >= n ? s : " ".repeat(n - s.length) + s; };

// 4×5 block digits, built from full and half blocks.
const DIGITS: Record<string, string[]> = {
  "0": ["█▀▀█", "█  █", "█  █", "█  █", "█▄▄█"], "1": [" ▄█ ", "  █ ", "  █ ", "  █ ", " ▄█▄"],
  "2": ["▀▀▀█", "   █", "█▀▀▀", "█   ", "█▄▄▄"], "3": ["▀▀▀█", "   █", " ▀▀█", "   █", "▄▄▄█"],
  "4": ["█  █", "█  █", "▀▀▀█", "   █", "   █"], "5": ["█▀▀▀", "█   ", "▀▀▀█", "   █", "▄▄▄█"],
  "6": ["█▀▀▀", "█   ", "█▀▀█", "█  █", "█▄▄█"], "7": ["▀▀▀█", "   █", "  █ ", " █  ", " █  "],
  "8": ["█▀▀█", "█  █", "█▀▀█", "█  █", "█▄▄█"], "9": ["█▀▀█", "█  █", "▀▀▀█", "   █", "▄▄▄█"],
  "-": ["    ", "    ", "▀▀▀▀", "    ", "    "], "?": ["▀▀▀█", "   █", " ▀▀ ", "    ", " █  "],
};
/** Draws a number in block digits; returns its width. */
export function bigNumber(s: Screen, x: number, y: number, value: string, style: Style): number {
  let cx = x;
  for (const ch of value) {
    const g = DIGITS[ch] ?? DIGITS["?"];
    g.forEach((row, i) => s.put(cx, y + i, row, style));
    cx += 5;
  }
  return cx - x - 1;
}
export const bigWidth = (value: string) => value.length * 5 - 1;

const SPARK = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[], width: number, max?: number): string {
  const v = values.slice(-width), m = max ?? Math.max(1, ...v);
  return v.map((n) => SPARK[Math.max(0, Math.min(7, Math.round((n / m) * 7)))]).join("").padStart(width, " ");
}

/** A braille area graph, `h` rows tall and `w` cells wide (two samples per cell), filled from the bottom, coloured by
 *  height along the value axis. */
export function braille(s: Screen, t: Theme, x: number, y: number, w: number, h: number, values: number[], opt: { max?: number; color?: RGB } = {}): void {
  const n = w * 2, v = values.slice(-n), pad = n - v.length, max = opt.max ?? Math.max(1, ...v);
  const dots = h * 4;
  const level = (i: number) => (i < pad ? -1 : Math.round((v[i - pad] / max) * dots));
  // dot bits per column in a braille cell, from the bottom row up: left 7,3,2,1 → 0x40,0x04,0x02,0x01; right 0x80,0x20,0x10,0x08
  const L = [0x40, 0x04, 0x02, 0x01], R = [0x80, 0x20, 0x10, 0x08];
  for (let cx = 0; cx < w; cx++) {
    const a = level(cx * 2), b = level(cx * 2 + 1);
    for (let row = 0; row < h; row++) {
      const base = (h - 1 - row) * 4; let bits = 0;
      for (let k = 0; k < 4; k++) { if (a > base + k || (a === 0 && base + k === 0 && false)) bits |= L[k]; if (b > base + k) bits |= R[k]; }
      if (a >= 0 && b >= 0 && a === 0 && b === 0 && row === h - 1) bits = 0x40 | 0x80;   // a flat line at zero, not nothing
      if (a < 0 && b < 0) continue;
      const ch = bits ? String.fromCharCode(0x2800 + bits) : "⠀";
      s.put(x + cx, y + row, ch, { fg: opt.color ?? gradient(t, (h - row) / h) });
    }
  }
}

/** A horizontal meter: filled cells, then a faint track. */
export function meter(s: Screen, t: Theme, x: number, y: number, w: number, frac: number | null, color: RGB): void {
  if (frac === null) { s.put(x, y, "·".repeat(w), { fg: t.faint }); return; }
  const f = Math.max(0, Math.min(w, Math.round(frac * w)));
  s.put(x, y, "█".repeat(f), { fg: color });
  s.put(x + f, y, "░".repeat(w - f), { fg: t.faint });
}

export function ago(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(sec / 86400)}d`;
}
export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
