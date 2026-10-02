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
import { rig, seats, pickFor, eligibleFamilies, seatAvailable, servableAt, familyGap, odb } from "./lib.js";

export const CONTEXT_WALL = 97;
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
export function plan(rows, all, families, { minutes = 20, now = Date.now(), moved = new Set() } = {}) {
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
    const pick = pickFor(all.filter((s) => s.seat !== seat.seat && !taken.has(s.seat)), seat.role, { families });
    if (!pick.seat) { out.push({ id: r.id, from: r.destination, why, to: null, note: `no free ${[seat.role, ...pick.tried.slice(1)].join(" or ")} seat in any family` }); continue; }
    taken.add(pick.seat.seat);
    const via = [pick.as ? `as ${pick.as}: no free ${seat.role} seat` : null, pick.fallback ? `fallback: ${pick.fallback.skipped.map((x) => x.reason).join("; ")}` : null].filter(Boolean);
    out.push({ id: r.id, state: r.state, from: r.destination, why, to: pick.seat.seat, family: pick.seat.family, waited_min: Math.round(age),
      note: `rerouted by agent-reroute after ${Math.round(age)} min: ${claimed}${why}; ${r.destination} -> ${pick.seat.seat} (${[pick.seat.family, ...via].join(", ")})` +
        (out0 ? `; served again ${out0.back ? new Date(out0.back).toISOString() : "at an unknown time"}` : "") +
        (r.source ? `; reply to ${r.source}` : "") + (r.state === "in-progress" ? `; ${r.destination} may have partial work in its branch` : "") });
  }
  return out;
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
  const moved = new Set(db.prepare("SELECT item FROM reroutes").all().map((r) => r.item));
  const wasOut = new Set(db.prepare("SELECT seat FROM reroute_unserved").all().map((r) => r.seat));
  const families = eligibleFamilies(), report = [], nudges = [];
  for (const rigName of rigsToCheck(flag("--rig"))) {
    const all = seats(rigName);
    const q = rig(["queue", "list", "-A", "--state", "pending,in-progress", "--limit", "1000"], { json: true, allowFail: true });
    const rows = (Array.isArray(q) ? q : q?.items || []).map((x) => ({ id: x.qitemId, state: x.state, destination: x.destinationSession,
      source: x.sourceSession, tags: x.tags, updated: x.tsUpdated, created: x.tsCreated })).filter((r) => String(r.destination || "").endsWith(`@${rigName}`));
    for (const m of plan(rows, all, families, { minutes, moved })) {
      if (apply && m.to) {
        rig(["queue", "handoff", m.id, "--to", m.to, "--note", m.note], { json: true });
        db.prepare("INSERT OR IGNORE INTO reroutes VALUES (?,?,?,?,?)").run(m.id, Date.now(), m.from, m.to, m.why);
        m.applied = true;
      }
      report.push({ rig: rigName, ...m });
    }
    const left = apply ? rig(["queue", "list", "-A", "--state", "in-progress", "--limit", "1000"], { json: true, allowFail: true }) : q;
    const leftRows = (Array.isArray(left) ? left : left?.items || []).map((x) => ({ id: x.qitemId, state: x.state, destination: x.destinationSession }));
    const r = resumes(leftRows, all, families, new Set([...wasOut].filter((s) => s.endsWith(`@${rigName}`))));
    for (const n of r.resume) {
      if (apply) { rig(["send", n.seat, n.text], { allowFail: true }); n.sent = true; }
      nudges.push({ rig: rigName, ...n });
    }
    if (apply) {
      for (const s of r.out) db.prepare("INSERT OR IGNORE INTO reroute_unserved VALUES (?, ?)").run(s, Date.now());
      // served again: nudged above, or already working again or holding nothing; either way, forget it
      for (const s of wasOut) if (s.endsWith(`@${rigName}`) && !r.out.includes(s)) db.prepare("DELETE FROM reroute_unserved WHERE seat = ?").run(s);
    }
  }
  console.log(JSON.stringify({ minutes, applied: apply, moves: report, resumes: nudges }, null, 2));
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] || "")).href) {
  main().catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
}
