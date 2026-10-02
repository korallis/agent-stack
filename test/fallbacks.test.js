// WO90 items 1, 2 and 4: automatic fallbacks so a large pool never gets stuck. Family chains per role (config/routing.json,
// Jev 2026-10-02) over live eligibility (proxy accounts, per-model cooldowns, native CLIs); the review matrix; and the
// reroute of rows waiting on a seat that can't take them. Failure injection on fixtures only: a family out of quota, a
// model cooling on every account, a dead seat, a seat at its context wall. No live rig, proxy or model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.AGENT_STACK_STATE ??= fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "fallbacks-"));
const { seatInfo, eligibleFamilies, seatAvailable, servableAt, pickSeat, pickFor, reviewerFor, ROLE_CHAIN, PROVIDER_FAMILY } = await import("../orchestration/lib.js");
const { plan, blocked, resumes } = await import("../orchestration/reroute.js");
const { ruleClass } = await import("../orchestration/recover.js");

const node = (id, runtime, o = {}) => ({ logicalId: id, canonicalSessionName: `${id.replace(".", "-")}@app`, runtime, model: o.model ?? null,
  lifecycleState: o.dead ? "stopped" : "running", sessionStatus: o.dead ? "exited" : "running", agentActivity: { state: o.working ? "running" : "idle" },
  assignedWorkCount: o.busy ? 1 : 0, pendingWorkCount: 0, contextUsage: o.ctx != null ? { usedPercentage: o.ctx } : undefined });
const acct = (provider, o = {}) => ({ provider, status: "active", disabled: false, unavailable: false, over_limit: false, cooldowns: [], ...o });
const cool = (model, ms = 3600e3) => ({ scope: "model", model_key: model, reason: "quota", retry_at: new Date(Date.now() + ms).toISOString() });

test("native grok and kimi seats are dispatch targets with their own family; proxy Kimi is kimi too", () => {
  assert.deepEqual(["impl.grok-1", "review.kimi"].map((id) => [seatInfo(node(id, "terminal")).family, seatInfo(node(id, "terminal")).native]), [["grok", true], ["kimi", true]]);
  assert.deepEqual([seatInfo(node("review.kimi", "claude-code")).family, seatInfo(node("review.kimi", "claude-code")).native], ["kimi", false]);
  assert.equal(seatInfo(node("impl.codex-1", "codex", { model: "gpt-6.1-sol" })).model, "gpt-6.1-sol");
  assert.equal(PROVIDER_FAMILY["kimi-ai"], "kimi", "the proxy calls Kimi kimi-ai: it used to count as an unknown family, never as out");
});

test("eligibility: credential cooldowns and models cooling on every account take a family out; native seats ignore the proxy", () => {
  const fam = eligibleFamilies([
    acct("claude", { cooldowns: [cool("claude-opus-5-5"), cool("claude-sonnet-5-5")] }), acct("claude", { cooldowns: [cool("claude-opus-5-5")] }),
    acct("codex", { cooldowns: [{ scope: "credential", reason: "quota", retry_at: new Date(Date.now() + 3600e3).toISOString() }] }),
    acct("kimi-ai", { over_limit: true })]);
  assert.deepEqual({ ...fam }, { claude: 2, codex: 0, kimi: 0 });
  assert.deepEqual(fam._models.claude, ["claude-opus-5-5"], "opus cools on both accounts; sonnet on one only");
  const s = (id, rt, model) => seatInfo(node(id, rt, { model }));
  assert.equal(seatAvailable(s("qa.claude", "claude-code", "claude-opus-5-5"), fam), false, "every claude account cools on opus");
  assert.equal(seatAvailable(s("impl.claude-ui", "claude-code", "claude-sonnet-5-5"), fam), true, "one account still serves sonnet");
  assert.equal(seatAvailable(s("impl.codex", "codex", "gpt-6.1-sol"), fam), false, "a credential-wide cooldown");
  assert.equal(seatAvailable(s("review.kimi", "claude-code", "kimi-k3-256k"), fam), false, "proxy kimi is out");
  assert.equal(seatAvailable(s("review.kimi", "terminal"), fam), true, "a native kimi seat isn't served by the proxy");
  assert.equal(seatAvailable(s("impl.grok-1", "terminal"), Object.defineProperty({}, "_native", { value: { grok: false } })), false, "a native CLI known to be out");
});

