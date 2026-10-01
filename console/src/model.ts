// The console's data model. `Raw` is one cached read of every source (daemon API, queue, gate log, account pool,
// heavy slots, host); `derive` turns it into what the views draw. Pure: the views and the tests share it.

export type Activity = "working" | "idle" | "stuck" | "unknown" | "detached" | "stopped";
export interface Seat {
  rig: string; pod: string; name: string; session: string; runtime: string; model: string | null;
  ctx: number | null; activity: Activity; why: string | null; assigned: number; pending: number; inProgress: number; blocked: number;
  lastActivityAt: string | null; kind: string;
}
export interface Rig { id: string; name: string; lifecycle: string; seats: Seat[] }
export interface QRow { id: string; state: string; priority: string; source: string; destination: string; blockedOn: string | null; tags: string[]; created: string; updated: string; summary: string | null }
export interface Gate { ts: string; decision: string; band: string }
export interface Account { label: string; provider: string; status: string; short: number | null; weekly: number | null; cooling: boolean }
export interface Heavy { cls: string; held: number; total: number; waiting: number }
export interface Event { at: string; kind: string; rig: string | null; text: string }
export interface Raw {
  at: number;
  host: { id: string; cores: number; load: number[]; memUsedGB: number; memTotalGB: number };
  daemon: { ok: boolean; latencyMs: number | null; version: string | null; cpuPct: number | null; loopUtil: number | null; error: string | null };
  rigs: Rig[]; queue: QRow[]; attention: QRow[]; gates: Gate[]; accounts: Account[]; heavy: Heavy[]; events: Event[];
  refreshMs: number; sources: Record<string, string>;
}

// ── normalising the daemon's node rows ──────────────────────────────────────────────────────────────────────────────
// Phase-1 "stuck": a running seat whose activity the daemon reports as stalled or unknown, or that waits for input.
export function seatFromNode(n: Record<string, any>): Seat {
  const display = n.activityState?.display ?? null, raw = n.agentActivity?.state ?? null, life = n.lifecycleState ?? n.sessionStatus ?? "unknown";
  const needs = (n.activityState?.needsInput?.count ?? 0) > 0;
  let activity: Activity, why: string | null = null;
  if (life === "detached" || life === "recoverable") activity = "detached";
  else if (life !== "running") activity = "stopped";
  else if (needs) { activity = "stuck"; why = "needs input"; }
  else if (display === "working" || (!display && raw === "running")) activity = "working";
  else if (display === "idle" || (!display && raw === "idle")) activity = "idle";
  else if (display === "stalled" || raw === "stalled") { activity = "stuck"; why = "stalled"; }
  else { activity = "unknown"; why = "activity unknown"; }
  const session = String(n.canonicalSessionName ?? n.logicalId ?? "?");
  const logical = String(n.logicalId ?? session);
  return {
    rig: String(n.rigName ?? session.split("@")[1] ?? "?"), pod: String(n.podNamespace ?? logical.split(".")[0]),
    name: logical.includes(".") ? logical.slice(logical.indexOf(".") + 1) : logical, session,
    runtime: n.runtime === "codex" ? "cx" : n.runtime === "claude-code" ? (/kimi/.test(n.model ?? "") ? "km" : "cl") : String(n.runtime ?? "?").slice(0, 2),
    model: n.model ? String(n.model).replace(/\[1m\]$/, "") : null,
    ctx: n.contextUsage?.availability === "known" && typeof n.contextUsage.usedPercentage === "number" ? Math.round(n.contextUsage.usedPercentage) : null,
    activity, why, assigned: n.assignedWorkCount ?? 0, pending: n.pendingWorkCount ?? 0, inProgress: n.inProgressWorkCount ?? 0,
    blocked: n.blockedWorkCount ?? 0, lastActivityAt: n.lastActivityAt ?? null, kind: String(n.nodeKind ?? "agent"),
  };
}
export function qrowFromItem(q: Record<string, any>): QRow {
  return { id: q.qitemId, state: q.state, priority: q.priority ?? "routine", source: q.sourceSession ?? "", destination: q.destinationSession ?? "",
    blockedOn: q.blockedOn ?? null, tags: Array.isArray(q.tags) ? q.tags : [], created: q.tsCreated, updated: q.tsUpdated, summary: q.summary ?? null };
}
/** A daemon event as one ticker line, or null for the noise (view refreshes, activity samples, watchdog skips). */
export function eventLine(e: Record<string, any>): Event | null {
  const at = e.at ?? (e.createdAt ? `${String(e.createdAt).replace(" ", "T")}Z` : new Date().toISOString());
  const rigOf = (s: unknown) => (typeof s === "string" && s.includes("@") ? s.split("@").pop()! : null);
  const short = (s: unknown) => (typeof s === "string" ? s.split("@")[0] : "?");
  const sum = (s: unknown) => (typeof s === "string" && s ? ` · ${s}` : "");
  switch (e.type) {
    case "queue.created": return { at, kind: "QUEUED", rig: rigOf(e.destinationSession), text: `${short(e.sourceSession)} → ${short(e.destinationSession)} ${e.priority !== "routine" ? `(${e.priority})` : ""}${sum(e.summary)}`.trim() };
    case "queue.claimed": return { at, kind: "CLAIMED", rig: rigOf(e.actorSession ?? e.destinationSession), text: `${short(e.actorSession ?? e.destinationSession)} took ${String(e.qitemId ?? "").slice(-8)}${sum(e.summary)}` };
    case "queue.handed_off": return { at, kind: "HANDOFF", rig: rigOf(e.toSession), text: `${short(e.fromSession)} → ${short(e.toSession)}${sum(e.summary)}` };
    case "queue.updated":
      if (e.toState === "done") return { at, kind: "DONE", rig: rigOf(e.actorSession), text: `${short(e.actorSession)}${sum(e.summary)}` };
      if (e.toState === "blocked") return { at, kind: "BLOCKED", rig: rigOf(e.actorSession), text: `${short(e.actorSession)}${sum(e.summary)}` };
      return null;
    case "proof.judged": return { at, kind: "PROOF", rig: null, text: `judgment recorded${sum(e.scope)}` };
    case "node.launched": return { at, kind: "UP", rig: rigOf(e.sessionName), text: `${e.sessionName ?? e.logicalId} launched` };
    case "node.stopped": case "node.removed": return { at, kind: "DOWN", rig: rigOf(e.sessionName), text: `${e.sessionName ?? e.logicalId} ${String(e.type).split(".")[1]}` };
    default: return null;
  }
}

