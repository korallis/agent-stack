// Palette "Pad 39A" (the owner-approved home mockup): night-navy ground, teal = working, steel = idle, signal red =
// stuck / context pressure, amber = blocked / hold, magenta = owner needed, launch green = merged / passed, gold titles.
import type { RGB } from "./term.ts";

export interface Theme {
  name: string;
  bg: RGB; panel: RGB; border: RGB; text: RGB; dim: RGB; faint: RGB; title: RGB;
  working: RGB; idle: RGB; stuck: RGB; blocked: RGB; owner: RGB; merged: RGB; info: RGB; violet: RGB;
}

export const PAD39A: Theme = {
  name: "Pad 39A",
  bg: [12, 17, 32], panel: [17, 24, 43], border: [52, 64, 96], text: [214, 220, 232], dim: [128, 140, 166], faint: [70, 82, 110],
  title: [244, 196, 64], working: [56, 214, 196], idle: [112, 128, 156], stuck: [240, 80, 96], blocked: [246, 176, 64],
  owner: [236, 92, 176], merged: [96, 220, 128], info: [104, 172, 240], violet: [170, 140, 250],
};

// Switchable palettes (phase 3): the same meanings, each theme's own colours.
export const CATPPUCCIN: Theme = {   // Catppuccin Mocha
  name: "Catppuccin", bg: [30, 30, 46], panel: [36, 36, 54], border: [69, 71, 90], text: [205, 214, 244], dim: [147, 153, 178], faint: [88, 91, 112],
  title: [249, 226, 175], working: [148, 226, 213], idle: [127, 132, 156], stuck: [243, 139, 168], blocked: [250, 179, 135],
  owner: [245, 194, 231], merged: [166, 227, 161], info: [137, 180, 250], violet: [203, 166, 247],
};
export const TOKYO_NIGHT: Theme = {
  name: "Tokyo Night", bg: [26, 27, 38], panel: [31, 35, 53], border: [59, 66, 97], text: [192, 202, 245], dim: [86, 95, 137], faint: [59, 66, 97],
  title: [224, 175, 104], working: [115, 218, 202], idle: [86, 95, 137], stuck: [247, 118, 142], blocked: [255, 158, 100],
  owner: [187, 154, 247], merged: [158, 206, 106], info: [122, 162, 247], violet: [157, 124, 216],
};
export const NORD: Theme = {
  name: "Nord", bg: [46, 52, 64], panel: [59, 66, 82], border: [76, 86, 106], text: [236, 239, 244], dim: [174, 182, 198], faint: [102, 112, 130],
  title: [235, 203, 139], working: [143, 188, 187], idle: [129, 161, 193], stuck: [191, 97, 106], blocked: [208, 135, 112],
  owner: [180, 142, 173], merged: [163, 190, 140], info: [136, 192, 208], violet: [180, 142, 173],
};
export const THEMES: Record<string, Theme> = { pad39a: PAD39A, catppuccin: CATPPUCCIN, "tokyo-night": TOKYO_NIGHT, nord: NORD };

const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as unknown as RGB;
export { mix };

/** The background shade of a context-usage cell: darker = lower, brighter = higher; red past 80%. */
export function ctxShade(t: Theme, pct: number | null): RGB {
  if (pct === null) return t.panel;
  if (pct >= 80) return mix(t.panel, t.stuck, 0.55);
  return mix(t.panel, t.info, 0.12 + (pct / 80) * 0.45);
}
/** A colour along a value axis (low = calm, high = hot): btop-style gradients. */
export function gradient(t: Theme, v: number): RGB {
  return v < 0.5 ? mix(t.working, t.blocked, v * 2) : mix(t.blocked, t.stuck, (v - 0.5) * 2);
}