test("family chains: the role's first family with a free, available seat; a fallback says why the earlier ones were passed", () => {
  assert.deepEqual(ROLE_CHAIN.implementer, ["grok", "codex", "claude", "kimi"]);
  const all = [node("impl.grok-1", "terminal", { busy: true }), node("impl.grok-2", "terminal", { dead: true }),
    node("impl.claude-ui", "claude-code", { model: "claude-sonnet-5-5" }), node("impl.codex", "codex", { model: "gpt-6.1-sol" })].map(seatInfo);
  const fam = eligibleFamilies([acct("claude"), acct("codex")]);
  const p = pickSeat(all, "implementer", { families: fam, chain: ROLE_CHAIN.implementer });
  assert.equal(p.seat.seat, "impl-codex@app");
  assert.deepEqual(p.fallback, { to: "codex", skipped: [{ family: "grok", reason: "grok implementer seats all busy" }] });
  // codex out of quota: on to claude, and the record names both
  const out = pickSeat(all, "implementer", { families: eligibleFamilies([acct("claude"), acct("codex", { over_limit: true })]), chain: ROLE_CHAIN.implementer });
  assert.equal(out.seat.seat, "impl-claude-ui@app");
  assert.deepEqual(out.fallback.skipped.map((x) => x.reason), ["grok implementer seats all busy", "codex: no eligible account"]);
  // the primary family is free: no fallback record
  assert.equal(pickSeat([seatInfo(node("impl.grok-1", "terminal")), ...all], "implementer", { families: fam, chain: ROLE_CHAIN.implementer }).fallback, undefined);
});

test("review matrix: never the author's seat or family while another family is free, in chain order; same family only as a recorded last resort", () => {
  const rev = (o = {}) => [node("review.grok", "terminal", o.grok), node("review.kimi", "terminal", o.kimi), node("review.codex", "codex", { model: "gpt-6.1-sol", ...o.codex })].map(seatInfo);
  const fam = eligibleFamilies([acct("codex")]);
  assert.equal(reviewerFor(rev(), "impl-grok-1", "grok", fam).seat.seat, "review-kimi@app", "a grok author: kimi first (chain grok > kimi > codex > claude, minus grok)");
  const r = reviewerFor(rev({ kimi: { busy: true } }), "impl-grok-1", "grok", fam);
  assert.equal(r.seat.seat, "review-codex@app");
  assert.deepEqual(r.matrix, { author_family: "grok", order: ["kimi", "codex", "claude"], chosen: "codex", skipped: [{ family: "kimi", reason: "kimi reviewer seats all busy" }] });
  // only the author's family is free: it reviews, and the matrix says so
  const last = reviewerFor(rev({ kimi: { busy: true }, codex: { busy: true } }), "impl-grok-1", "grok", fam);
  assert.equal(last.seat.seat, "review-grok@app"); assert.match(last.matrix.same_family, /no other family/);
  // the author's own seat never reviews its work, whatever the family
  assert.notEqual(reviewerFor([seatInfo(node("review.codex", "codex"))], "review-codex", "claude", fam).seat?.seat, "review-codex@app");
});

