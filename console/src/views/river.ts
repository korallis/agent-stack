// View 3, the River (mockup B), and its drill-in, one slice's journey. Work is the hero: each rig is a lane flowing left
// to right through the delivery stages; each open slice is a chip at the most advanced stage one of its rows waits on;
// where chips pile up, the stage pools. ⏎ on a chip opens that slice's journey: every row it took, who did it, how long
// it was worked and how long it waited, and what it waits on now.
import type { RGB } from "../term.ts";
import { ago, fit, panel, rpad } from "../draw.ts";
import { RIVER, doneToday, isHuman, journey, natural, podsOf, sliceStageTime, slices, stageTimes, type Slice, type SliceState } from "../model.ts";
import { footer, header, since, ticker, type Ctx } from "./chrome.ts";

export function chipColor(c: Ctx, st: SliceState): { fg: RGB; bg: RGB } {
  const t = c.t;
  return ({ active: { fg: t.bg, bg: t.working }, pending: { fg: t.text, bg: t.border }, blocked: { fg: t.bg, bg: t.blocked }, owner: { fg: t.bg, bg: t.owner } } as Record<SliceState, { fg: RGB; bg: RGB }>)[st];
}
/** The lanes: rigs with slices or agent seats, slices in stage order. */
export function lanes(c: Ctx): { rig: string; slices: Slice[] }[] {
  const all = slices(c.raw), names = c.raw.rigs.filter((r) => r.seats.some((s) => s.kind === "agent")).map((r) => r.name);
  for (const s of all) if (!names.includes(s.rig)) names.push(s.rig);
  return names.map((rig) => ({ rig, slices: all.filter((s) => s.rig === rig).sort((a, b) => a.stage - b.stage || a.since.localeCompare(b.since)) }));
}

