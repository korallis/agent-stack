#!/usr/bin/env node
// agent-recover — classify a failure/stall and choose a PERMITTED recovery action.
//
//   agent-recover --rig R --seat SEAT@R [--item QITEM] --error "text" [--apply] [--team-dir DIR]
//
// Code owns: the permitted-action table, retry budgets and cooldowns, ownership checks, duplicate
// suppression and execution. Jev owns: error classification, choosing among the permitted actions,
// ranking prior incidents. Without --apply it only reports. Every run is recorded.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { decide } from "../jev/lib/engine.js";
import { rig, seats, pickSeat, odb, lexicalTop, recordQuality, normQ } from "./lib.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const caller = process.env.OPENRIG_SESSION_NAME || "operator";

export const POLICY = {
  // class              permitted actions (escalate is always appended)
  auth_expired:         ["reauthenticate"],
  rate_limited:         ["retry", "reassign"],
  quota_exhausted:      ["reassign"],
  upstream_unavailable: ["retry"],
  network:              ["retry"],
  context_overflow:     ["repair", "reassign"],
  tool_failure:         ["repair", "retry"],
  test_failure:         ["repair"],
  merge_conflict:       ["repair"],
  permission_denied:    [],
  stalled:              ["retry", "reassign"],
  unclear:              [],
};
export const BUDGET = { maxRetriesPerItem: 2, retryCooldownMs: 60_000, maxReassignsPerItem: 1, duplicateWindowMs: 120_000 };
const ACTION_TEXT = {
  retry: "Retry the same step unchanged after the cooldown (nudge the owning seat)",
  reauthenticate: "Credentials expired: the user must re-run the proxy login for the affected account",
  repair: "The owning seat fixes the underlying problem (config, tests, conflict, context) before continuing",
  reassign: "Move the work item to another idle seat with the same role",
  escalate: "Stop automatic handling and hand the problem to the lead (or the user if it needs them)",
};
const REPAIR_HINT = {
  context_overflow: "Context is too large: write a handoff note, then /compact or restart the session from the note.",
  tool_failure: "A local tool failed: read the error, fix configuration or dependencies, re-run.",
  test_failure: "Tests fail: reproduce locally, fix the code or the test with justification, re-run the suite.",
  merge_conflict: "Rebase agent/<seat> onto main, resolve conflicts preserving both intents, re-run tests.",
};

// Deterministic signatures first (ordinary code); Jev only sees errors no rule — or more than one
// rule — matches. Rules must be high-precision: an exact status code or a provider's fixed wording.
export const RULES = [
  ["auth_expired", /\b401\b|unauthori[sz]ed|token (has )?expired|invalid[_ ]api[_ ]key|please run \/login/i],
  ["quota_exhausted", /usage[_ ]limit[_ ]reached|usage limit has been reached|weekly limit|quota (exceeded|exhausted)/i],
  ["upstream_unavailable", /\b529\b|overloaded_error/i],
  ["merge_conflict", /CONFLICT \(content\)|Automatic merge failed/],
  ["context_overflow", /prompt is too long|context_length_exceeded|maximum context length/i],
  // CLIProxyAPI's wording when a model has NO eligible credential left (all disabled/removed).
  ["quota_exhausted", /unknown provider for model|no (available|eligible) (credential|auth|account)s?/i],
];