test("reroute: rows waiting 20+ min on a dead, out-of-quota, cooling or context-full seat go to the role's fallback seat, once, never to a human", () => {
  const now = Date.parse("2026-10-02T12:00:00Z"), ago = (m) => new Date(now - m * 60e3).toISOString();
  const all = [node("impl.codex", "codex", { model: "gpt-6.1-sol" }), node("impl.grok-1", "terminal", { dead: true }),
    node("impl.claude-ui", "claude-code", { model: "claude-sonnet-5-5", ctx: 98 }), node("impl.grok-2", "terminal"),
    node("review.kimi", "claude-code", { model: "kimi-k3-256k" }), node("review.codex", "codex", { model: "gpt-6.1-sol" }),
    node("qa.claude", "claude-code", { model: "claude-opus-5-5" }), node("qa.codex", "codex", { model: "gpt-6.1-sol" })].map(seatInfo);
  const fam = eligibleFamilies([acct("claude", { cooldowns: [cool("claude-opus-5-5")] }), acct("codex"), acct("kimi-ai", { over_limit: true })]);
  const row = (id, dest, mins, o = {}) => ({ id, state: "pending", destination: dest, tags: [], updated: ago(mins), ...o });
  const rows = [
    row("q-dead", "impl-grok-1@app", 30), row("q-wall", "impl-claude-ui@app", 25), row("q-kimi-out", "review-kimi@app", 40),
    row("q-cooling", "qa-claude@app", 21), row("q-young", "impl-grok-1@app", 5), row("q-human", "human@app", 90),
    row("q-owner", "impl-grok-1@app", 90, { tags: ["owner-decision"] }), row("q-claimed", "impl-grok-1@app", 90, { state: "in-progress" }),
    row("q-done-before", "impl-grok-1@app", 90), row("q-fine", "impl-codex@app", 90)];
  const moves = plan(rows, all, fam, { minutes: 20, now, moved: new Set(["q-done-before"]) });
  const by = Object.fromEntries(moves.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(by).sort(), ["q-cooling", "q-dead", "q-kimi-out", "q-wall"]);
  assert.equal(by["q-dead"].to, "impl-grok-2@app", "grok first in the implementer chain");
  assert.match(by["q-dead"].why, /impl-grok-1@app is not running/);
  assert.equal(by["q-wall"].to, "impl-codex@app", "impl-grok-2 already took a row this pass");
  assert.match(by["q-wall"].why, /context wall \(98%\)/);
  assert.equal(by["q-kimi-out"].to, "review-codex@app"); assert.match(by["q-kimi-out"].why, /kimi: no eligible account/);
  assert.equal(by["q-cooling"].to, "qa-codex@app"); assert.match(by["q-cooling"].why, /cooling on claude-opus-5-5/);
  assert.match(by["q-dead"].note, /^rerouted by agent-reroute after 30 min: .*impl-grok-1@app -> impl-grok-2@app \(grok\)/);
  // no free seat of the role: reported, not moved
  const none = plan([row("q-x", "qa-claude@app", 30)], all.filter((s) => s.role !== "qa" || s.seat === "qa-claude@app"), fam, { now });
  assert.deepEqual(none.map((m) => [m.to, m.note]), [[null, "no free qa seat in any family"]]);
  assert.equal(blocked(all.find((s) => s.seat === "impl-codex@app"), fam), null);
});

test("wiring: install.sh installs agent-reroute and enables its timer; the timer applies; dispatch, recovery and pick-seat use the chains", () => {
  const install = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(install, /launcher agent-reroute "\$NODE_FOR_JEV" "\$S\/orchestration\/reroute\.js"/);
  assert.match(install, / agent-stuck-check agent-reroute agent-operator-watch/);
  assert.match(fs.readFileSync(join(repo, "system/systemd/agent-reroute.service"), "utf8"), /ExecStart=%h\/\.local\/bin\/agent-reroute --apply/);
  const d = fs.readFileSync(join(repo, "orchestration/dispatch.js"), "utf8");
  assert.match(d, /pickSeat\(all, role, \{ families, chain: ROLE_CHAIN\[role\] \}\)/);
  assert.match(d, /reviewerFor\(seats\(rigName\), authorSeat, authorFamily, eligibleFamilies\(\)\)/);
  assert.match(d, /"--note", why/, "the matrix is recorded in the handed-off row");
  const r = fs.readFileSync(join(repo, "orchestration/recover.js"), "utf8");
  assert.match(r, /A \$\{other\.family\} \$\{other\.role\} seat \(\$\{other\.seat\}\) can take the work/);
  assert.match(r, /pickFor\(rigSeats\.filter\(\(s\) => s\.seat !== seat\), me\.role, \{ excludeFamily: fam \}\)/);
  assert.doesNotMatch(r, /no paid fallback exists/);
});

