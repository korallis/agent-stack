#!/usr/bin/env node
// agent-dispatch — task intake, review planning and update triage for the OpenRig team.
//
//   agent-dispatch intake --rig R --title T (--body B | --body-file F) [--acceptance A] [--repo PATH]
//                         [--depends-on ID,ID] [--apply]
//   agent-dispatch review-plan --rig R --repo PATH --branch agent/<seat> [--base main] [--apply --item ID]
//   agent-dispatch triage-update --text "..."
//   agent-dispatch record --seat S --outcome completed|returned|failed      (quality ledger)
//   agent-dispatch pick-seat --rig R --role ROLE --task "one line" [--evidence "..."]   (Jev picks the seat; see pickseat.js)
//     [--exclude-family claude|codex|kimi | --mission M --slice S [--work-root W]]   implementer: never the locked tests' family
//     ROLE: implementer|reviewer|qa|architect|integrator|test-author|recovery|lead|deputy, or a pod name (impl, review, …)
//
// Jev supplies bounded judgments (type, gaps, role, duplicates, reviews, tests). Code supplies
// capacity, account availability, dependencies and the final seat. Without --apply nothing changes.
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decide, decideBatch } from "../jev/lib/engine.js";
import { rig, seats, pickSeat, reviewerFor, eligibleFamilies, seatAvailable, ROLE_CHAIN, queueItems, lexicalTop, recordQuality, odb, normQ, normalizeRole } from "./lib.js";
import { seatCandidates, nextStep, lockedTestsAuthor, familyFromName, FAMILIES } from "./pickseat.js";
import { decideOrStub } from "./jevcall.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const caller = process.env.OPENRIG_SESSION_NAME || "agent-dispatch";
const out = (o) => console.log(JSON.stringify(o, null, 2));
const brief = (r) => ({ decided_by: r.decided_by, band: r.band, result: r.result, ...(r.fallback ? { fallback: r.fallback.reason } : {}) });

const ROLE_TEXT = {
  implementer: "Writes and changes production code and its tests for a well-defined task",
  architect: "Plans designs, interfaces, data models and splits large or cross-cutting work into tasks",
  reviewer: "Reviews code changes, runs and writes tests, verifies behaviour against acceptance criteria",
  deputy: "Researches unknowns, investigates root causes, compares options, maintains handoffs",
  integrator: "Merges reviewed branches, resolves conflicts, fixes broken builds and recovers failed work",
};

function git(repo, ...a) { return execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim(); }