export function river(c: Ctx): void {
  const { s, t, raw, f } = c;
  header(c, "THE RIVER");
  let y = 2;
  if (f.owner.length) {
    const q = f.owner[0];
    s.put(2, y, `◆ OWNER · ${f.owner.length} waiting`, { fg: t.owner, bold: true });
    s.put(24, y, fit(`${q.summary ?? q.tags.join(" ")} · ${since(raw, q.created)}${f.owner.length > 1 ? ` · +${f.owner.length - 1} more` : ""}`, s.w - 28), { fg: t.text });
  } else s.put(2, y, "◆ OWNER · nothing waiting", { fg: t.dim });
  y += 2;
  const L = lanes(c), all = L.flatMap((l) => l.slices), done = doneToday(raw);
  const LW = 14, DW = 12, cw = Math.max(9, Math.floor((s.w - 2 - LW - DW) / RIVER.length));
  const counts = RIVER.map((_, i) => all.filter((x) => x.stage === i).length);
  const avg = all.length / RIVER.length, pool = counts.map((n) => n >= Math.max(4, 2 * avg));
  const doneN = Object.values(done).reduce((n, v) => n + v.length, 0);
  const worst = counts.indexOf(Math.max(...counts));
  let tx = s.put(2, y, " THE RIVER ", { fg: t.bg, bg: t.info, bold: true });
  tx = s.put(tx + 1, y, `slices flow left → right · ${all.length} open · ${doneN} reached the sea today`, { fg: t.dim });
  if (all.length && pool[worst]) { tx = s.put(tx, y, " · pooling at ", { fg: t.dim }); s.put(tx, y, ` ${RIVER[worst].label} ×${counts[worst]} `, { fg: t.bg, bg: t.blocked, bold: true }); }
  y += 1;
  const colX = (i: number) => 1 + LW + i * cw;
  s.put(2, y, "RIG", { fg: t.dim });
  RIVER.forEach((st, i) => {
    const x = colX(i);
    s.put(x, y, fit(cw >= 11 ? `● ${st.label}` : st.label, cw - 3), { fg: pool[i] ? t.blocked : t.info, bold: true });
    s.put(x, y + 1, `${counts[i]}`, { fg: counts[i] ? t.text : t.faint, bold: true });
    if (pool[i]) s.put(x + 4, y + 1, "▲pool", { fg: t.blocked });
    if (i < RIVER.length - 1) s.put(x + cw - 2, y, "→", { fg: t.faint });
  });
  s.put(colX(RIVER.length), y, "DONE today", { fg: t.merged, bold: true });
  // phase 4: how long open rows have sat in their current state at each stage (median), and the share waiting
  const times = stageTimes(raw);
  times.forEach((tm, i) => {
    if (tm.median === null) return;
    const share = tm.worked + tm.waited ? Math.round((tm.waited / (tm.worked + tm.waited)) * 100) : 0;
    s.put(colX(i), y + 2, fit(`⧗${ago(tm.median)} ${share}%w`, cw - 2), { fg: share >= 70 ? t.blocked : t.faint });
  });
  s.put(colX(RIVER.length), y + 2, fit("⧗ median · %w waiting", DW), { fg: t.faint });
  y += 3;
  const bottom = s.h - 6;
  const [fl, fc] = c.riverFocus ?? [0, 0];
  let sel: Slice | null = null;
  const visible = L.length;
  // a lane: chips wrap within their stage column (up to 3 lines), then one line of seat activity per stage
  const laneLines = (l: { slices: Slice[] }) => {
    const per = RIVER.map((_, i) => l.slices.filter((x) => x.stage === i).length), fit1 = Math.max(1, Math.floor((cw - 1) / 8));
    return Math.min(3, Math.max(1, ...per.map((n) => Math.ceil(n / fit1)))) + 1;
  };
  // scroll lanes so the focused one is drawn
  let start = 0;
  const heights = L.map(laneLines);
  const fitsFrom = (a: number) => { let h = 0, n = 0; for (let i = a; i < L.length && h + heights[i] <= bottom - y; i++) { h += heights[i]; n++; } return n; };
  while (fl >= start + fitsFrom(start) && start < L.length - 1) start++;
  const shown = fitsFrom(start);
  if (start > 0) s.put(2, y - 1, `▲ ${start} more`, { fg: t.title });
  for (let li = start; li < Math.min(visible, start + shown); li++) {
    const l = L[li], h = heights[li], focusedLane = li === fl;
    const k = f.byRig[l.rig] ?? { working: 0, idle: 0, stuck: 0, unknown: 0, detached: 0, stopped: 0 };
    if (focusedLane) sel = l.slices[fc] ?? null;
    s.put(1, y, focusedLane ? "▶" : " ", { fg: t.title });
    s.put(2, y, fit(l.rig, LW - 3), { fg: focusedLane ? t.title : t.text, bold: true });
    s.put(2, y + 1, fit(`▸${k.working} ·${k.idle}${k.stuck ? ` ◆${k.stuck}` : ""}${k.unknown ? ` ?${k.unknown}` : ""}`, LW - 3), { fg: t.dim });
    const fit1 = Math.max(1, Math.floor((cw - 1) / 8));
    RIVER.forEach((st, i) => {
      const here = l.slices.filter((x) => x.stage === i), x0 = colX(i);
      s.put(x0, y, "·".repeat(cw - 2), { fg: t.faint });
      // a crowded stage shows a window of its chips that always contains the focused one (QA PR90)
      const cap = fit1 * (h - 1), fi = focusedLane ? here.findIndex((x) => l.slices.indexOf(x) === fc) : -1;
      const from = fi >= cap ? fi - cap + 1 : 0;
      here.slice(from, from + cap).forEach((sl, j) => {
        const focused = focusedLane && l.slices.indexOf(sl) === fc;
        const col = chipColor(c, sl.state), x = x0 + (j % fit1) * 8, yy = y + Math.floor(j / fit1);
        s.put(x, yy, ` ${fit(sl.id, 6)}`, { fg: col.fg, bg: col.bg, bold: sl.state !== "pending", inverse: focused });
      });
      // more chips than fit: ▲ above / ▼ below the window, one cell right after the last chip (never over one)
      const mx2 = x0 + Math.min(fit1 * 8, cw - 2);
      if (from > 0) s.put(mx2, y, "▲", { fg: t.title });
      if (here.length > from + cap) s.put(mx2, y + h - 2, "▼", { fg: t.title });
      // who works this stage in this rig: ● working, ○ idle
      const seats = c.raw.rigs.find((r) => r.name === l.rig)?.seats.filter((x) => x.kind === "agent" && st.pods.includes(x.pod)) ?? [];
      if (seats.length) s.put(x0, y + h - 1, fit(`●${seats.filter((x) => x.activity === "working").length} ○${seats.filter((x) => x.activity === "idle").length}`, cw - 2), { fg: t.faint });
    });
    const d = done[l.rig] ?? [];
    s.put(colX(RIVER.length), y, d.length ? `✓ ${d.length}` : "·", { fg: d.length ? t.merged : t.faint, bold: true });
    if (d.length) s.put(colX(RIVER.length), y + 1, fit(d.slice(0, 2).join(" "), DW - 1), { fg: t.dim });
    y += h;
  }
  if (start + shown < visible) s.put(2, y, `▼ ${visible - start - shown} more`, { fg: t.title });
  if (!all.length) s.put(colX(0), y, "No open slice: no queue row carries a slice: tag.", { fg: t.faint });
  // below the lanes: what has waited longest, the gate today, the latest events
  const py = y + 1, ph = s.h - 7 - py;
  if (ph >= 5) {
    const w3 = Math.floor((s.w - 2) / 3);
    const stuck = all.filter((x) => x.state === "blocked" || x.state === "owner").sort((a, b) => a.since.localeCompare(b.since));
    panel(s, t, 1, py, w3 - 1, ph, "WAITING LONGEST", { right: `${stuck.length} blocked or with the owner` });
    stuck.slice(0, ph - 2).forEach((x, i) => {
      const col = chipColor(c, x.state);
      s.put(3, py + 1 + i, ` ${fit(x.id, 6)}`, { fg: col.fg, bg: col.bg });
      s.put(11, py + 1 + i, fit(`${x.rig} · ${RIVER[x.stage].label} · ${since(raw, x.since)}${x.label ? ` · ${x.label}` : ""}`, w3 - 14), { fg: t.text });
    });
    if (!stuck.length) s.put(3, py + 1, "nothing blocked", { fg: t.faint });
    const gx = 1 + w3;
    panel(s, t, gx, py, w3 - 1, ph, f.gate.partial ? "JEV MERGE GATE · TODAY ≥" : "JEV MERGE GATE · TODAY");
    const g = f.gate, gl: [string, RGB][] = [[`${g.partial ? "≥" : ""}${g.total} decisions since 00:00 UTC`, t.text], [`${g.merge} merge ✓`, t.merged], [`${g.hold} hold ▲`, g.hold ? t.blocked : t.dim],
      [`${g.act} act · ${g.uncertain} uncertain · ${g.total - g.act - g.uncertain} review band`, t.dim]];
    gl.slice(0, ph - 2).forEach(([txt, col], i) => s.put(gx + 2, py + 1 + i, fit(txt, w3 - 5), { fg: col }));
    const ex = 1 + 2 * w3, ew = s.w - 1 - ex;
    panel(s, t, ex, py, ew, ph, "EVENTS", { right: "newest first" });
    raw.events.slice(0, ph - 2).forEach((e, i) => {
      s.put(ex + 2, py + 1 + i, new Date(e.at).toISOString().slice(11, 19), { fg: t.faint });
      s.put(ex + 11, py + 1 + i, fit(`${e.kind.toLowerCase()} ${e.text}`, ew - 13), { fg: t.text });
    });
  }
  // legend + selection
  let lx = s.put(2, s.h - 6, "chips ", { fg: t.dim });
  for (const [st, label] of [["active", "in progress"], ["pending", "queued"], ["blocked", "blocked"], ["owner", "owner"]] as [SliceState, string][]) {
    const col = chipColor(c, st); lx = s.put(lx, s.h - 6, ` ${label} `, { fg: col.fg, bg: col.bg }) + 1;
  }
  s.put(lx + 1, s.h - 6, "●n working ○n idle seats per stage · a slice sits at the most advanced stage one of its open rows waits on", { fg: t.faint });
  const cur = sel as Slice | null;
  if (cur) {
    let sx = s.put(2, s.h - 5, "SELECTED ", { fg: t.dim });
    sx = s.put(sx, s.h - 5, `${cur.id} ${cur.label}`, { fg: t.text, bold: true });
    const tm = sliceStageTime(raw, cur);
    s.put(sx + 2, s.h - 5, fit(`${cur.rig}${cur.mission ? ` · ${cur.mission}` : ""} · at ${RIVER[cur.stage].label} for ${ago(tm.since)} (in progress ${tm.worked ? ago(tm.worked) : "—"} / waiting ${tm.waited ? ago(tm.waited) : "—"}) · ${cur.rows.length} open rows · ${cur.state === "owner" ? "waiting on the owner" : cur.state} · open ${since(raw, cur.since)} · ${cur.prs.join(" ") || "no PR yet"}`, s.w - sx - 4), { fg: t.dim });
  }
  ticker(c, s.h - 3);
  footer(c, [["←→", "along the river"], ["↑↓", "rig lane"], ["⏎", "slice journey"], ["1-5", "views"], ["esc", "home"], ["?", "help"], ["q", "quit"]],
    `[river] ${all.length} slices · ${L.length} lanes · read-only`);
}

