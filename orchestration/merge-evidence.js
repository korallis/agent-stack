#!/usr/bin/env node
// agent-merge-evidence <pr> [--repo owner/name] [--mission M --slice S] [--change "one line"] [--deploy "..."]
//                      [--rollback "..."] [--decide]
//
// The merge gate's evidence, assembled from exact-head facts instead of a hand-written summary (Jev decides better
// on evidence than on conclusions: 51% of review.merge_gate calls came back "uncertain" before this, 2026-09-30).
// Prints the review.merge_gate input as JSON: pr, full head and base shas, the change, every required check by name,
// the independent-review status on that head, QA's bug-review-board proof (proof/brb-<head>.md), the blast-radius
// comment, and the target branch, deploy effect and rollback as limits. Anything missing says MISSING, never
// "fine". --decide also asks Jev. Exit 0: live Jev merge in the act band. Exit 3: live Jev merge below the act bar with
// the gates it checks green (see gateProblems): NEEDS CONFIRM, a one-line exact-head "confirm <sha>" from the
// other-family independent reviewer after the integrator checks the repository's own gates (the integrator role's
// below-bar path). Exit 1: hold. Code still re-checks the head and merges with --match-head-commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { decideOrStub } from "./jevcall.js";
import { redact } from "./redact.js";

const YAML = createRequire(new URL("../jev/package.json", import.meta.url))("yaml");   // jev/ carries the dependency

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const ghJson = (...a) => JSON.parse(gh(...a) || "null");

// ---- Applicability: N/A only from verified facts (the diff, the PR's creation time, the configured cutoff) ---------
// Git C-quotes paths with special or non-ASCII characters ("a/src/caf\\303\\251.js"): undo it (octal bytes are UTF-8).
export function gitUnquote(q) {
  if (!q.startsWith('"')) return q;
  const bytes = [];
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < q.length - 1; i++) {
    const c = q[i];
    if (c !== "\\") { bytes.push(...Buffer.from(c, "utf8")); continue; }
    const n = q[++i];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(q.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

// Pure: a unified diff (gh pr diff) -> [{ path, oldPath, added, removed, renamed, newFile, deleted, modeChange, binary,
// unknown }]. A file header it cannot parse becomes an `unknown` entry: never guessed, never N/A (fails closed).
export function parseDiff(text) {
  const files = [];
  let cur = null;
  const PATH = String.raw`("(?:[^"\\]|\\.)*"|\S+)`;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(new RegExp(`^diff --git ${PATH} ${PATH}$`));
      const a = m && gitUnquote(m[1]), b = m && gitUnquote(m[2]);
      cur = a?.startsWith("a/") && b?.startsWith("b/")
        ? { path: b.slice(2), oldPath: a.slice(2), added: [], removed: [] }
        : { path: "<unparsed diff header>", oldPath: "<unparsed diff header>", added: [], removed: [], unknown: true, header: line.slice(0, 200) };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^(rename|copy) (from|to) /.test(line) || /^similarity index /.test(line)) cur.renamed = true;
    else if (line.startsWith("new file mode")) cur.newFile = true;
    else if (line.startsWith("deleted file mode")) cur.deleted = true;
    else if (/^(old|new) mode /.test(line)) cur.modeChange = true;
    else if (/^Binary files /.test(line) || line.startsWith("GIT binary patch")) cur.binary = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

// The bug-review-board cutoff: AGENT_BRB_REQUIRED_SINCE (ISO), else the rig CULTURE's transition bullet
// ("Transition (…, 2026-09-30 12:55Z): PRs opened before 13:00Z …" or "… before 2026-09-30T13:00Z …").
export function brbCutoff({ env = process.env, culture = "" } = {}) {
  const e = (env.AGENT_BRB_REQUIRED_SINCE || "").trim();
  if (e && !Number.isNaN(Date.parse(e))) return { iso: new Date(Date.parse(e)).toISOString(), source: "AGENT_BRB_REQUIRED_SINCE" };
  const bullet = (String(culture).match(/^- Transition \([^\n]*(?:\n {2,}[^\n]*)*/m) || [""])[0].replace(/\s+/g, " ");
  const full = bullet.match(/PRs opened before (\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})Z/);
  const short = bullet.match(/\((?:[^)]*?)(\d{4}-\d{2}-\d{2})[^)]*\):.*?PRs opened before (\d{2}:\d{2})Z/);
  const [d, t] = full ? [full[1], full[2]] : short ? [short[1], short[2]] : [];
  return d ? { iso: new Date(`${d}T${t}:00Z`).toISOString(), source: "the rig CULTURE's transition bullet" } : null;
}

