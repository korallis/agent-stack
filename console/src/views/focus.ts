// View 4, Calm Focus (mockup E): "what needs me?" first (the owner's decisions, answered in Slack: the console only
// shows them), then the fleet pulse, a live timeline of outcomes and each rig's progress. And the seat drill-in: one
// seat's work, context and recent history beside its live terminal tail (the daemon's own transcript capture).
import type { RGB } from "../term.ts";
import { ago, fit, meter, panel, rpad } from "../draw.ts";
import { RIVER, doneToday, journey, slices, type Event, type QRow, type Seat } from "../model.ts";
import { footer, header, kindColor, since, ticker, type Ctx } from "./chrome.ts";
import { DOT, dotColor } from "./home.ts";

/** An owner decision's text split into a question, its detail and the lettered options (A … B … C …). */
export function decision(q: QRow): { title: string; detail: string; options: [string, string][] } {
  const text = (q.summary ?? q.tags.filter((t) => !/^(project|slice|mission):/.test(t)).join(" ")).trim();
  const at = text.search(/(?:^|\s)A[).:]?\s+\S/);
  const head = at >= 0 ? text.slice(0, at).trim() : text, opts = at >= 0 ? text.slice(at).trim() : "";
  const options: [string, string][] = [];
  for (const m of opts.matchAll(/\b([A-F])[).:]?\s+(.+?)(?=\s+[A-F][).:]?\s+\S|$)/g)) options.push([m[1], m[2].trim()]);
  const cut = head.search(/[.:?]\s/);
  return { title: cut > 0 ? head.slice(0, cut + 1) : head, detail: cut > 0 ? head.slice(cut + 2).trim() : "", options };
}

interface Item { at: string; icon: string; color: RGB; label: string; rig: string | null; text: string; seat: string | null }
/** The live timeline: events as outcomes, plus what is true now (context pressure, stuck seats). Newest first. */
export function timeline(c: Ctx): Item[] {
  const { t, raw, f } = c;
  const icon: Record<string, [string, RGB, string]> = {
    DONE: ["✓", t.merged, "Done"], QUEUED: ["›", t.info, "Queued"], CLAIMED: ["▸", t.working, "Claimed"], HANDOFF: ["⇢", t.violet, "Handed off"],
    BLOCKED: ["▲", t.blocked, "Blocked"], RESUMED: ["▸", t.info, "Resumed"], PROOF: ["✓", t.merged, "Proof"], UP: ["●", t.working, "Seat up"], DOWN: ["○", t.stuck, "Seat down"],
  };
  const items: Item[] = raw.events.map((e: Event) => {
    const [i, col, label] = icon[e.kind] ?? ["·", t.dim, e.kind];
    return { at: e.at, icon: i, color: col, label, rig: e.rig, text: e.text, seat: e.seat ?? null };
  });
  const now = new Date(raw.at).toISOString();
  for (const s of f.ctxHigh.slice(0, 4)) items.push({ at: now, icon: "▶", color: t.blocked, label: "Context", rig: s.rig, text: `${s.session} · ${s.ctx}% used · hand over before the next slice`, seat: s.session });
  for (const s of f.stuck.slice(0, 6)) items.push({ at: now, icon: "▲", color: t.stuck, label: "Stuck", rig: s.rig, text: `${s.session} · ${s.why}`, seat: s.session });
  for (const s of f.unknown.slice(0, 3)) items.push({ at: now, icon: "?", color: t.blocked, label: "Quiet", rig: s.rig, text: `${s.session} · ${s.why} · not stuck`, seat: s.session });
  // the verdicts lead, whatever the events' clocks say: a stuck seat is never below the fold
  const lead = (x: Item) => (x.label === "Stuck" ? 0 : x.label === "Quiet" ? 1 : 2);
  return items.sort((a, b) => lead(a) - lead(b) || b.at.localeCompare(a.at));
}

export const FOCUS_PANES = ["decisions", "timeline", "progress"];