// The 2026-10-02 Claude stall, as the operator saw it: every Claude seat idle at its prompt after a 429 ("all credentials
// for claude-<model> are cooling down"), one account past its weekly limit, one at its 5h limit, the others active but
// cooling on the seats' models for hours; rows claimed (in progress) or pending, and nothing moving for 1h20.
test("the Claude stall: claimed rows on idle seats the proxy can't serve move after 5 min when the cooldown is long; the lead's go to the Codex deputy", () => {
  const now = Date.now(), ago = (m) => new Date(now - m * 60e3).toISOString(), H5 = 5 * 3600e3;
  const fam = eligibleFamilies([acct("claude", { over_limit: true }), acct("claude", { status: "error", unavailable: true }),
    acct("claude", { cooldowns: [cool("claude-opus-5-5", H5), cool("claude-sonnet-5-5", H5)] }),
    acct("claude", { cooldowns: [cool("claude-opus-5-5", H5 + 60e3), cool("claude-sonnet-5-5", 600e3)] }), acct("codex")]);
  assert.equal(fam.claude, 2, "two accounts are still eligible: the family isn't out, its models are");
  const all = [node("coord.lead-claude", "claude-code", { model: "claude-opus-5-5[1m]" }), node("coord.deputy-codex", "codex", { model: "gpt-6.1-sol" }),
    node("qa.claude", "claude-code", { model: "claude-opus-5-5", working: true }), node("qa.codex", "codex", { model: "gpt-6.1-sol" }),
    node("impl.claude-ui", "claude-code", { model: "claude-sonnet-5-5" }), node("impl.codex", "codex", { model: "gpt-6.1-sol", busy: true }),
    node("impl.codex-2", "codex", { model: "gpt-6.1-sol" })].map(seatInfo);
  assert.equal(Math.round((servableAt(all[0], fam) - now) / 60e3), 300, "opus is back when the first of its cooldowns ends");
  assert.equal(Math.round((servableAt(all[4], fam) - now) / 60e3), 10, "sonnet in 10 minutes");
  const row = (id, dest, state, mins) => ({ id, state, destination: dest, source: "operator@app", tags: [], updated: ago(mins) });
  const moves = plan([row("q-lead", "coord-lead-claude@app", "in-progress", 6), row("q-qa-working", "qa-claude@app", "in-progress", 60),
    row("q-ui", "impl-claude-ui@app", "in-progress", 8), row("q-ui-old", "impl-claude-ui@app", "pending", 25)], all, fam, { now });
  const by = Object.fromEntries(moves.map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(by).sort(), ["q-lead", "q-ui-old"]);
  assert.equal(by["q-lead"].to, "coord-deputy-codex@app", "no other lead seat: the lead's fallback role");
  assert.match(by["q-lead"].note, /claimed and idle: coord-lead-claude@app's last turn ended on the proxy's 429; claude: accounts cooling on claude-opus-5-5\[1m\]/);
  assert.match(by["q-lead"].note, /\(codex, as deputy: no free lead seat\); served again 20\d\d-/);
  assert.match(by["q-lead"].note, /reply to operator@app; coord-lead-claude@app may have partial work in its branch$/);
  // a working seat keeps its row; a 10-minute cooldown on a claimed row is waited out; a pending row past 20 min moves
  assert.equal(by["q-ui-old"].to, "impl-codex-2@app"); assert.match(by["q-ui-old"].why, /cooling on claude-sonnet-5-5/);
  assert.ok(!by["q-qa-working"] && !by["q-ui"]);
  // nothing free in the role or its fallback roles: reported, not moved, and never to a human
  const none = plan([row("q-arch", "arch-claude@app", "in-progress", 6)], [node("arch.claude", "claude-code", { model: "claude-opus-5-5" })].map(seatInfo), fam, { now });
  assert.deepEqual(none.map((m) => [m.to, m.note]), [[null, "no free architect or deputy or lead seat in any family"]]);
});

