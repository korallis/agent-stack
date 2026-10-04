#!/usr/bin/env node
// agent-stuck-check [--rig R] [--dry-run] [--max-asks N]: is a seat that holds open work stuck? It WARNS the lead; it
// never acts. Runs every 10 minutes (agent-stuck-check.timer).
//
// Code gathers the evidence and owns the thresholds; Jev (seat.stuck) judges only the seats code flags:
//   - the seat holds open work (an in-progress queue row, or assigned work beyond its parked rows: a row parked on a
//     named blocker is waiting, not stuck);
//   - its screen (last 40 lines, digits ignored so timers and spinners don't count as change) was the same at the last
//     2 checks, or it keeps showing the same few screens, or the same line repeats in it.
// Verdict looping / rate_limited / stalled (act or review band) -> one message to the rig's lead, at most once an
// hour per seat and verdict. unclear -> a message only when the screen has not changed for 3 checks.
// State per seat: $AGENT_STACK_STATE/stuck/<seat>.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../jev/lib/store.js";
import { rig, seats } from "./lib.js";
import { decideOrStub } from "./jevcall.js";
import { redact as redactText } from "./redact.js";

const redact = (t) => redactText(t, { longTokens: true });

const WARN_EVERY_MS = 60 * 60_000;
const KEEP = 6;   // screen hashes remembered per seat

// Pure helpers ------------------------------------------------------------------------------------------------------
export const screenHash = (text) =>
  createHash("sha256").update(text.split("\n").filter((l) => l.trim()).slice(-40).join("\n").replace(/\d+/g, "#")).digest("hex").slice(0, 16);