export function focus(c: Ctx): void {
  const { s, t, raw, f } = c;
  header(c, "FOCUS");
  const pane = FOCUS_PANES[(c.pane ?? 0) % FOCUS_PANES.length];
  if (c.expand) { focusPane(c, pane, 1, 2, s.w - 2, s.h - 5); ticker(c, s.h - 3); return footerFor(c, pane); }
  // what needs me?
  let y = 2;
  s.put(2, y, "what needs me?", { fg: t.text, bold: true });
  const n = f.owner.length;
  s.put(s.w - 26, y, n ? `${String(n).padStart(2, "0")} decision${n > 1 ? "s" : ""} waiting` : "nothing waiting", { fg: n ? t.owner : t.dim });
  s.put(2, y + 1, n ? `${n === 1 ? "One call" : `${n} calls`} to make, answered in Slack. Everything else has a next step.` : "Nothing needs you. Everything else has a next step.", { fg: t.dim });
  y += 3;
  const dh = n ? 8 : 0;
  if (n) focusPane(c, "decisions", 1, y, s.w - 2, dh);
  y += dh;
  // fleet pulse
  s.put(2, y, "FLEET PULSE", { fg: t.dim, bold: true });
  const live = f.agents.filter((x) => x.activity !== "detached" && x.activity !== "stopped").length;
  s.put(s.w - 30, y, `${live} reporting / ${f.agents.length} seats`, { fg: t.faint });
  const cols: [number, string, RGB, string][] = [[f.count.working, "working", t.working, Object.entries(f.byRig).filter(([, k]) => k.working).map(([r, k]) => `${r} ${k.working}`).join(" · ")],
    [f.count.idle, "idle", t.idle, ""], [f.stuck.length, "stuck", f.stuck.length ? t.stuck : t.dim, f.stuck.length ? f.stuck.map((x) => x.session).slice(0, 2).join(" · ") : f.unknown.length ? `${f.unknown.length} quiet, not stuck (see the timeline)` : "every running seat reports activity"],
    [f.queue.blocked, "blocked rows", t.violet, `queue: ${f.queue.pending} pending · ${f.queue.inProgress} in progress · ${f.queue.blocked} blocked`]];
  const cw = Math.floor((s.w - 4) / 4);
  cols.forEach(([v, label, col, sub], i) => {
    const x = 2 + i * cw;
    let px = s.put(x, y + 2, String(v).padStart(2, "0"), { fg: col, bold: true });
    s.put(px + 2, y + 2, label, { fg: t.text });
    s.put(x, y + 3, fit(sub, cw - 2), { fg: t.dim });
  });
  const unknown = f.unknown.length;
  if (unknown) s.put(2 + 3 * cw + Math.min(cw - 18, 20), y + 2, `● ${unknown} unknown seat${unknown > 1 ? "s" : ""}`, { fg: t.blocked });
  if (f.stuck.length) s.put(2, y + 4, fit(`▲ ${f.stuck[0].session} stuck: ${f.stuck[0].why}${f.stuck.length > 1 ? ` · +${f.stuck.length - 1} more in the timeline` : ""}`, s.w - 4), { fg: t.stuck });
  y += 5;
  s.put(1, y, "─".repeat(s.w - 2), { fg: t.border });
  y += 1;
  const lw = Math.floor((s.w - 2) * 0.55), bottom = s.h - 5;
  focusPane(c, "timeline", 1, y, lw, bottom - y);
  focusPane(c, "progress", 2 + lw, y, s.w - 3 - lw, bottom - y);
  // status line
  const d = raw.daemon, heavy = raw.heavy.map((h) => `${h.held}/${h.total}`).join(" ");
  const acc = raw.accounts.filter((a) => a.short !== null).slice(0, 2).map((a) => `${a.label} ${a.short}%${a.weekly !== null ? ` / ${a.weekly}%` : ""}`).join(" · ");
  s.put(2, s.h - 4, fit(`● daemon ${d.cpuPct ?? "—"}% cpu · healthz ${d.latencyMs ?? "—"}ms · heavy slots ${heavy || "—"}   ${acc}   today ${f.gate.partial ? "≥" : ""}${f.gate.total} gate decisions · ${f.gate.merge} merge`, s.w - 4), { fg: t.dim });
  ticker(c, s.h - 3);
  footerFor(c, pane);
}

function footerFor(c: Ctx, pane: string) {
  footer(c, [["Tab", `pane: ${pane}`], ["j/k", "select"], ["⏎", pane === "timeline" ? "open seat" : pane === "progress" ? "open rig" : "open seat"], ["e", c.expand ? "collapse" : "expand"],
    [":", "command"], ["1-5", "views"], ["?", "help"], ["q", "quit"]], `[focus] owner decisions are answered in Slack; the console is read-only`);
}