test("recovery after the stall: a seat served again, idle, still holding claimed rows gets one resume message naming them", () => {
  const fam = eligibleFamilies([acct("claude"), acct("codex")]);
  const all = [node("coord.lead-claude", "claude-code", { model: "claude-opus-5-5" }), node("qa.claude", "claude-code", { model: "claude-opus-5-5", working: true }),
    node("impl.claude-ui", "claude-code", { model: "claude-sonnet-5-5" })].map(seatInfo);
  const rows = [{ id: "q-1", state: "in-progress", destination: "coord-lead-claude@app" }, { id: "q-2", state: "in-progress", destination: "qa-claude@app" }];
  const r = resumes(rows, all, fam, new Set(["coord-lead-claude@app", "qa-claude@app", "impl-claude-ui@app"]));
  assert.deepEqual(r.resume.map((x) => [x.seat, x.rows]), [["coord-lead-claude@app", ["q-1"]]], "qa is working again; impl holds nothing");
  assert.match(r.resume[0].text, /served again .*Resume your claimed work: q-1\. Read each with rig queue show <id> --full --json/);
  assert.deepEqual(r.out, []);
  const still = resumes(rows, all, eligibleFamilies([acct("claude", { cooldowns: [cool("claude-opus-5-5")] }), acct("codex")]), new Set(["coord-lead-claude@app"]));
  assert.deepEqual([still.resume, still.out], [[], ["coord-lead-claude@app", "qa-claude@app"]], "still cooling: no message, and the seats are remembered");
});

test("agent-recover reads the proxy's cooling-down 429 as rate limited; role fallback; an out family's reset time", () => {
  assert.equal(ruleClass('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"all credentials for claude-opus-5-5 are cooling down"}}'), "rate_limited");
  const fam = eligibleFamilies([acct("claude"), acct("codex")]);
  const p = pickFor([node("coord.deputy-codex", "codex", { model: "gpt-6.1-sol" })].map(seatInfo), "lead", { families: fam });
  assert.deepEqual([p.seat.seat, p.as], ["coord-deputy-codex@app", "deputy"]);
  assert.equal(pickFor([node("coord.lead-claude", "claude-code")].map(seatInfo), "lead", { families: fam }).as, undefined);
  const t = Date.now() + 7200e3;
  const out = eligibleFamilies([acct("codex", { cooldowns: [{ scope: "credential", retry_at: new Date(t).toISOString() }] }), acct("claude")]);
  assert.equal(servableAt(seatInfo(node("impl.codex", "codex", { model: "gpt-6.1-sol" })), out), Date.parse(new Date(t).toISOString()));
  assert.equal(servableAt(seatInfo(node("impl.codex", "codex")), eligibleFamilies([acct("codex", { over_limit: true })])), null, "over a limit: unknown");
});

// End to end, both CLIs on the stall: a fake `rig` (records every call) and a fake agent-proxy-status; Jev stubbed.
import { spawnSync } from "node:child_process";
function cli(script, args, { nodes, rows, proxy, state, jev = {}, caller = "agent-reroute@app" }) {
  const dir = fs.mkdtempSync(join(process.env.AGENT_STACK_STATE, "e2e-")), calls = join(dir, "calls.log");
  const w = (n, s) => fs.writeFileSync(join(dir, n), s, { mode: 0o755 });
  w("rig", `#!/bin/sh\necho "rig $*" >> "${calls}"\ncase "$*" in\n  "ps --json") echo '[{"name":"app"}]' ;;\n` +
    `  "ps --nodes --rig app --json") cat "${join(dir, "nodes.json")}" ;;\n  "queue list -A --state pending,in-progress"*) cat "${join(dir, "rows.json")}" ;;\n` +
    `  "queue list -A --state in-progress"*) cat "${join(dir, "left.json")}" ;;\n  "queue show "*) echo '{"qitemId":"q-1","destinationSession":"coord-lead-claude@app","state":"in-progress"}' ;;\n` +
    `  "queue handoff"*) echo '{"qitemId":"q-new"}' ;;\nesac\n`);
  w("agent-proxy-status", `#!/bin/sh\ncat "${join(dir, "proxy.json")}"\n`);
  w("nodes.json", JSON.stringify(nodes)); w("rows.json", JSON.stringify(rows)); w("proxy.json", JSON.stringify(proxy));
  w("left.json", JSON.stringify(rows.filter((r) => r.state === "in-progress"))); w("jev.json", JSON.stringify(jev));
  const r = spawnSync(process.execPath, [join(repo, "orchestration", script), ...args], { encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, AGENT_STACK_STATE: state, AGENT_JEV_STUB: join(dir, "jev.json"), OPENRIG_SESSION_NAME: caller } });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
}
const H5 = () => new Date(Date.now() + 5 * 3600e3).toISOString();
const stallProxy = () => [acct("claude", { over_limit: true }), acct("claude", { cooldowns: [{ scope: "model", model_key: "claude-opus-5-5", retry_at: H5() }] }), acct("codex")];
const stallNodes = [node("coord.lead-claude", "claude-code", { model: "claude-opus-5-5" }), node("coord.deputy-codex", "codex", { model: "gpt-6.1-sol" })];

