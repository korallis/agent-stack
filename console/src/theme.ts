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
