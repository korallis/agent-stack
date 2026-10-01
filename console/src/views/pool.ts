// View 5, Pool & System: the 24 h telemetry as large btop-style braille graphs (colour along the value axis), the
// subscription pool with gradient meters, and system health. Each pane expands with 'e'.
import type { RGB } from "../term.ts";
import { braille, fit, panel, rpad } from "../draw.ts";
import { gradient } from "../theme.ts";
import type { History } from "../history.ts";
import { accountState, footer, header, ticker, type Ctx } from "./chrome.ts";

export const POOL_PANES = ["working", "queue", "gate", "accounts", "system"];

/** A meter filled with the theme's value gradient, cell by cell (btop). */
function gmeter(c: Ctx, x: number, y: number, w: number, frac: number | null, flat?: RGB): void {
  const { s, t } = c;
  if (frac === null) { s.put(x, y, "·".repeat(w), { fg: t.faint }); return; }
  const f = Math.max(0, Math.min(w, Math.round(Math.min(1, frac) * w)));
  for (let i = 0; i < w; i++) s.put(x + i, y, i < f ? "█" : "░", { fg: i < f ? flat ?? gradient(t, i / Math.max(1, w - 1)) : t.faint });
}

export function poolView(c: Ctx, hist: History): void {
  const { s } = c;
  header(c, "POOL & SYSTEM");
  const pane = POOL_PANES[(c.pane ?? 0) % POOL_PANES.length];
  if (c.expand) { poolPane(c, hist, pane, 1, 2, s.w - 2, s.h - 5); }
  else {
    const top = 2, gh = Math.max(8, Math.floor((s.h - 6 - top) * 0.55)), gw = Math.floor((s.w - 2) / 3);
    POOL_PANES.slice(0, 3).forEach((p, i) => poolPane(c, hist, p, 1 + i * gw, top, gw - 1, gh));
    const y2 = top + gh, lw = Math.floor((s.w - 2) * 0.55);
    poolPane(c, hist, "accounts", 1, y2, lw, s.h - 4 - y2);
    poolPane(c, hist, "system", 2 + lw, y2, s.w - 3 - lw, s.h - 4 - y2);
  }
  ticker(c, s.h - 3);
  footer(c, [["Tab", `pane: ${pane}`], ["e", c.expand ? "collapse" : "expand"], [":", "command"], ["1-5", "views"], ["?", "help"], ["q", "quit"]],
    `[pool] 24 h graphs from the local history (one sample a minute) · read-only`);
}

