// View 2, the Seat Matrix (mockup D): every seat of every rig in one grid, rigs as rows and pods as column groups.
// A cell is one seat: its context use in figures over a background that brightens with it (red past 80%), and its
// activity as a glyph and colour below. Empty slots stay visible so each rig keeps its shape. 24 h braille telemetry
// on the left, the account pool on the right (each drops away when the terminal is too narrow).
import type { RGB } from "../term.ts";
import { braille, fit, meter, panel, rpad } from "../draw.ts";
import { podsOf, natural, POD_ORDER, type Seat } from "../model.ts";
import type { History } from "../history.ts";
import { ctxShade } from "../theme.ts";
import { footer, header, kindColor, since, ticker, type Ctx } from "./chrome.ts";
import { DOT, dotColor } from "./home.ts";

export interface Grid { pods: { pod: string; width: number }[]; rows: { rig: string; compact: boolean; cells: (Seat | null)[] }[] }
/** The matrix layout: per team pod, as many columns as its largest rig has seats; each rig's seats in natural order.
 *  A rig with none of the team pods (a kernel, a two-seat pair) is drawn compact: its seats in a row from the first
 *  column, so it doesn't widen the grid. */
export function grid(c: Ctx): Grid {
  const agentsOf = (r: { seats: Seat[] }) => r.seats.filter((x) => x.kind === "agent");
  const team = c.raw.rigs.filter((r) => agentsOf(r).some((x) => POD_ORDER.includes(x.pod)));
  const basis = team.length ? team : c.raw.rigs;
  const pods = podsOf(basis.flatMap(agentsOf)).map((pod) => ({ pod, width: Math.max(...basis.map((r) => agentsOf(r).filter((x) => x.pod === pod).length)) }));
  const total = pods.reduce((n, p) => n + p.width, 0);
  const rows = c.raw.rigs.map((r) => {
    const compact = !basis.includes(r);
    const cells = compact
      ? Array.from({ length: total }, (_, i) => agentsOf(r).sort((a, b) => natural(a.session, b.session))[i] ?? null)
      : pods.flatMap(({ pod, width }) => {
        const ss = agentsOf(r).filter((x) => x.pod === pod).sort((a, b) => natural(a.name, b.name));
        return Array.from({ length: width }, (_, i) => ss[i] ?? null);
      });
    return { rig: r.name, compact, cells };
  });
  return { pods, rows };
}
const SHORT: Record<string, string> = { coord: "CO", arch: "AR", impl: "IM", integ: "IN", ops: "OP", qa: "QA", review: "RV", tests: "TS" };
const podLabel = (pod: string, cells: number) => (pod.length <= cells ? pod.toUpperCase() : (SHORT[pod] ?? pod.slice(0, cells).toUpperCase()).slice(0, cells));

