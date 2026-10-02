#!/usr/bin/env node
// agent-reroute [--rig R] [--minutes N] [--apply]: move work that waits on a seat that can't take it (WO90).
//
// A queue row whose seat can't make progress is handed to a live seat of the same role, the first family with a free
// one in the role's chain (config/routing.json), then the role's fallback roles (a Claude lead's rows go to the Codex
// deputy). Which rows:
// - pending (nobody claimed it) for N minutes (default 20) whose seat is not running, can't be served (its family has
//   no eligible account, every eligible account is cooling on the seat's model, a native CLI known to be out), or sits
//   at its context wall (97%+);
// - in progress, when its seat can't be served and sits idle: the turn ended on the proxy's 429 ("all credentials for
//   <model> are cooling down") and nothing will resume it until the cooldown ends (2026-10-02: 1h20 of Claude seats
//   idle on claimed rows).
// When the seat won't be served again for 30+ minutes (or nobody knows when), rows move after 5 minutes, not N.
// Every move carries an audit note naming the reason, both seats and the row's original sender; each row moves at most
// once. Never to a human: rows for a human, or tagged as the owner's decision, are left alone, and so is a row with no
// free seat anywhere (reported). A seat that was unservable and is served again, idle, still holding in-progress rows,
// gets one resume message. Without --apply it only reports. Runs every 10 minutes (agent-reroute.timer, --apply).
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { rig, seats, eligibleFamilies, seatAvailable, servableAt, familyGap, odb, CONTEXT_WALL } from "./lib.js";
import { pickForWork } from "./pickseat.js";

export { CONTEXT_WALL };
const HUMAN = /^human@|^owner@/;
const FAST_MIN = 5, LONG_OUT_MS = 30 * 60_000;

// Pure: why a seat can't take the row it was given, or null when it can.
export function blocked(seat, families) {
  if (!seat) return "its seat is gone";
  if (!seat.running) return `${seat.seat} is not running`;
  if (!seatAvailable(seat, families)) return familyGap([seat], seat.role, seat.family, families).replace(new RegExp(`^${seat.family} ${seat.role} seats all busy$`), `${seat.seat} can't be served`);
  if (seat.context !== null && seat.context >= CONTEXT_WALL) return `${seat.seat} is at its context wall (${Math.round(seat.context)}%)`;
  return null;
}

// Pure: is the seat running but unservable by the proxy, and for how long (minutes to wait before moving its rows)?
function unserved(seat, families, now, minutes) {
  if (!seat?.running || seatAvailable(seat, families)) return null;
  const at = servableAt(seat, families);
  return { wait: at == null || at - now >= LONG_OUT_MS ? Math.min(FAST_MIN, minutes) : minutes, back: at ?? null };
}

