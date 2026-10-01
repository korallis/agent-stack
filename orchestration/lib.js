// Deterministic orchestration helpers: everything here is ordinary code (capacity, availability,
// dependencies, ownership, budgets). Semantic judgments are delegated to jev/lib/engine.js.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../jev/lib/store.js";

export function rig(args, { json = false, allowFail = false } = {}) {
  try {
    const out = execFileSync("rig", json ? [...args, "--json"] : args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    return json ? JSON.parse(out) : out;
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`rig ${args.join(" ")} failed: ${(e.stderr || e.message).toString().slice(0, 300)}`);
  }
}

// Role and model family come from the seat's pod/member naming (see rig/agent_team.py ROSTER).
// Pod id -> role, as the team templates lay them out (rig/template/*.yaml; the roles are rig/template/agents/*).
// OpenRig's node data has no agent ref, so the pod is what tells the role. (team.yaml's integ pod also holds a
// recovery member under a neutral id: it reads as integrator.)
const POD_ROLE = { coord: null, arch: "architect", impl: "implementer", review: "reviewer", integ: "integrator",
  qa: "qa", tests: "test-author", ops: "recovery" };
export const ROLES = ["lead", "deputy", "architect", "implementer", "reviewer", "integrator", "qa", "test-author", "recovery"];
// What --role accepts: a role, or its pod's short name (impl, review, qa, arch, integ, tests, ops) and a few spellings.
const ROLE_ALIASES = { arch: "architect", impl: "implementer", review: "reviewer", integ: "integrator", tests: "test-author",
  test: "test-author", tester: "qa", ops: "recovery", coord: "lead" };
// Pure: the role for a --role value; throws, naming the valid ones, for anything else (never a silent "none free").
export function normalizeRole(role) {
  const r = String(role || "").trim().toLowerCase();
  if (ROLES.includes(r)) return r;
  if (Object.hasOwn(ROLE_ALIASES, r)) return ROLE_ALIASES[r];   // own entries only: "constructor", "__proto__" are not roles
  const aka = (x) => Object.entries(ROLE_ALIASES).filter(([, v]) => v === x).map(([k]) => k);
  throw new Error(`unknown role "${role}": use one of ${ROLES.map((x) => (aka(x).length ? `${x} (${aka(x).join(", ")})` : x)).join(", ")}`);
}
export function seatInfo(node) {
  const [pod, member] = node.logicalId.split(".");
  let role = Object.hasOwn(POD_ROLE, pod) ? POD_ROLE[pod] : undefined;
  if (pod === "coord") role = member.startsWith("lead") ? "lead" : "deputy";
  // Kimi seats run on the Claude Code runtime with a Kimi model (rig/template/fallback-codex.yaml: tests.kimi, review.kimi):
  // their member id says so. A family is the model's, not the runtime's.
  const family = /^kimi/.test(member || "") ? "kimi" : node.runtime === "codex" ? "codex" : "claude";
  return { seat: node.canonicalSessionName, pod, member, role, family, runtime: node.runtime,
    running: node.lifecycleState === "running" && node.sessionStatus === "running",
    idle: node.agentActivity?.state === "idle", assigned: node.assignedWorkCount ?? 0, pending: node.pendingWorkCount ?? 0 };
}

export function seats(rigName) {
  const nodes = rig(["ps", "--nodes", "--rig", rigName], { json: true });
  return (Array.isArray(nodes) ? nodes : nodes.nodes || []).filter((n) => n.runtime !== "terminal").map(seatInfo);
}

// One account can take work: enabled, available, active, and not past its quota limit (agent-proxy-status's over_limit:
// a window strictly above 100%, read by provider; WO84). Absent over_limit (an older status tool) counts as not over.
export const accountEligible = (r) => !r.disabled && !r.unavailable && r.status === "active" && r.over_limit !== true;

