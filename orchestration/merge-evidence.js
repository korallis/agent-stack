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
      ? `independent-review status on ${f.head}: ${f.independentReview.state} "${f.independentReview.description}" (by ${f.independentReview.creator})`
      : `MISSING: no independent-review status on ${f.head}`,
    f.brb
      ? `bug-review-board proof ${f.brb.file}: artifact_type=${f.brb.artifact_type} verdict=${f.brb.verdict} candidate_sha=${f.brb.candidate_sha}${f.brb.candidate_sha === f.head ? "" : " (NOT this head)"}; ${f.brb.money_evidence}`
      : `MISSING: no bug-review-board proof for ${f.head}${f.brbWhere ? ` (looked for ${f.brbWhere})` : " (no --mission/--slice given)"}`,
    f.blastRadius ? `blast radius (PR comment): ${f.blastRadius}` : "blast radius: none posted on the PR",
  ].join("\n");
  const limits = [
    `target branch ${f.baseRef} at ${f.base}; PR head branch ${f.headRef}`,
    `mergeable: ${f.mergeable}; draft: ${f.isDraft}`,
    `deploy effect: ${f.deploy || "MISSING: not stated (see the rig CULTURE specifics)"}`,
    `rollback: ${f.rollback || `revert the squash commit on ${f.baseRef}`}`,
  ].join("\n");
  return { pr: f.pr, head: f.head, base: f.base, change: f.change, review, ci, limits };
}

function frontmatter(path) {
  const m = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  return m ? YAML.parse(m[1]) || {} : {};
}

export function gather(pr, { repo, mission, slice, change, deploy, rollback } = {}) {
  const R = repo ? ["-R", repo] : [];
  const v = ghJson("pr", "view", String(pr), ...R, "--json", "number,title,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,isDraft,comments");
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
  const br = [...(v.comments || [])].reverse().find((c) => /^## Blast radius/m.test(c.body || ""));
  const blast = br ? br.body.slice(br.body.search(/^## Blast radius/m)).replace(/\s+/g, " ").slice(0, 700) : null;
  return {
    pr: v.number, head: v.headRefOid, base: v.baseRefOid, baseRef: v.baseRefName, headRef: v.headRefName,
    mergeable: v.mergeable, isDraft: v.isDraft, change: change || v.title, checks,
    independentReview: ir ? { state: ir.state, description: ir.description || "", creator: ir.creator?.login || "?" } : null,
    brb, brbWhere, blastRadius: blast, deploy, rollback,
  };
}

// Code owns the threshold: only a live Jev "merge" in the act band passes.
export const passes = (rec) => rec?.decided_by === "jev" && rec?.band === "act" && rec?.result?.decision === "merge";

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agent-merge-evidence")) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const pr = a.find((x) => /^\d+$/.test(x));
  if (!pr) { console.error("usage: agent-merge-evidence <pr> [--repo o/r] [--mission M --slice S] [--change ...] [--deploy ...] [--rollback ...] [--decide]"); process.exit(2); }
  const facts = gather(pr, { repo: flag("--repo"), mission: flag("--mission"), slice: flag("--slice"), change: flag("--change"), deploy: flag("--deploy"), rollback: flag("--rollback") });
  const input = buildMergeInput(facts);
  if (!a.includes("--decide")) { console.log(JSON.stringify(input, null, 2)); process.exit(0); }
  const rec = await decideOrStub("review.merge_gate", input, { caller: process.env.OPENRIG_SESSION_NAME || "agent-merge-evidence" });
  console.log(JSON.stringify({ input, decision: { decided_by: rec.decided_by, band: rec.band, result: rec.result, request_id: rec.request_id } }, null, 2));
  console.error(passes(rec) ? `merge gate: PASS (live Jev merge, act band) for ${input.head}` : `merge gate: HOLD (${rec.decided_by}/${rec.band}/${rec.result?.decision})`);
  process.exit(passes(rec) ? 0 : 1);
}
