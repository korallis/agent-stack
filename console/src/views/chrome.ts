// What every view shares: the header bar (where you are, host, daemon health, clock, live indicator), the tab strip of
// numbered views (lazygit), the live ticker and the footer of keys for the focused view (k9s).
import type { RGB, Screen } from "../term.ts";
import type { Theme } from "../theme.ts";
import { brief, type Account, type Fleet, type Raw } from "../model.ts";
import { ago, fit } from "../draw.ts";

export interface Ctx { s: Screen; t: Theme; raw: Raw; f: Fleet; frame: number; view: number; rigFocus: number; seatFocus: [number, number]; note: string | null;
  riverFocus?: [number, number]; journey?: string | null;
  // phase 3: the focused pane (Tab), 'e' expanded, the selection in it, the ':' command being typed
  pane?: number; expand?: boolean; select?: number; cmd?: string | null; clampSelect?: (n: number) => void }
export const VIEWS = ["Mission Control", "Seat Matrix", "River", "Focus", "Pool & System"];
export const COMMANDS = ["home", "matrix", "river", "focus", "pool", "seat <name>", "rig <name>", "slice <id>", "stuck <minutes>", "theme pad39a|catppuccin|tokyo-night|nord", "help", "q"];
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
  s.put(s.w - 22, 1, fit(`theme ${t.name}`, 20).padStart(20), { fg: t.faint });
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

/** A quota reading's colour: none reported is faint; a window used up while the account runs on credits is info, not
 *  red, at any reading (it isn't exhausted); otherwise green, amber from 75%, red from 95%. */
export function quotaColor(t: Theme, a: Account, v: number | null): RGB {
  if (v === null) return t.faint;
  if (a.onCredits && !a.over && v >= 100) return t.info;
  return v >= 95 ? t.stuck : v >= 75 ? t.blocked : t.working;
}
const when = (iso: string, at: number) => {
  const d = new Date(Date.parse(iso)), hm = d.toISOString().slice(11, 16);
  return `${d.toISOString().slice(0, 10) === new Date(at).toISOString().slice(0, 10) ? "" : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} `}${hm}Z`;
};
/** What a cooling account's timers say, from the proxy's cooldowns: a credential-wide cooldown gates the whole
 *  account ("cooling until Sun 07:00Z (quota, whole account, in 2d)"); model timers only say when the FIRST model is
 *  back ("3 models cooling, first back 14:10Z (quota, in 4m)"). Null without a timer, and for a disabled account:
 *  a timer never promises it back. */
export function coolingUntil(a: Account, at: number): string | null {
  if (!a.cooling || !a.coolUntil || a.blocked) return null;
  const until = Date.parse(a.coolUntil), left = until > at ? `in ${ago(until - at)}` : "due now";
  if (a.coolScope === "credential") return `cooling until ${when(a.coolUntil, at)} (${[a.coolReason, "whole account", left].filter(Boolean).join(", ")})`;
  const n = a.coolModels ?? 1;
  return `${n} model${n === 1 ? "" : "s"} cooling, first back ${when(a.coolUntil, at)} (${[a.coolReason, left].filter(Boolean).join(", ")})`;
}
/** The same, in a few words for a title: "back Sun 07:00Z" (whole account) or "first model back 14:10Z". */
export function coolingShort(a: Account, at: number): string | null {
  if (!coolingUntil(a, at)) return null;
  return `${a.coolScope === "credential" ? "back" : "first model back"} ${when(a.coolUntil!, at)}`;
}
/** An account's state word, its colour, and whether it can take work: over its limit, on credits, active, or
 *  cooling / its status. */
export function accountState(t: Theme, a: Account): [string, RGB, boolean] {
  if (a.over) return ["○ over", t.stuck, false];
  if (a.status === "active" && !a.cooling) return a.onCredits ? ["● on credits", t.info, true] : ["● active", t.working, true];
  return [a.cooling ? "○ cooling" : `○ ${a.status}`, t.blocked, false];
}

export function kindColor(t: Theme, kind: string) {
  return ({ DONE: t.merged, QUEUED: t.info, CLAIMED: t.working, HANDOFF: t.violet, BLOCKED: t.blocked, RESUMED: t.info, PROOF: t.merged, UP: t.working, DOWN: t.stuck } as Record<string, any>)[kind] ?? t.dim;
}

export function footer(c: Ctx, keys: [string, string][], status: string): void {
  const { s, t, f } = c;
  if (c.cmd !== null && c.cmd !== undefined) {   // k9s-style command bar in place of the key hints
    s.fill(0, s.h - 2, s.w, 1, " ", { bg: t.panel });
    let x = s.put(1, s.h - 2, " : ", { fg: t.bg, bg: t.title, bold: true });
    x = s.put(x, s.h - 2, c.cmd, { fg: t.text, bg: t.panel, bold: true });
    s.put(x, s.h - 2, "█", { fg: t.title, bg: t.panel });
    const word = c.cmd.split(" ")[0];
    const hints = COMMANDS.filter((k) => k.startsWith(word)).join("  ");
    s.put(Math.max(x + 3, 40), s.h - 2, fit(hints || "unknown command", s.w - Math.max(x + 3, 40) - 2), { fg: hints ? t.dim : t.stuck, bg: t.panel });
    keys = [];
  }
  let x = 1;
  for (const [k, what] of keys) {
    if (x + k.length + what.length + 4 > s.w) break;
    x = s.put(x, s.h - 2, ` ${k} `, { fg: t.text, bg: t.border, bold: true });
    x = s.put(x + 1, s.h - 2, what, { fg: t.dim }) + 2;
  }
  // the warnings, most important first; when they don't fit, the stuck reason shortens, then the ctx count goes
  const owner = f.owner.length ? `▲ ${f.owner.length} owner decision${f.owner.length > 1 ? "s" : ""} waiting` : null;
  const stuck = (why: string) => f.stuck.length ? `${f.stuck[0].session} stuck: ${why}${f.stuck.length > 1 ? ` · +${f.stuck.length - 1} more stuck (Focus)` : ""}` : null;
  const ctx = f.ctxHigh.length ? `${f.ctxHigh.length} ctx ≥ 80%` : null, room = s.w - 12;
  const w = [[owner, stuck(f.stuck[0]?.why ?? ""), ctx], [owner, stuck(brief(f.stuck[0]?.why ?? "")), ctx], [owner, stuck(brief(f.stuck[0]?.why ?? ""))]]
    .map((xs) => xs.filter(Boolean).join(" · ")).find((x) => [...x].length <= room) ?? fit([owner, stuck(brief(f.stuck[0]?.why ?? ""))].filter(Boolean).join(" · "), room);
  s.put(1, s.h - 1, fit(status, Math.max(0, s.w - [...w].length - 5)), { fg: t.dim });
  if (w) s.put(s.w - [...w].length - 2, s.h - 1, w, { fg: f.owner.length ? t.owner : t.blocked });
  if (c.note) s.put(Math.max(1, Math.floor(s.w / 2) - 20), s.h - 1, ` ${c.note} `, { fg: t.bg, bg: t.title });
}

export const since = (raw: Raw, iso: string | null) => (iso ? ago(raw.at - Date.parse(iso)) : "—");