test("agent-recover --apply on the cooling-down 429: MODEL OUT (accounts eligible, all cooling on the model), reassigned to the Codex deputy", () => {
  const state = fs.mkdtempSync(join(process.env.AGENT_STACK_STATE, "rec-"));
  const { out, calls } = cli("recover.js", ["--rig", "app", "--seat", "coord-lead-claude@app", "--item", "q-1", "--apply",
    "--error", "API Error: 429 rate_limit_error: all credentials for claude-opus-5-5 are cooling down"],
    { nodes: stallNodes, rows: [], proxy: stallProxy(), state, caller: "coord-lead-claude@app", jev: { "recovery.select_action": { decided_by: "jev", band: "act", result: { action: "reassign" } } } });
  assert.equal(out.class, "rate_limited"); assert.equal(out.class_decided_by, "code");
  assert.deepEqual(out.permitted, ["reassign", "escalate"], "no retry: the cooldown runs for hours");
  assert.match(out.excluded.pool, /^MODEL OUT: every eligible claude account is cooling on claude-opus-5-5; served again 20\d\d-.*A codex deputy seat \(coord-deputy-codex@app\) can take the work/);
  assert.match(calls, /rig queue handoff q-1 --to coord-deputy-codex@app --note recovery reassign from coord-lead-claude@app: rate_limited/);
});

test("agent-reroute --apply: moves the claimed row off the 429'd lead, remembers the seat, and nudges it once when it's served again", () => {
  const state = fs.mkdtempSync(join(process.env.AGENT_STACK_STATE, "rr-")), ago = (m) => new Date(Date.now() - m * 60e3).toISOString();
  const rows = [{ qitemId: "q-1", state: "in-progress", destinationSession: "coord-lead-claude@app", sourceSession: "operator@app", tags: [], tsUpdated: ago(6) },
    { qitemId: "q-2", state: "in-progress", destinationSession: "coord-lead-claude@app", sourceSession: "operator@app", tags: [], tsUpdated: ago(7) }];
  const one = cli("reroute.js", ["--apply"], { nodes: stallNodes, rows, proxy: stallProxy(), state });
  assert.deepEqual(one.out.moves.map((m) => [m.id, m.to, m.applied ?? false]), [["q-1", "coord-deputy-codex@app", true], ["q-2", null, false]], "one row per free seat a pass");
  assert.match(one.calls, /rig queue handoff q-1 --to coord-deputy-codex@app --note rerouted by agent-reroute after 6 min: claimed and idle/);
  assert.deepEqual(one.out.resumes, []);
  // the next pass: the moved row stays moved (ledger); Claude is served again; q-2 is still the lead's, so it gets one nudge
  const look = cli("reroute.js", [], { nodes: stallNodes, rows: [rows[1]], proxy: [acct("claude"), acct("codex")], state });
  assert.deepEqual(look.out.resumes.map((n) => [n.seat, n.sent ?? false]), [["coord-lead-claude@app", false]], "without --apply: reported, not sent");
  assert.doesNotMatch(look.calls, /rig send/);
  const two = cli("reroute.js", ["--apply"], { nodes: stallNodes, rows: [rows[1]], proxy: [acct("claude"), acct("codex")], state });
  assert.deepEqual(two.out.moves, []);
  assert.deepEqual(two.out.resumes.map((n) => [n.seat, n.rows, n.sent]), [["coord-lead-claude@app", ["q-2"], true]]);
  assert.match(two.calls, /rig send coord-lead-claude@app \[agent-reroute\] Your model is served again/);
  assert.deepEqual(cli("reroute.js", ["--apply"], { nodes: stallNodes, rows: [rows[1]], proxy: [acct("claude"), acct("codex")], state }).out.resumes, [], "once");
  // without --apply: a report, no handoff, no send
  const dry = cli("reroute.js", [], { nodes: stallNodes, rows: [{ ...rows[0], qitemId: "q-3" }], proxy: stallProxy(), state: fs.mkdtempSync(join(process.env.AGENT_STACK_STATE, "dry-")) });
  assert.equal(dry.out.moves[0].to, "coord-deputy-codex@app"); assert.doesNotMatch(dry.calls, /handoff|rig send/);
});

