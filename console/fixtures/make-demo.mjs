// Writes console/fixtures/demo.json: a neutral, made-up fleet for screenshots and tests (no real rig, project, seat or
// person names; no paths). Deterministic: a seeded generator, a fixed clock. node console/fixtures/make-demo.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const AT = Date.parse("2026-10-01T14:06:00Z");
const iso = (msAgo) => new Date(AT - msAgo).toISOString();

const TEAM = [["coord", ["lead-claude", "deputy-codex"]], ["arch", ["claude"]], ["impl", ["astra", "claude-ui-1", "claude-ui-2", "codex-1", "codex-2", "codex-3", "codex-4", "codex-5", "codex-6", "codex-7", "codex-8"]],
  ["integ", ["codex"]], ["ops", ["codex"]], ["qa", ["codex-1", "codex-2", "codex-3"]], ["review", ["claude-1", "claude-2", "codex", "codex-2", "kimi"]], ["tests", ["claude-1", "claude-2", "codex"]]];
const model = (name) => (/kimi/.test(name) ? "kimi-k3" : /claude-ui|tests-claude|^claude-[12]$/.test(name) ? "claude-sonnet-5-5" : /claude/.test(name) ? "claude-opus-5-5" : "gpt-6.1-sol");
function seat(rig, pod, name, opt = {}) {
  const runtime = /claude|kimi/.test(name) ? "claude-code" : "codex";
  const activity = opt.activity ?? (rnd() < (opt.busy ?? 0.55) ? "working" : "idle");
  return {
    rig, pod, name, session: `${pod}-${name}@${rig}`, runtime: runtime === "codex" ? "cx" : /kimi/.test(name) ? "km" : "cl", model: model(`${pod}-${name}`),
    ctx: opt.ctx !== undefined ? opt.ctx : Math.round(15 + rnd() * 70), activity, why: activity === "stuck" ? "stalled" : activity === "unknown" ? "activity unknown" : null,
    assigned: activity === "working" ? 1 : 0, pending: rnd() < 0.2 ? 1 : 0, inProgress: activity === "working" ? 1 : 0, blocked: rnd() < 0.15 ? 1 : 0,
    lastActivityAt: iso(activity === "working" ? 2000 : 60_000 * (1 + Math.floor(rnd() * 40))), kind: "agent",
  };
}
const team = (rig, busy) => TEAM.flatMap(([pod, names]) => names.map((n) => seat(rig, pod, n, { busy })));
const rigs = [
  { id: "R-kernel", name: "kernel", lifecycle: "running", seats: [seat("kernel", "advisor", "lead", { activity: "idle", ctx: 12 }), seat("kernel", "operator", "agent", { activity: "working", ctx: 41 }), seat("kernel", "queue", "worker", { activity: "working", ctx: 18 })] },
  { id: "R-alpha", name: "alpha", lifecycle: "running", seats: team("alpha", 0.35) },
  { id: "R-beta", name: "beta", lifecycle: "running", seats: team("beta", 0.55) },
  { id: "R-gamma", name: "gamma", lifecycle: "running", seats: team("gamma", 0.6) },
  { id: "R-pair", name: "pair", lifecycle: "running", seats: [seat("pair", "dev", "impl", { activity: "working", ctx: 78 }), seat("pair", "dev", "qa", { activity: "working", ctx: 44 })] },
  { id: "R-omega", name: "omega", lifecycle: "stopped", seats: TEAM.slice(0, 4).flatMap(([pod, names]) => names.slice(0, 3).map((n) => ({ ...seat("omega", pod, n), activity: "detached", ctx: null }))) },
];
// a few sharp cases: a stalled seat, an unknown one, context pressure
const g = rigs[3].seats;
Object.assign(g.find((x) => x.name === "codex-5" && x.pod === "impl"), { activity: "stuck", why: "stalled", ctx: 89 });
Object.assign(rigs[2].seats.find((x) => x.pod === "tests" && x.name === "codex"), { activity: "unknown", why: "activity unknown" });
Object.assign(rigs[2].seats.find((x) => x.pod === "arch"), { ctx: 92, activity: "working" });
Object.assign(rigs[1].seats.find((x) => x.pod === "ops"), { ctx: 84, activity: "working" });
Object.assign(g.find((x) => x.pod === "impl" && x.name === "codex-7"), { ctx: 81 });

const agentSessions = rigs.filter((r) => r.name !== "omega" && r.name !== "kernel").flatMap((r) => r.seats.map((s) => s.session));
const FEATURES = ["F-052 tenant export", "F-062 purge scheduler v2", "F-056 restore from snapshot", "F-057 export audit trail", "F-058 lifecycle events",
  "F-031 billing webhook retry", "F-061 retention policy UI", "F-064 data residency report", "W2-WIT wave 2 end-to-end proof"];