/** One pane of the Focus view, in any rectangle (also full screen with 'e'). */
export function focusPane(c: Ctx, pane: string, x: number, y: number, w: number, h: number): void {
  const { s, t, raw, f } = c;
  const sel = c.select ?? 0, focused = FOCUS_PANES[(c.pane ?? 0) % FOCUS_PANES.length] === pane;
  if (pane === "decisions") {
    const per = c.expand ? 1 : Math.min(2, f.owner.length), dw = Math.floor(w / Math.max(1, per)) - 1;
    // expanded: as many cards as fit, scrolled so the selected one is drawn (QA PR92)
    const fitN = Math.max(1, Math.floor((h - 1) / 8)), at = Math.min(Math.max(0, sel), Math.max(0, f.owner.length - 1));
    const from = c.expand ? (focused ? Math.max(0, at - fitN + 1) : 0) : 0;
    const list = c.expand ? f.owner.slice(from, from + fitN) : f.owner.slice(focused ? Math.max(0, sel - 1) : 0).slice(0, per);
    if (c.expand && from > 0) s.put(x + w - 14, y, `▲ ${from} more`, { fg: t.title });
    if (c.expand && from + fitN < f.owner.length) s.put(x + w - 14, y + h - 1, `▼ ${f.owner.length - from - fitN} more`, { fg: t.title });
    list.forEach((q, i) => {
      const bx = c.expand ? x : x + i * (dw + 1), by = c.expand ? y + 1 + i * 8 : y, idx = f.owner.indexOf(q), on = focused && idx === sel % Math.max(1, f.owner.length);
      if (by + 7 > y + h && !(c.expand && i === 0)) return;
      const d = decision(q);
      panel(s, t, bx, by, c.expand ? w : dw, 7, "", { color: on ? t.title : t.border });
      s.put(bx + 2, by + 1, `${on ? "▶ " : ""}${String(idx + 1).padStart(2, "0")}  `, { fg: t.text, bold: true });
      s.put(bx + 8, by + 1, fit(d.title, (c.expand ? w : dw) - 11), { fg: t.text, bold: true });
      s.put(bx + 2, by + 2, fit(`${q.source || "?"}  /  ${q.tags.find((x) => x.startsWith("slice:"))?.slice(6) ?? q.id.slice(-8)}  /  waiting ${since(raw, q.created)}`, (c.expand ? w : dw) - 4), { fg: t.dim });
      s.put(bx + 2, by + 3, fit(d.detail, (c.expand ? w : dw) - 4), { fg: t.text });
      let ox = bx + 2;
      for (const [k, v] of d.options) { if (ox > bx + (c.expand ? w : dw) - 8) break; ox = s.put(ox, by + 4, `[${k}] ${v}`, { fg: t.blocked }, (c.expand ? w : dw) - (ox - bx) - 3) + 3; }
      if (!d.options.length) s.put(bx + 2, by + 4, "no lettered options in the row", { fg: t.faint });
      s.put(bx + 2, by + 5, fit(`answered in Slack (reply to the owner message) · ${q.destination} · ${q.priority}`, (c.expand ? w : dw) - 4), { fg: t.faint });
    });
    if (!f.owner.length) s.put(x + 2, y + 1, "Nothing needs you.", { fg: t.dim });
    return;
  }
  if (pane === "timeline") {
    const items = timeline(c);
    s.put(x + 1, y, "LIVE TIMELINE", { fg: focused ? t.title : t.dim, bold: true });
    s.put(x + w - 26, y, `following · ${new Date(raw.at).toISOString().slice(11, 19)}`, { fg: t.faint });
    const rows = Math.floor((h - 2) / 2), start = focused ? Math.max(0, Math.min(sel, items.length - 1) - rows + 1) : 0;
    items.slice(start, start + rows).forEach((it, i) => {
      const yy = y + 2 + i * 2, on = focused && start + i === sel;
      if (on) s.shade(x, yy, w, t.panel), s.shade(x, yy + 1, w, t.panel);
      s.put(x + 1, yy, new Date(it.at).toISOString().slice(11, 16), { fg: t.faint });
      s.put(x + 8, yy, it.icon, { fg: it.color, bold: true });
      s.put(x + 10, yy, fit(it.label, 12), { fg: it.color });
      s.put(x + 23, yy, fit(it.rig ?? "", 10), { fg: t.dim });
      s.put(x + 10, yy + 1, fit(it.text, w - 12), { fg: on ? t.text : t.dim });
    });
    if (!items.length) s.put(x + 1, y + 2, "quiet: no events yet", { fg: t.faint });
    return;
  }
  // progress: per rig, slices done today vs open, and what the rig waits on
  s.put(x + 1, y, "PROGRESS TODAY", { fg: focused ? t.title : t.dim, bold: true });
  s.put(x + 1, y + 1, "slices done today / open · what the rig waits on", { fg: t.faint });
  const all = slices(raw), done = doneToday(raw), rigs = raw.rigs.filter((r) => r.seats.some((z) => z.kind === "agent")).map((r) => r.name);
  // scrolled so the selected rig is drawn (QA PR92)
  const fitR = Math.max(1, Math.floor((h - 3) / 2)), selR = Math.min(Math.max(0, sel), Math.max(0, rigs.length - 1));
  const fromR = focused ? Math.max(0, selR - fitR + 1) : 0;
  if (fromR > 0) s.put(x + w - 12, y + 1, `▲ ${fromR} more`, { fg: t.title });
  if (fromR + fitR < rigs.length) s.put(x + w - 12, y + h - 1, `▼ ${rigs.length - fromR - fitR} more`, { fg: t.title });
  let ry = y + 3;
  rigs.forEach((rig, i) => {
    if (i < fromR || ry + 1 >= y + h) return;
    const open = all.filter((z) => z.rig === rig), d = (done[rig] ?? []).length, on = focused && i === sel;
    const owner = open.filter((z) => z.state === "owner").length, blocked = open.filter((z) => z.state === "blocked").length;
    const k = f.byRig[rig], down = k && k.working + k.idle + k.stuck + k.unknown === 0;
    const state = down ? ["stopped", t.violet] : owner ? ["owner needed", t.owner] : blocked > open.length / 2 && open.length ? ["mostly blocked", t.blocked] : open.length ? ["building", t.working] : ["quiet", t.dim];
    s.put(x + 1, ry, fit(`${on ? "▶ " : ""}${rig}`, 16), { fg: on ? t.title : t.text, bold: true });
    s.put(x + 18, ry, `${rpad(d, 3)} / ${rpad(open.length, 3)}`, { fg: t.dim });
    meter(s, t, x + 30, ry, Math.max(6, Math.min(16, w - 50)), open.length + d ? d / (open.length + d) : null, t.merged);
    s.put(x + 32 + Math.max(6, Math.min(16, w - 50)), ry, fit(state[0] as string, 16), { fg: state[1] as RGB });
    ry += 2;
  });
}