const dur = (ms: number) => (ms <= 0 ? "—" : ago(ms));

export function journeyView(c: Ctx, key: string): void {
  const { s, t, raw } = c;
  const j = journey(raw, key), sl = j.slice;
  const tag = key.slice(key.indexOf("/") + 1);
  header(c, `RIVER › ${sl?.rig ?? "?"} › ${sl?.id ?? tag}`);
  let y = 2;
  s.put(2, y, sl?.id ?? tag, { fg: t.owner, bold: true });
  s.put(4 + (sl?.id ?? tag).length, y, fit(sl?.label ?? "", 40), { fg: t.text, bold: true });
  const meta = sl ? `${sl.rig}${sl.project && sl.project !== sl.rig ? ` · ${sl.project}` : ""}${sl.mission ? ` · ${sl.mission}` : ""} · ${sl.prs.join(" ") || "no PR yet"} · open ${since(raw, sl.since)}` : "finished: no open row";
  s.put(2, y + 1, fit(meta, s.w - 40), { fg: t.dim });
  if (sl) {
    const badge = sl.state === "owner" ? " WAITING ON OWNER " : sl.state === "blocked" ? " BLOCKED " : sl.state === "active" ? " IN PROGRESS " : " QUEUED ";
    const col = chipColor(c, sl.state);
    s.put(s.w - badge.length - 3, y, badge, { fg: col.fg, bg: col.bg, bold: true });
    s.put(s.w - 30, y + 1, fit(`at ${RIVER[sl.stage].label}`, 27).padStart(27), { fg: t.dim });
  }
  y += 3;
  // the stage rail, with worked / waited per stage
  const rw = Math.floor((s.w - 4) / RIVER.length);
  RIVER.forEach((st, i) => {
    const x = 2 + i * rw, cur = sl?.stage === i, passed = sl ? i < sl.stage : true, ps = j.perStage[i];
    const mark = cur ? "◆" : passed && (ps.worked + ps.waited) ? "✓" : "○";
    s.put(x, y, `${mark} ${st.label}`, { fg: cur ? t.owner : passed ? t.working : t.faint, bold: cur });
    if (i < RIVER.length - 1) s.put(x + st.label.length + 3, y, "─".repeat(Math.max(0, rw - st.label.length - 4)), { fg: passed ? t.working : t.faint });
    s.put(x, y + 1, fit(ps.worked + ps.waited ? `${dur(ps.worked)} / ${dur(ps.waited)}` : "—", rw - 1), { fg: t.dim });
  });
  const W = j.steps.reduce((n, x) => n + x.worked, 0), Wt = j.steps.reduce((n, x) => n + x.waited, 0);
  const note = j.steps.some((x) => !x.known) ? (j.steps.length > 20 ? "history: newest 20 rows (… = not read)" : "history still loading (…)") : "";
  const sum = `worked / waited per stage · total worked ${dur(W)} · waited ${dur(Wt)}${W + Wt ? ` (${Math.round((Wt / (W + Wt)) * 100)}% waiting)` : ""}`;
  // the history note never gets cut: beside the totals when they fit, else on its own line (QA PR90)
  const together = note && [...sum].length + 3 + note.length <= s.w - 4;
  s.put(2, y + 2, fit(together ? `${sum} · ${note}` : sum, s.w - 4), { fg: t.dim });
  if (note && !together) { s.put(2, y + 3, fit(note, s.w - 4), { fg: t.blocked }); y += 1; }
  y += 4;
  const bottom = s.h - 4, wide = s.w >= 140;
  const open = j.steps.filter((x) => x.open).map((x) => x.row);
  const waits = open.filter((r) => r.state === "blocked" || isHuman(r.destination));
  const waitLine = (r: (typeof open)[number]) => `${r.id.slice(-8)} ${isHuman(r.destination) ? `the owner (${r.destination})` : `${r.state} on ${r.blockedOn ?? "?"}`}`;
  const lw = wide ? Math.floor(s.w * 0.62) : s.w - 2, rx = 1 + lw + 1, rwid = s.w - rx - 1;
  let jy = y;
  if (!wide) {   // narrow (QA PR90): who it waits on, full width, above the journey
    const wh2 = Math.min(5, Math.max(3, waits.length + 2));
    panel(s, t, 1, y, s.w - 2, wh2, "WAITING ON", { color: sl?.state === "owner" ? t.owner : t.border, right: `${open.length} open row${open.length === 1 ? "" : "s"}` });
    if (!waits.length) s.put(3, y + 1, open.length ? "nothing: its open rows are queued or in progress" : "nothing: no open row", { fg: t.dim });
    waits.slice(0, wh2 - 2).forEach((r, i) => s.put(3, y + 1 + i, fit(waitLine(r), s.w - 6), { fg: isHuman(r.destination) || isHuman(r.blockedOn) ? t.owner : t.blocked }));
    jy = y + wh2;
  }
  panel(s, t, 1, jy, lw, bottom - jy, `JOURNEY · ${sl?.id ?? tag}`, { right: `${j.steps.length} rows` });
  s.put(3, jy + 1, fit("WHEN          STAGE    WHO                       STATE        WORKED   WAITED", lw - 4), { fg: t.dim });
  const maxT = Math.max(1, ...j.steps.map((x) => x.worked + x.waited)), bw = lw - 86;   // the bar fits inside the panel or isn't drawn
  const bySession = new Map(raw.rigs.flatMap((r) => r.seats).map((x) => [x.session, x]));
  let ry = jy + 2;
  for (const st of j.steps) {
    if (ry + 1 >= bottom - 1) { s.put(3, ry, `… ${j.steps.length - j.steps.indexOf(st)} more rows`, { fg: t.faint }); break; }
    const r = st.row, who = r.destination.split("@")[0], seat = bySession.get(r.destination);
    const stc = r.state === "in-progress" ? t.working : r.state === "blocked" ? (isHuman(r.blockedOn) ? t.owner : t.blocked) : r.state === "pending" ? t.info : t.dim;
    s.put(3, ry, new Date(st.first ?? r.created).toISOString().slice(5, 16).replace("T", " "), { fg: t.faint });
    s.put(17, ry, fit(st.stage >= 0 ? RIVER[st.stage].label : "OTHER", 8), { fg: t.info, bold: true });
    s.put(26, ry, fit(`${who}${seat?.model ? ` ${seat.runtime}` : ""}`, 25), { fg: t.text });
    s.put(52, ry, fit(r.state, 12), { fg: stc });
    s.put(65, ry, rpad(st.known ? dur(st.worked) : "…", 7), { fg: t.working });
    s.put(74, ry, rpad(st.known ? dur(st.waited) : "…", 7), { fg: t.blocked });
    if (st.known && bw >= 4) {
      const a = Math.min(bw, Math.round((st.worked / maxT) * bw)), b = Math.min(bw - a, Math.round((st.waited / maxT) * bw));
      s.put(83, ry, "█".repeat(a), { fg: t.working }); s.put(83 + a, ry, "░".repeat(b), { fg: t.blocked });
    }
    s.put(19, ry + 1, fit(`${r.summary ?? r.tags.filter((x) => !/^(project|slice|mission):/.test(x)).join(" ")}${r.blockedOn ? ` · blocked on ${r.blockedOn}` : ""}`, lw - 22), { fg: t.dim });
    ry += 2;
  }
  if (!j.steps.length) s.put(3, jy + 2, "No rows carry this slice's tag.", { fg: t.faint });
  if (wide) {   // right: what it waits on now, and its open rows
    const wh = Math.min(8, Math.max(4, waits.length + 3));
    panel(s, t, rx, y, rwid, wh, "WAITING ON", { color: sl?.state === "owner" ? t.owner : t.border });
    if (!waits.length) s.put(rx + 2, y + 1, open.length ? "nothing: its open rows are queued or in progress" : "nothing: no open row", { fg: t.dim });
    waits.slice(0, wh - 2).forEach((r, i) => s.put(rx + 2, y + 1 + i, fit(waitLine(r), rwid - 4), { fg: isHuman(r.destination) || isHuman(r.blockedOn) ? t.owner : t.blocked }));
    const qy = y + wh;
    panel(s, t, rx, qy, rwid, bottom - qy, "QUEUE ROWS", { right: `${open.length} open` });
    open.slice(0, bottom - qy - 2).forEach((r, i) => {
      s.put(rx + 2, qy + 1 + i, fit(r.id.slice(-8), 9), { fg: t.dim });
      s.put(rx + 12, qy + 1 + i, fit(r.state, 11), { fg: r.state === "in-progress" ? t.working : r.state === "blocked" ? t.blocked : t.info });
      s.put(rx + 24, qy + 1 + i, fit(`${r.destination.split("@")[0]}${r.priority !== "routine" ? ` · ${r.priority}` : ""}`, rwid - 26), { fg: t.text });
    });
  }
  footer(c, [["esc", "back to the river"], ["[ ]", "prev / next slice"], ["1-5", "views"], ["?", "help"], ["q", "quit"]],
    `[journey] ${sl?.id ?? tag} · ${j.steps.length} rows · read-only · transitions read for this slice only`);
}

/** The lane and chip of a slice key, for keeping focus across refreshes. */
export function findChip(c: Ctx, key: string): [number, number] | null {
  const L = lanes(c);
  for (let i = 0; i < L.length; i++) { const k = L[i].slices.findIndex((x) => x.key === key); if (k >= 0) return [i, k]; }
  return null;
}
export { podsOf, natural };