export function poolPane(c: Ctx, hist: History, pane: string, x: number, y: number, w: number, h: number): void {
  const { s, t, raw, f } = c;
  const focused = POOL_PANES[(c.pane ?? 0) % POOL_PANES.length] === pane;
  const color = focused ? t.title : t.border;
  if (pane === "working" || pane === "queue" || pane === "gate") {
    const n = (w - 4) * 2, now = raw.at;
    const series = pane === "working" ? hist.series("working", n, now)
      : pane === "queue" ? hist.series("pending", n, now).map((v, i, a) => v + hist.series("inProgress", n, now)[i] + hist.series("blocked", n, now)[i])
      : hist.series("gateToday", n, now);
    const nowV = pane === "working" ? `${f.count.working} now` : pane === "queue" ? `${f.queue.pending + f.queue.inProgress + f.queue.blocked} rows` : `${f.gate.partial ? "≥" : ""}${f.gate.total} today`;
    const title = pane === "working" ? "WORKING SEATS" : pane === "queue" ? "QUEUE DEPTH" : "GATE DECISIONS";
    panel(s, t, x, y, w, h, w >= 44 ? `${title} · 24 h` : title, { color, right: nowV });   // narrow: the axis says 24 h
    if (hist.samples.length > 1) {
      const max = Math.max(1, ...series);
      braille(s, t, x + 2, y + 1, w - 4, h - 3, series, { max });
      s.put(x + 2, y + h - 2, "-24h", { fg: t.faint }); s.put(x + w - 6, y + h - 2, "now", { fg: t.faint });
      s.put(x + Math.floor(w / 2) - 6, y + h - 2, `peak ${Math.round(max)}`, { fg: t.dim });
    } else s.put(x + 2, y + 1, fit("collecting: one sample a minute", w - 4), { fg: t.faint });
    return;
  }
  if (pane === "accounts") {
    panel(s, t, x, y, w, h, "SUBSCRIPTION POOL", { color, right: w >= 72 ? "local proxy · 5 h window / weekly" : undefined });
    const mw = Math.max(6, Math.floor((w - 48) / 2));
    s.put(x + 2, y + 1, fit("ACCOUNT    PROV  5 H" + " ".repeat(mw + 2) + "WEEK", w - 4), { fg: t.faint });
    raw.accounts.slice(0, h - 3).forEach((a, i) => {
      const yy = y + 2 + i, [word, wc] = accountState(t, a);
      // a window used up while the account runs on credits is drawn flat in the info colour: used, not exhausted
      const flat = (v: number | null) => (a.onCredits && (v ?? 0) >= 100 ? t.info : undefined);
      s.put(x + 2, yy, fit(a.label, 10), { fg: t.text });
      s.put(x + 13, yy, fit(a.provider === "claude" ? "cl" : a.provider === "codex" ? "cx" : "km", 4), { fg: t.dim });
      gmeter(c, x + 19, yy, mw, a.short === null ? null : a.short / 100, flat(a.short));
      s.put(x + 20 + mw, yy, rpad(a.short === null ? "—" : `${a.short}%`, 5), { fg: (a.short ?? 0) > 100 ? t.stuck : a.short === null ? t.faint : t.text });
      gmeter(c, x + 27 + mw, yy, mw, a.weekly === null ? null : a.weekly / 100, flat(a.weekly));
      s.put(x + 28 + 2 * mw, yy, rpad(a.weekly === null ? "—" : `${a.weekly}%`, 5), { fg: (a.weekly ?? 0) > 100 ? t.stuck : a.weekly === null ? t.faint : t.text });
      s.put(x + 35 + 2 * mw, yy, fit(word, w - 37 - 2 * mw), { fg: wc });
    });
    if (!raw.accounts.length) s.put(x + 2, y + 2, "proxy status unavailable", { fg: t.faint });
    return;
  }
  // system
  panel(s, t, x, y, w, h, "SYSTEM", { color });
  const d = raw.daemon;
  const lines: [string, RGB][] = [
    [`daemon ${d.ok ? "ok" : "unreachable"} ${d.version ?? ""}`, d.ok ? t.working : t.stuck],
    [`cpu ${d.cpuPct ?? "—"}% · event loop ${d.loopUtil === null ? "—" : Math.round(d.loopUtil * 100) + "%"} · healthz ${d.latencyMs ?? "—"}ms`, t.text],
    [`load ${raw.host.load.map((v) => v.toFixed(1)).join(" ")} / ${raw.host.cores} cores`, t.text],
    [`memory ${raw.host.memUsedGB.toFixed(1)} / ${Math.round(raw.host.memTotalGB)} GB`, t.text],
    [`heavy ${raw.heavy.map((hh) => `${hh.cls} ${hh.held}/${hh.total}${hh.waiting ? ` +${hh.waiting} waiting` : ""}`).join(" · ") || "—"}`, t.text],
    [`refresh every ${Math.round(raw.refreshMs / 1000)}s · sources ${Object.entries(raw.sources).map(([k, v]) => `${k} ${v === "ok" ? "✓" : v}`).join(" ")}`, t.dim],
  ];
  lines.slice(0, h - 2).forEach(([l, col], i) => s.put(x + 2, y + 1 + i, fit(l, w - 4), { fg: col }));
  if (h - 2 > lines.length + 1) { s.put(x + 2, y + 2 + lines.length, "memory", { fg: t.faint }); gmeter(c, x + 10, y + 2 + lines.length, Math.min(30, w - 14), raw.host.memTotalGB ? raw.host.memUsedGB / raw.host.memTotalGB : null); }
}
