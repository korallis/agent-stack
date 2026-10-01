// View 1, Mission Control (mockup A): six hero tiles you can read from across the room, one card per rig, the work in
// flight by stage, owner decisions, the account pool, system health, the event log and a live ticker. Best at 176+
// columns, graceful at 120: tiles and cards share the width, cards wrap to a second row, lower panels shrink.
import type { RGB } from "../term.ts";
import { bigNumber, bigWidth, braille, fit, meter, panel, rpad, sparkline } from "../draw.ts";
import { podsOf, natural, type Activity, type Seat } from "../model.ts";
import type { History } from "../history.ts";
import { footer, header, kindColor, since, ticker, type Ctx } from "./chrome.ts";

export const DOT: Record<Activity, string> = { working: "●", idle: "○", stuck: "◆", unknown: "?", detached: "·", stopped: "·" };
export function dotColor(c: Ctx, a: Activity): RGB {
  const t = c.t;
  return ({ working: t.working, idle: t.idle, stuck: t.stuck, unknown: t.blocked, detached: t.faint, stopped: t.faint } as Record<Activity, RGB>)[a];
}

export function home(c: Ctx, hist: History): void {
  const { s, t, f, raw } = c;
  header(c, "MISSION CONTROL");
  let y = 2;
  // ── hero tiles ──
  const n = 6, tw = Math.floor((s.w - 2) / n);
  const top = (xs: [string, number][]) => xs.sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0);
  const perRig = (a: Activity) => top(Object.entries(f.byRig).map(([r, c2]) => [r, c2[a]]));
  const pairs = (xs: [string, number][], w: number) => {
    const out: string[] = []; let line = "";
    for (const [k, v] of xs) { const p = `${k} ${v}`; if ([...line].length + p.length + 2 > w && line) { out.push(line); line = ""; } line += (line ? "  " : "") + p; }
    if (line) out.push(line); return out;
  };
  const now = raw.at;
  // narrow tiles (under 26 cells) show the figure in plain bold over a full-width breakdown instead of block digits
  const big = tw >= 26;
  const lw0 = (v: number) => (big ? tw - 1 - (3 + bigWidth(String(v))) - 1 : tw - 5);
  const tiles: { title: string; value: number; color: RGB; lines: [string, RGB?][]; spark?: number[] }[] = [
    { title: "WORKING", value: f.count.working, color: t.working, lines: [[`of ${f.agents.length} seats`, t.dim], ...pairs(perRig("working"), lw0(f.count.working)).map((l) => [l] as [string])], spark: hist.series("working", 24, now) },
    { title: "IDLE", value: f.count.idle, color: t.idle, lines: [[`of ${f.agents.length} seats`, t.dim], ...pairs(perRig("idle"), lw0(f.count.idle)).map((l) => [l] as [string])], spark: hist.series("idle", 24, now) },
    { title: "STUCK", value: f.stuck.length, color: f.stuck.length ? t.stuck : t.faint,
      // derived, conservative (phase 4): each with its reason; quiet seats that aren't stuck are counted apart
      // one stuck seat: its full reason, wrapped; several: the seats, and Focus has each reason
      lines: f.stuck.length === 1 ? [[f.stuck[0].session, t.stuck] as [string, RGB], ...wrap(f.stuck[0].why ?? "", lw0(1)).slice(0, 4).map((l) => [l, t.dim] as [string, RGB])]
        : f.stuck.length ? f.stuck.slice(0, 4).map((x) => [x.session, t.stuck] as [string, RGB]).concat([[f.stuck.length > 4 ? `+${f.stuck.length - 4} more · reasons: Focus` : "reasons: Focus (4)", t.dim]])
        : [["none stuck", t.dim], [f.unknown.length ? `${f.unknown.length} quiet, not stuck` : "every running seat", t.dim], [f.unknown.length ? "(Focus says why)" : "reports activity", t.dim]], spark: hist.series("stuck", 24, now) },
    { title: "BLOCKED", value: f.queue.blocked, color: f.queue.blocked ? t.blocked : t.faint,
      lines: [["queue rows", t.dim], [`on row ${f.queue.onRow}`], [`on PR ${f.queue.onPr}`], [`on owner ${f.queue.onOwner}`, f.queue.onOwner ? t.owner : undefined], [`pending ${f.queue.pending}`, t.dim]], spark: hist.series("blocked", 24, now) },
    { title: "OWNER DECISIONS", value: f.owner.length, color: f.owner.length ? t.owner : t.faint,
      lines: f.owner.length ? [["WAITING", t.owner] as [string, RGB], ...f.owner.slice(0, 3).map((q) => [`${q.id.slice(-8)} ${q.destination.split("@")[0]}`] as [string]), [`oldest ${since(raw, f.owner[0].created)}`, t.dim]]
        : [["none waiting", t.dim]] },
    { title: f.gate.partial ? "GATE TODAY ≥" : "GATE TODAY", value: f.gate.total, color: f.gate.total ? t.merged : t.faint,
      lines: [...(f.gate.partial ? [["PARTIAL: at least", t.blocked] as [string, RGB]] : []), [`${f.gate.merge} merge ✓`, t.merged], [`${f.gate.hold} hold ▲`, f.gate.hold ? t.blocked : t.dim], [`${f.gate.uncertain} uncertain`, t.violet], [`${f.gate.act} act band`, t.dim], ["since 00:00 UTC", t.faint]], spark: hist.series("gateToday", 24, now) },
  ];
  tiles.forEach((tile, i) => {
    const x = 1 + i * tw, w = tw - 1;
    panel(s, t, x, y, w, 8, w < 20 ? tile.title.split(" ")[0] + (tile.title.endsWith("≥") ? "≥" : "") : tile.title, { color: tile.value ? tile.color : t.border });
    const v = String(tile.value);
    if (big) {
      const bw = bigWidth(v);
      bigNumber(s, x + 2, y + 1, v, { fg: tile.color, bold: true });
      const lx = x + 3 + bw, lw = w - (lx - x) - 1;
      if (lw > 4) tile.lines.slice(0, 5).forEach(([txt, col], k) => s.put(lx, y + 1 + k, fit(txt, lw), { fg: col ?? t.text }));
    } else {
      s.put(x + 2, y + 1, v, { fg: tile.color, bold: true });
      tile.lines.slice(0, 4).forEach(([txt, col], k) => s.put(x + 2, y + 2 + k, fit(txt, w - 4), { fg: col ?? t.text }));
    }
    if (tile.spark && w > 14) {
      const sw = Math.min(24, w - 8);
      s.put(x + 2, y + 6, sparkline(tile.spark, sw), { fg: tile.color === t.faint ? t.faint : tile.color });
      s.put(x + 3 + sw, y + 6, "24h", { fg: t.faint });
    }
  });
  y += 9;

  // ── rig cards ──
  const rigs = f.rigs;
  // every rig on one row when cards can be 19+ wide; narrow cards (< 26) drop the pod labels and keep the dots
  const per = Math.max(1, Math.min(rigs.length || 1, Math.floor((s.w - 2) / (Math.floor((s.w - 2) / Math.max(1, rigs.length)) >= 19 ? 19 : 27))));
  const cw = Math.floor((s.w - 2) / per);
  rigs.forEach((r, i) => {
    const row = Math.floor(i / per), x = 1 + (i % per) * cw, cy = y + row * 8, w = cw - 1;
    const sel = c.rigFocus === i;
    const hcol = r.health === "ok" ? t.working : r.health === "degraded" ? t.blocked : t.stuck;
    panel(s, t, x, cy, w, 8, r.rig.name, { color: sel ? t.title : t.border, titleColor: sel ? t.title : t.text });
    const hl = cw >= 27 ? `● ${r.health}` : "●";
    s.put(x + w - 2 - [...hl].length, cy, hl, { fg: hcol });
    // pods as "label dots" tokens, wrapped over four lines
    const tokens = podsOf(r.rig.seats.filter((x2) => x2.kind === "agent")).map((pod) => {
      const ss = r.rig.seats.filter((x2) => x2.pod === pod && x2.kind === "agent").sort((a, b) => natural(a.name, b.name));
      return { pod, ss };
    });
    let line = 0, px = x + 2;
    for (const tok of tokens) {
      const labels = cw >= 27;
      const need = (labels ? tok.pod.length + 1 : 0) + Math.min(tok.ss.length, 11) + (labels ? 2 : 1);
      if (px + need > x + w - 1) { line++; px = x + 2; }
      if (line > 3) break;
      if (labels) px = s.put(px, cy + 1 + line, tok.pod + " ", { fg: t.dim });
      for (const seat of tok.ss.slice(0, 11)) px = s.put(px, cy + 1 + line, DOT[seat.activity], { fg: dotColor(c, seat.activity) });
      if (tok.ss.length > 11) px = s.put(px, cy + 1 + line, "+", { fg: t.dim });
      px += labels ? 2 : 1;
    }
    const k = r.count;
    if (cw < 27) {
      let nx = s.put(x + 2, cy + 5, `${k.working}●`, { fg: k.working ? t.working : t.dim });
      nx = s.put(nx + 1, cy + 5, `${k.idle}○`, { fg: t.idle });
      if (k.stuck + k.unknown) nx = s.put(nx + 1, cy + 5, `${k.stuck + k.unknown}◆`, { fg: t.stuck });
      if (k.detached + k.stopped) s.put(nx + 1, cy + 5, `${k.detached + k.stopped}·`, { fg: t.faint });
      s.put(x + 2, cy + 6, fit(`ctx ${r.ctxMax ?? "—"}% · ${r.rows}r`, w - 4), { fg: (r.ctxMax ?? 0) >= 80 ? t.stuck : t.dim });
      return;
    }
    let sx = s.put(x + 2, cy + 5, `${k.working} wrk`, { fg: k.working ? t.working : t.dim });
    sx = s.put(sx + 2, cy + 5, `${k.idle} idle`, { fg: t.idle });
    if (k.stuck + k.unknown) sx = s.put(sx + 2, cy + 5, `${k.stuck + k.unknown} stuck`, { fg: t.stuck });
    if (k.detached + k.stopped) s.put(sx + 2, cy + 5, `${k.detached + k.stopped} down`, { fg: t.faint });
    s.put(x + 2, cy + 6, fit(`ctx ${r.ctxAvg ?? "—"}%/${r.ctxMax ?? "—"}%  ${r.rows} rows`, w - 4), { fg: (r.ctxMax ?? 0) >= 80 ? t.stuck : t.dim });
  });
  y += Math.max(1, Math.ceil(rigs.length / per)) * 8 + 1;

  // ── work in flight by stage ──
  s.put(2, y, "WORK IN FLIGHT", { fg: t.title, bold: true });
  s.put(17, y, "· active queue rows by the role they wait on · left → right", { fg: t.dim });
  const sw = Math.floor((s.w - 4) / f.stages.length);
  f.stages.forEach((st, i) => {
    const x = 2 + i * sw, total = st.pending + st.inProgress + st.blocked;
    s.put(x, y + 1, st.label, { fg: t.text, bold: true });
    if (i < f.stages.length - 1) s.put(x + st.label.length + 1, y + 1, "─".repeat(Math.max(0, sw - st.label.length - 3)) + "▶", { fg: t.faint });
    s.put(x, y + 2, String(total), { fg: total ? (st.blocked > st.inProgress + st.pending ? t.blocked : t.working) : t.faint, bold: true });
    s.put(x, y + 3, fit(sw >= 21 ? `${st.inProgress} act ${st.pending} pend ${st.blocked} blk` : `${st.inProgress}a ${st.pending}p ${st.blocked}b`, sw - 1), { fg: st.blocked ? t.blocked : t.dim });
  });
  let qx = s.put(2, y + 4, "QUEUE ", { fg: t.title, bold: true });
  qx = s.put(qx, y + 4, `${f.queue.pending} pending  `, { fg: t.text });
  qx = s.put(qx, y + 4, `${f.queue.inProgress} in progress  `, { fg: t.working });
  qx = s.put(qx, y + 4, `${f.queue.blocked} blocked `, { fg: t.blocked });
  qx = s.put(qx, y + 4, `(on row ${f.queue.onRow} · on PR ${f.queue.onPr} · on owner ${f.queue.onOwner} · other ${f.queue.onOther})`, { fg: t.dim });
  if (s.w - qx < 50) { y += 6; } else {
  qx = s.put(qx + 2, y + 4, "│  GATE today ", { fg: t.faint });
  qx = s.put(qx, y + 4, `${f.gate.partial ? "≥" : ""}${f.gate.total}${f.gate.partial ? " (partial)" : ""}  `, { fg: f.gate.partial ? t.blocked : t.text, bold: true });
  qx = s.put(qx, y + 4, `${f.gate.merge} merge ✓  `, { fg: t.merged });
  qx = s.put(qx, y + 4, `${f.gate.hold} hold ▲  `, { fg: f.gate.hold ? t.blocked : t.dim });
  s.put(qx, y + 4, `${f.gate.uncertain} uncertain`, { fg: t.violet });
  y += 6; }

  // ── lower panels: decisions, accounts, system | events ──
  const bottom = s.h - 4, avail = bottom - y;
  if (avail >= 6) {
    const lw = Math.max(60, Math.floor(s.w * 0.5)), rx = 1 + lw + 1, rw = s.w - rx - 1;
    let ly = y;
    const oh = Math.min(5, Math.max(3, f.owner.length + 2));
    panel(s, t, 1, ly, lw, oh, "OWNER DECISIONS", { color: f.owner.length ? t.owner : t.border, right: f.owner.length ? `${f.owner.length} waiting` : "none" });
    if (!f.owner.length) s.put(3, ly + 1, "Nothing is waiting on the owner (OpenRig attention rows).", { fg: t.dim });
    f.owner.slice(0, oh - 2).forEach((q, i) => {
      let x = s.put(3, ly + 1 + i, ` ${q.id.slice(-8)} `, { fg: t.bg, bg: t.owner, bold: true });
      x = s.put(x + 1, ly + 1 + i, fit(q.summary ?? q.tags.find((g) => g.startsWith("slice:"))?.slice(6) ?? q.source, lw - 30), { fg: t.text });
      s.put(1 + lw - 10, ly + 1 + i, rpad(since(raw, q.created), 7), { fg: t.owner });
    });
    ly += oh;
    const room = bottom - ly;
    const accH = Math.min(raw.accounts.length + 2, Math.max(0, room - 5));
    if (accH >= 3) {
      panel(s, t, 1, ly, lw, accH, "ACCOUNT POOL", { right: "local proxy · 5h window / weekly" });
      raw.accounts.slice(0, accH - 2).forEach((a, i) => {
        const yy = ly + 1 + i, mw = Math.max(6, Math.floor((lw - 50) / 2));
        s.put(3, yy, fit(a.label, 10), { fg: t.text });
        s.put(14, yy, a.provider === "claude" ? "cl" : a.provider === "codex" ? "cx" : a.provider === "kimi" ? "km" : fit(a.provider, 2), { fg: t.dim });
        s.put(17, yy, "5h", { fg: t.faint });
        const col = (v: number | null) => (v === null ? t.faint : v >= 95 ? t.stuck : v >= 75 ? t.blocked : t.working);
        meter(s, t, 20, yy, mw, a.short === null ? null : a.short / 100, col(a.short));
        s.put(21 + mw, yy, rpad(a.short === null ? "—" : `${a.short}%`, 4), { fg: col(a.short) });
        s.put(27 + mw, yy, "wk", { fg: t.faint });
        meter(s, t, 30 + mw, yy, mw, a.weekly === null ? null : a.weekly / 100, col(a.weekly));
        s.put(31 + 2 * mw, yy, rpad(a.weekly === null ? "—" : `${a.weekly}%`, 4), { fg: col(a.weekly) });
        s.put(37 + 2 * mw, yy, fit(a.status === "active" && !a.cooling ? "● active" : a.cooling ? "○ cooling" : `○ ${a.status}`, lw - 38 - 2 * mw), { fg: a.status === "active" && !a.cooling ? t.working : t.blocked });
      });
      ly += accH;
    }
    const sysH = Math.min(5, bottom - ly);
    if (sysH >= 3) {
      panel(s, t, 1, ly, lw, sysH, "SYSTEM");
      const d = raw.daemon;
      const heavy = raw.heavy.map((h) => `${h.cls} ${h.held}/${h.total}${h.waiting ? ` (+${h.waiting} waiting)` : ""}`).join("  ") || "heavy slots —";
      const lines: [string, RGB][] = [
        [`daemon ${d.ok ? "ok" : "unreachable"} ${d.version ?? ""} · cpu ${d.cpuPct ?? "—"}% · loop ${d.loopUtil === null ? "—" : Math.round(d.loopUtil * 100) + "%"} · healthz ${d.latencyMs ?? "—"}ms`, d.ok ? t.text : t.stuck],
        [`load ${raw.host.load.map((v) => v.toFixed(1)).join(" ")} / ${raw.host.cores} cores · mem ${raw.host.memUsedGB.toFixed(1)}/${Math.round(raw.host.memTotalGB)} GB · ${heavy}`, t.text],
        [`refresh every ${Math.round(raw.refreshMs / 1000)}s${raw.refreshMs > 5000 ? " (backed off)" : ""} · sources ${Object.entries(raw.sources).map(([k, v]) => `${k} ${v === "ok" ? "✓" : v === "partial" ? "partial" : "✗"}`).join(" ")}`, t.dim],
      ];
      lines.slice(0, sysH - 2).forEach(([l, col], i) => s.put(3, ly + 1 + i, fit(l, lw - 4), { fg: col }));
    }
    // events
    panel(s, t, rx, y, rw, bottom - y, "EVENTS", { right: "newest first" });
    raw.events.slice(0, bottom - y - 2).forEach((e, i) => {
      const yy = y + 1 + i;
      s.put(rx + 2, yy, new Date(e.at).toISOString().slice(11, 19), { fg: t.faint });
      s.put(rx + 11, yy, fit(e.kind, 8), { fg: kindColor(t, e.kind), bold: true });
      s.put(rx + 20, yy, fit(e.rig ?? "", 10), { fg: t.dim });
      s.put(rx + 31, yy, fit(e.text, rw - 33), { fg: t.text });
    });
    if (!raw.events.length) s.put(rx + 2, y + 1, "No live events yet (the stream joins near the tail).", { fg: t.faint });
    if (avail >= 14 && bottom - y - 2 > raw.events.length + 6 && hist.samples.length > 1) {
      const gy = bottom - 6;
      s.put(rx + 2, gy, "working seats · 24 h", { fg: t.dim });
      braille(s, t, rx + 2, gy + 1, rw - 4, 4, hist.series("working", (rw - 4) * 2, now), { color: t.working });
    }
  }
  ticker(c, s.h - 3);
  footer(c, [["⏎", "rig seats"], ["←→", "select rig"], ["1-5", "views"], ["r", "refresh"], ["?", "help"], ["q", "quit"]],
    `[mission control] ${raw.host.id} · ${f.agents.length} seats · read-only · as of ${new Date(raw.at).toISOString().slice(11, 19)} UTC`);
}

/** Words into lines of at most `w` cells (a word longer than a line is cut). */
export function wrap(text: string, w: number): string[] {
  const out: string[] = []; let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word.slice(0, w);
    else if (line.length + 1 + word.length <= w) line += ` ${word}`;
    else { out.push(line); line = word.slice(0, w); }
  }
  if (line) out.push(line);
  return out;
}
export function seatsOf(r: { seats: Seat[] }) { return r.seats.filter((x) => x.kind === "agent"); }