/** A queue transition (GET /api/queue/recent-transitions) as one ticker line. */
export function transitionLine(x: Record<string, any>): Event | null {
  if (!x || typeof x.change !== "string" || typeof x.ts !== "string") return null;
  const ch = x.change, short = (v: unknown) => (typeof v === "string" ? v.split("@")[0] : "?");
  const kind = /^claimed/.test(ch) ? "CLAIMED" : /^handed off/.test(ch) ? "HANDOFF" : /^(completed|done|closed)/.test(ch) ? "DONE"
    : /^blocked/.test(ch) ? "BLOCKED" : /^resumed/.test(ch) ? "RESUMED" : /^created/.test(ch) ? "QUEUED" : ch.split(" ")[0].toUpperCase().slice(0, 8);
  const what = ch.replace(/\b([A-Za-z0-9._-]+)@[A-Za-z0-9._-]+/g, "$1");
  return { at: x.ts, kind, rig: typeof x.rig === "string" ? x.rig : null, text: `${short(x.actorSession)} ${what}${x.summary ? ` · ${x.summary}` : ""}` };
}

// ── derived fleet view ──────────────────────────────────────────────────────────────────────────────────────────────
export const POD_ORDER = ["coord", "arch", "impl", "integ", "ops", "qa", "review", "tests"];
export const STAGES: { label: string; pods: string[] }[] = [
  { label: "SPEC", pods: ["arch"] }, { label: "TESTS", pods: ["tests"] }, { label: "BUILD", pods: ["impl"] },
  { label: "REVIEW", pods: ["review"] }, { label: "QA", pods: ["qa"] }, { label: "MERGE", pods: ["integ"] },
  { label: "OPS", pods: ["ops"] }, { label: "COORD", pods: ["coord"] },
];
// OpenRig's human seat (session-name.js): human[-name]@kernel|host. Owner decisions themselves come from the daemon's
// own attention query (queue/list?attention=1).
const HUMAN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;
export const isHuman = (s: string | null) => !!s && HUMAN.test(s);

