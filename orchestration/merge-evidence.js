#!/usr/bin/env node
// agent-merge-evidence <pr> [--repo owner/name] [--mission M --slice S] [--change "one line"] [--deploy "..."]
//                      [--rollback "..."] [--decide]
//
// The merge gate's evidence, assembled from exact-head facts instead of a hand-written summary (Jev decides better
// on evidence than on conclusions: 51% of review.merge_gate calls came back "uncertain" before this, 2026-09-30).
// Prints the review.merge_gate input as JSON: pr, full head and base shas, the change, every required check by name,
// the independent-review status on that head, QA's bug-review-board proof (proof/brb-<head>.md), the blast-radius
// comment, and the target branch, deploy effect and rollback as limits. Anything missing says MISSING, never
// "fine". --decide also asks Jev and exits 0 only for decided_by jev, band act, decision merge (1 otherwise); code
// still re-checks the head and merges with --match-head-commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { decideOrStub } from "./jevcall.js";
import { redact } from "./redact.js";

const YAML = createRequire(new URL("../jev/package.json", import.meta.url))("yaml");   // jev/ carries the dependency

const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const ghJson = (...a) => JSON.parse(gh(...a) || "null");

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
      : `MISSING: no bug-review-board proof for ${f.head}${f.brbWhere ? ` (looked for ${f.brbWhere})` : " (no --mission/--slice given)"}`,
    f.blastRadius
      ? `blast radius (${f.blastRadius.url}, ${f.blastRadius.at}${f.blastRadius.namesHead ? ", names this head" : ", does NOT name this head"}): ${f.blastRadius.excerpt}`
      : "MISSING: no blast-radius comment on the PR",
  ].join("\n");
  const limits = [
    `target branch ${f.baseRef} at ${f.base}; PR head branch ${f.headRef}`,
    `mergeable: ${f.mergeable}; draft: ${f.isDraft}`,
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
  const FIELDS = "number,title,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,isDraft,comments,reviews";
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
  // Checks are read by PR number: if a push landed while we collected, the facts would mix two heads. Re-read and refuse.
  const again = ghJson("pr", "view", String(pr), ...R, "--json", "headRefOid,baseRefOid");
  if (again.headRefOid !== v.headRefOid || again.baseRefOid !== v.baseRefOid)
    throw new Error(`the PR moved while its evidence was collected (head ${v.headRefOid.slice(0, 12)} -> ${again.headRefOid.slice(0, 12)}, base ${v.baseRefOid.slice(0, 12)} -> ${again.baseRefOid.slice(0, 12)}); run it again`);
  return {
    pr: v.number, head: v.headRefOid, base: v.baseRefOid, baseRef: v.baseRefName, headRef: v.headRefName,
    mergeable: v.mergeable, isDraft: v.isDraft, change: change || v.title, checks,
    independentReview: ir ? { state: ir.state, description: ir.description || "", creator: ir.creator?.login || "?", url: ir.target_url || null } : null,
    reviewNote, unlinkedNote, brb, brbWhere, blastRadius: blast, deploy, rollback,
  };
}

// Code owns the threshold: only a live Jev "merge" in the act band passes.
// A stubbed answer (AGENT_JEV_STUB, tests) is never a live decision, so it never passes.
export const passes = (rec) => !rec?.stubbed && rec?.decided_by === "jev" && rec?.band === "act" && rec?.result?.decision === "merge";

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
  console.error(passes(rec) ? `merge gate: PASS (live Jev merge, act band) for ${input.head}`
    : rec.stubbed ? `merge gate: HOLD (a STUBBED answer, not a live Jev decision: ${rec.decided_by}/${rec.band}/${rec.result?.decision})`
    : `merge gate: HOLD (${rec.decided_by}/${rec.band}/${rec.result?.decision})`);
  process.exit(passes(rec) ? 0 : 1);
}