async function intake() {
  const rigName = flag("--rig"); const title = flag("--title");
  if (!rigName || !title) throw new Error("--rig and --title are required");
  const body = flag("--body") ?? (flag("--body-file") ? readFileSync(flag("--body-file"), "utf8") : "");
  const acceptance = flag("--acceptance", "");
  const repo = flag("--repo");
  const task = `${title}\n\n${body}`.trim();

  // Candidates from ordinary code/search.
  const areas = repo ? git(repo, "ls-tree", "-d", "--name-only", "HEAD").split("\n").filter((d) => d && !d.startsWith("."))
    .map((d) => ({ id: d, text: `${d}/: ${git(repo, "ls-tree", "--name-only", `HEAD:${d}`).split("\n").slice(0, 8).join(", ")}` })) : [];
  const open = queueItems(rigName).filter((q) => ["pending", "in-progress", "blocked"].includes(q.state));
  const dupCands = lexicalTop(task, open.map((q) => ({ id: q.id, text: String(q.summary || q.body || "").slice(0, 600) })), 20);

  const base = { task, ...(acceptance ? { acceptance_criteria: acceptance } : {}) };
  const batch = [
    { id: "intake.requirements", input: base },
    { id: "intake.paths", input: base },
    { id: "intake.classify", input: { ...base, ...(areas.length ? { candidates: areas.slice(0, 30) } : {}) } },
  ];
  if (dupCands.length) batch.push({ id: "intake.duplicates", input: { task, candidates: dupCands } });
  const recs = await decideBatch(batch, { caller });
  const [reqs, paths, cls, dups] = recs;

  // Role candidates = roles with real capacity right now (code), then Jev picks among them.
  const all = seats(rigName);
  const families = eligibleFamilies();
  const roles = [...new Set(all.filter((s) => s.running && s.assigned === 0 && s.pending === 0 && seatAvailable(s, families) && ROLE_TEXT[s.role]).map((s) => s.role))];
  let roleRec = null; let role = null;
  if (roles.length === 1) role = roles[0];
  else if (roles.length > 1) {
    roleRec = await decide("intake.specialist", { task, candidates: roles.map((r) => ({ id: r, text: ROLE_TEXT[r] })) }, { caller });
    role = roleRec.result.role !== "none_fit" ? roleRec.result.role : null;
  }

  // Dependencies are facts from the queue, not judgments.
  const deps = (flag("--depends-on", "") || "").split(",").filter(Boolean);
  const allItems = deps.length ? queueItems(null, { all: true }) : [];
  const unmet = deps.filter((d) => { const q = allItems.find((x) => x.id === d); return !q || q.state !== "done"; });

  const gaps = Object.entries(reqs.result.checks || {}).filter(([k, v]) => (k === "has_testable_acceptance" ? v === "no" : v === "yes")).map(([k]) => k);
  const blockingGaps = gaps.filter((g) => ["missing_info_blocks_start", "conflicting_requirements"].includes(g));
  const duplicates = Object.entries(dups?.result?.duplicate || {}).filter(([, v]) => v === "yes").map(([k]) => k);
  const overlaps = Object.entries(dups?.result?.overlap || {}).filter(([, v]) => v === "yes").map(([k]) => k);

  // the role's family chain (WO90): the first family with a free, available seat; a later one is a recorded fallback
  const pick = role ? pickSeat(all, role, { families, chain: ROLE_CHAIN[role] }) : { seat: null };
  let verdict = "dispatch";
  if (duplicates.length) verdict = "duplicate";
  else if (blockingGaps.length) verdict = "clarify";
  else if (unmet.length) verdict = "wait_for_dependencies";
  else if (!role) verdict = "lead_decides_role";
  else if (!pick.seat) verdict = "no_capacity";

  const plan = {
    verdict, title, role, seat: pick.seat?.seat ?? null, seat_selection: { considered: pick.considered, in_flight: pick.inFlight, eligible_accounts: families,
      ...(pick.fallback ? { fallback: pick.fallback } : {}) },
    type: cls.result.type, area: cls.result.area ?? null, gaps, blocking_gaps: blockingGaps, suggested_paths: paths.result.paths,
    duplicates, overlaps, unmet_dependencies: unmet,
    decisions: { classify: brief(cls), requirements: brief(reqs), paths: brief(paths), ...(dups ? { duplicates: brief(dups) } : {}), ...(roleRec ? { specialist: brief(roleRec) } : { specialist: { decided_by: "code", result: { role }, note: "single role with capacity" } }) },
  };

  if (has("--apply") && verdict === "dispatch") {
    const key = `${rigName}:${title}`;
    const prev = odb().prepare("SELECT item, seat FROM dispatches WHERE key=?").get(key);
    if (prev) { plan.applied = { skipped: "already dispatched", ...prev }; return out(plan); }
    const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
    const f = join(dir, "body.md");
    writeFileSync(f, `# ${title}\n\n${body}\n\n## Acceptance criteria\n${acceptance || "(none supplied — owner must propose and record in REQUIREMENTS.md)"}\n\n` +
      `## Dispatch notes (advisory)\n- type: ${plan.type}; area: ${plan.area ?? "-"}\n- suggested paths: ${JSON.stringify(plan.suggested_paths)}\n` +
      `- non-blocking gaps: ${gaps.join(", ") || "none"}\n- overlaps with: ${overlaps.join(", ") || "none"}\n` +
      `- review: by a family other than ${pick.seat.family} (reviewer chain ${(ROLE_CHAIN.reviewer || []).filter((f) => f !== pick.seat.family).join(" > ")})\n` +
      (pick.fallback ? `- seat: ${pick.seat.family} by fallback (${pick.fallback.skipped.map((x) => x.reason).join("; ")})\n` : ""));
    const res = rig(["queue", "create", "--destination", pick.seat.seat, "--body-file", f, "--summary", title,
      "--tags", [`type:${plan.type}`, plan.area ? `area:${plan.area}` : null, `role:${role}`, `family:${pick.seat.family}`].filter(Boolean).join(",")], { json: true });
    const item = normQ(res)?.id;
    if (!item) throw new Error(`queue create returned no qitemId: ${JSON.stringify(res).slice(0, 200)}`);
    odb().prepare("INSERT INTO dispatches VALUES (?,?,?,?)").run(key, Date.now(), item, pick.seat.seat);
    plan.applied = { item, seat: pick.seat.seat };
  }
  out(plan);
}

