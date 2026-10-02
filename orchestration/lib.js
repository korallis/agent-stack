// Deterministic orchestration helpers: everything here is ordinary code (capacity, availability,
// dependencies, ownership, budgets). Semantic judgments are delegated to jev/lib/engine.js.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
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
  // Kimi seats run on the Claude Code runtime with a Kimi model (rig/template/fallback-codex.yaml: tests.kimi, review.kimi),
  // or natively (a terminal member running agent-native-seat, rig/template/standard.yaml): their member id says so, as
  // it does for native Grok seats. A family is the model's, not the runtime's; `native` says the CLI is its own.
  const native = node.runtime === "terminal";
  const family = /^grok/.test(member || "") ? "grok" : /^kimi/.test(member || "") ? "kimi" : node.runtime === "codex" ? "codex" : "claude";
  return { seat: node.canonicalSessionName, pod, member, role, family, native, runtime: node.runtime, model: node.model ?? null,
    running: node.lifecycleState === "running" && node.sessionStatus === "running",
    idle: node.agentActivity?.state === "idle", assigned: node.assignedWorkCount ?? 0, pending: node.pendingWorkCount ?? 0,
    context: typeof node.contextUsage?.usedPercentage === "number" ? node.contextUsage.usedPercentage : null };
}

export function seats(rigName) {
  const nodes = rig(["ps", "--nodes", "--rig", rigName], { json: true });
  // Terminal nodes are plain shells, except native agent seats (agent-native-seat: member grok* / kimi*), which take work.
  return (Array.isArray(nodes) ? nodes : nodes.nodes || [])
    .filter((n) => n.runtime !== "terminal" || /^(grok|kimi)/.test(String(n.logicalId || "").split(".")[1] || "")).map(seatInfo);
}

// One account can take work: enabled, available, active, and not past its quota limit (agent-proxy-status's over_limit:
// a window strictly above 100%, read by provider (WO84), or a used-up Codex window with no credits left; an account on
// credits is not over (WO85)). Absent over_limit (an older status tool) counts as not over.
export const accountEligible = (r) => !r.disabled && !r.unavailable && r.status === "active" && r.over_limit !== true;

// The proxy's provider names, as seat families (agent-proxy-status reports Kimi as "kimi-ai", Grok as "xai").
export const PROVIDER_FAMILY = { claude: "claude", codex: "codex", kimi: "kimi", "kimi-ai": "kimi", xai: "grok" };
const bareModel = (m) => String(m || "").replace(/\[1m\]$/, "");

// When a cooldown list ends: 0 when empty, null when any has no known end.
const cooldownEnd = (cs) => (cs.length ? (cs.every((c) => Number.isFinite(Date.parse(c?.retry_at))) ? Math.max(...cs.map((c) => Date.parse(c.retry_at))) : null) : 0);
// The earliest an account clears both its credential cooldown and model m's ("*": the credential alone); null if any
// account's time is unknown or there is no account to wait for.
function soonest(accts, m) {
  const ts = accts.map((a) => { const mm = m === "*" ? 0 : cooldownEnd(a.models.get(m) || []); return a.cred === null || mm === null ? null : Math.max(a.cred, mm); });
  return !ts.length || ts.includes(null) ? null : Math.min(...ts);
}