export function matrix(c: Ctx, hist: History): void {
  const { s, t, f, raw } = c;
  header(c, "SEAT MATRIX");
  let y = 2;
  // owner inbox first: the one thing only the owner can unblock
  if (f.owner.length) {
    const h = Math.min(5, f.owner.length + 2);
    panel(s, t, 1, y, s.w - 2, h, `OWNER INBOX · ${f.owner.length} WAITING`, { color: t.owner });
    f.owner.slice(0, h - 2).forEach((q, i) => s.put(3, y + 1 + i, fit(`${q.id.slice(-8)}  ${q.destination}  ${q.summary ?? q.tags.join(" ")}  · waiting ${since(raw, q.created)}`, s.w - 6), { fg: t.text }));
    y += h;
  } else {
    s.put(2, y, "◆ OWNER INBOX", { fg: t.owner, bold: true }); s.put(17, y, "nothing waiting on the owner", { fg: t.dim }); y += 1;
  }
  let x = s.put(2, y, `AGENTS ${f.agents.length}`, { fg: t.text, bold: true });
  for (const [label, v, col] of [["WORKING", f.count.working, t.working], ["IDLE", f.count.idle, t.idle], ["STUCK/UNKNOWN", f.stuck.length, f.stuck.length ? t.stuck : t.dim],
    ["DOWN", f.count.detached + f.count.stopped, t.faint], ["BLOCKED ROWS", f.queue.blocked, t.blocked], ["CTX ≥ 80%", f.ctxHigh.length, f.ctxHigh.length ? t.stuck : t.dim], ["GATE TODAY", f.gate.total, t.merged]] as [string, number, RGB][]) {
    x = s.put(x + 3, y, `${label} `, { fg: t.dim });
    x = s.put(x, y, String(v), { fg: col, bold: true });
  }
  y += 2;

  const g = grid(c);
  const need = 15 + g.pods.reduce((n, p) => n + p.width * 3 + 1, 0) + 13;
  const showLeft = s.w - 2 - need >= 29, showRight = s.w - 2 - need >= 57;
  const lw = showLeft ? 29 : 0, rw = showRight ? 28 : 0;
  const mx = 1 + lw, mw = s.w - 2 - lw - rw - (rw ? 1 : 0);
  const bottom = s.h - 7;
  const mh = Math.min(bottom - y, Math.max(18, g.rows.length * 3 + 4));

  // ── matrix ──
  panel(s, t, mx, y, mw, mh, `SEAT MATRIX · ${f.agents.length} AGENTS`, { right: `${f.count.detached + f.count.stopped} down` });
  const gx = mx + 15;
  let cx = gx;
  for (const p of g.pods) {
    s.put(cx, y + 1, podLabel(p.pod, p.width * 3 - 1), { fg: t.dim, bold: true });
    for (let i = 0; i < p.width; i++) s.put(cx + i * 3, y + 2, String(i + 1).padStart(2, "0"), { fg: t.faint });
    cx += p.width * 3 + 1;
  }
  const sumX = Math.min(cx + 1, mx + mw - 13);
  s.put(sumX, y + 1, "W / I / ?", { fg: t.dim }); s.put(sumX, y + 2, "rows", { fg: t.faint });
  let flat: Seat | null = null;
  g.rows.forEach((row, ri) => {
    const ry = y + 3 + ri * 3;
    if (ry + 1 >= y + mh - 1) return;
    const sel = c.seatFocus[0] === ri;
    s.put(mx + 2, ry, fit((sel ? "▶ " : "  ") + row.rig, 12), { fg: sel ? t.title : t.text, bold: sel });
    if (row.compact) s.put(mx + 4, ry + 1, fit([...new Set(row.cells.filter(Boolean).map((x) => x!.pod))].join(" "), 10), { fg: t.faint });
    let px = gx, col = 0;
    for (const p of g.pods) {
      for (let i = 0; i < p.width; i++, col++) {
        const seat = row.cells[col];
        const focused = sel && c.seatFocus[1] === col;
        if (focused) flat = seat;
        if (!seat) { s.put(px + i * 3, ry, " ·", { fg: t.faint }); continue; }
        const live = seat.activity !== "detached" && seat.activity !== "stopped";
        const label = seat.ctx === null ? "--" : seat.ctx >= 100 ? "99" : String(seat.ctx).padStart(2, " ");
        s.put(px + i * 3, ry, label, { fg: live ? ((seat.ctx ?? 0) >= 80 ? t.text : t.text) : t.faint, bg: live ? ctxShade(t, seat.ctx) : t.panel, bold: (seat.ctx ?? 0) >= 80, inverse: focused });
        s.put(px + i * 3, ry + 1, " " + DOT[seat.activity], { fg: dotColor(c, seat.activity), inverse: focused });
      }
      px += p.width * 3 + 1;
    }
    const k = f.byRig[row.rig] ?? { working: 0, idle: 0, stuck: 0, unknown: 0, detached: 0, stopped: 0 };
    s.put(sumX, ry, `${rpad(k.working, 2)} / ${rpad(k.idle, 2)} / ${k.stuck + k.unknown}`, { fg: t.text });
    const rig = f.rigs.find((r) => r.rig.name === row.rig);
    s.put(sumX, ry + 1, `${rig?.rows ?? 0} rows${rig?.health === "down" ? " · down" : ""}`, { fg: rig?.health === "down" ? t.stuck : t.faint });
  });

  // ── telemetry (left) ──
  if (showLeft) {
    panel(s, t, 1, y, lw - 1, mh, "24H TELEMETRY");
    const gw = lw - 5, now = raw.at;
    const blocks: [string, string, number[], RGB][] = [
      ["WORKING SEATS", `${f.count.working} now`, hist.series("working", gw * 2, now), t.working],
      ["QUEUE DEPTH", `${f.queue.pending + f.queue.inProgress + f.queue.blocked} rows`, hist.series("blocked", gw * 2, now).map((v, i) => v + hist.series("pending", gw * 2, now)[i] + hist.series("inProgress", gw * 2, now)[i]), t.blocked],
      ["GATE DECISIONS", `${f.gate.total} today`, hist.series("gateToday", gw * 2, now), t.merged],
    ];
    const bh = Math.max(2, Math.min(4, Math.floor((mh - 2 - blocks.length * 3 - 3) / blocks.length)));
    let by = y + 1;
    for (const [title, val, series, col] of blocks) {
      if (by + bh + 2 >= y + mh - 3) break;
      s.put(3, by, title, { fg: t.dim }); s.put(lw - 2 - val.length, by, val, { fg: col });
      if (hist.samples.length > 1) braille(s, t, 3, by + 1, gw, bh, series, {});
      else s.put(3, by + 1, fit("collecting (1 sample a minute)", gw), { fg: t.faint });
      s.put(3, by + 1 + bh, "-24h", { fg: t.faint }); s.put(lw - 5, by + 1 + bh, "now", { fg: t.faint });
      by += bh + 3;
    }
    const heavy = raw.heavy.map((h) => `${h.cls} ${h.held}/${h.total}${h.waiting ? ` +${h.waiting}` : ""}`).join("  ");
    s.put(3, y + mh - 3, "AGENT-HEAVY", { fg: t.dim }); s.put(3, y + mh - 2, fit(heavy || "—", lw - 5), { fg: t.text });
  }
  // ── account pool (right) ──
  if (showRight) {
    const rx = s.w - 1 - rw;
    panel(s, t, rx, y, rw, mh, "SUBSCRIPTION POOL");
    s.put(rx + 2, y + 1, fit("ACCOUNT", 10) + "  5H   WEEK", { fg: t.faint });
    raw.accounts.slice(0, Math.floor((mh - 3) / 2)).forEach((a, i) => {
      const ay = y + 2 + i * 2, ok = a.status === "active" && !a.cooling, pct = (v: number | null) => rpad(v === null ? "—" : `${v}%`, 4);
      const col = (v: number | null) => (v === null ? t.faint : v >= 95 ? t.stuck : v >= 75 ? t.blocked : t.working);
      s.put(rx + 2, ay, fit(a.label, 10), { fg: t.text });
      s.put(rx + 13, ay, pct(a.short), { fg: col(a.short) });
      s.put(rx + 18, ay, pct(a.weekly), { fg: col(a.weekly) });
      s.put(rx + rw - 3, ay, ok ? "●" : "○", { fg: ok ? t.working : t.blocked });
      meter(s, t, rx + 2, ay + 1, rw - 4, a.short === null ? null : a.short / 100, col(a.short));
    });
    if (!raw.accounts.length) s.put(rx + 2, y + 1, "proxy status unavailable", { fg: t.faint });
  }

  // ── below the grid: context pressure, queue by rig, event tape ──
  const ly = y + mh, lh = bottom - ly;
  if (lh >= 5) {
    const w3 = Math.floor((s.w - 2) / 3);
    panel(s, t, 1, ly, w3 - 1, lh, "CONTEXT PRESSURE", { right: `${f.ctxHigh.length} ≥ 80%` });
    const hot = [...f.agents].filter((x) => x.ctx !== null && x.activity !== "detached").sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0)).slice(0, lh - 2);
    hot.forEach((x, i) => {
      const yy = ly + 1 + i, col = (x.ctx ?? 0) >= 80 ? t.stuck : (x.ctx ?? 0) >= 60 ? t.blocked : t.working;
      s.put(3, yy, fit(x.session, 26), { fg: t.text });
      meter(s, t, 30, yy, Math.max(4, w3 - 40), (x.ctx ?? 0) / 100, col);
      s.put(w3 - 8, yy, rpad(`${x.ctx}%`, 4), { fg: col, bold: (x.ctx ?? 0) >= 80 });
    });
    const qx0 = 1 + w3;
    panel(s, t, qx0, ly, w3 - 1, lh, "QUEUE BY RIG", { right: "pending · active · blocked" });
    const byRig = f.rigs.map((r) => {
      const rows = raw.queue.filter((q) => q.destination.endsWith(`@${r.rig.name}`));
      return { name: r.rig.name, p: rows.filter((q) => q.state === "pending").length, a: rows.filter((q) => q.state === "in-progress").length, b: rows.filter((q) => q.state === "blocked").length };
    }).filter((r) => r.p + r.a + r.b > 0).sort((a, b) => b.p + b.a + b.b - (a.p + a.a + a.b));
    const qmax = Math.max(1, ...byRig.map((r) => r.p + r.a + r.b)), bw = w3 - 30;
    byRig.slice(0, lh - 2).forEach((r, i) => {
      const yy = ly + 1 + i, scale = (v: number) => Math.round((v / qmax) * bw);
      s.put(qx0 + 2, yy, fit(r.name, 10), { fg: t.text });
      let bx = s.put(qx0 + 13, yy, "█".repeat(scale(r.p)), { fg: t.info });
      bx = s.put(bx, yy, "█".repeat(scale(r.a)), { fg: t.working });
      s.put(bx, yy, "█".repeat(scale(r.b)), { fg: t.blocked });
      s.put(qx0 + w3 - 15, yy, `${rpad(r.p, 3)}${rpad(r.a, 4)}${rpad(r.b, 4)}`, { fg: t.dim });
    });
    if (!byRig.length) s.put(qx0 + 2, ly + 1, "no active rows", { fg: t.faint });
    const ex = 1 + 2 * w3, ew = s.w - 1 - ex;
    panel(s, t, ex, ly, ew, lh, "EVENT TAPE", { right: "latest first" });
    raw.events.slice(0, lh - 2).forEach((e, i) => {
      const yy = ly + 1 + i;
      s.put(ex + 2, yy, new Date(e.at).toISOString().slice(11, 19), { fg: t.faint });
      s.put(ex + 11, yy, fit(e.kind, 8), { fg: kindColor(t, e.kind), bold: true });
      s.put(ex + 20, yy, fit(e.text, ew - 22), { fg: t.text });
    });
    if (!raw.events.length) s.put(ex + 2, ly + 1, "no live events yet", { fg: t.faint });
  }
  // ── legend, selection, exceptions ──
  let lx = s.put(2, bottom, "● working  ", { fg: t.working });
  lx = s.put(lx, bottom, "○ idle  ", { fg: t.idle });
  lx = s.put(lx, bottom, "◆ stuck  ", { fg: t.stuck });
  lx = s.put(lx, bottom, "? unknown  ", { fg: t.blocked });
  lx = s.put(lx, bottom, "· down / no seat    ", { fg: t.faint });
  lx = s.put(lx, bottom, "CTX shade ", { fg: t.dim });
  for (const v of [20, 40, 60, 80]) lx = s.put(lx, bottom, ` ${v} `, { fg: t.text, bg: ctxShade(t, v) }) + 1;
  s.put(lx + 1, bottom, "darker = lower · red ≥ 80% (compaction or handover due)", { fg: t.dim });
  const sel = flat as Seat | null;
  if (sel) {
    let sx = s.put(2, bottom + 1, "SELECTED ", { fg: t.dim });
    sx = s.put(sx, bottom + 1, sel.session, { fg: t.text, bold: true });
    sx = s.put(sx + 2, bottom + 1, `${DOT[sel.activity]} ${sel.activity}${sel.why ? ` (${sel.why})` : ""}`, { fg: dotColor(c, sel.activity) });
    s.put(sx + 2, bottom + 1, fit(`CTX ${sel.ctx ?? "—"}% · ${sel.runtime} ${sel.model ?? "—"} · assigned ${sel.assigned} / pending ${sel.pending} / in progress ${sel.inProgress} / blocked ${sel.blocked} · last activity ${since(raw, sel.lastActivityAt)} ago`, s.w - sx - 4), { fg: t.dim });
  } else s.put(2, bottom + 1, "SELECTED  — (an empty slot: this rig has no seat here)", { fg: t.faint });
  const exc = [...f.stuck.map((x) => `${x.session}: ${x.why ?? x.activity}`), ...f.rigs.filter((r) => r.health === "down").map((r) => `${r.rig.name}: down (${r.count.detached + r.count.stopped} seats)`)];
  s.put(2, bottom + 2, "EXCEPTIONS ", { fg: exc.length ? t.blocked : t.dim, bold: true });
  s.put(13, bottom + 2, fit(exc.join("  ·  ") || "none", s.w - 16), { fg: exc.length ? t.text : t.dim });
  ticker(c, s.h - 3);
  footer(c, [["hjkl/←↑↓→", "move"], ["⏎", "focus rig"], ["1-2", "views"], ["esc", "home"], ["r", "refresh"], ["?", "help"], ["q", "quit"]],
    `[seat matrix] ${g.rows.length} rigs · ${f.agents.length} seats · read-only`);
}