const isDocs = (p) => /^docs\//i.test(p) || /\.md$/i.test(p);
const known = (f) => !f.unknown;
const FLAG_LINE = /^\s*"[\w.-]+"\s*:\s*(true|false)\s*,?\s*$/;
const flagKeys = (lines) => lines.map((l) => l.match(/"([\w.-]+)"/)[1]).sort().join(",");
// A features.json change that only flips boolean flags: every changed line is `"key": true|false`, same keys on both sides.
// Only an in-place text edit of the same features.json: no rename or copy, no new, deleted or binary file, no mode change.
export const flagOnly = (f) => /(^|\/)features\.json$/.test(f.path) && f.oldPath === f.path
  && !(f.unknown || f.renamed || f.newFile || f.deleted || f.modeChange || f.binary) && f.added.length > 0
  && [...f.added, ...f.removed].every((l) => FLAG_LINE.test(l)) && flagKeys(f.added) === flagKeys(f.removed);

// Pure: why the bug-review-board proof doesn't apply, or null (it is required).
export function brbNotApplicable({ createdAt, cutoff, files }) {
  if (cutoff && createdAt && Date.parse(createdAt) < Date.parse(cutoff.iso))
    return `N/A: PR created ${createdAt}, before the bug-review-board cutoff ${cutoff.iso} (${cutoff.source})`;
  if (files?.length && files.every((f) => known(f) && isDocs(f.path) && isDocs(f.oldPath)))
    return `N/A: ${files.length} changed path(s), all docs (docs/** or *.md): ${files.map((f) => f.path).slice(0, 8).join(", ")}`;
  return null;
}

// Pure: why a blast-radius check doesn't apply, or null (it is required).
export function blastNotApplicable({ files }) {
  if (!files?.length) return null;
  const why = (f) => !known(f) ? null : /^tests\/acceptance\//.test(f.path) && /^tests\/acceptance\//.test(f.oldPath) ? "tests/acceptance/"
    : isDocs(f.path) && isDocs(f.oldPath) ? "docs" : flagOnly(f) ? "features.json flag flips only" : null;
  const kinds = files.map(why);
  if (kinds.some((k) => !k)) return null;
  return `N/A: ${files.length} changed path(s), all ${[...new Set(kinds)].join(" or ")} (checked in the diff): ${files.map((f) => f.path).slice(0, 8).join(", ")}`;
}