// Account availability from the proxy (never estimated by a model): eligible accounts per family. Two details ride on
// the result, not enumerable (so callers that read the counts are unchanged): `_models`, per family, the models every
// eligible account is cooling on (a credential-wide cooldown makes the account ineligible outright); and `_native`, the
// native CLIs' state (null: unknown, never a block).
export function eligibleFamilies(rows = null) {
  try {
    rows ??= JSON.parse(execFileSync("agent-proxy-status", ["--json"], { encoding: "utf8", timeout: 20_000 }));
    const fam = { claude: 0, codex: 0 }, cooling = {}, ready = {};
    const at = (c) => (c?.retry_at ? Date.parse(c.retry_at) : NaN);
    const end = cooldownEnd;
    for (const r of rows) {
      const f = PROVIDER_FAMILY[r.provider] ?? r.provider;
      fam[f] ??= 0;   // every provider seen starts at 0 (all accounts down is unavailable, not unknown)
      const cds = Array.isArray(r.cooldowns) ? r.cooldowns.filter((c) => !c?.retry_at || at(c) > Date.now()) : [];
      const cred = cds.filter((c) => c?.scope === "credential"), models = new Map();
      for (const c of cds.filter((c) => c?.scope !== "credential" && c?.model_key)) {
        const m = bareModel(c.model_key); models.set(m, [...(models.get(m) || []), c]);
      }
      // When this account can serve: a model, once its credential and that model's cooldowns have both ended (null:
      // not known); an account over its quota limit, in error or disabled reports no reset here, so it adds nothing.
      if (accountEligible(r)) (ready[f] ??= []).push({ cred: end(cred), models });
      if (!accountEligible(r) || cred.length) continue;
      fam[f] += 1;
      (cooling[f] ??= []).push(models);
    }
    // a model is out for a family when EVERY eligible account of it is cooling on that model; it can be served again at
    // the earliest time any account clears both its credential cooldown and that model's (null if any is unknown)
    const models = {}, until = {};
    for (const [f, maps] of Object.entries(cooling)) {
      models[f] = [...maps[0].keys()].filter((m) => maps.every((x) => x.has(m)));
      for (const m of models[f]) (until[f] ??= {})[m] = soonest(ready[f] || [], m);
    }
    for (const f of Object.keys(fam)) if (fam[f] === 0) (until[f] ??= {})["*"] = soonest(ready[f] || [], "*");
    Object.defineProperty(fam, "_ready", { value: ready });
    Object.defineProperty(fam, "_models", { value: models });
    Object.defineProperty(fam, "_until", { value: until });
    Object.defineProperty(fam, "_native", { value: { grok: null, kimi: null } });
    return fam;
  } catch {
    return { claude: null, codex: null }; // unknown ≠ zero: do not block dispatch on a status-tool failure
  }
}

// Can this seat take work now? Native seats run their own CLI (the proxy's accounts don't apply); a proxy seat needs an
// eligible account of its family that isn't cooling on its model. Unknown (null/undefined) never blocks.
export function seatAvailable(s, families = {}) {
  if (s.native) return families._native?.[s.family] !== false;
  if (families[s.family] === 0) return false;
  return !(s.model && (families._models?.[s.family] || []).includes(bareModel(s.model)));
}