export function repeatedLine(text) {
  const counts = {};
  // Words, not decoration: separators and box-drawing lines repeat on every screen.
  for (const l of text.split("\n").map((x) => x.trim()).filter((x) => (x.match(/[A-Za-z]/g) || []).length >= 6)) counts[l] = (counts[l] || 0) + 1;
  const [line, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return n >= 3 ? { line, n } : null;
}

// Consecutive checks (including this one) that saw the same screen.
export const unchangedRuns = (hashes) => { let n = 1; for (let i = hashes.length - 1; i > 0 && hashes[i] === hashes[i - 1]; i--) n++; return n; };
// Screens keep coming back: over the last 6 checks at most 2 different screens, and not simply the same one.
export const cycling = (hashes) => hashes.length >= KEEP && new Set(hashes.slice(-KEEP)).size <= 2 && unchangedRuns(hashes) < KEEP;

// Does the seat hold work it could be doing? A parked row (state blocked: it waits on a named blocker and comes back by
// itself) is not open work: an idle seat whose only rows are parked isn't stuck (a project, 2026-10-04: seats waiting on
// external:...:github-auth were flagged). OpenRig's assigned count includes parked rows, so with the queue rows at hand
// only work beyond the seat's parked rows counts; without them (the list didn't read) the assigned count decides.
export function holdsOpenWork({ assigned = 0, rows, seat }) {
  if (!Array.isArray(rows)) return assigned > 0;
  const mine = rows.filter((q) => q.destinationSession === seat);
  const parked = mine.filter((q) => q.state === "blocked").length;
  const active = mine.filter((q) => ["in-progress", "claimed"].includes(q.state)).length;
  return active > 0 || assigned - parked > 0;
}

export function shouldAsk({ openWork, hashes, repeat }) {
  if (!openWork) return false;
  return unchangedRuns(hashes) >= 2 || cycling(hashes) || Boolean(repeat);
}

export function buildEvidence({ state, minutesInState, hashes, intervalMin, repeat, openRows, tail }) {
  const same = unchangedRuns(hashes);
  // Everything here goes to Jev (an external service): the whole text is redacted, queue summaries included.
  return redact([
    `state: ${state} for about ${minutesInState} min (tracked by this check)`,
    same >= 2 ? `screen output: unchanged for the last ${same} checks (about ${(same - 1) * intervalMin} min; digits ignored)`
      : cycling(hashes) ? `screen output: only ${new Set(hashes.slice(-KEEP)).size} different screens over the last ${KEEP} checks`
      : "screen output: changed since the last check",
    repeat ? `repeated line (${repeat.n}x in the last 40): ${repeat.line.slice(0, 160)}` : "no line repeats 3 times",
    openRows.length ? "open queue work: " + openRows.map((r) => `${r.id} ${r.state} for ${r.ageMin} min (${(r.summary || "").slice(0, 80)})`).join("; ") : "open queue work: assigned, no in-progress row",
    "last lines of the screen:",
    tail.split("\n").filter((l) => l.trim()).slice(-15).join("\n").slice(0, 1500),
  ].join("\n"));
}

export function warning(seat, rec, evidence, { unchanged }) {
  const v = rec?.result?.verdict, band = rec?.band;
  const firstLines = evidence.split("\n").slice(0, 2).join("; ");
  if (["looping", "rate_limited", "stalled"].includes(v) && ["act", "review"].includes(band))
    return { verdict: v, text: `stuck-check: ${seat} looks ${v.replace("_", "-")} (Jev ${band}). ${firstLines}. Nothing was done; look at it (tmux attach -t ${seat}) and decide.` };
  if (unchanged >= 3 && (band === "uncertain" || v === "unclear"))
    return { verdict: "unclear", text: `stuck-check: ${seat} has shown the same screen for ${unchanged} checks while holding work; Jev couldn't tell why. ${firstLines}. Nothing was done; please look (tmux attach -t ${seat}).` };
  return null;
}

// Live run ----------------------------------------------------------------------------------------------------------
async function main() {
  const a = process.argv.slice(2);
  const flag = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  const dry = a.includes("--dry-run"), maxAsks = Number(flag("--max-asks", 10)), intervalMin = 10;
  const dir = join(STATE_DIR, "stuck"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rigs = flag("--rig") ? [flag("--rig")] : (rig(["ps"], { json: true }) || []).filter((r) => !r.isArchived && r.runningCount > 0).map((r) => r.name).filter((n) => n && n !== "kernel");
  const now = Date.now(); let asks = 0; const report = []; const flagged = [];
  for (const rigName of rigs) {
    const all = seats(rigName);
    const lead = all.find((s) => s.role === "lead")?.seat;
    const rows = rig(["queue", "list", "-A", "--limit", "500"], { json: true, allowFail: true });
    const listed = Array.isArray(rows) ? rows : rows?.items || rows?.qitems || null;   // null: the list didn't read
    const list = listed || [];
    for (const s of all.filter((x) => x.running && x.role !== "lead")) {
      let tail = "";
      try { tail = execFileSync("tmux", ["capture-pane", "-p", "-S", "-60", "-t", s.seat], { encoding: "utf8", timeout: 10_000 }); } catch { continue; }
      const file = join(dir, `${s.seat.replace(/[^A-Za-z0-9@._-]/g, "_")}.json`);
      let st = {}; try { st = JSON.parse(readFileSync(file, "utf8")); } catch { /* first sight */ }
      const state = s.idle ? "idle" : "working";
      if (st.state !== state) { st.state = state; st.since = now; }
      st.hashes = [...(st.hashes || []), screenHash(tail)].slice(-KEEP);
      const openRows = list.filter((q) => q.destinationSession === s.seat && ["in-progress", "claimed"].includes(q.state))
        .map((q) => ({ id: q.qitemId, state: q.state, summary: q.summary, ageMin: Math.round((now - Date.parse(q.claimedAt || q.tsUpdated || q.tsCreated)) / 60_000) }));
      const repeat = repeatedLine(tail);
      const openWork = holdsOpenWork({ assigned: s.assigned, rows: listed, seat: s.seat });
      if (shouldAsk({ openWork, hashes: st.hashes, repeat }))
        flagged.push({ s, st, file, lead, evidence: buildEvidence({ state, minutesInState: Math.round((now - st.since) / 60_000), hashes: st.hashes, intervalMin, repeat, openRows, tail }) });
      writeFileSync(file, JSON.stringify(st));
    }
  }
  // At most --max-asks Jev calls per run, the seats asked longest ago first, so no flagged seat waits forever.
  flagged.sort((x, y) => (x.st.lastAsked || 0) - (y.st.lastAsked || 0));
  for (const f of flagged.slice(0, maxAsks)) {
    const { s, st, file, lead, evidence } = f;
    asks++;
    const rec = await decideOrStub("seat.stuck", { seat: s.seat, evidence }, { caller: "agent-stuck-check" });
    st.lastAsked = now;
    const w = warning(s.seat, rec, evidence, { unchanged: unchangedRuns(st.hashes) });
    const last = st.warned?.[w?.verdict];
    const row = { seat: s.seat, band: rec.band, verdict: rec.result?.verdict, warn: Boolean(w), sent: false };
    if (w && lead && !(last && now - last < WARN_EVERY_MS) && !dry) {
      // Recorded as warned only when the message really went out; a failed send is tried again next run.
      if (rig(["send", lead, w.text], { allowFail: true }) !== null) { st.warned = { ...(st.warned || {}), [w.verdict]: now }; row.sent = true; }
      else row.sendFailed = true;
    }
    report.push(row);
    writeFileSync(file, JSON.stringify(st));
  }
  console.log(JSON.stringify({ asked: asks, flagged: flagged.length, results: report }, null, 2));
}

if (process.argv[1]?.endsWith("stuck.js") || process.argv[1]?.endsWith("agent-stuck-check")) await main();