function testCandidates(repo) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    for (const e of readdirSync(join(repo, d))) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const p = d ? `${d}/${e}` : e;
      const st = statSync(join(repo, p));
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/(^|[._/-])(test|spec)s?([._/-]|$)/i.test(p)) found.push(p);
    }
  };
  walk("", 0);
  return found;
}

async function reviewPlan() {
  const repo = flag("--repo"); const branch = flag("--branch"); const base = flag("--base", "main");
  // The caller's own rig unless --rig names another: without a rig the plan had no reviewer and said nothing (WO96).
  const rigName = flag("--rig") || (process.env.OPENRIG_SESSION_NAME || "").split("@")[1] || null;
  if (!repo || !branch) throw new Error("--repo and --branch are required");
  if (!existsSync(join(repo, ".git")))
    throw new Error(`--repo ${repo}: not a local checkout. Give the repository's path on this machine (e.g. ~/Projects/<P>), not owner/name`);
  const files = git(repo, "diff", "--name-only", `${base}...${branch}`).split("\n").filter(Boolean);
  const stat = git(repo, "diff", "--stat", `${base}...${branch}`);
  const log = git(repo, "log", "--format=%s", `${base}..${branch}`);
  const change = `Commits:\n${log}\n\nFiles changed:\n${stat}`;
  const tests = testCandidates(repo);
  const cands = (tests.length > 40 ? lexicalTop(files.join(" ") + " " + log, tests.map((t) => ({ id: t, text: t })), 40) : tests.map((t) => ({ id: t, text: t })));
  const batch = [{ id: "review.change_class", input: { change } }];
  if (cands.length) batch.push({ id: "review.select_tests", input: { change, candidates: cands } });
  const [cc, st] = await decideBatch(batch, { caller });
  const selected = st ? Object.entries(st.result.run).filter(([, v]) => v !== "no").map(([k]) => k) : [];
  // Review matrix (WO90): the author's family is never the reviewer's while another family has a free seat; the order is
  // the reviewer chain; the author's own seat is never a reviewer. Recorded in the plan and the handed-off row.
  const authorSeat = branch.replace(/^(?:refs\/remotes\/)?(?:[^/]+\/)?agent\//, "");   // agent/<seat>, origin/agent/<seat>
  const authorFamily = familyFromName(authorSeat) || (/codex/.test(branch) ? "codex" : "claude");
  const chain = (ROLE_CHAIN.reviewer || FAMILIES).filter((f) => f !== authorFamily);
  let reviewer = null, matrix = null;
  if (rigName) ({ seat: reviewer, matrix } = reviewerFor(seats(rigName), authorSeat, authorFamily, eligibleFamilies()));
  const plan = {
    branch, files, specialist_reviews: Object.entries(cc.result.reviews).filter(([, v]) => v !== "no").map(([k, v]) => `${k}${v === "uncertain" ? "?" : ""}`),
    tests_to_run: selected, always_run: "full suite before merge (integration owner)",
    reviewer: reviewer?.seat ?? null, cross_family: reviewer ? reviewer.family !== authorFamily : null, ...(matrix ? { reviewer_matrix: matrix } : {}),
    ...(rigName ? { rig: rigName } : { reviewer_note: "no rig: run it from a seat, or pass --rig <rig>, to get a reviewer" }),
    decisions: { change_class: brief(cc), ...(st ? { select_tests: brief(st) } : {}) },
    note: "Advisory. The reviewer's own reading of the diff and actual test results decide; this never approves a merge.",
  };
  if (has("--apply") && flag("--item") && reviewer) {
    const why = `reviewer by matrix: author ${authorFamily}, order ${chain.join(" > ")}, chosen ${reviewer.family}`
      + (matrix.skipped.length ? ` (skipped: ${matrix.skipped.map((x) => x.reason).join("; ")})` : "") + (matrix.same_family ? `; SAME family: ${matrix.same_family}` : "");
    rig(["queue", "handoff", flag("--item"), "--to", reviewer.seat, "--note", why,
      "--summary", `Review ${branch}`, "--body", `Review branch ${branch} in ${repo}.\nAuthor: ${authorSeat} (${authorFamily})\nSuggested specialist reviews: ${plan.specialist_reviews.join(", ") || "none"}\nSuggested tests: ${selected.join(", ") || "full suite"}`], { json: true });
    plan.applied = { handed_off_to: reviewer.seat };
  }
  out(plan);
}

async function triage() {
  const text = flag("--text");
  if (!text) throw new Error("--text required");
  const r = await decide("comms.triage_update", { update: text }, { caller });
  out({ kind: r.result.kind, ...brief(r), route: { routine_progress: "log only", actionable_blocker: "lead resolves or reassigns", needs_user: "surface to the user" }[r.result.kind] });
}

// Which family an implementer must NOT be: --exclude-family, else (implementer, with --mission and --slice) the locked
// tests' author from the slice files. { family, source } or { family: null, reason }; null when nothing applies.
function excludedFamily(role, all) {
  // Present is one question, its value another: a trailing or valueless --exclude-family is an error, never "no filter".
  const at = args.findIndex((a) => a === "--exclude-family" || a.startsWith("--exclude-family="));
  if (at >= 0) {
    const given = args[at].includes("=") ? args[at].slice(args[at].indexOf("=") + 1) : args[at + 1];
    if (given == null || given.trim() === "" || given.startsWith("-"))
      throw new Error(`--exclude-family needs a family: one of ${FAMILIES.join(", ")}`);
    const f = given.trim().toLowerCase();
    if (!FAMILIES.includes(f)) throw new Error(`--exclude-family "${given}": use one of ${FAMILIES.join(", ")}`);
    return { family: f, source: "--exclude-family" };
  }
  const mission = flag("--mission"), slice = flag("--slice");
  if (role !== "implementer" || !mission || !slice) return null;
  const dir = join(flag("--work-root") || process.env.OPENRIG_WORK_ROOT || ".", "missions", mission, "slices", slice);
  const texts = ["PROGRESS.md", "SPEC.md"].map((n) => ({ name: join(dir, n), text: existsSync(join(dir, n)) ? readFileSync(join(dir, n), "utf8") : "" }));
  return lockedTestsAuthor(texts, all);
}

async function pickSeatCmd() {
  const rigName = flag("--rig"), task = flag("--task");
  if (!rigName || !flag("--role") || !task) throw new Error("--rig, --role and --task are required");
  const role = normalizeRole(flag("--role"));   // impl -> implementer, qa -> qa, …; an unknown role fails loudly
  const all = seats(rigName), ex = excludedFamily(role, all);
  const exclusion = ex && (ex.family ? { exclude_family: ex.family, because: `the locked tests are by the ${ex.family} family (${ex.source}); the implementer must be the other family` }
    : { exclude_family: null, author_note: `locked tests' author unknown, nothing excluded: ${ex.reason}` });
  const candidates = seatCandidates(all, role, eligibleFamilies(), ex?.family || null);
  if (!candidates.length) return out({ action: "none free", ...exclusion, note: `no running ${role} seat${ex?.family ? ` outside the ${ex.family} family` : ""} without open work in ${rigName}: queue it to the least-loaded such seat or wait` });
  const rec = await decideOrStub("intake.seat", { task, role, ...(flag("--evidence") ? { evidence: flag("--evidence") } : {}), candidates }, { caller });
  out({ ...brief(rec), ...exclusion, candidates: candidates.map((c) => c.id), next: nextStep(rec, candidates, task) });
}

const cmds = { intake, "pick-seat": pickSeatCmd, "review-plan": reviewPlan, "triage-update": triage,
  record: async () => { recordQuality(flag("--seat"), flag("--outcome")); out({ ok: true }); } };
try {
  if (!cmds[args[0]]) { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n").replace(/^\/\/ ?/gm, "")); process.exit(args[0] ? 2 : 0); }
  await cmds[args[0]]();
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