// ── the seat drill-in ────────────────────────────────────────────────────────────────────────────────────────────────
export const SEAT_PANES = ["work", "terminal"];
const tailOf = (c: Ctx, session: string) => (c.raw.tail?.session === session ? c.raw.tail : c.raw.tails?.[session] !== undefined ? { session, content: c.raw.tails[session], at: c.raw.at, state: "fixture", error: null } : null);
const tailLines = (c: Ctx, session: string) => (tailOf(c, session)?.content ?? "").split("\n").filter((l) => !/^--- SESSION BOUNDARY/.test(l)).map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => l || (i > 0 && a[i - 1]));

export function seatView(c: Ctx, session: string): void {
  const { s, t, raw } = c;
  const seat = raw.rigs.flatMap((r) => r.seats).find((x) => x.session === session) ?? null;
  header(c, `${seat?.rig ?? session.split("@")[1] ?? "?"} / ${seat?.pod ?? "?"} / ${seat?.name ?? session.split("@")[0]}`);
  const pane = SEAT_PANES[(c.pane ?? 0) % SEAT_PANES.length];
  if (c.expand) { seatPane(c, pane, session, seat, 1, 2, s.w - 2, s.h - 4); return seatFooter(c, pane, session); }
  let y = 2;
  s.put(2, y, session, { fg: t.text, bold: true });
  let endX = 4 + session.length;
  if (seat) {
    const x = s.put(endX, y, `${DOT[seat.activity]} ${seat.activity}${seat.why ? ` (${seat.why})` : ""}`, { fg: dotColor(c, seat.activity) });
    endX = s.put(x + 4, y, `${seat.model ?? "—"} · ${seat.runtime === "cx" ? "Codex" : seat.runtime === "cl" ? "Claude Code" : seat.runtime === "km" ? "Kimi" : seat.runtime}`, { fg: t.dim });
  } else endX = s.put(endX, y, "not a seat this daemon runs", { fg: t.blocked });
  const tl = tailOf(c, session);
  const status = tl ? (tl.content !== null ? `transcript tail · as of ${new Date(tl.at).toISOString().slice(11, 19)}` : "tail unavailable") : "tail: loading…";
  // the tail status never covers the seat's state or model (QA PR92): beside them when it fits, else on the next line
  const sx = Math.max(endX + 3, s.w - 2 - status.length), below = sx + status.length > s.w - 2;
  if (!below) s.put(sx, y, status, { fg: tl?.content !== null ? t.dim : t.blocked });
  else s.put(s.w - 2 - Math.min(status.length, Math.floor(s.w / 2)), y + 1, fit(status, Math.floor(s.w / 2)), { fg: tl?.content !== null ? t.dim : t.blocked });
  const work = raw.queue.filter((r) => r.destination === session);
  const sl = work.map((r) => r.tags.find((x) => x.startsWith("slice:"))).find(Boolean);
  s.put(2, y + 1, fit(sl ? `${sl.slice(6)}${seat ? ` · last activity ${since(raw, seat.lastActivityAt)} ago` : ""}` : seat ? `last activity ${since(raw, seat.lastActivityAt)} ago` : "", Math.floor(s.w / 2) - 4), { fg: t.dim });
  y += 3;
  s.put(1, y, "─".repeat(s.w - 2), { fg: t.border });
  const lw = Math.floor((s.w - 2) * 0.42);
  seatPane(c, "work", session, seat, 1, y + 1, lw, s.h - 4 - (y + 1));
  for (let r = y + 1; r < s.h - 4; r++) s.put(2 + lw, r, "│", { fg: t.border });
  seatPane(c, "terminal", session, seat, 4 + lw, y + 1, s.w - 5 - lw, s.h - 4 - (y + 1));
  seatFooter(c, pane, session);
}
function seatFooter(c: Ctx, pane: string, session: string) {
  footer(c, [["esc", "back"], ["Tab", `pane: ${pane}`], ["e", c.expand ? "collapse" : "expand"], ["j/k", "scroll"], [":", "command"], ["1-5", "views"], ["?", "help"], ["q", "quit"]],
    `[seat] ${session} · read-only · the tail is read only while this view is open`);
}