// Pure: the review.merge_gate input from gathered facts (facts are what gh and the proof file said; strings only).
export function buildMergeInput(f) {
  const checks = f.checks || [];
  const failed = checks.filter((c) => c.bucket !== "pass");
  const ci = !checks.length
    ? "MISSING: no required checks reported for this head"
    : `${checks.length} required check(s) on ${f.head}: ` + checks.map((c) => `${c.name}=${c.bucket}`).join(", ")
      + (failed.length ? `; NOT passing: ${failed.map((c) => c.name).join(", ")}` : "; all pass");
  const review = [
    f.independentReview
      ? `independent-review status on ${f.head}: ${f.independentReview.state} "${f.independentReview.description}" (by ${f.independentReview.creator}${f.independentReview.url ? `, ${f.independentReview.url}` : ""})`
      : `MISSING: no independent-review status on ${f.head}`,
    // Provenance comes only from the status's own link (target_url): a comment that merely mentions the head could be
    // anyone's, the author's included, so it is shown as UNVERIFIED and never as the review.
    f.reviewNote
      ? `independent review report, linked from the independent-review status (${f.reviewNote.url}, ${f.reviewNote.at}, by ${f.reviewNote.author}): ${f.reviewNote.excerpt}`
      : f.independentReview?.url
        ? `independent review report: ${f.independentReview.url} (linked from the status, outside this PR; not read)`
        : `MISSING: the independent-review status links no review report (no target_url), so what the reviewer verified is not established`,
    ...(!f.reviewNote && f.unlinkedNote
      ? [`UNVERIFIED, not linked from the status and not treated as the review: the latest PR comment naming ${f.head.slice(0, 7)} (${f.unlinkedNote.url}, ${f.unlinkedNote.at}, by ${f.unlinkedNote.author}): ${f.unlinkedNote.excerpt}`]
      : []),
    f.brb
      ? `bug-review-board proof ${f.brb.file}: artifact_type=${f.brb.artifact_type} verdict=${f.brb.verdict} candidate_sha=${f.brb.candidate_sha}${f.brb.candidate_sha === f.head ? "" : " (NOT this head)"}; ${f.brb.money_evidence}`
      : f.brbNA || `MISSING: no bug-review-board proof for ${f.head}${f.brbWhere ? ` (looked for ${f.brbWhere})` : " (no --mission/--slice given)"}`,
    f.blastRadius
      ? `blast radius (${f.blastRadius.url}, ${f.blastRadius.at}${f.blastRadius.namesHead ? ", names this head" : ", does NOT name this head"}): ${f.blastRadius.excerpt}`
      : f.blastNA ? `blast radius ${f.blastNA}` : "MISSING: no blast-radius comment on the PR",
  ].join("\n");
  const limits = [
    `target branch ${f.baseRef} at ${f.base}; PR head branch ${f.headRef}`,
    `mergeable: ${f.mergeable}; merge state: ${f.mergeState || "unknown"}; draft: ${f.isDraft}`,
    `deploy effect: ${f.deploy || "MISSING: not stated (see the rig CULTURE specifics)"}`,
    f.rollback ? `rollback: ${f.rollback}` : `rollback: not stated (proposed default: revert the squash commit on ${f.baseRef})`,
  ].join("\n");
  // Free text from PR comments and statuses goes out to Jev: redact anything credential-shaped (shas are kept).
  return { pr: f.pr, head: f.head, base: f.base, change: redact(f.change), review: redact(review), ci, limits: redact(limits) };
}

function frontmatter(path) {
  const m = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  return m ? YAML.parse(m[1]) || {} : {};
}

