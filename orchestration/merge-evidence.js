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
      // Git leaves spaces unquoted ("a/docs/guide one.md b/docs/guide one.md"): an unrenamed file's header is exactly
      // "a/P b/P", so it splits without guessing. Anything else waits for its rename or ---/+++ lines.
      const rest = line.slice("diff --git ".length);
      const half = (rest.length - 5) / 2, P = Number.isInteger(half) ? rest.slice(2, 2 + half) : null;
      if (a?.startsWith("a/") && b?.startsWith("b/")) cur = { path: b.slice(2), oldPath: a.slice(2), added: [], removed: [] };
      else if (P !== null && rest === `a/${P} b/${P}`) cur = { path: P, oldPath: P, added: [], removed: [] };
      else cur = { path: "<unparsed diff header>", oldPath: "<unparsed diff header>", added: [], removed: [], unknown: true, header: line, seen: {} };
      files.push(cur);
      continue;
    }
    // An unresolved header is confirmed only when the names from its rename or ---/+++ lines rebuild it exactly.
    if (cur?.unknown && cur.seen) {
      const name = (l, prefix) => { const v = gitUnquote(l.replace(/\t$/, "")); return v.startsWith(prefix) ? v.slice(prefix.length) : null; };
      let hit = true;
      if (line.startsWith("rename from ")) cur.seen.old = gitUnquote(line.slice(12));
      else if (line.startsWith("rename to ")) cur.seen.new = gitUnquote(line.slice(10));
      else if (line.startsWith("--- ")) cur.seen.old ??= name(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) cur.seen.new ??= name(line.slice(4), "b/");
      else hit = false;
      if (hit && cur.seen.old && cur.seen.new && `diff --git a/${cur.seen.old} b/${cur.seen.new}` === cur.header) {
        Object.assign(cur, { path: cur.seen.new, oldPath: cur.seen.old, unknown: false });
        delete cur.header; delete cur.seen;
      }
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

// ---- Evidence sources (WO39): commit statuses by default, or PR comments for repos that record them there ----------
// Config: --config <file>, else AGENT_MERGE_EVIDENCE_CONFIG (a file), else $OPENRIG_WORK_ROOT/.agent-stack/merge-evidence.json.
// Top-level keys are the defaults; "repos": { "owner/name": { ... } } overrides them per repository. See docs/REFERENCE.md.
export const DEFAULT_CONFIG = { review: { source: "status", context: "independent-review" }, qa: { source: "proof" },
  gate: { source: "status", context: "jev-merge" }, authorFamily: null };
const SOURCES = { review: ["status", "comments"], qa: ["proof", "comments"], gate: ["status", "comments"] };

// Pure: the effective config for `nwo` from a parsed file (null = defaults). Throws on anything it can't use.
export function resolveConfig(raw, nwo) {
  const own = (raw?.repos && nwo && raw.repos[nwo]) || {};
  const cfg = { authorFamily: own.authorFamily || raw?.authorFamily || null, identities: { ...raw?.identities, ...own.identities },
    identityHeadings: { ...raw?.identityHeadings, ...own.identityHeadings } };
  for (const k of Object.keys(SOURCES)) {
    const c = cfg[k] = { ...DEFAULT_CONFIG[k], ...raw?.[k], ...own[k] };
    if (!SOURCES[k].includes(c.source)) throw new Error(`merge-evidence config: ${k}.source must be ${SOURCES[k].join(" or ")}, not ${JSON.stringify(c.source)}`);
    if (c.source === "comments" && !c.heading) throw new Error(`merge-evidence config: ${k}.heading is required with source "comments"`);
    if (c.heading) {   // with source "status", a review heading still lets comments serve as a fallback source
      try { c.headingRe = new RegExp(c.heading); } catch (e) { throw new Error(`merge-evidence config: ${k}.heading is not a valid regex: ${e.message}`); }
    }
  }
  for (const [login, fam] of Object.entries(cfg.identities))
    if (!FAMILIES.includes(fam) && fam !== "shared") throw new Error(`merge-evidence config: identities.${login} must be one of ${FAMILIES.join(", ")} or shared`);
  cfg.identityHeadingRes = Object.entries(cfg.identityHeadings).map(([pattern, fam]) => {
    if (!FAMILIES.includes(fam)) throw new Error(`merge-evidence config: identityHeadings["${pattern}"] must be one of ${FAMILIES.join(", ")}`);
    let re;
    try { re = new RegExp(pattern); }
    catch (e) { throw new Error(`merge-evidence config: identityHeadings["${pattern}"] is not a valid regex: ${e.message}`); }
    return { pattern, family: fam, re };
  });
  if (cfg.authorFamily && !FAMILIES.includes(cfg.authorFamily)) throw new Error(`merge-evidence config: authorFamily must be one of ${FAMILIES.join(", ")}`);
  return cfg;
}

export function loadConfig({ flagPath, nwo, env = process.env } = {}) {
  const named = flagPath || env.AGENT_MERGE_EVIDENCE_CONFIG;
  const path = named || (env.OPENRIG_WORK_ROOT ? join(env.OPENRIG_WORK_ROOT, ".agent-stack", "merge-evidence.json") : null);
  if (!path || !existsSync(path)) {
    if (named) throw new Error(`merge-evidence config ${named} not found`);
    return { ...resolveConfig(null, nwo), path: null };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`merge-evidence config ${path} is not valid JSON: ${e.message}`); }
  return { ...resolveConfig(raw, nwo), path };
}

// A seat's model family from its name (review-claude-2, impl-codex-1, impl-astra-1). null when the name doesn't say.
export const FAMILIES = ["claude", "codex", "kimi"];
export const familyOf = (seat) => { const s = String(seat || "").toLowerCase();
  return /claude|fable|opus|sonnet/.test(s) ? "claude" : /codex|gpt|astra/.test(s) ? "codex" : /kimi/.test(s) ? "kimi" : null; };