// Pure: the moves for one rig's active rows. rows: [{ id, state, destination, source, tags, updated }]; now: ms.
// load(row): the full row ({ body, summary, tags }) when the list elided its text (rig queue list does), or null when
// unreadable. Reviews and implementations need it for their constraint; without it they're left for the lead.
export function plan(rows, all, families, { minutes = 20, now = Date.now(), moved = new Set(), load = null } = {}) {
  const out = [];
  const taken = new Set();   // one row per free seat in a single pass
  for (const r of rows) {
    if (!["pending", "in-progress"].includes(r.state) || HUMAN.test(r.destination || "") || moved.has(r.id)) continue;
    if ((r.tags || []).some((t) => /^(human|owner)(-decision)?$|^decision:owner$/.test(t))) continue;
    const age = (now - Date.parse(r.updated || r.created || 0)) / 60_000;
    const seat = all.find((s) => s.seat === r.destination);
    const out0 = unserved(seat, families, now, minutes);
    // claimed work moves only off an idle seat the proxy can't serve: a dead seat or a full context has its own recovery
    if (r.state === "in-progress" && !(out0 && seat.idle)) continue;
    if (!(age >= (out0 ? out0.wait : minutes))) continue;
    const why = blocked(seat, families);
    if (!why) continue;
    const claimed = r.state === "in-progress" ? `claimed and idle: ${seat.seat}'s last turn ended on the proxy's 429; ` : "";
    if (!seat?.role) { out.push({ id: r.id, from: r.destination, why, to: null, note: "no role known for this seat: left for the lead" }); continue; }
    // the destination: idle, servable, below its wall, with no open work; and the row's own constraint kept (a review's
    // author family, the locked tests' family), or the row is left for the lead
    let full = r;
    if (["reviewer", "implementer"].includes(seat.role) && (r.elided || []).includes("body")) {
      const got = load ? load(r) : null;
      if (!got) { out.push({ id: r.id, from: r.destination, why, to: null, note: "left for the lead: the row's text couldn't be read to keep its review or locked-test constraint" }); continue; }
      full = { ...r, ...got };
    }
    const pick = pickForWork(all.filter((s) => s.seat !== seat.seat && !taken.has(s.seat)), seat.role, full, { families });
    if (!pick.seat) { out.push({ id: r.id, from: r.destination, why, to: null, note: pick.why }); continue; }
    taken.add(pick.seat.seat);
    const via = [pick.as ? `as ${pick.as}: no free ${seat.role} seat` : null, pick.fallback ? `fallback: ${pick.fallback.skipped.map((x) => x.reason).join("; ")}` : null,
      pick.constraint?.review ? `review of ${pick.constraint.review.family} work${pick.matrix?.skipped?.length ? `, skipped: ${pick.matrix.skipped.map((x) => x.reason).join("; ")}` : ""}` : null,
      pick.constraint?.exclude ? `not ${pick.constraint.exclude}: locked tests` : null].filter(Boolean);
    out.push({ id: r.id, state: r.state, from: r.destination, why, to: pick.seat.seat, family: pick.seat.family, waited_min: Math.round(age),
      note: `rerouted by agent-reroute after ${Math.round(age)} min: ${claimed}${why}; ${r.destination} -> ${pick.seat.seat} (${[pick.seat.family, ...via].join(", ")})` +
        (out0 ? `; served again ${out0.back ? new Date(out0.back).toISOString() : "at an unknown time"}` : "") +
        (r.source ? `; reply to ${r.source}` : "") + (r.state === "in-progress" ? `; ${r.destination} may have partial work in its branch` : "") });
  }
  return out;
}

// Pure: who hears about a row left unmoved: the rig's lead if it is running and servable, else its deputy (a lead on a
// 429 can't read it), else nobody (reported). Returns the seat or null.
export function tellWhom(all, families) {
  const ok = (s) => s && s.running && seatAvailable(s, families);
  return [all.find((s) => s.role === "lead"), all.find((s) => s.role === "deputy")].find(ok)?.seat ?? null;
}

// Pure: the message for a row left unmoved (once per row).
export function leftMessage(m) {
  return `[agent-reroute] ${m.id} for ${m.from} was not moved: ${m.why}; ${m.note}. It is yours to decide: re-route it, `
    + `reassign it, or fix the row (a review row needs "Author: <seat> (<family>)", an implementation against locked tests `
    + `"Locked tests: <seat> (<family>)").`;
}

// Pure: seats that were unservable (wasOut: seat -> since) and are served again, idle, with claimed rows left: one
// resume message each, naming the rows. Returns { resume: [{ seat, rows, text }], out: [seats unservable now] }.
export function resumes(rows, all, families, wasOut = new Set()) {
  const out = all.filter((s) => s.running && !seatAvailable(s, families)).map((s) => s.seat);
  const resume = [];
  for (const seat of wasOut) {
    const s = all.find((x) => x.seat === seat);
    if (!s?.running || !s.idle || !seatAvailable(s, families)) continue;
    const mine = rows.filter((r) => r.state === "in-progress" && r.destination === seat).map((r) => r.id);
    if (mine.length) resume.push({ seat, rows: mine, text: `[agent-reroute] Your model is served again (the proxy's cooldown ended). Resume your claimed work: ${mine.join(", ")}. Read each with rig queue show <id> --full --json.` });
  }
  return { resume, out };
}