export function gather(pr, { repo, mission, slice, change, deploy, rollback } = {}) {
  const R = repo ? ["-R", repo] : [];
  const FIELDS = "number,title,createdAt,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,isDraft,comments,reviews";
  const v = ghJson("pr", "view", String(pr), ...R, "--json", FIELDS);
  const nwo = repo || ghJson("repo", "view", "--json", "nameWithOwner").nameWithOwner;
  let checks = [];
  try { checks = ghJson("pr", "checks", String(pr), ...R, "--required", "--json", "name,state,bucket"); }
  catch (e) { const out = String(e.stdout || ""); if (out.trim().startsWith("[")) checks = JSON.parse(out); }   // gh exits non-zero when a check fails
  const statuses = ghJson("api", `repos/${nwo}/commits/${v.headRefOid}/statuses`);
  const ir = (statuses || []).find((s) => s.context === "independent-review");
  let brb = null, brbWhere = null;
  if (mission && slice) {
    brbWhere = join(process.env.OPENRIG_WORK_ROOT || ".", "missions", mission, "slices", slice, "proof", `brb-${v.headRefOid}.md`);
    if (existsSync(brbWhere)) {
      const fm = frontmatter(brbWhere);
      brb = { file: brbWhere, artifact_type: fm.artifact_type, verdict: fm.verdict, candidate_sha: String(fm.candidate_sha), money_evidence: fm.money_evidence };
    }
  }
  const short = v.headRefOid.slice(0, 7);
  const namesHead = (body) => (body || "").includes(short);
  const notes = [
    ...(v.comments || []).map((c) => ({ body: c.body, url: c.url, at: c.createdAt, author: c.author?.login })),
    ...(v.reviews || []).map((r) => ({ body: r.body, url: r.url || `review ${r.id}`, at: r.submittedAt, author: r.author?.login, commit: r.commit?.oid })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const br = [...notes].reverse().find((c) => /^## Blast radius/m.test(c.body || ""));
  const blast = br ? { url: br.url, at: br.at, namesHead: namesHead(br.body) || br.commit === v.headRefOid,
    excerpt: br.body.slice(br.body.search(/^## Blast radius/m)).replace(/\s+/g, " ").slice(0, 700) } : null;
  // What the cross-family reviewer verified: the report the independent-review status links to (target_url), and
  // nothing else. Without a link, the latest comment naming the head is passed on only as UNVERIFIED.
  const note = (c) => c && { url: c.url, at: c.at, author: c.author || "?", excerpt: c.body.replace(/\s+/g, " ").slice(0, 900) };
  const link = ir?.target_url || null;
  const reviewNote = link ? note(notes.find((c) => c.url && c.url === link)) || null : null;
  const unlinkedNote = note([...notes].reverse().find((c) => (c.body || "").length > 40 && (namesHead(c.body) || c.commit === v.headRefOid)));
  // Applicability from verified facts only: the actual diff and the PR's creation time against the configured cutoff.
  const files = parseDiff(gh("pr", "diff", String(pr), ...R));
  let culture = "";
  try { culture = readFileSync(join(process.env.OPENRIG_WORK_ROOT || ".", "rig", "CULTURE.md"), "utf8"); } catch { /* no rig CULTURE here */ }
  const cutoff = brbCutoff({ culture });
  const brbNA = brb ? null : brbNotApplicable({ createdAt: v.createdAt, cutoff, files });
  const blastNA = blast ? null : blastNotApplicable({ files });
  // Checks, statuses and the diff are read by PR number: if a push landed while we collected, the facts would mix two heads. Re-read and refuse.
  const again = ghJson("pr", "view", String(pr), ...R, "--json", "headRefOid,baseRefOid");
  if (again.headRefOid !== v.headRefOid || again.baseRefOid !== v.baseRefOid)
    throw new Error(`the PR moved while its evidence was collected (head ${v.headRefOid.slice(0, 12)} -> ${again.headRefOid.slice(0, 12)}, base ${v.baseRefOid.slice(0, 12)} -> ${again.baseRefOid.slice(0, 12)}); run it again`);
  return {
    pr: v.number, head: v.headRefOid, base: v.baseRefOid, baseRef: v.baseRefName, headRef: v.headRefName,
    mergeable: v.mergeable, mergeState: v.mergeStateStatus, isDraft: v.isDraft, change: change || v.title, checks,
    independentReview: ir ? { state: ir.state, description: ir.description || "", creator: ir.creator?.login || "?", url: ir.target_url || null } : null,
    reviewNote, unlinkedNote, brb, brbWhere, brbNA, blastRadius: blast, blastNA, deploy, rollback,
  };
}

// Code owns the threshold: only a live Jev "merge" in the act band passes.
// A stubbed answer (AGENT_JEV_STUB, tests) is never a live decision, so it never passes.
export const passes = (rec) => !rec?.stubbed && rec?.decided_by === "jev" && rec?.band === "act" && rec?.result?.decision === "merge";

// The deterministic gates this helper can check from the evidence it gathered: required checks pass, the
// independent-review status is success, QA's bug-review-board proof is a qa artifact with PASS for exactly this head,
// the PR is not a draft, GitHub says it is mergeable, and the branch is neither behind its base nor conflicted.
// Returns what is not green. Repository-specific gates (the integrator role's starter-kit journeys, risk tier and
// owner OK) are not visible here and stay the integrator's to check.
export function gateProblems(f) {
  const p = [];
  if (f.isDraft !== false) p.push(f.isDraft ? "the PR is a draft" : "draft state unknown");
  if (f.mergeable !== "MERGEABLE") p.push(`GitHub mergeable: ${f.mergeable || "unknown"}`);
  if (["BEHIND", "DIRTY", "UNKNOWN", undefined, null, ""].includes(f.mergeState)) p.push(`merge state ${f.mergeState || "unknown"} (the branch must be up to date with its base and free of conflicts)`);
  if (!f.checks?.length) p.push("no required checks reported");
  else if (f.checks.some((c) => c.bucket !== "pass")) p.push(`required checks not passing: ${f.checks.filter((c) => c.bucket !== "pass").map((c) => c.name).join(", ")}`);
  if (f.independentReview?.state !== "success") p.push(`independent-review is ${f.independentReview?.state || "missing"}`);
  if (!f.brbNA && !(f.brb && f.brb.artifact_type === "qa" && f.brb.verdict === "PASS" && f.brb.candidate_sha === f.head)) p.push("no bug-review-board qa PASS for this head");
  return p;
}

// The integrator's standing below-bar path: live Jev merge in the review band, every deterministic gate green ->
// ask the other-family independent reviewer for a one-line exact-head "confirm <sha>", then merge.
export function outcome(rec, facts) {
  if (passes(rec)) return { code: 0, text: `merge gate: PASS (live Jev merge, act band) for ${facts.head}` };
  if (rec?.stubbed) return { code: 1, text: `merge gate: HOLD (a STUBBED answer, not a live Jev decision: ${rec.decided_by}/${rec.band}/${rec.result?.decision})` };
  // Below the act bar = the review or the uncertain band (the integrator role's "MERGE below the act confidence bar").
  if (rec?.decided_by === "jev" && ["review", "uncertain"].includes(rec?.band) && rec?.result?.decision === "merge") {
    const problems = gateProblems(facts);
    return problems.length
      ? { code: 1, text: `merge gate: HOLD (Jev merge below the act bar, ${rec.band} band, and a gate this helper checks is not green: ${problems.join("; ")})` }
      : { code: 3, text: `merge gate: NEEDS CONFIRM (Jev merge below the act bar, ${rec.band} band; the gates this helper checks are green: required checks, independent-review, ${facts.brbNA ? `QA verdict not required (${facts.brbNA.replace(/^N\/A: /, "")})` : "QA's qa PASS for this head"}, not a draft, mergeable, up to date). Check the repository's own gates too (integrator role: starter-kit journeys, risk tier, owner OK), then ask the other-family independent reviewer for a one-line exact-head "confirm ${facts.head}", and merge with --match-head-commit ${facts.head}` };
  }
  return { code: 1, text: `merge gate: HOLD (${rec?.decided_by}/${rec?.band}/${rec?.result?.decision})` };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agent-merge-evidence")) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const pr = a.find((x) => /^\d+$/.test(x));
  if (!pr) { console.error("usage: agent-merge-evidence <pr> [--repo o/r] [--mission M --slice S] [--change ...] [--deploy ...] [--rollback ...] [--decide]"); process.exit(2); }
  let facts;
  try { facts = gather(pr, { repo: flag("--repo"), mission: flag("--mission"), slice: flag("--slice"), change: flag("--change"), deploy: flag("--deploy"), rollback: flag("--rollback") }); }
  catch (e) { console.error(`agent-merge-evidence: ${e.message}`); process.exit(2); }
  const input = buildMergeInput(facts);
  if (!a.includes("--decide")) { console.log(JSON.stringify(input, null, 2)); process.exit(0); }
  const rec = await decideOrStub("review.merge_gate", input, { caller: process.env.OPENRIG_SESSION_NAME || "agent-merge-evidence" });
  console.log(JSON.stringify({ input, decision: { decided_by: rec.decided_by, band: rec.band, result: rec.result, request_id: rec.request_id, ...(rec.stubbed ? { stubbed: true } : {}) } }, null, 2));
  const o = outcome(rec, facts);
  console.error(o.text);
  process.exit(o.code);
}