const tagFor = (f) => f.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
const queue = [];
for (let i = 0; i < 100; i++) {
  const dest = pick(agentSessions), state = i < 18 ? "pending" : i < 59 ? "in-progress" : "blocked";
  const kind = rnd();
  queue.push({ id: `qitem-20261001${String(100000 + i * 37).slice(-6)}-${(0x10000000 + i * 7919).toString(16).slice(-8)}`, state, priority: rnd() < 0.15 ? "urgent" : "routine",
    source: pick(agentSessions), destination: dest, blockedOn: state !== "blocked" ? null : kind < 0.5 ? `pr:${400 + Math.floor(rnd() * 30)}` : kind < 0.85 ? `qitem-20261001${String(100000 + i).slice(-6)}-0000abcd` : "human@kernel",
    tags: [`project:${dest.split("@")[1]}`, `mission:m4-data-lifecycle`, `slice:${tagFor(pick(FEATURES))}`], created: iso(60_000 * (5 + Math.floor(rnd() * 300))), updated: iso(60_000 * Math.floor(rnd() * 30)), summary: null });
}
// one slice's whole journey (gamma, F-055): spec → tests → build → review → QA → merge held for the owner
const J = "slice:f-055-backup-and-restore-drill", jtags = ["project:gamma", "mission:m4-data-lifecycle", J, "pr:412"];
const jrows = [
  ["arch-claude@gamma", "done", 3000, 2900, "spec locked: 14 acceptance outcomes"], ["tests-codex@gamma", "done", 2880, 2770, "11 locked tests, red by design"],
  ["impl-codex-4@gamma", "done", 2700, 2350, "PR #412: 11/11 locked tests green"], ["review-claude-1@gamma", "done", 2300, 2180, "cross-family review: 2 findings fixed"],
  ["qa-codex-1@gamma", "done", 2150, 1990, "bug review board: ship YES"], ["integ-codex@gamma", "blocked", 1960, 30, "merge held: Jev HOLD 58%, owner asked"],
];
const transitions = {};
jrows.forEach(([dest, state, startMin, endMin, summary], i) => {
  const id = `qitem-20260929${String(140000 + i * 1111).slice(-6)}-j055${String(i).padStart(4, "0")}`;
  const row = { id, state, priority: i === 5 ? "urgent" : "routine", source: i ? jrows[i - 1][0] : "coord-lead-claude@gamma", destination: dest, blockedOn: state === "blocked" ? "human@kernel" : null,
    tags: jtags, created: iso(startMin * 60_000), updated: iso(endMin * 60_000), summary };
  (state === "done" ? (globalThis.jdone ??= []) : queue).push(row);
  const claim = startMin - Math.round((startMin - endMin) * 0.3);
  transitions[id] = [{ id: 1000 + i * 10, ts: iso(startMin * 60_000), state: "pending", note: "created", actor: row.source },
    { id: 1001 + i * 10, ts: iso(claim * 60_000), state: "in-progress", note: "claimed", actor: dest },
    ...(state === "done" ? [{ id: 1002 + i * 10, ts: iso(endMin * 60_000), state: "done", note: summary, actor: dest }]
      : [{ id: 1002 + i * 10, ts: iso((claim - 60) * 60_000), state: "blocked", note: summary, actor: dest }])];
});
// slices that reached the sea today, and earlier done rows
const done = [...globalThis.jdone];
for (let i = 0; i < 24; i++) {
  const rig = pick(["alpha", "beta", "gamma"]), f = `slice:f-0${30 + i}-${pick(["export", "audit-log", "billing-retry", "tenant-roles", "search"])}`;
  done.push({ id: `qitem-20261001${String(10000 + i * 97).padStart(6, "0")}-d0ne${String(i).padStart(4, "0")}`, state: "done", priority: "routine", source: `coord-lead-claude@${rig}`,
    destination: `integ-codex@${rig}`, blockedOn: null, tags: [`project:${rig}`, f], created: iso((300 + i * 20) * 60_000), updated: iso((10 + i * 25) * 60_000), summary: "merged" });
}
const attention = [
  { id: "qitem-20261001115500-d121aaaa", state: "pending", priority: "urgent", source: "integ-codex@beta", destination: "human@kernel", blockedOn: null, tags: ["project:beta"], created: iso(131 * 60_000), updated: iso(60_000), summary: "F-056 restore from snapshot: gate HOLD 58%. A merge  B add test  C defer" },
  { id: "qitem-20261001130200-d119bbbb", state: "pending", priority: "urgent", source: "coord-lead-claude@alpha", destination: "human@kernel", blockedOn: null, tags: ["project:alpha"], created: iso(64 * 60_000), updated: iso(60_000), summary: "F-031 billing webhook retry: A per-tenant key  B global key" },
  { id: "qitem-20261001132800-d120cccc", state: "pending", priority: "routine", source: "arch-claude@alpha", destination: "human@kernel", blockedOn: null, tags: ["project:alpha"], created: iso(38 * 60_000), updated: iso(60_000), summary: "M5 scope: A SSO in wave 1  B SSO in wave 2  C drop" },
];
const gates = [];
for (let i = 0; i < 36; i++) gates.push({ ts: iso(60_000 * (8 + i * 22)), decision: i % 7 === 3 ? "hold" : "merge", band: i % 9 === 4 ? "uncertain" : i % 5 === 1 ? "review" : "act" });
const accounts = [["claude-a", "claude", 55, 60, "active"], ["claude-b", "claude", 42, 51, "active"], ["claude-c", "claude", 71, 48, "active"], ["codex-a", "codex", 100, 74, "cooling"],
  ["codex-b", "codex", 63, 58, "active"], ["codex-c", "codex", 88, 66, "active"], ["codex-d", "codex", 31, 40, "active"], ["kimi-a", "kimi", 12, 9, "active"]]
  .map(([label, provider, short, weekly, status]) => ({ label, provider, status, short, weekly, cooling: status !== "active" }));