// Account availability from the proxy (never estimated by a model).
export function eligibleFamilies() {
  try {
    const rows = JSON.parse(execFileSync("agent-proxy-status", ["--json"], { encoding: "utf8", timeout: 20_000 }));
    const fam = { claude: 0, codex: 0 };
    // every provider seen starts at 0 (a family whose accounts are all down is unavailable, not unknown: kimi too)
    for (const r of rows) { fam[r.provider] ??= 0; if (accountEligible(r)) fam[r.provider] += 1; }
    return fam;
  } catch {
    return { claude: null, codex: null }; // unknown ≠ zero: do not block dispatch on a status-tool failure
  }
}

// OpenRig queue JSON is camelCase (qitemId, destinationSession, ...); normalise once here.
export function normQ(q) {
  if (!q) return null;
  const x = q.qitem || q;
  return { id: x.qitemId, state: x.state, destination: x.destinationSession, source: x.sourceSession,
    summary: x.summary, body: x.body, closureReason: x.closureReason, tags: x.tags };
}
export function queueItems(rigName, { all = false } = {}) {
  const r = rig(["queue", "list", "-A", ...(all ? ["-a"] : []), "--limit", "500"], { json: true, allowFail: true });
  const items = (Array.isArray(r) ? r : r?.items || r?.qitems || []).map(normQ);
  return items.filter((q) => !rigName || String(q.destination || "").endsWith(`@${rigName}`));
}

// Durable orchestration state: seat quality record, recovery attempts, dispatch idempotency.
let db;
export function odb() {
  if (db) return db;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  db = new DatabaseSync(join(STATE_DIR, "orchestration.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS seat_quality (seat TEXT PRIMARY KEY, completed INTEGER DEFAULT 0, returned INTEGER DEFAULT 0, failed INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS recovery (id INTEGER PRIMARY KEY, ts INTEGER, item TEXT, seat TEXT, class TEXT, action TEXT, applied INTEGER, decided_by TEXT);
    CREATE TABLE IF NOT EXISTS dispatches (key TEXT PRIMARY KEY, ts INTEGER, item TEXT, seat TEXT);`);
  return db;
}
export function quality(seat) {
  return odb().prepare("SELECT completed, returned, failed FROM seat_quality WHERE seat=?").get(seat) || { completed: 0, returned: 0, failed: 0 };
}
export function recordQuality(seat, field) {
  if (!["completed", "returned", "failed"].includes(field)) throw new Error("bad field");
  odb().prepare(`INSERT INTO seat_quality (seat, ${field}) VALUES (?,1) ON CONFLICT(seat) DO UPDATE SET ${field}=${field}+1`).run(seat);
}
// Laplace-smoothed success rate: new seats start at 0.5, demonstrated quality moves it.
export function qualityScore(seat) {
  const q = quality(seat);
  return (q.completed + 1) / (q.completed + q.returned + q.failed + 2);
}

// Pick a concrete seat for a role: capacity + availability + balance + demonstrated quality. Pure code.
export function pickSeat(all, role, { preferFamily = null, excludeFamily = null, families = eligibleFamilies() } = {}) {
  const inFlight = { claude: 0, codex: 0 };
  for (const s of all) inFlight[s.family] += s.assigned;
  const pool = all.filter((s) => s.role === role && s.running && s.assigned === 0 && s.pending === 0
    && s.family !== excludeFamily && families[s.family] !== 0);
  pool.sort((a, b) =>
    (preferFamily ? (b.family === preferFamily) - (a.family === preferFamily) : 0)
    || inFlight[a.family] - inFlight[b.family]
    || qualityScore(b.seat) - qualityScore(a.seat)
    || (b.idle - a.idle)
    || a.seat.localeCompare(b.seat));
  return { seat: pool[0] || null, considered: pool.map((s) => s.seat), inFlight, families };
}

// Crude lexical prefilter so Jev only sees a focused candidate set (≤ n).
export function lexicalTop(query, docs, n = 20) {
  const toks = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
  const q = toks(query);
  return docs.map((d) => { const t = toks(d.text); let hit = 0; for (const w of q) if (t.has(w)) hit++; return { ...d, _s: hit / Math.sqrt(t.size + 1) }; })
    .filter((d) => d._s > 0).sort((a, b) => b._s - a._s).slice(0, n).map(({ _s, ...d }) => d);
}