// Pool facts come from the proxy, never from a model: which families have zero eligible accounts,
// and when the soonest cooldown/quota window resets.
function poolCheck() {
  try {
    const rows = JSON.parse(execFileSync("agent-proxy-status", ["--json"], { encoding: "utf8", timeout: 20_000 }));
    const out = {};
    for (const fam of ["claude", "codex"]) {
      const rs = rows.filter((r) => r.provider === fam);
      const ok = rs.filter((r) => !r.disabled && !r.unavailable && r.status === "active");
      const resets = rs.flatMap((r) => (r.cooldowns || []).map((c) => c.until || c.next_retry_after)).filter(Boolean).sort();
      out[fam] = { eligible: ok.length, total: rs.length, soonest_reset: resets[0] || null };
    }
    return out;
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}
export function ruleClass(error) {
  const hits = RULES.filter(([, re]) => re.test(error)).map(([c]) => c);
  return hits.length === 1 ? hits[0] : null;
}

function history(item) {
  if (!item) return { retries: 0, reassigns: 0, lastRetry: 0, recent: [] };
  const rows = odb().prepare("SELECT ts, action, applied FROM recovery WHERE item=? ORDER BY ts DESC").all(item);
  const applied = rows.filter((r) => r.applied);
  return { retries: applied.filter((r) => r.action === "retry").length, reassigns: applied.filter((r) => r.action === "reassign").length,
    lastRetry: applied.find((r) => r.action === "retry")?.ts || 0, recent: rows.filter((r) => Date.now() - r.ts < BUDGET.duplicateWindowMs && r.applied) };
}

export function permittedActions(cls, band, { item, seat, owner, caller: who, rigSeats }) {
  const h = history(item);
  const reasons = {};
  let acts = band === "uncertain" ? [] : [...(POLICY[cls] || [])];
  if (band === "uncertain") reasons.all = "classification uncertain: only escalation is permitted";
  acts = acts.filter((a) => {
    if (a === "retry") {
      if (h.retries >= BUDGET.maxRetriesPerItem) { reasons.retry = `retry budget exhausted (${h.retries}/${BUDGET.maxRetriesPerItem})`; return false; }
      if (Date.now() - h.lastRetry < BUDGET.retryCooldownMs) { reasons.retry = "retry cooldown active"; return false; }
    }
    if (a === "reassign") {
      if (!item) { reasons.reassign = "no work item to reassign"; return false; }
      if (h.reassigns >= BUDGET.maxReassignsPerItem) { reasons.reassign = "reassign budget exhausted"; return false; }
      const allowed = [owner, ...rigSeats.filter((s) => ["lead", "integrator"].includes(s.role)).map((s) => s.seat)];
      if (!allowed.includes(who)) { reasons.reassign = `caller ${who} does not own the item (owner ${owner}) and is not lead/integration`; return false; }
      const me = rigSeats.find((s) => s.seat === seat);
      if (!me || !pickSeat(rigSeats.filter((s) => s.seat !== seat), me.role).seat) { reasons.reassign = "no idle seat with the same role"; return false; }
    }
    if (a === "repair" && !REPAIR_HINT[cls]) return false;
    return true;
  });
  if (h.recent.length) reasons.duplicate = `a recovery action was already applied to ${item} in the last ${BUDGET.duplicateWindowMs / 1000}s`;
  return { actions: h.recent.length ? ["escalate"] : [...acts, "escalate"], reasons, history: h };
}

async function main() {
  const rigName = flag("--rig"); const seat = flag("--seat"); const item = flag("--item"); const error = flag("--error");
  if (!rigName || !seat || !error) throw new Error("--rig, --seat and --error are required");
  const rigSeats = seats(rigName);
  let owner = seat;
  if (item) {
    const q = rig(["queue", "show", item], { json: true, allowFail: true });
    owner = normQ(q)?.destination || seat;
  }
  const teamDir = flag("--team-dir");
  const ruled = ruleClass(error);
  const cls = ruled ? { result: { class: ruled }, decided_by: "code", band: "act" }
    : await decide("recovery.classify_error", { error }, { caller });
  const perm = permittedActions(cls.result.class, cls.band, { item, seat, owner, caller, rigSeats });
  let pool = null;
  if (["quota_exhausted", "rate_limited", "auth_expired", "upstream_unavailable"].includes(cls.result.class)) {
    pool = poolCheck();
    const fam = rigSeats.find((s) => s.seat === seat)?.family;
    if (fam && pool[fam]?.eligible === 0) {
      // Clear, deterministic report: nothing to retry or reassign within this family.
      perm.actions = ["escalate"];
      perm.reasons.pool = `POOL EXHAUSTED: ${fam} has 0/${pool[fam].total} eligible accounts` +
        (pool[fam].soonest_reset ? `; soonest reset ${pool[fam].soonest_reset}` : "") + ". Needs the user (re-auth or wait); no paid fallback exists.";
    }
  }

  let incidents = null;
  if (teamDir && existsSync(join(teamDir, "incidents"))) {
    const docs = readdirSync(join(teamDir, "incidents")).filter((f) => f.endsWith(".md"))
      .map((f) => ({ id: f, text: readFileSync(join(teamDir, "incidents", f), "utf8").slice(0, 1500) }));
    const cands = lexicalTop(error, docs, 30);
    if (cands.length) incidents = await decide("recovery.rank_incidents", { error, candidates: cands }, { caller });
  }

  let actionRec = null; let action = perm.actions[0];
  if (perm.actions.length > 1) {
    actionRec = await decide("recovery.select_action", { error, error_class: cls.result.class,
      candidates: perm.actions.map((a) => ({ id: a, text: ACTION_TEXT[a] })) }, { caller });
    action = actionRec.result.action;
    if (!perm.actions.includes(action)) action = "escalate";   // defensive: never act outside the permitted set
  }

  const report = { class: cls.result.class, class_decided_by: cls.decided_by, class_band: cls.band, permitted: perm.actions,
    excluded: perm.reasons, pool, budget: { retries: perm.history.retries, reassigns: perm.history.reassigns },
    action, action_decided_by: actionRec ? actionRec.decided_by : "code", action_band: actionRec?.band ?? "act",
    related_incidents: incidents ? incidents.result.ranking : [], applied: false };

  if (has("--apply")) {
    const lead = rigSeats.find((s) => s.role === "lead")?.seat;
    if (action === "retry") rig(["send", seat, `[recovery] ${cls.result.class}: cooldown passed, please retry your last step${item ? ` for ${item}` : ""}.`]);
    else if (action === "repair") rig(["send", seat, `[recovery] ${cls.result.class}: ${REPAIR_HINT[cls.result.class]}`]);
    else if (action === "reassign") {
      const me = rigSeats.find((s) => s.seat === seat);
      const to = pickSeat(rigSeats.filter((s) => s.seat !== seat), me.role).seat;
      rig(["queue", "handoff", item, "--to", to.seat, "--note", `recovery reassign from ${seat}: ${cls.result.class}`], { json: true });
      recordQuality(seat, "failed");
      report.reassigned_to = to.seat;
    } else if (action === "reauthenticate") {
      if (lead) rig(["send", lead, `[recovery] ${seat}: upstream auth expired. The USER must run: agent-login <claude|codex> <label> (see agent-proxy-status). Seat should wait.`]);
    } else if (lead && lead !== seat) {
      rig(["send", lead, `[recovery] escalation from ${seat}${item ? ` (${item})` : ""}: ${cls.result.class}. ${error.slice(0, 200)}`]);
    }
    report.applied = true;
    if (teamDir) {
      mkdirSync(join(teamDir, "incidents"), { recursive: true });
      const f = join(teamDir, "incidents", `${new Date().toISOString().replace(/[:.]/g, "-")}-${cls.result.class}.md`);
      writeFileSync(f, `# ${cls.result.class} on ${seat}\n\nitem: ${item || "-"}\naction: ${action} (${report.action_decided_by})\n\n## Error\n${error.slice(0, 1200)}\n\n## Resolution\n(fill in when resolved)\n`);
      report.incident = f;
    }
  }
  odb().prepare("INSERT INTO recovery (ts,item,seat,class,action,applied,decided_by) VALUES (?,?,?,?,?,?,?)")
    .run(Date.now(), item || null, seat, cls.result.class, action, report.applied ? 1 : 0, report.action_decided_by);
  console.log(JSON.stringify(report, null, 2));
}

// Run as a CLI only when executed directly (tests import the policy functions).
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] || "")).href) {
  main().catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });
}