const WORD = { success: /^(PASS(ED)?|APPROVED?|YES|MERGE)$/i, failure: /^(FAIL(ED)?|BLOCK(ED|ING)?|NO|HOLD|CHANGES[_ ]REQUESTED|REQUEST[_ ]CHANGES)$/i };
const word = (w) => WORD.success.test(w) ? "success" : WORD.failure.test(w) ? "failure" : null;

// Pure: the lines of a record that are its own declarations: fenced code blocks and quoted (">") lines are examples or
// citations, never the record's own statements, so they are dropped. Bold/code markers are removed; underscores kept.
export function ownLines(body) {
  const out = []; let fence = null;
  for (const raw of String(body || "").split("\n")) {
    const m = raw.match(/^\s*(`{3,}|~{3,})/);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; continue; }
    if (fence || /^\s*>/.test(raw)) continue;
    out.push(raw.replace(/\*\*|`/g, "").trim());
  }
  return out;
}

// Pure: what a record declares. `candidates`: the shas it names on a declaration line of its own ("head: <sha>",
// "candidate_sha: <sha>", "reviewed head <sha>", or "confirm <sha>"); a sha mentioned inside a sentence is not one.
// `verdicts`: each declared verdict (a "confirm <sha>" line; each "Verdict:" / "Ship:" / "Result:" line; verdict
// words in the heading after its seat word), as success, failure or unknown (a declaration this helper can't read).
export function declarations(body) {
  const lines = ownLines(body), candidates = [], verdicts = [];
  const heading = (lines[0] || "").replace(/^#*\s*[\w.@-]+/, "");
  for (const w of heading.split(/[^A-Za-z_]+/)) if (word(w)) verdicts.push(word(w));
  for (const l of lines.slice(1)) {
    let m = l.match(/^confirm\s+([0-9a-f]{40})$/i);
    if (m) { candidates.push(m[1].toLowerCase()); verdicts.push("success"); continue; }
    m = l.match(/^(?:reviewed\s+)?(?:head|candidate(?:[_ ]sha)?|sha|commit)\s*[:=]?\s*([0-9a-f]{40})\.?$/i);
    if (m) { candidates.push(m[1].toLowerCase()); continue; }
    m = l.match(/^(?:verdict|ship|result)\s*[:=—-]\s*(.*)$/i);
    if (m) { const t = m[1].trim().split(/[\s—:;,.()]+/); verdicts.push(word(`${t[0]} ${t[1] || ""}`.trim()) || word(t[0]) || "unknown"); }
  }
  return { candidates: [...new Set(candidates)], verdicts };
}

// Pure: one record's state from its declarations: success only when every declared verdict is success; any failure
// (or a conflict) is failure; otherwise "unclear". null when it declares none.
const combine = (v) => {
  if (!v.length) return null;
  return v.every((x) => x === "success") ? "success" : v.includes("failure") ? "failure" : "unclear";
};
export const verdictOf = (body, reviewState) => combine([...declarations(body).verdicts,
  ...(reviewState === "APPROVED" ? ["success"] : reviewState === "CHANGES_REQUESTED" ? ["failure"] : [])]);

// Pure: the PR comments/reviews that are records for one evidence kind ABOUT THIS HEAD: the first line matches the
// configured heading, and the record's own candidate declarations name exactly this head (a record that declares
// another sha, or none, is not about it). Oldest first. `seat` is the first word of the heading (the seat); `state`
// is its verdict (null when it declares none, which never counts as success). A GitHub review's own state
// (APPROVED / CHANGES_REQUESTED) is one more declaration.
export function records(notes, headingRe, head) {
  return (notes || []).filter((n) => {
    if (!headingRe.test(String(n.body || "").split("\n", 1)[0])) return false;
    const c = declarations(n.body).candidates;
    return c.length === 1 && c[0] === head.toLowerCase();
  }).map((n) => {
    return { ...n, seat: (String(n.body).split("\n", 1)[0].match(/^#*\s*([\w.@-]+)/) || [])[1] || null, state: verdictOf(n.body, n.reviewState) };
  });
}

// Pure: the limits a record states in its own lines ("LIMIT: ...", "Limits: ...", "Caveat: ...", "Not verified: ...").
export const statedLimits = (body) => ownLines(body).flatMap((l) => [...l.matchAll(/\b(?:LIMITS?|CAVEATS?|NOT VERIFIED|UNTESTED)\s*:\s*(.+?)(?=\s+\b(?:LIMITS?|CAVEATS?)\s*:|$)/gi)].map((m) => m[1].trim()));

// Pure: the independent review from comments: the LATEST record by a seat of another family than the author's. An
// unknown author family, or a record whose seat has no family, never counts (cross-family can't be verified).
export function reviewFromComments(notes, headingRe, head, authorFamily) {
  const recs = records(notes, headingRe, head);
  if (!authorFamily) return { review: null, problem: `the PR author's model family is unknown (set authorFamily, pass --author-family, or use an agent/<seat> branch), so no comment review can be verified as cross-family${recs.length ? `; ${recs.length} review record(s) for this head not counted` : ""}` };
  const r = recs.filter((x) => familyOf(x.seat) && familyOf(x.seat) !== authorFamily).at(-1);
  if (!r) return { review: null, problem: `no review comment for ${head} by a seat outside the ${authorFamily} family${recs.length ? ` (${recs.length} same-family or unattributed record(s) ignored)` : ""}` };
  return { review: { state: r.state || "no verdict stated", description: String(r.body).split("\n", 1)[0].slice(0, 200), creator: r.seat, url: r.url || null, source: "comment" },
    note: { url: r.url, at: r.at, author: r.seat, excerpt: String(r.body).replace(/\s+/g, " ").slice(0, 900), limits: statedLimits(r.body) } };
}

// Pure: the independent review from GitHub PR reviews. Only reviews submitted ON the exact head count (commit ==
// head); older ones are counted and ignored. The reviewer's family comes from the configured identities (GitHub login
// -> family); an unmapped login, or an unknown author family, can't be verified as cross-family. APPROVED and
// CHANGES_REQUESTED are verdicts (combined with any the body declares); a COMMENTED review counts only when its own
// lines declare one. Dismissed and pending reviews never count. The latest counting review decides.
// With identityHeadings (heading regex -> family), a review whose login is unmapped or mapped to "shared" (every seat
// posting as one account) takes its family from the first line of its body: self-declared, so only as trustworthy
// as the seats. The exact-head rule is unchanged: the review's commit must be the head.
export function familyFromHeading(body, headings = []) {
  const first = String(body || "").split("\n", 1)[0];
  const fams = [...new Set(headings.filter((h) => h.re.test(first)).map((h) => h.family))];
  return fams.length === 1 ? fams[0] : null;   // no match, or patterns that disagree: unknown
}
export function reviewFromPrReviews(reviews, head, authorFamily, identities = {}, headings = []) {
  const all = (reviews || []).filter((r) => !["DISMISSED", "PENDING"].includes(r.reviewState));
  const stale = all.filter((r) => r.commit !== head).length;
  const staleNote = stale ? `; ${stale} review(s) on another commit ignored` : "";
  const who = (r) => {
    const byLogin = identities[r.author];
    if (byLogin && byLogin !== "shared") return { family: byLogin, how: "login" };
    const byHeading = familyFromHeading(r.body, headings);
    return byHeading ? { family: byHeading, how: "heading" } : { family: null, how: null };
  };
  const onHead = all.filter((r) => r.commit === head).map((r) => ({ ...r, state: verdictOf(r.body, r.reviewState), ...who(r) })).filter((r) => r.state);
  if (!onHead.length) return { verdict: null, problem: `no GitHub review with a verdict on ${head}${staleNote}` };
  if (!authorFamily) return { verdict: null, problem: `the PR author's model family is unknown, so no GitHub review can be verified as cross-family${staleNote}` };
  const r = onHead.filter((x) => x.family && x.family !== authorFamily).at(-1);
  if (!r) return { verdict: null, problem: `no GitHub review on ${head} by a reviewer of a family other than ${authorFamily} (${onHead.length} unmapped or same-family; map logins in "identities", or headings in "identityHeadings" for a shared login)${staleNote}` };
  const fam = r.how === "heading" ? `${r.family} family, self-declared in its heading "${String(r.body).split("\n", 1)[0].slice(0, 60)}"` : `${r.family} family`;
  return { verdict: { state: r.state, by: r.author, source: `GitHub PR review ${r.reviewState} by ${r.author} (${fam}; the author is ${authorFamily}) submitted on commit ${head}`, url: r.url, at: r.at,
    excerpt: String(r.body || "").replace(/\s+/g, " ").slice(0, 900), limits: statedLimits(r.body) }, problem: stale ? staleNote.slice(2) : null };
}

const statusRecord = (statuses, context) => { const ir = (statuses || []).find((s) => s.context === context);
  return ir ? { state: ir.state, description: ir.description || "", creator: ir.creator?.login || "?", url: ir.target_url || null, source: "status" } : null; };

// Pure: the review verdict that goes to Jev, from verified sources only, in order: the configured primary source,
// then the others (the independent-review status on the exact head -- its own state and description --, GitHub
// reviews on the exact head, review comments declaring the head). The first verifiable one gives the verdict; a
// verifiable source that disagrees makes it a conflict. With none, `why` says what each source lacked.
// With identityHeadings, the status description's declared signer gives the status's family: its FIRST word (the
// seat, as in "review-codex-1: PASS"), tested with each configured pattern exactly as written against the signer as a
// plain first line ("Kimi", for "^Kimi$") and as the Markdown heading it would sign ("## review-codex-1"). Mentions
// elsewhere in the text are not the signer. { family } for one family,
// { ambiguous: true } when the signer matches patterns of two families, {} when it matches none (unknown, as before).
export function familyFromDescription(description, headings = []) {
  const signer = (String(description || "").trim().match(/^([\w.@-]+)/) || [])[1];
  if (!signer || !headings.length) return {};
  const fams = [...new Set(headings.filter((h) => h.re.test(signer) || h.re.test(`## ${signer}`)).map((h) => h.family))];
  return fams.length === 1 ? { family: fams[0], signer } : fams.length > 1 ? { ambiguous: true, signer } : {};
}
export function reviewVerdict({ head, primary = "status", status, statusContext = "independent-review", prReview, commentReview, authorFamily = null, headings = [] }) {
  const id = status ? familyFromDescription(status.description, headings) : {};
  const sameFamily = id.family && authorFamily && id.family === authorFamily;
  const bySource = {
    status: status && ["success", "failure"].includes(status.state) && !sameFamily && !id.ambiguous
      ? { verdict: { state: status.state, source: `${statusContext} status on ${head} (${status.state}, "${status.description || ""}", by ${status.creator}${id.family ? `; signed by ${id.signer}, ${id.family} family` : ""})`, url: status.url } }
      : { problem: !status ? `no ${statusContext} status on ${head}`
        : sameFamily ? `the ${statusContext} status on ${head} is signed by ${id.signer}, the author's own ${id.family} family, so it is not an independent review`
        : id.ambiguous ? `the ${statusContext} status on ${head} is signed by ${id.signer}, which matches identity headings of more than one family, so its family is not established`
        : `the ${statusContext} status on ${head} is ${status.state}, not a verdict` },
    reviews: prReview?.verdict ? { ...prReview, verdict: { ...prReview.verdict, report: { kind: "GitHub review", url: prReview.verdict.url, at: prReview.verdict.at, author: prReview.verdict.by, excerpt: prReview.verdict.excerpt, limits: prReview.verdict.limits } } } : prReview || { problem: "GitHub reviews not read" },
    comments: commentReview ? { verdict: commentReview.review && { state: commentReview.review.state, source: `review comment by seat ${commentReview.review.creator} declaring head ${head}`, url: commentReview.review.url, report: commentReview.note && { kind: "review comment", ...commentReview.note } }, problem: commentReview.problem }
      : { problem: "no review comment heading configured" },
  };
  const order = primary === "comments" ? ["comments", "status", "reviews"] : ["status", "reviews", "comments"];
  const found = order.filter((k) => bySource[k].verdict && ["success", "failure"].includes(bySource[k].verdict.state)).map((k) => ({ key: k, ...bySource[k].verdict }));
  const unclear = order.filter((k) => bySource[k].verdict && !found.some((x) => x.key === k)).map((k) => `${k}: ${bySource[k].verdict.state}`);
  if (!found.length) return { state: null, why: order.map((k) => `${k}: ${bySource[k].verdict ? bySource[k].verdict.state : bySource[k].problem}`).join("; ") };
  const [first] = found, other = found.filter((x) => x.state !== first.state);
  return { state: other.length ? "conflict" : first.state, first: first.state, source: first.source, url: first.url || null, key: first.key, report: first.report || null,
    others: found.slice(1).map((x) => `${x.state} from ${x.source}`), conflict: other.length ? other.map((x) => `${x.state} from ${x.source}`) : null,
    notes: [...unclear, ...order.map((k) => bySource[k].problem && bySource[k].verdict ? `${k}: ${bySource[k].problem}` : null).filter(Boolean)] };
}

// Pure: QA's verdict from comments, in the shape of a bug-review-board proof (the same exact-head rule applies).
export function qaFromComments(notes, headingRe, head) {
  const r = records(notes, headingRe, head).at(-1);
  return r ? { file: r.url || "PR comment", artifact_type: "qa", verdict: r.state === "success" ? "PASS" : r.state === "failure" ? "BLOCKING" : "UNCLEAR", candidate_sha: head,
    money_evidence: `QA comment by ${r.seat} (${r.at}): ${String(r.body).replace(/\s+/g, " ").slice(0, 300)}`, source: "comment" } : null;
}

// Pure: this gate's own earlier runs on this head, newest first: every status of its context (statuses are read for
// the head only, so an older head's never appear), or every gate comment declaring the head. This is history, not
// evidence: the gate's own earlier HOLD fed back as "failure already posted" would make every hold re-hold itself.
// It is reported to people next to the input and never sent to Jev.
export function gateHistory(cfg, { statuses, notes, head }) {
  if (cfg.gate.source === "comments")
    return records(notes, cfg.gate.headingRe, head).reverse().map((r) =>
      `${r.state || "no verdict"}: ${String(r.body).split("\n", 1)[0].slice(0, 160)} (gate comment ${r.url || "?"}, ${r.at || "?"})`);
  return (statuses || []).filter((x) => x.context === cfg.gate.context).map((x) =>
    `${x.state}: "${x.description || ""}" (status${x.target_url ? ` ${x.target_url}` : ""}, ${x.created_at || "?"})`);
}

// Pure: is this PR comment or review one of the gate's own reports?
export function isGateReport(n, cfg, statuses = []) {
  const first = String(n.body || "").split("\n", 1)[0];
  const ctx = cfg.gate.context.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (statuses || []).some((s) => s.context === cfg.gate.context && s.target_url && s.target_url === n.url)
    || !!cfg.gate.headingRe?.test(first) || new RegExp(`^#+\\s*${ctx}\\b`, "i").test(first);
}

// ---- Branch requirements when GitHub says BLOCKED -----------------------------------------------------------------
// Rule types that govern pushes to the branch itself, never merging a PR into it.
const MERGE_NEUTRAL_RULES = new Set(["deletion", "non_fast_forward", "creation"]);
const reviewsRequired = (p) => p && (p.required_approving_review_count > 0 || p.require_code_owner_review || p.require_code_owner_reviews || p.require_last_push_approval);

// Pure: every requirement the base branch's rulesets and classic protection place on merging. Required contexts carry
// their bound producer (ruleset integration_id, classic app_id; null/-1 = any). Anything this helper cannot verify is
// listed in `unverified`, never assumed satisfied.
export function requirementsFrom(rules, prot, reviewDecision) {
  const contexts = [], unverified = [];
  const needsReview = (where) => { if (reviewDecision !== "APPROVED" && !["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(reviewDecision)) unverified.push(`${where} requires approving review(s) and GitHub reported no review decision`); };
  for (const r of rules || []) {
    if (MERGE_NEUTRAL_RULES.has(r.type)) continue;
    if (r.type === "required_status_checks") { for (const c of r.parameters?.required_status_checks || []) contexts.push({ context: c.context, app: c.integration_id ?? null }); continue; }
    if (r.type === "pull_request") {
      if (r.parameters?.required_review_thread_resolution) unverified.push("a ruleset requires review conversations to be resolved");
      if (reviewsRequired(r.parameters)) needsReview("a ruleset");
      continue;
    }
    unverified.push(`ruleset rule ${r.type}`);   // required_deployments, required_signatures, merge_queue, required_linear_history, update, ...
  }
  if (prot) {
    for (const c of prot.required_status_checks?.checks || []) contexts.push({ context: c.context, app: c.app_id ?? null });
    const bound = new Set((prot.required_status_checks?.checks || []).map((c) => c.context));
    for (const c of prot.required_status_checks?.contexts || []) if (!bound.has(c)) contexts.push({ context: c, app: null });
    if (prot.required_pull_request_reviews && (reviewsRequired(prot.required_pull_request_reviews) || prot.required_pull_request_reviews.required_approving_review_count == null)) needsReview("classic protection");
    for (const [k, what] of [["required_signatures", "signed commits"], ["required_linear_history", "linear history"],
      ["required_conversation_resolution", "resolved conversations"], ["lock_branch", "a locked branch"]])
      if (prot[k]?.enabled) unverified.push(`classic protection: ${what}`);
    if (prot.restrictions) unverified.push("classic protection: restrictions on who may merge");
  }
  return { contexts, unverified };
}

// Pure: one required context on this head: "pass", null (nothing posted yet) or why it is not met. Every same-name
// result counts (a check and a status can share a name): any non-success one keeps it unmet. A context bound to an app
// is met only by that app's latest check run; unreadable check runs keep it unmet.
export function contextState(req, { checks, statuses, checkRuns }) {
  const bad = (checks || []).filter((c) => c.name === req.context && c.bucket !== "pass").map((c) => `check ${c.bucket}`);
  const latest = (statuses || []).find((s) => s.context === req.context);
  if (latest && latest.state !== "success") bad.push(`status ${latest.state}`);
  if (req.app != null && req.app !== -1) {
    if (!Array.isArray(checkRuns)) return `${req.context}: bound to app ${req.app} and the check runs could not be read`;
    const run = checkRuns.filter((r) => r.name === req.context && r.app?.id === req.app).sort((a, b) => b.id - a.id)[0];
    if (!run) return `${req.context}: no result from its required app ${req.app}${latest || (checks || []).some((c) => c.name === req.context) ? " (another producer's result does not count)" : ""}`;
    if (run.conclusion !== "success") bad.unshift(`app ${req.app} ${run.conclusion || run.status}`);
    return bad.length ? `${req.context}: ${bad.join(", ")}` : "pass";
  }
  if (bad.length) return `${req.context}: ${bad.join(", ")}`;
  return latest || (checks || []).some((c) => c.name === req.context) ? "pass" : null;
}

// GitHub says BLOCKED while ANY merge requirement is unmet, including the merge-gate status this helper exists to
// produce (jev-merge). Pure: the merge-state line with the real reasons when BLOCKED. "pending this gate" only when
// the gate is the single unmet requirement, has posted nothing, and everything else is verified; else BLOCKED.
export const GATE_CONTEXT = "jev-merge";
export function mergeStateLine(f) {
  const GATE = f.gateContext || GATE_CONTEXT;
  if (f.mergeState !== "BLOCKED") return `merge state: ${f.mergeState || "unknown"}`;
  const reasons = [];
  if (f.mergeable && f.mergeable !== "MERGEABLE") reasons.push(`mergeable ${f.mergeable}`);
  if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(f.reviewDecision)) reasons.push(`review decision ${f.reviewDecision}`);
  const req = f.requirements;
  if (!req) reasons.push("the branch requirements could not be read");
  else {
    for (const u of req.unverified) reasons.push(`not verified by this helper: ${u}`);
    const missing = req.contexts.filter((c) => c.context !== GATE && c.state === null).map((c) => c.context);
    if (missing.length) reasons.push(`required context(s) not posted: ${[...new Set(missing)].join(", ")}`);
    for (const c of req.contexts) if (c.context !== GATE && c.state && c.state !== "pass") reasons.push(c.state);
  }
  // The gate's own context is this run's to decide: an earlier run's result on it is never a reason (WO45).
  const gateReqs = (req?.contexts || []).filter((c) => c.context === GATE);
  const gateOpen = gateReqs.length && gateReqs.some((c) => c.state !== "pass"), gateUnposted = gateReqs.length && gateReqs.every((c) => c.state === null);
  if (!reasons.length && gateOpen)
    return `merge state: pending this gate (${GATE} ${gateUnposted ? "not yet posted" : "holds an earlier run's result, which this run replaces"}; every other requirement verified)`;
  if (gateUnposted) reasons.push(`${GATE} not yet posted`);
  return `merge state: BLOCKED (${[...new Set(reasons)].join("; ") || "reason not visible to this helper"})`;
}

// Pure: every check that ran on the head, for an unprotected base: each check run's latest result by name, and each
// status context's latest state (newest first), kept apart (a check run and a status can share a name, and either
// failing counts), minus this helper's own contexts (the review and the gate) from both. bucket: pass (success,
// neutral, skipped), pending (not finished), fail (anything else).
export function observedFrom(checkRuns, statuses, own = []) {
  const runs = new Map(), sts = new Map();
  for (const r of [...(checkRuns || [])].sort((a, b) => b.id - a.id)) {
    if (own.includes(r.name) || runs.has(r.name)) continue;
    const c = r.conclusion;
    runs.set(r.name, { name: r.name, source: "check", result: c || r.status || "pending", bucket: !c ? "pending" : ["success", "neutral", "skipped"].includes(c) ? "pass" : "fail" });
  }
  for (const s of statuses || []) {
    if (own.includes(s.context) || sts.has(s.context)) continue;
    sts.set(s.context, { name: runs.has(s.context) ? `${s.context} (status)` : s.context, source: "status", result: s.state,
      bucket: s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail" });
  }
  return [...runs.values(), ...sts.values()];
}

// Pure: the review.merge_gate input from gathered facts (facts are what gh and the proof file said; strings only).
export function buildMergeInput(f) {
  const RC = f.reviewContext || "independent-review";
  const checks = f.checks || [];
  const failed = checks.filter((c) => c.bucket !== "pass");
  const obs = f.observedChecks, bad = (obs || []).filter((c) => c.bucket !== "pass");
  const ci = !checks.length && obs
    ? `base ${f.baseRef} has no required checks; ` + (obs.length
      ? `observed on exact head ${f.head}: ${obs.map((c) => `${c.name}=${c.result}`).join(", ")}${bad.length ? `; NOT passing: ${bad.map((c) => `${c.name} (${c.result})`).join(", ")}` : "; all pass"}`
      : `no check ran on exact head ${f.head}`)
    : !checks.length
    ? "MISSING: no required checks reported for this head"
    : `${checks.length} required check(s) on ${f.head}: ` + checks.map((c) => `${c.name}=${c.bucket}`).join(", ")
      + (failed.length ? `; NOT passing: ${failed.map((c) => c.name).join(", ")}` : "; all pass");
  const rv = f.reviewVerdict;
  const review = [
    ...(rv ? [rv.state
      ? `review verdict: ${rv.state === "conflict" ? `CONFLICT (${rv.first} from ${rv.source}; ${rv.conflict.join("; ")})` : `${rv.state}, from ${rv.source}`}; bound to head ${f.head}`
        + (rv.others?.length && rv.state !== "conflict" ? `; agreeing: ${rv.others.join("; ")}` : "") + (rv.notes?.length ? `; ${rv.notes.join("; ")}` : "")
      : `review verdict: NONE VERIFIABLE on ${f.head} (${rv.why})`] : []),
    ...(f.verdictReport ? [`${f.verdictReport.kind} report, the source of the verdict above (${f.verdictReport.url}, ${f.verdictReport.at}, by ${f.verdictReport.author}): ${f.verdictReport.excerpt}`] : []),
    f.independentReview?.source === "comment"
      ? `independent review comment on ${f.head}: ${f.independentReview.state} "${f.independentReview.description}" (seat ${f.independentReview.creator}, another family than the author's ${f.authorFamily}${f.independentReview.url ? `, ${f.independentReview.url}` : ""})`
      : f.independentReview
        ? `${RC} status on ${f.head}: ${f.independentReview.state} "${f.independentReview.description}" (by ${f.independentReview.creator}${f.independentReview.url ? `, ${f.independentReview.url}` : ""})`
        : f.sources?.review === "comments" ? `MISSING: ${f.reviewProblem || `no independent review comment for ${f.head}`}` : `MISSING: no ${RC} status on ${f.head}`,
    // Provenance comes only from the status's own link (target_url): a comment that merely mentions the head could be
    // anyone's, the author's included, so it is shown as UNVERIFIED and never as the review.
    f.independentReview?.source === "comment"
      ? (f.reviewNote ? `independent review report, the selected comment itself (${f.reviewNote.url}, ${f.reviewNote.at}, seat ${f.reviewNote.author}): ${f.reviewNote.excerpt}` : null)
      : f.reviewNote
      ? `independent review report, linked from the ${RC} status (${f.reviewNote.url}, ${f.reviewNote.at}, by ${f.reviewNote.author}): ${f.reviewNote.excerpt}`
      : f.independentReview?.url
        ? `independent review report: ${f.independentReview.url} (linked from the status, outside this PR, so not read${rv?.state && rv.key !== "status" ? `; the verdict above comes from ${rv.key === "reviews" ? "the GitHub review" : "the review comment"}` : ""})`
        : f.sources?.review === "comments" ? null : `MISSING: the ${RC} status links no review report (no target_url), so what the reviewer verified is not established`,
    ...(!f.reviewNote && f.unlinkedNote && f.unlinkedNote.url !== f.verdictReport?.url   // not the verdict's own source again
      ? [`UNVERIFIED, not linked from the status and not treated as the review: the latest PR comment naming ${f.head.slice(0, 7)} (${f.unlinkedNote.url}, ${f.unlinkedNote.at}, by ${f.unlinkedNote.author}): ${f.unlinkedNote.excerpt}`]
      : []),
    f.brb
      ? `bug-review-board proof ${f.brb.file}: artifact_type=${f.brb.artifact_type} verdict=${f.brb.verdict} candidate_sha=${f.brb.candidate_sha}${f.brb.candidate_sha === f.head ? "" : " (NOT this head)"}; ${f.brb.money_evidence}`
      : f.brbNA || `MISSING: no bug-review-board proof for ${f.head}${f.brbWhere ? ` (looked for ${f.brbWhere})` : " (no --mission/--slice given)"}`,
    f.blastRadius
      ? `blast radius (${f.blastRadius.url}, ${f.blastRadius.at}${f.blastRadius.namesHead ? ", names this head" : ", does NOT name this head"}): ${f.blastRadius.excerpt}`
      : f.blastNA ? `blast radius ${f.blastNA}` : "MISSING: no blast-radius comment on the PR",
  ].filter((x) => x !== null).join("\n");
  const limits = [
    `target branch ${f.baseRef} at ${f.base}; PR head branch ${f.headRef}`,
    `mergeable: ${f.mergeable}; ${mergeStateLine(f)}; draft: ${f.isDraft}`,
    ...(f.reviewNote?.limits?.length ? [`limits stated by the independent review: ${f.reviewNote.limits.join("; ")}`] : []),
    ...(f.verdictReport?.limits?.length ? [`limits stated by the ${f.verdictReport.kind}: ${f.verdictReport.limits.join("; ")}`] : []),
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

export function gather(pr, { repo, mission, slice, change, deploy, rollback, config, configPath, authorFamily } = {}) {
  const R = repo ? ["-R", repo] : [];
  const FIELDS = "number,title,createdAt,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,isDraft,comments,reviews";
  const v = ghJson("pr", "view", String(pr), ...R, "--json", FIELDS);
  const nwo = repo || ghJson("repo", "view", "--json", "nameWithOwner").nameWithOwner;
  const cfg = config || loadConfig({ flagPath: configPath, nwo });
  if (authorFamily && !FAMILIES.includes(authorFamily)) throw new Error(`--author-family must be one of ${FAMILIES.join(", ")}`);
  let checks = [];
  try { checks = ghJson("pr", "checks", String(pr), ...R, "--required", "--json", "name,state,bucket"); }
  catch (e) { const out = String(e.stdout || ""); if (out.trim().startsWith("[")) checks = JSON.parse(out); }   // gh exits non-zero when a check fails
  // The gate's own status is this run's output, not CI: never a failing (or passing) required check here (WO45).
  checks = checks.filter((c) => c.name !== cfg.gate.context);
  // Every status, all pages, newest first: absence from one page is not absence (a context's latest status can sit
  // behind many newer ones of another context).
  const pages = ghJson("api", `repos/${nwo}/commits/${v.headRefOid}/statuses?per_page=100`, "--paginate", "--slurp") || [];
  const statuses = pages.every(Array.isArray) ? pages.flat() : pages;
  // Every merge requirement on the base branch (rulesets + classic protection) and its state on this head. When
  // BLOCKED, these tell a real block apart from "only the gate itself hasn't posted". Unreadable -> null (keeps BLOCKED).
  // The base branch's merge requirements (rulesets + classic protection); throws when they can't be read in full.
  let baseReq;
  const readBaseRequirements = () => baseReq ??= (() => {
    const rules = ghJson("api", `repos/${nwo}/rules/branches/${v.baseRefName}?per_page=100`) || [];
    if (rules.length >= 100) throw new Error("more rules than one page");
    let prot = null;
    try { prot = ghJson("api", `repos/${nwo}/branches/${v.baseRefName}/protection`); }
    catch (e) { if (!/HTTP 404|Branch not protected/.test(String(e.stderr || e.message))) throw e; }
    // Protected at all: any rule that governs merging (not only push-side rules) or any classic protection.
    return { ...requirementsFrom(rules, prot, v.reviewDecision || null), protected: !!prot || rules.some((r) => !MERGE_NEUTRAL_RULES.has(r.type)) };
  })();
  let requirements = null;
  if (v.mergeStateStatus === "BLOCKED") {
    try {
      const found = readBaseRequirements();
      let checkRuns = null;
      if (found.contexts.some((c) => c.app != null && c.app !== -1)) {
        try { const cr = ghJson("api", `repos/${nwo}/commits/${v.headRefOid}/check-runs?per_page=100`); if (cr.total_count <= cr.check_runs.length) checkRuns = cr.check_runs; }
        catch { checkRuns = null; }
      }
      requirements = { unverified: found.unverified, contexts: found.contexts.map((c) => ({ ...c, state: contextState(c, { checks, statuses, checkRuns }) })) };
    } catch { requirements = null; }
  }
  // No required checks reported: when the base has no required contexts at all (an unprotected integration branch),
  // report what actually ran on the exact head instead of a bare MISSING. Unreadable -> null (MISSING stands).
  let observedChecks = null;
  if (!checks.length) {
    try {
      if (!readBaseRequirements().protected) {   // no ruleset or protection: nothing is required, so show what ran
        const pages = ghJson("api", `repos/${nwo}/commits/${v.headRefOid}/check-runs?per_page=100`, "--paginate", "--slurp") || [];
        const runs = (Array.isArray(pages) ? pages : [pages]).flatMap((p) => p.check_runs || []);
        const total = Math.max(0, ...(Array.isArray(pages) ? pages : [pages]).map((p) => p.total_count || 0));
        if (runs.length < total) throw new Error("check runs incomplete");
        observedChecks = observedFrom(runs, statuses, [cfg.review.context, cfg.gate.context]);
      }
    } catch { observedChecks = null; }
  }
  let brb = null, brbWhere = null;
  if (mission && slice && cfg.qa.source === "proof") {
    brbWhere = join(process.env.OPENRIG_WORK_ROOT || ".", "missions", mission, "slices", slice, "proof", `brb-${v.headRefOid}.md`);
    if (existsSync(brbWhere)) {
      const fm = frontmatter(brbWhere);
      brb = { file: brbWhere, artifact_type: fm.artifact_type, verdict: fm.verdict, candidate_sha: String(fm.candidate_sha), money_evidence: fm.money_evidence };
    }
  }
  const short = v.headRefOid.slice(0, 7);
  const namesHead = (body) => (body || "").includes(short);
  const allNotes = [
    ...(v.comments || []).map((c) => ({ body: c.body, url: c.url, at: c.createdAt, author: c.author?.login })),
    ...(v.reviews || []).map((r) => ({ body: r.body, url: r.url || `review ${r.id}`, at: r.submittedAt, author: r.author?.login, commit: r.commit?.oid, reviewState: r.state, kind: "review" })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const gateRuns = gateHistory(cfg, { statuses, notes: allNotes.filter((n) => n.kind !== "review"), head: v.headRefOid });
  // The gate's own reports are history only (WO45): no evidence collector below (review fallback, blast radius,
  // comment sources) may pick one up. A gate report is one a gate status links to, one under the configured gate
  // heading, or one headed with the gate's context name ("## jev-merge").
  const notes = allNotes.filter((n) => !isGateReport(n, cfg, statuses));
  // Comment sources read PR comments only. A GitHub review is its own source with its own eligibility (exact-head
  // commit, not dismissed or pending, a mapped login of another family), so it never re-enters as a "comment".
  const comments = notes.filter((n) => n.kind !== "review");
  const author = { family: authorFamily || cfg.authorFamily || familyOf((v.headRefName || "").match(/^agent\/([\w.-]+)/)?.[1]) || null };
  if (cfg.qa.source === "comments") { brb = qaFromComments(comments, cfg.qa.headingRe, v.headRefOid); brbWhere = `PR comments headed /${cfg.qa.heading}/`; }
  const br = [...notes].reverse().find((c) => /^## Blast radius/m.test(c.body || ""));
  const blast = br ? { url: br.url, at: br.at, namesHead: namesHead(br.body) || br.commit === v.headRefOid,
    excerpt: br.body.slice(br.body.search(/^## Blast radius/m)).replace(/\s+/g, " ").slice(0, 700) } : null;
  // What the cross-family reviewer verified: the report the independent-review status links to (target_url), and
  // nothing else. Without a link, the latest comment naming the head is passed on only as UNVERIFIED.
  const note = (c) => c && { url: c.url, at: c.at, author: c.author || "?", excerpt: c.body.replace(/\s+/g, " ").slice(0, 900), limits: statedLimits(c.body) };
  let independentReview = null, reviewNote = null, unlinkedNote = null, reviewProblem = null;
  const commentReview = cfg.review.headingRe
    ? reviewFromComments(comments, cfg.review.headingRe, v.headRefOid, author.family) : null;
  const prReview = reviewFromPrReviews(notes.filter((n) => n.kind === "review"), v.headRefOid, author.family, cfg.identities || {}, cfg.identityHeadingRes || []);
  if (cfg.review.source === "comments") {
    ({ review: independentReview, note: reviewNote = null, problem: reviewProblem = null } = reviewFromComments(comments, cfg.review.headingRe, v.headRefOid, author.family));
  } else {
    const ir = statuses.find((s) => s.context === cfg.review.context);   // its target_url links the report
    independentReview = statusRecord(statuses, cfg.review.context);
    const link = ir?.target_url || null;
    reviewNote = link ? note(notes.find((c) => c.url && c.url === link)) || null : null;
    unlinkedNote = note([...notes].reverse().find((c) => (c.body || "").length > 40 && (namesHead(c.body) || c.commit === v.headRefOid)));
  }
  const reviewVerdictFacts = reviewVerdict({ head: v.headRefOid, primary: cfg.review.source, statusContext: cfg.review.context,
    status: independentReview?.source === "status" ? independentReview : cfg.review.source === "status" ? null : statusRecord(statuses, cfg.review.context),
    prReview, commentReview, authorFamily: author.family, headings: cfg.identityHeadingRes || [] });
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
    mergeable: v.mergeable, mergeState: v.mergeStateStatus, reviewDecision: v.reviewDecision || null, isDraft: v.isDraft, change: change || v.title, checks,
    requirements, observedChecks, gateHistory: gateRuns, gateContext: cfg.gate.context, reviewContext: cfg.review.context, sources: { review: cfg.review.source, qa: cfg.qa.source, gate: cfg.gate.source },
    authorFamily: author.family, independentReview, reviewProblem, reviewNote,
    reviewVerdict: reviewVerdictFacts,
    // The report of the source the verdict came from, when the lines below don't already carry it (a fallback source).
    verdictReport: reviewVerdictFacts.key && reviewVerdictFacts.key !== cfg.review.source ? reviewVerdictFacts.report : null, unlinkedNote, brb, brbWhere, brbNA, blastRadius: blast, blastNA, deploy, rollback,
  };
}

// Code owns the threshold: only a live Jev "merge" in the act band passes.
// A stubbed answer (AGENT_JEV_STUB, tests) is never a live decision, so it never passes.
export const passes = (rec) => !rec?.stubbed && rec?.decided_by === "jev" && rec?.band === "act" && rec?.result?.decision === "merge";

// The deterministic gates this helper can check from the evidence it gathered: required checks pass, the
// review verdict (or, without one, the independent-review status) is success, QA's bug-review-board proof is a qa artifact with PASS for exactly this head,
// the PR is not a draft, GitHub says it is mergeable, and the branch is neither behind its base nor conflicted.
// Returns what is not green. Repository-specific gates (the integrator role's starter-kit journeys, risk tier and
// owner OK) are not visible here and stay the integrator's to check.
export function gateProblems(f) {
  const p = [];
  if (f.isDraft !== false) p.push(f.isDraft ? "the PR is a draft" : "draft state unknown");
  if (f.mergeable !== "MERGEABLE") p.push(`GitHub mergeable: ${f.mergeable || "unknown"}`);
  if (["BEHIND", "DIRTY", "UNKNOWN", undefined, null, ""].includes(f.mergeState)) p.push(`merge state ${f.mergeState || "unknown"} (the branch must be up to date with its base and free of conflicts)`);
  if (!f.checks?.length && f.observedChecks) {
    if (!f.observedChecks.length) p.push(`the base has no required checks and no check ran on this head`);
    else if (f.observedChecks.some((c) => c.bucket !== "pass")) p.push(`checks on this head not passing: ${f.observedChecks.filter((c) => c.bucket !== "pass").map((c) => `${c.name} (${c.result})`).join(", ")}`);
  } else if (!f.checks?.length) p.push("no required checks reported");
  else if (f.checks.some((c) => c.bucket !== "pass")) p.push(`required checks not passing: ${f.checks.filter((c) => c.bucket !== "pass").map((c) => c.name).join(", ")}`);
  if (f.reviewVerdict) { if (f.reviewVerdict.state !== "success") p.push(f.reviewVerdict.state ? `review verdict ${f.reviewVerdict.state}` : `no verifiable review verdict (${f.reviewVerdict.why})`); }
  else if (f.independentReview?.state !== "success") p.push(f.independentReview ? `independent review is ${f.independentReview.state}` : `independent review missing${f.reviewProblem ? ` (${f.reviewProblem})` : ""}`);
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
      : { code: 3, text: `merge gate: NEEDS CONFIRM (Jev merge below the act bar, ${rec.band} band; the gates this helper checks are green: required checks, the review verdict, ${facts.brbNA ? `QA verdict not required (${facts.brbNA.replace(/^N\/A: /, "")})` : "QA's qa PASS for this head"}, not a draft, mergeable, up to date). Check the repository's own gates too (integrator role: starter-kit journeys, risk tier, owner OK), then ask the other-family independent reviewer for a one-line exact-head "confirm ${facts.head}", and merge with --match-head-commit ${facts.head}` };
  }
  return { code: 1, text: `merge gate: HOLD (${rec?.decided_by}/${rec?.band}/${rec?.result?.decision})` };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agent-merge-evidence")) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const pr = a.find((x) => /^\d+$/.test(x));
  if (!pr) { console.error("usage: agent-merge-evidence <pr> [--repo o/r] [--mission M --slice S] [--change ...] [--deploy ...] [--rollback ...] [--config F] [--author-family claude|codex|kimi] [--decide]"); process.exit(2); }
  let facts;
  try { facts = gather(pr, { repo: flag("--repo"), mission: flag("--mission"), slice: flag("--slice"), change: flag("--change"), deploy: flag("--deploy"), rollback: flag("--rollback"), configPath: flag("--config"), authorFamily: flag("--author-family") }); }
  catch (e) { console.error(`agent-merge-evidence: ${e.message}`); process.exit(2); }
  const input = buildMergeInput(facts);
  // `history`: this gate's own earlier runs on this head, for people; never part of the input Jev decides on.
  const history = facts.gateHistory?.length ? { history: facts.gateHistory } : {};
  if (!a.includes("--decide")) { console.log(JSON.stringify({ ...input, ...history }, null, 2)); process.exit(0); }
  const rec = await decideOrStub("review.merge_gate", input, { caller: process.env.OPENRIG_SESSION_NAME || "agent-merge-evidence" });
  console.log(JSON.stringify({ input, ...history, decision: { decided_by: rec.decided_by, band: rec.band, result: rec.result, request_id: rec.request_id, ...(rec.stubbed ? { stubbed: true } : {}) } }, null, 2));
  const o = outcome(rec, facts);
  console.error(o.text);
  process.exit(o.code);
}