function rigsToCheck(only) {
  if (only) return [only];
  const ps = rig(["ps"], { json: true, allowFail: true });
  return (Array.isArray(ps) ? ps : ps?.rigs || []).map((r) => r.name).filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2), flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const minutes = Number(flag("--minutes", "20")), apply = args.includes("--apply");
  if (!(minutes >= 5)) throw new Error("--minutes is at least 5");
  const db = odb();
  db.exec("CREATE TABLE IF NOT EXISTS reroutes (item TEXT PRIMARY KEY, ts INTEGER, from_seat TEXT, to_seat TEXT, why TEXT)");
  db.exec("CREATE TABLE IF NOT EXISTS reroute_unserved (seat TEXT PRIMARY KEY, since INTEGER)");
  db.exec("CREATE TABLE IF NOT EXISTS reroute_told (item TEXT PRIMARY KEY, ts INTEGER, seat TEXT, note TEXT)");
  const moved = new Set(db.prepare("SELECT item FROM reroutes").all().map((r) => r.item));
  const wasOut = new Set(db.prepare("SELECT seat FROM reroute_unserved").all().map((r) => r.seat));
  const families = eligibleFamilies(), report = [], nudges = [], errors = [];
  for (const rigName of rigsToCheck(flag("--rig"))) {
    const all = seats(rigName);
    const q = rig(["queue", "list", "-A", "--state", "pending,in-progress", "--limit", "1000"], { json: true, allowFail: true });
    // a failed or malformed read is unknown, not an empty queue: nothing moves, nothing remembered is forgotten
    const listed = (x) => (Array.isArray(x) ? x : Array.isArray(x?.items) ? x.items : null);
    const remember = () => { if (apply) for (const x of all.filter((x) => x.running && !seatAvailable(x, families))) db.prepare("INSERT OR IGNORE INTO reroute_unserved VALUES (?, ?)").run(x.seat, Date.now()); };
    if (!listed(q)) { errors.push({ rig: rigName, error: "rig queue list failed: nothing moved, resumes kept for the next pass" }); remember(); continue; }
    const rows = listed(q).map((x) => ({ id: x.qitemId, state: x.state, destination: x.destinationSession,
      source: x.sourceSession, tags: x.tags, updated: x.tsUpdated, created: x.tsCreated, body: x.body, summary: x.summary,
      elided: x.fieldsElided || [] })).filter((r) => String(r.destination || "").endsWith(`@${rigName}`));
    const load = (r) => {
      const f = rig(["queue", "show", r.id, "--full"], { json: true, allowFail: true });
      const rec = f?.item || f?.qitem || f;
      return rec && typeof rec.body === "string" ? { body: rec.body, summary: rec.summary, tags: rec.tags ?? r.tags } : null;
    };
    for (const m of plan(rows, all, families, { minutes, moved, load })) {
      if (apply && m.to) {
        rig(["queue", "handoff", m.id, "--to", m.to, "--note", m.note], { json: true });
        db.prepare("INSERT OR IGNORE INTO reroutes VALUES (?,?,?,?,?)").run(m.id, Date.now(), m.from, m.to, m.why);
        m.applied = true;
      }
      // left unmoved (no free seat, or a constraint only a lead can settle): tell the lead once per row (WO96)
      if (!m.to && !db.prepare("SELECT 1 FROM reroute_told WHERE item = ?").get(m.id)) {
        const who = tellWhom(all, families);
        m.tell = who;
        if (apply && who && rig(["send", who, leftMessage(m)], { allowFail: true }) !== null) {
          db.prepare("INSERT OR IGNORE INTO reroute_told VALUES (?,?,?,?)").run(m.id, Date.now(), who, m.note);
          m.told = true;
        }
      }
      report.push({ rig: rigName, ...m });
    }
    const left = listed(apply ? rig(["queue", "list", "-A", "--state", "in-progress", "--limit", "1000"], { json: true, allowFail: true }) : q);
    if (!left) { errors.push({ rig: rigName, error: "rig queue list (in progress) failed: resumes kept for the next pass" }); remember(); continue; }
    const leftRows = left.map((x) => ({ id: x.qitemId, state: x.state, destination: x.destinationSession }));
    const r = resumes(leftRows, all, families, new Set([...wasOut].filter((s) => s.endsWith(`@${rigName}`))));
    const failed = new Set();
    for (const n of r.resume) {
      if (apply) {
        // a send that failed keeps the seat remembered, so the next pass tries again (rig() is null on a failure)
        n.sent = rig(["send", n.seat, n.text], { allowFail: true }) !== null;
        if (!n.sent) { n.error = "rig send failed: will retry next pass"; failed.add(n.seat); }
      }
      nudges.push({ rig: rigName, ...n });
    }
    if (apply) {
      remember();
      // served again: nudged above, or working again or holding nothing; forget it, unless the nudge didn't go out
      for (const s of wasOut) if (s.endsWith(`@${rigName}`) && !r.out.includes(s) && !failed.has(s)) db.prepare("DELETE FROM reroute_unserved WHERE seat = ?").run(s);
    }
  }
  console.log(JSON.stringify({ minutes, applied: apply, moves: report, resumes: nudges, ...(errors.length ? { errors } : {}) }, null, 2));
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] || "")).href) {
  main().catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
}
