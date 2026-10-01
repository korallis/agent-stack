// What every view shares: the header bar (where you are, host, daemon health, clock, live indicator), the tab strip of
// numbered views (lazygit), the live ticker and the footer of keys for the focused view (k9s).
import type { Screen } from "../term.ts";
import type { Theme } from "../theme.ts";
import type { Fleet, Raw } from "../model.ts";
import { ago, fit } from "../draw.ts";

export interface Ctx { s: Screen; t: Theme; raw: Raw; f: Fleet; frame: number; view: number; rigFocus: number; seatFocus: [number, number]; note: string | null }
export const VIEWS = ["Mission Control", "Seat Matrix"];
const SPIN = "⣾⣽⣻⢿⡿⣟⣯⣷";

export function header(c: Ctx, crumb: string): void {
  const { s, t, raw, f } = c;
  s.fill(0, 0, s.w, 1, " ", { bg: t.panel });
  let x = s.put(1, 0, " OPENRIG ", { fg: t.bg, bg: t.title, bold: true });
  x = s.put(x + 1, 0, crumb, { fg: t.text, bg: t.panel, bold: true });
  const sessions = f.agents.filter((a) => a.activity !== "detached" && a.activity !== "stopped").length;
  x = s.put(x + 2, 0, `${raw.host.id} · ${raw.host.cores} cores · ${sessions} sessions · ${raw.rigs.length} rigs`, { fg: t.dim, bg: t.panel });
  const d = raw.daemon;
  const right: [string, any][] = [];
  if (d.ok) {
    right.push(["daemon ", t.dim], [d.cpuPct === null ? "—" : `${d.cpuPct}%`, d.cpuPct !== null && d.cpuPct > 40 ? t.stuck : t.working], [" cpu  healthz ", t.dim],
      [d.latencyMs === null ? "—" : `${d.latencyMs}ms`, (d.latencyMs ?? 0) > 500 ? t.blocked : t.working]);
  } else right.push(["daemon ", t.dim], [`unreachable${d.error ? ` (${d.error})` : ""}`.slice(0, 48), t.stuck]);
  right.push([`  load ${raw.host.load[0]?.toFixed(1) ?? "—"}  mem ${Math.round(raw.host.memUsedGB)}/${Math.round(raw.host.memTotalGB)} GB  `, t.dim],
    [new Date(raw.at).toISOString().replace("T", " ").slice(0, 19) + " UTC", t.text],
    [d.ok ? `  ${SPIN[c.frame % SPIN.length]} live` : "  ○ stale", d.ok ? t.working : t.blocked], [` · ${Math.round(raw.refreshMs / 1000)}s `, t.dim]);
  // too narrow for everything: keep daemon health and the live indicator, drop load, memory and the date
  const fits = (parts: [string, any][]) => s.w - 1 - parts.reduce((n, [txt]) => n + [...txt].length, 0) > x + 2;
  const parts = fits(right) ? right : right.filter((_, i) => i !== right.length - 4 && i !== right.length - 3);
  let rx = s.w - parts.reduce((n, [txt]) => n + [...txt].length, 0) - 1;
  if (rx > x + 2) for (const [txt, col] of parts) rx = s.put(rx, 0, txt, { fg: col, bg: t.panel, bold: col === t.text });
  // tabs
  let tx = 1;
  VIEWS.forEach((v, i) => {
    const on = c.view === i;
    tx = s.put(tx, 1, ` ${i + 1} ${v} `, on ? { fg: t.bg, bg: t.working, bold: true } : { fg: t.dim });
    tx += 1;
  });
  s.put(tx + 1, 1, "3 River · 4 Focus · 5 Constellation: later phases", { fg: t.faint });
}

export function ticker(c: Ctx, y: number): void {
  const { s, t, raw } = c;
  s.put(1, y, " ◀◀ LIVE ", { fg: t.bg, bg: t.working, bold: true });
  let x = 11;
  if (!raw.events.length) { s.put(x, y, "waiting for live events from the daemon…", { fg: t.faint }); return; }
  for (const e of raw.events.slice(0, 8)) {
    const col = kindColor(t, e.kind), item = `${e.kind.toLowerCase()} ${e.text}`;
    if (x + 6 >= s.w) break;
    x = s.put(x, y, " │ ", { fg: t.faint });
    x = s.put(x, y, "● ", { fg: col });
    x = s.put(x, y, fit(item, Math.min(46, s.w - x - 1)).trimEnd(), { fg: t.text });
  }
}

export function kindColor(t: Theme, kind: string) {
  return ({ DONE: t.merged, QUEUED: t.info, CLAIMED: t.working, HANDOFF: t.violet, BLOCKED: t.blocked, PROOF: t.merged, UP: t.working, DOWN: t.stuck } as Record<string, any>)[kind] ?? t.dim;
}

export function footer(c: Ctx, keys: [string, string][], status: string): void {
  const { s, t, f } = c;
  let x = 1;
  for (const [k, what] of keys) {
    if (x + k.length + what.length + 4 > s.w) break;
    x = s.put(x, s.h - 2, ` ${k} `, { fg: t.text, bg: t.border, bold: true });
    x = s.put(x + 1, s.h - 2, what, { fg: t.dim }) + 2;
  }
  const warn: string[] = [];
  if (f.owner.length) warn.push(`▲ ${f.owner.length} owner decision${f.owner.length > 1 ? "s" : ""} waiting`);
  if (f.stuck.length) warn.push(`${f.stuck.length} seat${f.stuck.length > 1 ? "s" : ""} stuck or unknown`);
  if (f.ctxHigh.length) warn.push(`${f.ctxHigh.length} ctx ≥ 80%`);
  const w = warn.join(" · ");
  s.put(1, s.h - 1, fit(status, Math.max(0, s.w - [...w].length - 5)), { fg: t.dim });
  if (w) s.put(s.w - [...w].length - 2, s.h - 1, w, { fg: f.owner.length ? t.owner : t.blocked });
  if (c.note) s.put(Math.max(1, Math.floor(s.w / 2) - 20), s.h - 1, ` ${c.note} `, { fg: t.bg, bg: t.title });
}

export const since = (raw: Raw, iso: string | null) => (iso ? ago(raw.at - Date.parse(iso)) : "—");