export function seatPane(c: Ctx, pane: string, session: string, seat: Seat | null, x: number, y: number, w: number, h: number): void {
  const { s, t, raw } = c;
  const focused = SEAT_PANES[(c.pane ?? 0) % SEAT_PANES.length] === pane;
  if (pane === "terminal") {
    s.put(x, y, "LIVE TERMINAL", { fg: focused ? t.title : t.dim, bold: true });
    const tl = tailOf(c, session), lines = tailLines(c, session), rows = h - 2;
    // scrolling up stops at the first page of the text (QA PR92); the view state keeps the clamped value
    const maxScroll = Math.max(0, lines.length - rows), scroll = focused ? Math.min(maxScroll, Math.max(0, c.select ?? 0)) : 0;
    if (focused && c.clampSelect) c.clampSelect(scroll);
    const end = Math.max(0, lines.length - scroll), view = lines.slice(Math.max(0, end - rows), end);
    s.put(x + w - 30, y, fit(scroll ? `scrolled up ${scroll} lines` : `following · ${lines.length} lines`, 28), { fg: t.faint });
    if (!tl) s.put(x, y + 2, "loading the tail…", { fg: t.faint });
    else if (tl.content === null) s.put(x, y + 2, fit(tl.error ?? "unavailable", w), { fg: t.blocked });
    view.forEach((l, i) => s.put(x, y + 2 + i, fit(l, w), { fg: /^\s*[$›>] /.test(l) ? t.text : /✓|pass/i.test(l) ? t.merged : /✗|fail|error/i.test(l) ? t.stuck : t.dim, bold: /^\s*[$›] /.test(l) }));
    return;
  }
  // work: current rows, its slice's stages, context, recent history
  s.put(x + 1, y, "CURRENT WORK", { fg: focused ? t.title : t.dim, bold: true });
  const work = raw.queue.filter((r) => r.destination === session).sort((a, b) => (a.state === "in-progress" ? -1 : 0) - (b.state === "in-progress" ? -1 : 0) || a.created.localeCompare(b.created));
  let yy = y + 2;
  const top = work[0];
  if (top) {
    s.put(x + 1, yy, fit(top.summary ?? top.tags.filter((z) => !/^(project|mission):/.test(z)).join(" "), w - 2), { fg: t.text, bold: true });
    s.put(x + 1, yy + 1, fit(`${top.id.slice(-8)} · ${top.priority} · ${top.state}${top.blockedOn ? ` on ${top.blockedOn}` : ""} · from ${top.source.split("@")[0]}`, w - 2), { fg: t.dim });
    yy += 3;
    const tag = top.tags.find((z) => z.startsWith("slice:")), proj = top.tags.find((z) => z.startsWith("project:"))?.slice(8) ?? session.split("@")[1];
    if (tag) {
      const j = journey(raw, `${proj}/${tag.slice(6)}`), cur = j.slice?.stage ?? -1;
      let sx = x + 1;
      RIVER.forEach((st, i) => { if (sx + st.label.length + 3 > x + w) return; sx = s.put(sx, yy, `${i < cur ? "✓" : i === cur ? "●" : "○"} ${st.label}  `, { fg: i < cur ? t.working : i === cur ? t.info : t.faint }); });
      yy += 2;
    }
  } else { s.put(x + 1, yy, "No open queue row for this seat.", { fg: t.dim }); yy += 2; }
  if (seat) s.put(x + 1, yy, `${seat.assigned} assigned   ${seat.pending} pending   ${seat.inProgress} in progress   ${seat.blocked} blocked`, { fg: t.text });
  if (work.length > 1) s.put(x + 1, yy + 1, fit(`+${work.length - 1} more open row${work.length > 2 ? "s" : ""}: ${work.slice(1, 4).map((r) => r.id.slice(-8)).join(" ")}`, w - 2), { fg: t.faint });
  yy += 3;
  // context
  s.put(x + 1, yy, "CONTEXT", { fg: t.dim, bold: true });
  const pct = seat?.ctx ?? null, col = (pct ?? 0) >= 80 ? t.blocked : t.working;
  s.put(x + w - 12, yy, pct === null ? "unknown" : `${pct}% used`, { fg: col });
  meter(s, t, x + 1, yy + 2, Math.min(40, w - 4), pct === null ? null : pct / 100, col);
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (seat?.tokens && seat.window) s.put(x + 1, yy + 3, `${k(seat.tokens)} / ${k(seat.window)} tokens · ${k(Math.max(0, seat.window - seat.tokens))} remaining`, { fg: t.dim });
  if ((pct ?? 0) >= 80) {
    s.put(x + 1, yy + 5, "▲ Above the 80% handover threshold", { fg: t.blocked });
    s.put(x + 1, yy + 6, fit("Finish this check, then hand over before taking another slice.", w - 2), { fg: t.dim });
  }
  yy += 8;
  // recent history: the queue's transitions by this seat
  if (yy + 3 < y + h) {
    s.put(x + 1, yy, "RECENT HISTORY", { fg: t.dim, bold: true });
    const hist = (raw.history ?? []).filter((z) => z.actor === session).slice(0, Math.max(0, y + h - yy - 2));
    hist.forEach((z, i) => {
      s.put(x + 1, yy + 2 + i, new Date(z.ts).toISOString().slice(11, 16), { fg: t.faint });
      s.put(x + 8, yy + 2 + i, fit(`${z.change.replace(/\b([A-Za-z0-9._-]+)@[A-Za-z0-9._-]+/g, "$1")}${z.summary ? ` · ${z.summary}` : ""}`, w - 9), { fg: t.text });
    });
    if (!hist.length) s.put(x + 1, yy + 2, "nothing in the recent queue history", { fg: t.faint });
  }
}