// QA PR118 P1: the standard roster's native seats, through the real consumer (seats() over `rig ps --nodes`).
test("seats() over standard-shaped nodes: native grok/kimi seats take work, a plain shell doesn't; locked tests and reviewers keep families apart", async () => {
  const { seats } = await import("../orchestration/lib.js");
  const { seatCandidates, familyFromName, lockedTestsAuthor } = await import("../orchestration/pickseat.js");
  // review-plan reads the author's family from the branch/seat name; locked tests name theirs
  assert.equal(familyFromName("impl-grok-1@app"), "grok");
  assert.equal(lockedTestsAuthor([{ name: "PROGRESS.md", text: "Locked tests: tests-grok@app #12" }]).family, "grok");
  const nodes = [node("impl.grok-1", "terminal"), node("impl.grok-2", "terminal"), node("tests.grok", "terminal"), node("review.grok", "terminal"),
    node("review.kimi", "terminal"), node("review.codex", "codex", { model: "gpt-6.1-sol" }), node("impl.codex", "codex", { model: "gpt-6.1-sol" }),
    node("ops.shell", "terminal"), node("integ.claude", "claude-code", { model: "claude-opus-5-5" })];
  const dir = fs.mkdtempSync(join(process.env.AGENT_STACK_STATE, "ps-")), old = process.env.PATH;
  fs.writeFileSync(join(dir, "rig"), `#!/bin/sh\ncat "${join(dir, "nodes.json")}"\n`, { mode: 0o755 });
  fs.writeFileSync(join(dir, "nodes.json"), JSON.stringify(nodes));
  let all;
  try { process.env.PATH = `${dir}:${old}`; all = seats("app"); } finally { process.env.PATH = old; }
  assert.ok(!all.some((s) => s.seat === "ops-shell@app"), "an ordinary terminal is still not a seat");
  assert.deepEqual(all.filter((s) => s.native).map((s) => [s.seat, s.family]), [["impl-grok-1@app", "grok"], ["impl-grok-2@app", "grok"],
    ["tests-grok@app", "grok"], ["review-grok@app", "grok"], ["review-kimi@app", "kimi"]]);
  const fam = eligibleFamilies([acct("codex"), acct("claude")]);
  assert.equal(pickSeat(all, "implementer", { families: fam, chain: ROLE_CHAIN.implementer }).seat.family, "grok", "grok leads the implementer chain");
  // locked tests by the grok test author: no grok implementer, in code before Jev ranks anything
  assert.deepEqual(seatCandidates(all, "implementer", fam, "grok").map((c) => c.id), ["impl-codex@app"]);
  // grok-authored work: the kimi reviewer (chain grok > kimi > codex), never review-grok
  assert.equal(reviewerFor(all, "impl-grok-1", "grok", fam).seat.seat, "review-kimi@app");
  assert.equal(reviewerFor(all, "impl-codex", "codex", fam).seat.seat, "review-grok@app");
});