// When a seat the proxy can't serve now can be served again: ms since the epoch, null when not known (an account over
// its quota limit reports no reset here), undefined when it isn't out.
export function servableAt(s, families = {}) {
  if (s.native || seatAvailable(s, families)) return undefined;
  // per account, both cooldowns, for this seat's model: also when every account is credential-cooling (QA PR119)
  if (families._ready) return soonest(families._ready[s.family] || [], s.model ? bareModel(s.model) : "*");
  const u = families._until?.[s.family] || {};
  return families[s.family] === 0 ? u["*"] ?? null : u[bareModel(s.model)] ?? null;
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

// The family fallback chain per role (config/routing.json; Jev, 2026-10-02).
const ROUTING = JSON.parse(readFileSync(new URL("../config/routing.json", import.meta.url), "utf8"));
export const ROLE_CHAIN = Object.fromEntries(Object.entries(ROUTING).filter(([k]) => !k.startsWith("_")));
// Roles held by one family in a team (the Claude lead, the Claude architect): when no seat of the role is free in any
// family, the work goes to the next role here (a Codex deputy), in that role's own chain.
export const ROLE_FALLBACK = ROUTING._role_fallback || {};

// Why a family has no seat to give for a role right now (for the fallback record): none, all out, or all busy.
export function familyGap(all, role, family, families) {
  const mine = all.filter((s) => s.role === role && s.family === family);
  if (!mine.length) return `no ${family} ${role} seat`;
  const live = mine.filter((s) => s.running);
  if (!live.length) return `${family} ${role} seats not running`;
  const ok = live.filter((s) => seatAvailable(s, families));
  if (!ok.length) {
    const cool = live.map((s) => s.model).filter((m) => m && (families._models?.[family] || []).includes(bareModel(m)));
    return families[family] === 0 ? `${family}: no eligible account` : cool.length ? `${family}: accounts cooling on ${[...new Set(cool)].join(", ")}`
      : `${family}: the native CLI is out`;
  }
  if (live.every((s) => s.context >= CONTEXT_WALL)) return `${family} ${role} seats at their context wall`;
  return `${family} ${role} seats all busy`;
}

// A seat at or past this share of its context window takes no new work (it's about to compact or stall).
export const CONTEXT_WALL = 97;

// Pick a concrete seat for a role: capacity + availability + balance + demonstrated quality. Pure code. With `chain` (a
// role's family order, ROLE_CHAIN), the first family that has a seat wins, and `fallback` says why the earlier ones didn't.
// `idle`: only seats observed idle (a move of existing work: a seat busy on something the queue doesn't show can't take it).
export function pickSeat(all, role, { preferFamily = null, excludeFamily = null, families = eligibleFamilies(), chain = null, idle = false } = {}) {
  const inFlight = { claude: 0, codex: 0 };
  for (const s of all) inFlight[s.family] = (inFlight[s.family] ?? 0) + s.assigned;
  const excluded = new Set([excludeFamily].flat().filter(Boolean));
  const pool = all.filter((s) => s.role === role && s.running && s.assigned === 0 && s.pending === 0
    && !excluded.has(s.family) && seatAvailable(s, families) && !(s.context >= CONTEXT_WALL) && (!idle || s.idle));
  const rank = (f) => { const i = chain ? chain.indexOf(f) : 0; return i < 0 ? 99 : i; };
  pool.sort((a, b) =>
    rank(a.family) - rank(b.family)
    || (preferFamily ? (b.family === preferFamily) - (a.family === preferFamily) : 0)
    || inFlight[a.family] - inFlight[b.family]
    || qualityScore(b.seat) - qualityScore(a.seat)
    || (b.idle - a.idle)
    || a.seat.localeCompare(b.seat));
  const seat = pool[0] || null;
  const skipped = chain && seat ? chain.slice(0, chain.indexOf(seat.family)).filter((f) => !excluded.has(f))
    .map((f) => ({ family: f, reason: familyGap(all, role, f, families) })) : [];
  return { seat, considered: pool.map((s) => s.seat), inFlight, families,
    ...(skipped.length ? { fallback: { to: seat.family, skipped } } : {}) };
}

// A seat for a role's work: the role's chain first, then its fallback roles (ROLE_FALLBACK) in theirs. `as` names the
// role that took it when that isn't the role asked for.
export function pickFor(all, role, { families = eligibleFamilies(), excludeFamily = null, idle = false } = {}) {
  const tried = [];
  for (const r of [role, ...(ROLE_FALLBACK[role] || [])]) {
    const p = pickSeat(all, r, { families, excludeFamily, idle, chain: ROLE_CHAIN[r] || null });
    if (p.seat) return { ...p, ...(r !== role ? { as: r, tried } : {}) };
    tried.push(r);
  }
  return { seat: null, tried };
}

// The review matrix (WO90), pure: never the author's own seat; another family than the author's, in the reviewer
// chain's order; the author's family only when no other family has a free reviewer, and then said so.
export function reviewerFor(all, authorSeat, authorFamily, families, chain = ROLE_CHAIN.reviewer || [], { idle = false } = {}) {
  const order = chain.filter((f) => f !== authorFamily);
  const pool = all.filter((s) => !authorSeat || (s.seat !== authorSeat && !s.seat.startsWith(`${authorSeat}@`)));
  const cross = pickSeat(pool, "reviewer", { excludeFamily: authorFamily, chain: order, families, idle });
  const same = cross.seat ? null : pickSeat(pool, "reviewer", { families, idle });
  const seat = cross.seat || same?.seat || null;
  return { seat, matrix: { author_family: authorFamily, order, chosen: seat?.family ?? null,
    skipped: cross.seat ? (cross.fallback?.skipped || []) : order.map((f) => ({ family: f, reason: familyGap(pool, "reviewer", f, families) })),
    ...(same?.seat ? { same_family: "no other family had a free reviewer" } : {}) } };
}

// Crude lexical prefilter so Jev only sees a focused candidate set (≤ n).
export function lexicalTop(query, docs, n = 20) {
  const toks = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
  const q = toks(query);
  return docs.map((d) => { const t = toks(d.text); let hit = 0; for (const w of q) if (t.has(w)) hit++; return { ...d, _s: hit / Math.sqrt(t.size + 1) }; })
    .filter((d) => d._s > 0).sort((a, b) => b._s - a._s).slice(0, n).map(({ _s, ...d }) => d);
}