export interface Fleet {
  seats: Seat[]; agents: Seat[];
  count: Record<Activity, number>;
  byRig: Record<string, Record<Activity, number>>;
  stuck: Seat[];
  queue: { pending: number; inProgress: number; blocked: number; onRow: number; onPr: number; onOwner: number; onOther: number };
  owner: QRow[];
  gate: { merge: number; hold: number; uncertain: number; act: number; total: number; partial: boolean };
  stages: { label: string; pending: number; inProgress: number; blocked: number }[];
  ctxHigh: Seat[];
  rigs: { rig: Rig; count: Record<Activity, number>; ctxMax: number | null; ctxAvg: number | null; rows: number; health: "ok" | "degraded" | "down" }[];
}
const zero = (): Record<Activity, number> => ({ working: 0, idle: 0, stuck: 0, unknown: 0, detached: 0, stopped: 0 });
const podOf = (session: string, seats: Map<string, Seat>) => seats.get(session)?.pod ?? session.split("@")[0].split("-")[0];

export function derive(raw: Raw): Fleet {
  const seats = raw.rigs.flatMap((r) => r.seats);
  const agents = seats.filter((s) => s.kind === "agent");
  const count = zero(), byRig: Fleet["byRig"] = {};
  for (const s of agents) { count[s.activity]++; (byRig[s.rig] ??= zero())[s.activity]++; }
  const bySession = new Map(seats.map((s) => [s.session, s]));
  const q = { pending: 0, inProgress: 0, blocked: 0, onRow: 0, onPr: 0, onOwner: 0, onOther: 0 };
  for (const r of raw.queue) {
    if (r.state === "pending") q.pending++;
    else if (r.state === "in-progress") q.inProgress++;
    else if (r.state === "blocked") {
      q.blocked++;
      const b = r.blockedOn ?? "";
      if (isHuman(b)) q.onOwner++; else if (/^qitem-/.test(b)) q.onRow++; else if (/^(pr:|#\d|https:\/\/github\.com\/.*\/pull\/)/.test(b) || /\bPR\b|#\d+/.test(b)) q.onPr++; else q.onOther++;
    }
  }
  const today = new Date(raw.at).toISOString().slice(0, 10);
  // partial: today's log was over the read cap, so the counts are a lower bound (shown as ≥ in every view)
  const gate = { merge: 0, hold: 0, uncertain: 0, act: 0, total: 0, partial: raw.sources.gates === "partial" };
  for (const g of raw.gates) {
    if (!g.ts.startsWith(today)) continue;
    gate.total++;
    if (g.decision === "merge") gate.merge++; else gate.hold++;
    if (g.band === "uncertain") gate.uncertain++; else if (g.band === "act") gate.act++;
  }
  const stages = STAGES.map((st) => {
    const rows = raw.queue.filter((r) => st.pods.includes(podOf(r.destination, bySession)));
    return { label: st.label, pending: rows.filter((r) => r.state === "pending").length, inProgress: rows.filter((r) => r.state === "in-progress").length, blocked: rows.filter((r) => r.state === "blocked").length };
  });
  const rigs = raw.rigs.map((rig) => {
    const c = zero(), as = rig.seats.filter((s) => s.kind === "agent");
    for (const s of as) c[s.activity]++;
    const ctx = as.map((s) => s.ctx).filter((v): v is number => v !== null);
    const live = c.working + c.idle + c.stuck + c.unknown;
    const health: "ok" | "degraded" | "down" = live === 0 ? "down" : c.stuck + c.unknown + c.detached + c.stopped > 0 ? "degraded" : "ok";
    return { rig, count: c, ctxMax: ctx.length ? Math.max(...ctx) : null, ctxAvg: ctx.length ? Math.round(ctx.reduce((a, b) => a + b, 0) / ctx.length) : null,
      rows: raw.queue.filter((r) => r.destination.endsWith(`@${rig.name}`)).length, health };
  });
  return {
    seats, agents, count, byRig, stuck: agents.filter((s) => s.activity === "stuck" || s.activity === "unknown"),
    queue: q, owner: [...raw.attention].sort((a, b) => a.created.localeCompare(b.created)), gate, stages,
    ctxHigh: agents.filter((s) => (s.ctx ?? 0) >= 80).sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0)), rigs,
  };
}

/** Pods in their canonical order, then any others alphabetically. */
export function podsOf(seats: Seat[]): string[] {
  const set = [...new Set(seats.map((s) => s.pod))];
  return set.sort((a, b) => (POD_ORDER.indexOf(a) + 1 || 99) - (POD_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
}
export const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