const KINDS = [["DONE", "integ-codex · F-052 tenant export merged"], ["BLOCKED", "impl-codex-6 · F-057 export audit trail waits on PR #412"], ["QUEUED", "qa-codex-2 → impl-codex-4 (urgent) · F-055 fix round"],
  ["CLAIMED", "review-claude-1 took 7e1c09a2 · cross-family review #415"], ["HANDOFF", "tests-claude-1 → coord-lead-claude · F-058 tests locked"], ["PROOF", "judgment recorded · m4/slices/f-055"],
  ["UP", "impl-codex-3@gamma launched"], ["DONE", "qa-codex-1 · bug board: 0 open findings"]];
const events = KINDS.concat(KINDS).slice(0, 16).map(([kind, text], i) => ({ at: iso(i * 47_000 + 4000), kind, rig: pick(["alpha", "beta", "gamma"]), text }));
const history = [];
for (let m = 1440; m > 0; m--) {
  const t = AT - m * 60_000, h = (t / 3_600_000) % 24, day = Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2));
  history.push({ t, working: Math.round(14 + day * 24 + rnd() * 4), idle: Math.round(40 - day * 20 + rnd() * 3), stuck: rnd() < 0.05 ? 1 : 0,
    pending: Math.round(10 + day * 12 + rnd() * 4), inProgress: Math.round(20 + day * 25), blocked: Math.round(30 + day * 15 + rnd() * 5), gateToday: Math.round(Math.max(0, (h - 0) * 1.5)) });
}
// a terminal tail for the seats a screenshot opens, and some queue history (neutral, made up)
const tails = {
  "impl-codex-4@gamma": ["--- SESSION BOUNDARY: restore attempt from snapshot X at 2026-10-01T09:00:00Z ---", "› Running the locked restore tests.", "", "$ npm test -- restore-progress --run",
    "", " RUN  v3.2.4 restore-progress", "", " ✓ progress survives a dropped connection          184ms", " ✓ replayed events do not duplicate progress         92ms",
    " ✓ completed restore remains complete after reconnect 76ms", "", " Test Files  1 passed (1)", "      Tests  3 passed (3)", "", "• The reconnect cases pass. Checking the diff before opening the PR.",
    "", "$ git diff --stat", " src/restore/progress.ts | 28 ++++++++++++++++++++--------", " 1 file changed, 20 insertions(+), 8 deletions(-)", "", "$ npm run typecheck", "> tsc --noEmit", "• Checking types…"].join("\n"),
};
const queueHistory = [["claimed", "F-055 fix round"], ["handed off to review-claude-1@gamma", "PR #412 ready for cross-family review"], ["resumed", "locked tests green"], ["claimed", "F-056 restore from snapshot"]]
  .map(([change, summary], i) => ({ id: 9000 + i, ts: iso((20 + i * 37) * 60_000), actor: "impl-codex-4@gamma", change, summary, rig: "gamma", qitemId: `qitem-demo-${i}` }));
const raw = {
  at: AT, host: { id: "host-demo01", cores: 32, load: [6.4, 7.1, 6.8], memUsedGB: 41.2, memTotalGB: 64 },
  daemon: { ok: true, latencyMs: 12, version: "0.6.3", cpuPct: 5.1, loopUtil: 0.18, error: null },
  rigs, queue, attention, gates, accounts, done, transitions, tails, history: queueHistory, heavy: [{ cls: "build", held: 2, total: 2, waiting: 1 }, { cls: "browser", held: 1, total: 2, waiting: 0 }], events,
  refreshMs: 5000, sources: { daemon: "ok", accounts: "ok", heavy: "ok", gates: "ok" },
};
fs.writeFileSync(fileURLToPath(new URL("./demo.json", import.meta.url)), JSON.stringify({ note: "Neutral demo data for rig-console (made up).", raw, history }) + "\n");
