#!/usr/bin/env node
// agent-merge-evidence <pr> [--repo owner/name] [--mission M --slice S] [--change "one line"] [--deploy "..."]
//                      [--rollback "..."] [--decide [--no-post] [--confirm <comment-url>]]
//
// The merge gate's evidence, assembled from exact-head facts instead of a hand-written summary (Jev decides better
// on evidence than on conclusions: 51% of review.merge_gate calls came back "uncertain" before this, 2026-09-30).
// Prints the review.merge_gate input as JSON: pr, full head and base shas, the change, every required check by name,
// the independent-review status on that head, QA's bug-review-board proof (proof/brb-<head>[-rN].md in the rig workspace, see findBrb), the blast-radius
// comment, and the target branch, deploy effect and rollback as limits. Anything missing says MISSING, never
// "fine". --decide also asks Jev, but never while GitHub reports mergeable UNKNOWN (it waits up to 90 s first; still
// UNKNOWN: exit 4, Jev not asked). Exit 0: live Jev merge in the act band, and the helper has posted the PR comment
// (verdict, raw request and response) and the jev-merge success status on the head (--no-post: neither; a failed
// post: exit 5). Exit 3: live Jev merge below the act bar with
// the gates it checks green (see gateProblems): NEEDS CONFIRM, a one-line exact-head "confirm <sha>" from the
// other-family independent reviewer after the integrator checks the repository's own gates (the integrator role's
// below-bar path). Exit 1: hold. Code still re-checks the head and merges with --match-head-commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
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
// CI configuration: how the build and checks run, not what users get. A change to it can still break builds, so the
// blast radius still applies; only QA's user-facing verdict doesn't.
export const CI_PATHS = "`.github/workflows/**`, `.github/actions/**`, `.gitlab-ci.yml`, `.circleci/**`, `.buildkite/**`, `azure-pipelines.yml`, `Jenkinsfile`";
export const isCI = (p) => /^\.github\/(workflows|actions)\//.test(p) || /^\.(circleci|buildkite)\//.test(p)
  || /^(\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile)$/.test(p);
const known = (f) => !f.unknown;
const FLAG_LINE = /^\s*"[\w.-]+"\s*:\s*(true|false)\s*,?\s*$/;
const flagKeys = (lines) => lines.map((l) => l.match(/"([\w.-]+)"/)[1]).sort().join(",");
// A features.json change that only flips boolean flags: every changed line is `"key": true|false`, same keys on both sides.
// Only an in-place text edit of the same features.json: no rename or copy, no new, deleted or binary file, no mode change.
export const flagOnly = (f) => /(^|\/)features\.json$/.test(f.path) && f.oldPath === f.path
  && !(f.unknown || f.renamed || f.newFile || f.deleted || f.modeChange || f.binary) && f.added.length > 0
  && [...f.added, ...f.removed].every((l) => FLAG_LINE.test(l)) && flagKeys(f.added) === flagKeys(f.removed);

// Pure (WO75): is the change tests only? A test path is under a tests/test/__tests__/e2e/cypress/playwright directory
// (anywhere in the path) or is a *.test.* / *.spec.* source file; a rename counts only if both sides are tests. A
// "spec"/"specs" directory is NOT a test directory (runtime specs, API schemas), and some files are never tests
// wherever they sit: CI configuration, package manifests and lockfiles, build and tool configs, Dockerfiles, Prisma
// schemas and anything under migrations/ or schema/. The merge gate's tests-first exception applies only when this
// line says tests-only: a fact from the diff, not a reading (QA PR80).
const NEVER_TEST = (p) => isCI(p)
  || /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Dockerfile[^/]*|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|[^/]*\.prisma)$/i.test(p)
  || /(^|\/)(migrations?|schema)\//i.test(p);
export const isTestPath = (p) => !!p && !NEVER_TEST(p)
  && (/(^|\/)(tests?|__tests__|e2e|cypress|playwright)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p));
export function testScope(files) {
  if (!files?.length) return "scope (from the diff): unknown, the diff could not be read";
  const nonTest = files.filter((f) => !known(f) || !isTestPath(f.path) || !isTestPath(f.oldPath));
  if (!nonTest.length)
    return `scope (from the diff): tests-only, ${files.length} path(s), all tests, fixtures or test helpers: ${files.map((f) => f.path).slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}`;
  // WO79: stated neutrally. An ordinary PR is a code change, not a defect; "NOT tests-only" read as one and pushed
  // ordinary merges toward HOLD. The decisive negative is the separate contradiction line (tests-only claimed, code
  // changed), added in buildMergeInput only when the change or review claims tests-only.
  return `scope (from the diff): code change, ${nonTest.length} non-test path(s): ${nonTest.map((f) => (f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path)).slice(0, 8).join(", ")}${nonTest.length > 8 ? ", …" : ""}${files.length > nonTest.length ? ` (plus ${files.length - nonTest.length} test path(s))` : ""}`;
}

// Pure: why the bug-review-board proof doesn't apply, or null (it is required).
export function brbNotApplicable({ createdAt, cutoff, files }) {
  if (cutoff && createdAt && Date.parse(createdAt) < Date.parse(cutoff.iso))
    return `N/A: PR created ${createdAt}, before the bug-review-board cutoff ${cutoff.iso} (${cutoff.source})`;
  if (files?.length && files.every((f) => known(f) && isDocs(f.path) && isDocs(f.oldPath)))
    return `N/A: ${files.length} changed path(s), all docs (docs/** or *.md): ${files.map((f) => f.path).slice(0, 8).join(", ")}`;
  const docsOrCI = (p) => isDocs(p) || isCI(p);
  if (files?.length && files.every((f) => known(f) && docsOrCI(f.path) && docsOrCI(f.oldPath)))
    return `N/A: ${files.length} changed path(s), all ${files.some((f) => isDocs(f.path)) ? "docs or " : ""}CI configuration (${CI_PATHS}${files.some((f) => isDocs(f.path)) ? "; docs/** or *.md" : ""}), no user-facing behaviour: ${files.map((f) => f.path).slice(0, 8).join(", ")}`;
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

// A seat's model family from its name (review-claude-2, impl-codex-1, impl-astra-1, impl-grok-1). null when the name
// doesn't say. Grok: the native seats (agent-native-seat, WO96); a Grok author needs a review from another family.
export const FAMILIES = ["claude", "codex", "kimi", "grok"];
export const familyOf = (seat) => { const s = String(seat || "").toLowerCase();
  return /claude|fable|opus|sonnet/.test(s) ? "claude" : /codex|gpt|astra/.test(s) ? "codex" : /kimi/.test(s) ? "kimi"
    : /grok/.test(s) ? "grok" : null; };

const WORD = { success: /^(PASS(ED)?|APPROVED?|YES|MERGE|SHIP)$/i, failure: /^(FAIL(ED)?|BLOCK(ED|ING)?|NO|HOLD|CHANGES[_ ]REQUESTED|REQUEST[_ ]CHANGES)$/i };
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
// `verdicts`: each declared verdict, from an explicit line only: "confirm <sha>", or "Verdict: <word>". The heading
// (first line) identifies the seat and nothing else: "evidence remedy for HOLD 7db8271e" in a heading is not a HOLD.
// As success, failure or unknown (a declaration this helper can't read).
export function declarations(body) {
  const lines = ownLines(body), candidates = [], verdicts = [];
  for (const l of lines) {   // a heading line never matches these explicit forms, so it declares nothing
    let m = l.match(/^confirm\s+([0-9a-f]{40})$/i);
    if (m) { candidates.push(m[1].toLowerCase()); verdicts.push("success"); continue; }
    m = l.match(/^(?:reviewed\s+)?(?:head|candidate(?:[_ ]sha)?|sha|commit)\s*[:=]?\s*([0-9a-f]{40})\.?$/i);
    if (m) { candidates.push(m[1].toLowerCase()); continue; }
    m = l.match(/^verdict\s*[:=—-]\s*(.*)$/i);
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
  return r ? { file: r.url || "PR comment", seat: r.seat, at: r.at, artifact_type: "qa", verdict: r.state === "success" ? "PASS" : r.state === "failure" ? "BLOCKING" : "UNCLEAR", candidate_sha: head,
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
  // A PR comment reporting a merge-gate result (the merge owner's "live Jev merge gate HOLD", the helper's own
  // "merge gate: HOLD (…)" pasted in): its first line names the merge gate, or Jev with a gate outcome word, or one of
  // its own lines (not fenced or quoted) is the helper's outcome line; and it isn't signed by a review or QA seat. A
  // GitHub review is never a gate report: its state is review evidence ("Review of Jev retry behaviour" included).
  const own = ownLines(n.body), lead = own.find((l) => l) || "";   // the comment's own first line (not quoted or fenced)
  const signer = (lead.replace(/^#+\s*/, "").match(/^([\w.@-]+)/) || [])[1] || "";
  const reportsGate = n.kind !== "review" && !/^(review|qa|reviewer)[-_]/i.test(signer)
    && (/\bmerge[ _.-]?gate\b/i.test(lead) || /\bjev\b.*\b(hold|merge|decision|band|gate)\b/i.test(lead)
      || own.some((l) => /^merge gate: (PASS|HOLD|NEEDS CONFIRM)\b/.test(l)));
  return (statuses || []).some((s) => s.context === cfg.gate.context && s.target_url && s.target_url === n.url)
    || !!cfg.gate.headingRe?.test(first) || new RegExp(`^#+\\s*${ctx}\\b`, "i").test(first) || reportsGate;
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
  // Check runs, when read, count too: the latest run of that name (any producer, as the context isn't bound).
  const run = Array.isArray(checkRuns) ? checkRuns.filter((r) => r.name === req.context).sort((a, b) => b.id - a.id)[0] : null;
  if (run && !["success", "neutral", "skipped"].includes(run.conclusion)) bad.push(`check run ${run.conclusion || run.status || "pending"}`);
  if (bad.length) return `${req.context}: ${bad.join(", ")}`;
  return latest || run || (checks || []).some((c) => c.name === req.context) ? "pass" : null;
}

// GitHub says BLOCKED while ANY merge requirement is unmet, including the merge-gate status this helper exists to
// produce (jev-merge). Pure: the merge-state line with the real reasons when BLOCKED; null (no merge-state line at
// all) when the gate's own status is the only unmet requirement and everything else is verified.
export const GATE_CONTEXT = "jev-merge";
export function mergeStateLine(f) {
  const GATE = f.gateContext || GATE_CONTEXT;
  if (f.mergeState === "UNSTABLE" && f.unstable !== undefined) {
    const u = f.unstable;
    if (!u) return "merge state: UNSTABLE (the checks behind it could not be read)";
    if (u.required.length) return `merge state: UNSTABLE (required check(s) not passing: ${u.required.join(", ")}${u.other.length ? `; also non-required: ${u.other.join(", ")}` : ""})`;
    if (u.other.length) return `merge state: UNSTABLE (only non-required checks not passing: ${u.other.join(", ")}; every required check passes)`;
    return "merge state: UNSTABLE (no failing or pending check visible to this helper)";
  }
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
  // The gate's own context is this run's to decide, so it is never mentioned (WO45, WO50): any wording about it
  // ("pending this gate", "not yet posted") reads to the gate as a missing gate and makes it hold. When the gate's own
  // status is the only unmet requirement there is nothing to say (null: the limits line then omits the merge state).
  const gateReqs = (req?.contexts || []).filter((c) => c.context === GATE);
  if (!reasons.length && gateReqs.length) return null;
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
  // carried reviews (risky tier): each shown as carried, proven or not, never as a fresh exact-head review
  const carried = (f.risk?.carries || []).map((c) => c.ok
    ? `carried review: ${c.seat}, carried from ${String(c.from).slice(0, 12)} to ${f.head}: proven by this helper (ancestor; the PR's own files byte-identical; only base-branch changes in between; required CI green on the head; ${c.seat} passed at ${String(c.from).slice(0, 7)}); NOT a fresh review of this head`
    : `carried review NOT accepted: ${c.seat}, claimed carried from ${String(c.from).slice(0, 12)}: ${c.problems.join("; ")}`);
  const review = [
    ...carried,
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
      ? `independent review report, linked from the ${RC} status (${f.reviewNote.url}, ${f.reviewNote.at}, by ${f.reviewNote.author}${f.reviewNote.commit ? `; submitted on ${f.reviewNote.commit === f.head ? "this head" : `commit ${f.reviewNote.commit.slice(0, 12)}, not this head`}` : ""}): ${f.reviewNote.excerpt}`
      : f.independentReview?.url
        ? `independent review report: ${f.independentReview.url} (linked from the status, ${f.reviewLinkProblem || "outside this PR, so not read"}${rv?.state && rv.key !== "status" ? `; the verdict above comes from ${rv.key === "reviews" ? "the GitHub review" : "the review comment"}` : ""})`
        : f.sources?.review === "comments" ? null : `MISSING: the ${RC} status links no review report (no target_url), so what the reviewer verified is not established`,
    ...(!f.reviewNote && f.unlinkedNote && f.unlinkedNote.url !== f.verdictReport?.url   // not the verdict's own source again
      ? [`UNVERIFIED, not linked from the status and not treated as the review: the latest PR comment naming ${f.head.slice(0, 7)} (${f.unlinkedNote.url}, ${f.unlinkedNote.at}, by ${f.unlinkedNote.author}): ${f.unlinkedNote.excerpt}`]
      : []),
    f.brb?.carried
      ? `bug-review-board verdict from a PR comment by ${f.brb.seat} (${f.brb.file}; the seat is self-declared; no proof file for this head${f.brb.otherProofs?.length ? `; proof on file for another head: ${f.brb.otherProofs.join(", ")}` : ""}): artifact_type=qa verdict=${f.brb.verdict} candidate_sha=${f.brb.candidate_sha}`
      : f.brb
      ? `bug-review-board proof ${f.brb.file}: artifact_type=${f.brb.artifact_type} verdict=${f.brb.verdict} candidate_sha=${f.brb.candidate_sha}${f.brb.candidate_sha === f.head ? "" : " (NOT this head)"}; ${f.brb.money_evidence}`
      : f.brbNA || `MISSING: no bug-review-board proof for ${f.head}${f.brbWhere ? ` (looked for ${f.brbWhere})` : " (no --mission/--slice given)"}`,
    f.blastRadius
      ? `blast radius (${f.blastRadius.url}, ${f.blastRadius.at}${f.blastRadius.own ? ", in the selected review" : ""}${f.blastRadius.namesHead ? ", names this head" : ", does NOT name this head"}): ${f.blastRadius.excerpt}`
      : f.blastNA ? `blast radius ${f.blastNA}` : "MISSING: no blast-radius comment on the PR",
    // Evidence the caller adds (--extra-evidence <file>): labelled as theirs, never mistaken for what was verified here.
    // Redacted whole, before AND after whitespace is collapsed (collapsing can join a split value into a recognizable
    // credential), and only then cut: a cut can split a credential past the redactor. The label (a file name the
    // caller controls) has its control characters removed and is quoted, so it can't start a line of its own.
    ...(f.extraEvidence ? [`additional evidence supplied by the caller (${JSON.stringify(String(f.extraEvidence.label).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").slice(0, 80))}; not verified by this helper): ${redact(redact(f.extraEvidence.text).replace(/\s+/g, " ").trim()).slice(0, 1500)}`] : []),
  ].filter((x) => x !== null).join("\n");
  const limits = [
    `target branch ${f.baseRef} at ${f.base}; PR head branch ${f.headRef}`,
    `mergeable: ${f.mergeable}; ${[mergeStateLine(f), `draft: ${f.isDraft}`].filter(Boolean).join("; ")}`,
    ...(f.reviewNote?.limits?.length ? [`limits stated by the independent review: ${f.reviewNote.limits.join("; ")}`] : []),
    ...(f.verdictReport?.limits?.length ? [`limits stated by the ${f.verdictReport.kind}: ${f.verdictReport.limits.join("; ")}`] : []),
    `deploy effect: ${f.deploy || "MISSING: not stated (see the rig CULTURE specifics)"}`,
    f.rollback ? `rollback: ${f.rollback}` : `rollback: not stated (proposed default: revert the squash commit on ${f.baseRef})`,
  ].join("\n");
  // Free text from PR comments and statuses goes out to Jev: redact anything credential-shaped (shas are kept).
  // WO79: only when the PR or its review CLAIMS tests-only but the diff changes code is the scope a decisive negative.
  // The claim is structural, never read from prose (QA PR83: titles, descriptions and reviews mention "tests-only" in
  // every sense): test authors work on a `tests/<feature-id>` branch (rig template, test-author role). A tests/ branch
  // whose diff changes code is the decisive negative; any other branch is an ordinary change.
  const contradiction = /^tests\//.test(f.headRef || "") && /^scope \(from the diff\): code change,/.test(f.scope || "")
    ? `scope check: head branch ${f.headRef} is a tests-first branch, but the diff changes ${f.scope.replace(/^scope \(from the diff\): code change, /, "")}`
    : null;
  return { pr: f.pr, head: f.head, base: f.base, change: redact([f.change, f.scope, contradiction].filter(Boolean).join("\n")), review: redact(review), ci, limits: redact(limits) };
}

function frontmatter(path) {
  const m = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  return m ? YAML.parse(m[1]) || {} : {};
}

// Pure: the PR body's first section, as plain text (up to its first heading after some text; the first heading's
// content when the body starts with one), at most 600 characters. With the title it is the default `change`.
export function firstSection(body) {
  const out = [];
  for (const l of String(body || "").replace(/\r/g, "").split("\n")) {
    if (/^\s*#{1,6}\s/.test(l)) { if (out.length) break; continue; }
    if (/^\s*(🤖|Co-Authored-By:)/.test(l)) continue;
    if (l.trim()) out.push(l.trim());
  }
  // Redacted whole, before and after joining lines (joining can form a credential), and only then cut: a cut can
  // split a credential past the redactor.
  return redact(redact(out.join("\n")).replace(/\s+/g, " ").trim()).slice(0, 600);
}

// Pure: a note's blast-radius section, from its "Blast radius" heading (any level), bold or plain lead-in to the end,
// redacted whole and then cut to its own 900-character budget (a cut can split a credential past the redactor); null
// when the note has none. Only the note's own lines count (not fenced or quoted).
export function blastSection(body) {
  const text = ownLines(body).join("\n");
  const at = text.search(/^(?:#{1,6}[ \t]*)?Blast radius\b/im);
  if (at < 0) return null;
  return redact(redact(text.slice(at)).replace(/\s+/g, " ").trim()).slice(0, 900);
}

// GitHub recomputes mergeability after a push or a base change and reports UNKNOWN meanwhile. Gating then gave HOLDs
// that were only the recompute (three on one project on 2026-10-03), so with --decide the helper first waits: it reads
// mergeable every pollS seconds for up to maxS while it is UNKNOWN. Returns the last value read.
export async function awaitMergeable({ read, sleep = (s) => new Promise((r) => setTimeout(r, s * 1000)), pollS = 5, maxS = 90 }) {
  if (!(pollS > 0) || !(maxS >= 0)) throw new Error(`awaitMergeable: pollS must be > 0 and maxS >= 0 (got ${pollS}, ${maxS})`);   // 0 would never advance
  let value = read(), waited = 0;
  while (value === "UNKNOWN" && waited + pollS <= maxS) { await sleep(pollS); waited += pollS; value = read(); }
  return { value, waited };
}

// ---- Risk tier (starter-kit repos) ----------------------------------------------------------------------------------
// A starter-kit repo's features.json gives each feature (F-NNN) a risk_tier; a PR names its features in its title
// ("F-012 WP-08: ...") or its body. A risky PR needs two independent reviews from two different families, neither the author's,
// and the owner-approved label, before Jev is asked (2026-10-04: a risky PR merged with one review and no label).
const TIER_RANK = { trivial: 0, standard: 1, risky: 2 };
export const OWNER_LABEL = "owner-approved";
// Pure: the highest tier among the features a PR names. features: the parsed features.json (a list, or { features }).
export function featureTier(features, text) {
  const ids = [...new Set(String(text || "").match(/\bF-\d{3,}\b/g) || [])];
  const list = Array.isArray(features) ? features : Array.isArray(features?.features) ? features.features : [];
  const named = ids.map((id) => ({ id, tier: list.find((f) => f?.id === id)?.risk_tier ?? null })).filter((f) => f.tier);
  const top = named.reduce((a, f) => (TIER_RANK[f.tier] ?? -1) > (TIER_RANK[a?.tier] ?? -1) ? f : a, null);
  return { ids, features: named, tier: top?.tier ?? null, unknown: ids.filter((id) => !named.some((f) => f.id === id)) };
}
// Pure: the distinct families of independent reviews that PASS on this head, none the author's: review-seat comment
// records ("## review-<family>..." declaring this head), GitHub reviews on the head (family by identities or heading),
// and the review status (family from its description's signer).
// Each reviewer counts by its LATEST record on this head (a later BLOCK withdraws an earlier PASS); dismissed and
// pending GitHub reviews never count; an unknown author family counts nothing (cross-family can't be verified, as for
// the other collectors). QA PR174.
// Statuses (2026-10-04): every reviewer posts the review context from one GitHub account, and the combined status keeps
// only the newest per context, so the full list is read (gather: commits/<sha>/statuses, paginated) and every one of
// the review context counts by its seat. The seat is the description's first word ("review-kimi (Kimi K3): clean at
// exact head 96b7d3a"), its family from the seat name; a status is about this head when the sha its description
// names is the head, or (naming none) its target_url is on this PR. Each seat counts by its newest status.
export function statusReviewers(statuses = [], { head, context = "independent-review", pr = null } = {}) {
  const short = String(head || "").toLowerCase();
  const carriedFrom = (s) => (String(s.description || "").match(/\bcarried from\s+([0-9a-f]{7,40})\b/i) || [])[1]?.toLowerCase() ?? null;
  const onHead = (s) => {
    const from = carriedFrom(s);
    const shas = (String(s.description || "").match(/\b[0-9a-f]{7,40}\b/gi) || []).filter((x) => x.toLowerCase() !== from);
    if (shas.length) return shas.every((x) => short.startsWith(x.toLowerCase()));
    return pr != null && new RegExp(`/pull/${pr}(?:[#/?]|$)`).test(String(s.target_url || s.url || ""));
  };
  const out = new Map();
  for (const s of [...statuses].filter((x) => x.context === context).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))) {
    const seat = (String(s.description || "").trim().match(/^([\w.-]+(?:@[\w.-]+)?)/) || [])[1];
    if (!seat || out.has(seat) || !onHead(s)) continue;   // newest first: a seat's first seen is its latest
    out.set(seat, { seat, family: familyOf(seat), state: s.state, by: s.target_url || "status", at: s.created_at || "", carriedFrom: carriedFrom(s) });
  }
  return [...out.values()];
}

// A status that says "carried from <sha A>" counts only when carry(seat, A) proves it ({ ok, problems }): the review is
// then marked carried (2026-10-04, operator: the helper proves the carry itself; see carryProblems).
export function reviewFamilies({ notes = [], head, authorFamily, identities = {}, headings = [], status = null, statuses = null, context = "independent-review", pr = null, carry = null, carries = null }) {
  if (!authorFamily) return [];
  const seatHeads = FAMILIES.map((f) => ({ re: new RegExp(`^(?:#+\\s*)?review-${f}\\b`, "i"), family: f }));
  const all = [...headings, ...seatHeads];
  const latest = new Map();   // reviewer -> its newest record { family, state, by, at } (comments, reviews and statuses)
  const put = (who, family, state, by, at = "", carried = null) => {
    const cur = latest.get(who);
    if (who && (!cur || String(at) >= String(cur.at))) latest.set(who, { family, state, by, at: String(at), carried });
  };
  for (const r of records(notes.filter((n) => n.kind !== "review"), /^(?:#+\s*)?review-(claude|codex|kimi|grok)/i, head))
    put(`seat:${r.seat}`, familyOf(r.seat), r.state, r.url || r.seat, r.at);
  for (const r of notes.filter((n) => n.kind === "review" && String(n.commit || "").toLowerCase() === String(head).toLowerCase())) {
    if (/^(DISMISSED|PENDING)$/i.test(r.reviewState || "")) continue;
    const byLogin = identities[r.author];
    const family = byLogin && byLogin !== "shared" ? byLogin : familyFromHeading(r.body, all);
    const seat = (String(r.body || "").split("\n", 1)[0].match(/^#*\s*(review-[\w.@-]+)/i) || [])[1];
    put(seat ? `seat:${seat}` : `login:${r.author}`, family, verdictOf(r.body, r.reviewState), r.url, r.at);
  }
  if (statuses) for (const r of statusReviewers(statuses, { head, context, pr })) {
    if (r.carriedFrom) {
      const proof = carry ? carry(r.seat, r.carriedFrom) : { ok: false, problems: ["the carry can't be checked here"] };
      carries?.push({ seat: r.seat, from: r.carriedFrom, ...proof });
      if (!proof.ok) continue;   // an unproven carry counts for nothing
    }
    put(`seat:${r.seat}`, r.family, r.state === "success" ? "success" : "failure", r.by, r.at, r.carriedFrom);
  }
  else if (status) put("status", familyFromDescription(status.description, all).family, status.state, status.url || "status");
  const fams = new Map();   // a family counts fresh if any of its seats is fresh
  for (const { family, state, by, carried } of latest.values()) {
    if (state !== "success" || !family || family === authorFamily || !FAMILIES.includes(family)) continue;
    const cur = fams.get(family);
    if (!cur || (cur.carried && !carried)) fams.set(family, { by, carried });
  }
  return [...fams].map(([family, v]) => ({ family, by: v.by, ...(v.carried ? { carried: v.carried } : {}) }));
}
// Pure: what a PR still lacks for its tier, as MISSING lines (empty when not risky, or complete). Fails closed
// (operator 2026-10-04): a repo that HAS a features.json and a PR naming F-ids, with the file unreadable or an F-id
// not in it, is "tier unknown". A repo with no features.json keeps "no tier".
export function riskProblems(risk) {
  if (!risk) return [];
  if (risk.featuresFile === "unreadable" && risk.ids?.length) return [`MISSING: the risk tier of ${risk.ids.join(", ")} (features.json exists but couldn't be read: ${risk.featuresError || "unreadable"})`];
  if (risk.featuresFile === "read" && risk.unknown?.length) return [`MISSING: the risk tier of ${risk.unknown.join(", ")} (not in features.json; fix the PR title's F-id or add the feature)`];
  if (risk.tier !== "risky") return [];
  const p = [];
  if (!risk.authorFamily) p.push(`MISSING: the PR author's model family (unknown, so no review can be verified as cross-family; pass --author-family or use an agent/<seat> branch)`);
  if ((risk.reviewFamilies || []).length < 2) p.push(`MISSING: a second independent review from another family (risky ${risk.features.map((f) => f.id).join(", ")} needs two families other than the author's; have ${(risk.reviewFamilies || []).map((r) => r.family).join(", ") || "none"})`);
  if ((risk.reviewFamilies || []).length >= 2 && !(risk.reviewFamilies || []).some((r) => !r.carried))
    p.push(`MISSING: a fresh exact-head review from at least one family (risky ${risk.features.map((f) => f.id).join(", ")}: every counted review is carried from an earlier commit)`);
  if (!risk.ownerApproved) p.push(`MISSING: the ${OWNER_LABEL} label (risky ${risk.features.map((f) => f.id).join(", ")} needs the owner's OK, or a CULTURE standing approval cited when adding the label)`);
  return p;
}

// ---- QA's bug-review-board proof: where it lives -------------------------------------------------------------------
// Rig workspaces keep missions in <Project>-work beside the repo (~/Projects/App-work), not in the checkout the
// integrator runs from (~/Projects/App.worktrees/integ-codex): a false "MISSING: no bug-review-board proof" twice.
// Pure: the workspace roots to search, in order: $OPENRIG_WORK_ROOT, the <Project>-work beside the checkout
// (<P>.worktrees/<seat> or <P>), <projects>/<repo name>-work, then the current directory. No duplicates.
export function workspaceRoots({ env = process.env, cwd = process.cwd(), nwo = null, projects = env.AGENT_PROJECTS_DIR || join(homedir(), "Projects") } = {}) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  add(env.OPENRIG_WORK_ROOT);
  const worktree = String(cwd).match(/^(.*)\.worktrees\/[^/]+/)?.[1];   // <P>.worktrees/<seat>[/...] -> <P>-work
  if (worktree) add(`${worktree}-work`);
  else for (let d = String(cwd); d && d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".git"))) { add(`${d}-work`); break; }   // <P>[/...] -> <P>-work
  if (nwo) add(join(projects, `${nwo.split("/")[1]}-work`));
  add(".");
  return out;
}
// Pure (reads the dir): the proof file for this head in one slice's proof dir: brb-<sha>.md with the full sha or a
// prefix of 7+, optionally -rN (the highest N wins; an unrevised file counts as r0).
export function findBrb(proofDir, head) {
  let files = [];
  try { files = readdirSync(proofDir); } catch { return null; }
  const h = String(head).toLowerCase();
  const hits = files.map((f) => f.match(/^brb-([0-9a-f]{7,40})(?:-r(\d+))?\.md$/i)).filter((m) => m && h.startsWith(m[1].toLowerCase()))
    .sort((a, b) => Number(b[2] || 0) - Number(a[2] || 0) || b[1].length - a[1].length);
  return hits.length ? join(proofDir, hits[0][0]) : null;
}

// Pure: the seat a branch names: the starter kit's branch prefixes agent/, tests/, wp/ and plan/ all start with the
// author's seat ("tests/impl-claude-ui-f006-tighten"), so its family is the author's. null for any other branch.
export const branchSeat = (ref) => String(ref || "").match(/^(?:agent|tests|wp|plan)\/([\w.-]+)/)?.[1] ?? null;

// ---- Review carry (operator 2026-10-04): a review of commit A counts for head B only when the helper proves, itself:
// (1) A is an ancestor of B; (2) the PR's own change set is the same at A and B (same paths vs each merge-base, blob
// shas byte-identical); (3) everything A..B changed came from the base branch (a pure "merge main in" refresh, no
// author edit); (4) required CI is green on B (main's changes meeting the PR are caught by CI); and the seat itself
// passed at A. Pure: each failed condition as a line (empty: the carry is proven).
export function carryProblems({ ancestor, filesA, filesB, abPaths, basePaths, ciGreen, seatPassedAtA, seat = "the seat", from = "A" }) {
  const p = [];
  if (!ancestor) p.push(`(1) ${from} is not an ancestor of the head`);
  const a = filesA || {}, b = filesB || {}, keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [...keys].filter((k) => a[k] !== b[k]);
  if (!filesA || !filesB) p.push("(2) the PR's change set couldn't be read at both commits");
  else if (diff.length) p.push(`(2) the PR's own files differ between ${from} and the head: ${diff.slice(0, 5).join(", ")}${diff.length > 5 ? ` and ${diff.length - 5} more` : ""}`);
  const base = new Set(basePaths || []), own = (abPaths || []).filter((x) => !base.has(x));
  if (!abPaths || !basePaths) p.push(`(3) what changed from ${from} to the head couldn't be read`);
  else if (own.length) p.push(`(3) changes from ${from} to the head that didn't come from the base branch: ${own.slice(0, 5).join(", ")}${own.length > 5 ? ` and ${own.length - 5} more` : ""}`);
  if (!ciGreen) p.push("(4) required CI isn't green on the head");
  if (!seatPassedAtA) p.push(`${seat} has no passing review of its own at ${from}`);
  return p;
}
// The facts for carryProblems, through gh compare (blob shas) and the statuses on A.
export function proveCarry({ nwo, base, head, from, seat, ciGreen, reviewContext = "independent-review" }) {
  const j = (path) => { try { return ghJson("api", path); } catch { return null; } };
  const A = j(`repos/${nwo}/commits/${from}`)?.sha;
  if (!A) return { ok: false, problems: [`the carried-from commit ${from} couldn't be read`] };
  const ab = j(`repos/${nwo}/compare/${A}...${head}`);
  const toA = j(`repos/${nwo}/compare/${encodeURIComponent(base)}...${A}`), toB = j(`repos/${nwo}/compare/${encodeURIComponent(base)}...${head}`);
  const files = (c) => (c?.files ? Object.fromEntries(c.files.map((f) => [f.filename, f.status === "removed" ? "removed" : f.sha])) : null);
  const mbA = toA?.merge_base_commit?.sha, mbB = toB?.merge_base_commit?.sha;
  const baseCmp = mbA && mbB ? (mbA === mbB ? { files: [] } : j(`repos/${nwo}/compare/${mbA}...${mbB}`)) : null;
  let statusesA = []; try { const pages = ghJson("api", `repos/${nwo}/commits/${A}/statuses?per_page=100`, "--paginate", "--slurp") || []; statusesA = pages.every(Array.isArray) ? pages.flat() : pages; } catch { statusesA = []; }
  const seatPassedAtA = statusesA.some((s) => s.context === reviewContext && s.state === "success" && new RegExp(`^\\s*${seat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(s.description || "")) && !/carried from/i.test(String(s.description || "")));
  const problems = carryProblems({ ancestor: ab ? ab.behind_by === 0 : false, filesA: files(toA), filesB: files(toB), abPaths: ab?.files ? ab.files.map((f) => f.filename) : null,
    basePaths: baseCmp?.files ? baseCmp.files.map((f) => f.filename) : null, ciGreen, seatPassedAtA, seat, from: A.slice(0, 7) });
  return { ok: !problems.length, problems, from: A };
}

export function gather(pr, { repo, mission, slice, change, deploy, rollback, config, configPath, authorFamily } = {}) {
  const R = repo ? ["-R", repo] : [];
  const FIELDS = "number,title,body,createdAt,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,isDraft,comments,reviews,labels";
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
  // Every check run on the head, all pages; throws when the list can't be read in full.
  const readCheckRuns = () => {
    const pages = ghJson("api", `repos/${nwo}/commits/${v.headRefOid}/check-runs?per_page=100`, "--paginate", "--slurp") || [];
    const runs = (Array.isArray(pages) ? pages : [pages]).flatMap((p) => p.check_runs || []);
    const total = Math.max(0, ...(Array.isArray(pages) ? pages : [pages]).map((p) => p.total_count || 0));
    if (runs.length < total) throw new Error("check runs incomplete");
    return runs;
  };
  let observedChecks = null;
  if (!checks.length) {
    try {
      if (!readBaseRequirements().protected)   // no ruleset or protection: nothing is required, so show what ran
        observedChecks = observedFrom(readCheckRuns(), statuses, [cfg.review.context, cfg.gate.context]);
    } catch { observedChecks = null; }
  }
  // GitHub's UNSTABLE: mergeable, but some check or status on the head isn't passing. Say which, and whether any of
  // them is required, so a red optional check doesn't read as a blocker (nor a required one hide behind the word).
  let unstable;
  if (v.mergeStateStatus === "UNSTABLE") {
    try {
      const found = readBaseRequirements(), runs = readCheckRuns();
      // Every required context is verified on its own (bound app, every same-name result, presence), exactly as the
      // merge-state line does: "every required check passes" is said only when each one is, never inferred from
      // the absence of a red one. The gate's own context is this run's to decide (WO45).
      const reqs = found.contexts.filter((c) => c.context !== cfg.gate.context), names = new Set(found.contexts.map((c) => c.context));
      unstable = { required: [...new Set(reqs.map((c) => contextState(c, { checks, statuses, checkRuns: runs }))
        .map((st, i) => (st === "pass" ? null : st ?? `${reqs[i].context}: not reported`)).filter(Boolean))], other: [] };
      for (const c of observedFrom(runs, statuses, [cfg.gate.context]).filter((x) => x.bucket !== "pass"))
        if (!names.has(c.name.replace(/ \(status\)$/, ""))) unstable.other.push(`${c.name} (${c.result})`);
    } catch { unstable = null; }
  }
  let brb = null, brbWhere = null;
  if (mission && slice && cfg.qa.source === "proof") {
    const dirs = workspaceRoots({ nwo }).map((r) => join(r, "missions", mission, "slices", slice, "proof"));
    const found = dirs.map((d) => findBrb(d, v.headRefOid)).find(Boolean);
    brbWhere = found || join(dirs.find((d) => existsSync(d)) || dirs[0], `brb-${v.headRefOid}.md`);
    if (found) {
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
  const author = { family: authorFamily || cfg.authorFamily || familyOf(branchSeat(v.headRefName)) || null };
  if (cfg.qa.source === "comments") { brb = qaFromComments(comments, cfg.qa.headingRe, v.headRefOid); brbWhere = `PR comments headed /${cfg.qa.heading}/`; }
  // No proof file for this head (a branch refresh left brb-<old head>.md): a QA seat's comment on the PR that
  // declares this exact head and a verdict carries it. The seat is self-declared in the comment, so it is shown as
  // such, with any proof file on record for another head.
  if (!brb && cfg.qa.source === "proof") {
    const carried = qaFromComments(comments, cfg.qa.headingRe || /^(?:#+\s*)?qa-[\w.@-]+/i, v.headRefOid);
    if (carried) {
      let others = [];
      try { if (brbWhere) others = readdirSync(dirname(brbWhere)).filter((f) => /^brb-[0-9a-f]{7,40}(?:-r\d+)?\.md$/i.test(f)); } catch { others = []; }
      brb = { ...carried, carried: true, otherProofs: others };
    }
  }
  // What the cross-family reviewer verified: the report the independent-review status links to (target_url), and
  // nothing else. Without a link, the latest comment naming the head is passed on only as UNVERIFIED.
  const note = (c) => c && { url: c.url, at: c.at, author: c.author || "?", excerpt: c.body.replace(/\s+/g, " ").slice(0, 900), limits: statedLimits(c.body),
    ...(c.commit ? { commit: c.commit } : {}) };   // a GitHub review keeps its commit: "submitted on this head" or not
  let independentReview = null, reviewNote = null, unlinkedNote = null, reviewProblem = null, reviewLinkProblem = null, reviewSrc = null;
  const commentReview = cfg.review.headingRe
    ? reviewFromComments(comments, cfg.review.headingRe, v.headRefOid, author.family) : null;
  const prReview = reviewFromPrReviews(notes.filter((n) => n.kind === "review"), v.headRefOid, author.family, cfg.identities || {}, cfg.identityHeadingRes || []);
  if (cfg.review.source === "comments") {
    ({ review: independentReview, note: reviewNote = null, problem: reviewProblem = null } = reviewFromComments(comments, cfg.review.headingRe, v.headRefOid, author.family));
    if (reviewNote) reviewSrc = notes.find((c) => c.url === reviewNote.url) || null;
  } else {
    const ir = statuses.find((s) => s.context === cfg.review.context);   // its target_url links the report
    independentReview = statusRecord(statuses, cfg.review.context);
    const link = ir?.target_url || null;
    reviewNote = link ? note(notes.find((c) => c.url && c.url === link)) || null : null;
    if (reviewNote) reviewSrc = notes.find((c) => c.url === link);
    // A link to a GitHub review on this PR (…/pull/<n>#pullrequestreview-<id>) is read from the API, with the
    // commit it was submitted on, so the report is shown rather than "outside this PR".
    const rl = !reviewNote && link && link.match(/^https:\/\/github\.com\/([^/]+\/[^/#]+)\/pull\/(\d+)#pullrequestreview-(\d+)$/);
    if (rl && rl[1].toLowerCase() === nwo.toLowerCase() && Number(rl[2]) === Number(pr)) {
      try {
        const rv = ghJson("api", `repos/${nwo}/pulls/${pr}/reviews/${rl[3]}`);
        // A fetched review that is the gate's own report is history, like every other gate report (WO45).
        if (isGateReport({ body: rv.body, url: link, kind: "review" }, cfg, statuses)) throw Object.assign(new Error("gate report"), { gate: true });
        reviewNote = { url: link, at: rv.submitted_at || "?", author: rv.user?.login || "?", commit: rv.commit_id || null,
          excerpt: String(rv.body || "").replace(/\s+/g, " ").slice(0, 900), limits: statedLimits(rv.body) };
        reviewSrc = { url: link, at: reviewNote.at, author: reviewNote.author, commit: reviewNote.commit, body: String(rv.body || ""), kind: "review" };
      } catch (e) { reviewLinkProblem = e.gate ? "a review on this PR that is the merge gate's own report, so not the review" : "a review on this PR, but it could not be read"; }
    }
    unlinkedNote = note([...notes].reverse().find((c) => (c.body || "").length > 40 && (namesHead(c.body) || c.commit === v.headRefOid)));
  }
  const reviewVerdictFacts = reviewVerdict({ head: v.headRefOid, primary: cfg.review.source, statusContext: cfg.review.context,
    status: independentReview?.source === "status" ? independentReview : cfg.review.source === "status" ? null : statusRecord(statuses, cfg.review.context),
    prReview, commentReview, authorFamily: author.family, headings: cfg.identityHeadingRes || [] });
  // The blast radius: a "Blast radius" section at any heading level, bold or a plain lead-in ("Blast radius: …"), in a
  // note's own lines. Preferred: the selected review's own (the status-linked report, or the source of a fallback
  // verdict); else the newest note naming this head; else the newest note (labelled as not naming it).
  const picked = reviewVerdictFacts.key && reviewVerdictFacts.key !== cfg.review.source && reviewVerdictFacts.report
    ? notes.find((c) => c.url === reviewVerdictFacts.report.url) : null;
  // The gate's own reports never count (a fetched review can be one); the source that gave the verdict comes first
  // (a pending status's stale linked report doesn't outrank the review that actually decided).
  const withBlast = (c) => c && !isGateReport(c, cfg, statuses) && blastSection(c.body) !== null;
  const own = (reviewVerdictFacts.key === "status" ? [reviewSrc, picked] : [picked, reviewSrc]).find(withBlast);
  const namingHead = (c) => namesHead(c.body) || c.commit === v.headRefOid;
  const br = own || [...notes].reverse().find((c) => withBlast(c) && namingHead(c)) || [...notes].reverse().find(withBlast);
  const blast = br ? { url: br.url, at: br.at, namesHead: namingHead(br), own: br === own, excerpt: blastSection(br.body) } : null;
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
  // the risk tier of the features the PR names (starter-kit repos: features.json on the base branch)
  let risk = null;
  const carries = [];
  // the features the PR names in its title OR its body (2026-10-04: a risky feature's PR named it only in the body,
  // "Implement F-006 …", so its tier was never read and it passed without its owner-approved label). Every F-id named
  // counts; the highest tier wins, so a passing mention can only make the gate stricter.
  const named = `${v.title || ""}\n${v.body || ""}`;
  if (/\bF-\d{3,}\b/.test(named)) {
    let features = null, featuresFile = "read", featuresError = null;
    try { const c = ghJson("api", `repos/${nwo}/contents/features.json?ref=${encodeURIComponent(v.baseRefName)}`); features = JSON.parse(Buffer.from(c.content, "base64").toString("utf8")); }
    catch (e) {   // 404: the repo has no features.json (no tier); anything else: it has one we can't read (tier unknown)
      const why = String(e.stderr || e.message || "");
      featuresFile = /HTTP 404|Not Found/i.test(why) ? "absent" : "unreadable"; featuresError = why.trim().split("\n")[0].slice(0, 160);
    }
    const t = featureTier(features, named);
    risk = { ...t, featuresFile, featuresError, authorFamily: author.family, ownerApproved: (v.labels || []).some((l) => l.name === OWNER_LABEL),
      reviewFamilies: t.tier === "risky" ? reviewFamilies({ notes, head: v.headRefOid, authorFamily: author.family, identities: cfg.identities || {},
        headings: cfg.identityHeadingRes || [], statuses, context: cfg.review.context, pr: v.number, carries,
        carry: (seat, from) => proveCarry({ nwo, base: v.baseRefName, head: v.headRefOid, from, seat, reviewContext: cfg.review.context,
          ciGreen: (checks.length ? checks.every((c) => c.bucket === "pass") : (observedChecks || []).length > 0 && observedChecks.every((c) => c.bucket === "pass")) }) }) : [] };
    risk.carries = carries;
  }
  return {
    pr: v.number, nwo, risk, head: v.headRefOid, base: v.baseRefOid, baseRef: v.baseRefName, headRef: v.headRefName,
    mergeable: v.mergeable, mergeState: v.mergeStateStatus, reviewDecision: v.reviewDecision || null, isDraft: v.isDraft, change: change || [v.title, firstSection(v.body)].filter(Boolean).join(". "), scope: testScope(files), checks,
    requirements, observedChecks, unstable, gateHistory: gateRuns, gateContext: cfg.gate.context, reviewContext: cfg.review.context, sources: { review: cfg.review.source, qa: cfg.qa.source, gate: cfg.gate.source },
    authorFamily: author.family, independentReview, reviewProblem, reviewNote, reviewLinkProblem,
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
  // WO75 (QA PR80): the diff's scope line is what the tests-first exception rests on; a diff this helper couldn't read
  // (or a missing line) fails closed in every band.
  if (!/^scope \(from the diff\): (tests-only|code change),/.test(f.scope || "")) p.push(`the diff scope could not be computed (${f.scope || "no scope line"})`);
  return p;
}

// The integrator's standing below-bar path: live Jev merge in the review band, every deterministic gate green ->
// ask the other-family independent reviewer for a one-line exact-head "confirm <sha>", then merge.
export function outcome(rec, facts) {
  // WO75 (QA PR80): the act band never skips the deterministic gates. Jev judges the evidence; code still refuses a
  // head whose required checks, review verdict or QA PASS isn't green, whatever Jev answered.
  if (passes(rec)) {
    const problems = gateProblems(facts);
    return problems.length
      ? { code: 1, text: `merge gate: HOLD (live Jev merge in the act band, but a gate this helper checks is not green: ${problems.join("; ")})` }
      : { code: 0, text: `merge gate: PASS (live Jev merge, act band) for ${facts.head}` };
  }
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

// Posting the gate's result (operator 2026-10-03: integrators kept hitting "branch policy blocks merge" after forgetting
// it). Only a pass posts: a live Jev merge in the act band (decided_by jev, not stubbed) with every gate this helper
// checks green (outcome code 0). Never on review or uncertain bands, fallback, HOLD, NEEDS CONFIRM or errors.
export const shouldPost = (rec, o) => o?.code === 0 && rec?.decided_by === "jev" && rec?.band === "act" && !rec?.stubbed;

// (a) a PR comment with the verdict line plus the raw request and response, then (b) the gate status on the exact head,
// success, the request id in its description, target_url = that comment. The comment's first line is the helper's
// outcome line, so a later gather knows it as a gate report. Returns { commentUrl } or throws (nothing is posted after
// a failure: no status without its comment).
export function postGateResult({ facts, input, rec, verdict }) {
  const fence = (o) => "```json\n" + JSON.stringify(o, null, 2) + "\n```";
  const response = { decided_by: rec.decided_by, band: rec.band, result: rec.result, request_id: rec.request_id };
  const body = [`${verdict} at ${facts.head}`, "",
    `<details><summary>Jev request (review.merge_gate)</summary>\n\n${fence(input)}\n</details>`, "",
    `<details><summary>Jev response</summary>\n\n${fence(response)}\n</details>`].join("\n");
  const comment = JSON.parse(execFileSync("gh", ["api", "-X", "POST", `repos/${facts.nwo}/issues/${facts.pr}/comments`, "--input", "-"],
    { input: JSON.stringify({ body }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }));
  if (!comment?.html_url) throw new Error("the PR comment was not created (no html_url)");
  const description = `Live Jev merge (act band); request ${rec.request_id ?? "?"}`.slice(0, 140);
  gh("api", "-X", "POST", `repos/${facts.nwo}/statuses/${facts.head}`, "-f", "state=success", "-f", `context=${facts.gateContext || GATE_CONTEXT}`,
    "-f", `description=${description}`, "-f", `target_url=${comment.html_url}`);
  return { commentUrl: comment.html_url };
}

// ---- The below-bar confirm (--confirm <comment-url>) ----------------------------------------------------------------
// Jev chose MERGE below the act bar with every checked gate green (exit 3, NEEDS CONFIRM): the integrator asks the
// other-family independent reviewer for a one-line exact-head "confirm <sha>". With --confirm <that comment's URL>
// the helper checks it and posts the gate's success status itself (operator 2026-10-04: integrators hit "branch policy
// blocks merge" after having to hand-post it). Never on HOLD, act-band PASS (that one posts already), fallback or error.
export const shouldConfirm = (rec, o) => o?.code === 3 && rec?.decided_by === "jev" && ["review", "uncertain"].includes(rec?.band)
  && rec?.result?.decision === "merge" && !rec?.stubbed;
// Pure: why a confirm comment can't stand for this PR and head (empty: it can). Its seat is the first word of its
// heading; it must be of a known family other than the author's, be on this PR, and have its own "confirm <full head
// sha>" line (not fenced or quoted) with no failing verdict.
// The seat: the heading's first word ("## review-kimi …"), or the one after "Reviewer:" ("Reviewer: arch-claude (Opus).
// **confirm <sha>.** Basis: …", the reviewers' usual layout). The confirm: "confirm <full sha>" opening one of its own
// lines or a sentence in one (bold is stripped), never inside a fence or quote; "cannot confirm …" is no confirm.
export function confirmProblems({ body, url, pr, head, authorFamily }) {
  const p = [], first = ownLines(body).find((l) => l) || "";
  const seat = (first.match(/^#*\s*(?:reviewer\s*:\s*)?([\w.-]+(?:@[\w.-]+)?)/i) || [])[1] || null, family = familyOf(seat);
  if (!new RegExp(`/pull/${pr}(?:[#/?]|$)`).test(String(url || ""))) p.push(`the confirm (${url}) is not on PR #${pr}`);
  if (!seat || !family) p.push(`its heading names no seat of a known family ("${first.slice(0, 60)}")`);
  if (!authorFamily) p.push("the author's family is unknown, so the confirm can't be verified as other-family (pass --author-family)");
  else if (family && family === authorFamily) p.push(`${seat} is of the author's family (${authorFamily})`);
  if (!ownLines(body).some((l) => new RegExp(`(?:^|[.:;]\\s+)confirm\\s+${String(head).toLowerCase()}(?![0-9a-f])`, "i").test(l))) p.push(`it has no line of its own reading "confirm ${head}"`);
  if (declarations(body).verdicts.some((v) => v !== "success")) p.push("it also declares a verdict that isn't success");
  return { seat, family, problems: p };
}
// The confirm comment (an issue comment or a PR review, by its URL).
export function readConfirm(nwo, pr, url) {
  const c = String(url).match(/#issuecomment-(\d+)$/), r = String(url).match(/#pullrequestreview-(\d+)$/);
  if (c) { const j = ghJson("api", `repos/${nwo}/issues/comments/${c[1]}`); return { body: j.body, url: j.html_url || url }; }
  if (r) { const j = ghJson("api", `repos/${nwo}/pulls/${pr}/reviews/${r[1]}`); return { body: j.body, url: j.html_url || url }; }
  throw new Error(`--confirm needs a PR comment or review URL (…#issuecomment-<id> or …#pullrequestreview-<id>), not ${url}`);
}
export function postConfirmStatus({ facts, rec, seat, url }) {
  const description = `Jev merge below confidence bar (${rec.request_id ?? "?"}); ${seat} confirmed at ${String(facts.head).slice(0, 7)}`.slice(0, 140);
  gh("api", "-X", "POST", `repos/${facts.nwo}/statuses/${facts.head}`, "-f", "state=success", "-f", `context=${facts.gateContext || GATE_CONTEXT}`,
    "-f", `description=${description}`, "-f", `target_url=${url}`);
  return { description };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agent-merge-evidence")) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const pr = a.find((x) => /^\d+$/.test(x));
  if (!pr) { console.error("usage: agent-merge-evidence <pr> [--repo o/r] [--mission M --slice S] [--change ...] [--deploy ...] [--rollback ...] [--config F] [--author-family claude|codex|kimi|grok] [--extra-evidence FILE] [--decide [--no-post] [--confirm <comment-url>]]"); process.exit(2); }
  // Extra evidence goes in through this flag, into input.review, so nobody hand-edits the printed JSON.
  let extraEvidence = null;
  if (a.includes("--extra-evidence")) {
    const file = flag("--extra-evidence");
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`agent-merge-evidence: --extra-evidence ${file}: ${e.code || e.message}`); process.exit(2); }
    if (!text.trim()) { console.error(`agent-merge-evidence: --extra-evidence ${file} is empty`); process.exit(2); }
    extraEvidence = { label: file.split("/").pop(), text };
  }
  if (a.includes("--decide")) {
    // Never ask Jev while GitHub is still computing mergeability (see awaitMergeable).
    const R = flag("--repo") ? ["-R", flag("--repo")] : [];
    // a poll interval must be positive (0 would poll forever); the wait may be 0 (one read, no polling)
    const env = (n, d, min0) => { const v = Number(process.env[n]); return process.env[n] && Number.isFinite(v) && (min0 ? v >= 0 : v > 0) ? v : d; };
    let m;
    try { m = await awaitMergeable({ read: () => ghJson("pr", "view", String(pr), ...R, "--json", "mergeable").mergeable,
      pollS: env("AGENT_MERGE_EVIDENCE_POLL_S", 5), maxS: env("AGENT_MERGE_EVIDENCE_MERGEABLE_WAIT_S", 90, true) }); }
    catch (e) { console.error(`agent-merge-evidence: ${e.message}`); process.exit(2); }
    if (m.value === "UNKNOWN") {
      console.error(`merge gate: NOT DECIDED (GitHub still reports mergeable UNKNOWN after ${m.waited}s: it is recomputing after a push or a base change). Jev was not asked; run the gate again in a minute.`);
      process.exit(4);
    }
  }
  let facts;
  try { facts = gather(pr, { repo: flag("--repo"), mission: flag("--mission"), slice: flag("--slice"), change: flag("--change"), deploy: flag("--deploy"), rollback: flag("--rollback"), configPath: flag("--config"), authorFamily: flag("--author-family") }); }
  catch (e) { console.error(`agent-merge-evidence: ${e.message}`); process.exit(2); }
  const input = buildMergeInput({ ...facts, extraEvidence });
  // Printed as { input, history }: `input` is exactly what Jev decides on; `history` (this gate's own earlier runs on
  // this head) is for people and must never be copied into an input. Same shape with --decide, plus the decision.
  const history = facts.gateHistory || [];
  if (!a.includes("--decide")) { console.log(JSON.stringify({ input, history }, null, 2)); process.exit(0); }
  if (facts.mergeable === "UNKNOWN") {   // it can flip back between the wait and the full read
    console.error("merge gate: NOT DECIDED (GitHub reports mergeable UNKNOWN again: it is recomputing). Jev was not asked; run the gate again in a minute.");
    process.exit(4);
  }
  const riskMissing = riskProblems(facts.risk);
  if (riskMissing.length) {   // a risky PR without its two reviews and the owner's OK is never sent to Jev
    console.error(`merge gate: HOLD (${facts.risk.tier === "risky" ? `risky tier: ${facts.risk.features.map((f) => f.id).join(", ")}` : "risk tier unknown"}). Jev was not asked.\n${riskMissing.join("\n")}`);
    process.exit(1);
  }
  const rec = await decideOrStub("review.merge_gate", input, { caller: process.env.OPENRIG_SESSION_NAME || "agent-merge-evidence" });
  console.log(JSON.stringify({ input, history, decision: { decided_by: rec.decided_by, band: rec.band, result: rec.result, request_id: rec.request_id, ...(rec.stubbed ? { stubbed: true } : {}) } }, null, 2));
  const o = outcome(rec, facts);
  console.error(o.text);
  if (shouldPost(rec, o)) {
    if (a.includes("--no-post")) console.error("merge gate: not posted (--no-post): no comment, no jev-merge status");
    else {
      try { const p = postGateResult({ facts, input, rec, verdict: o.text.split("\n", 1)[0] }); console.error(`merge gate: posted ${p.commentUrl} and the ${facts.gateContext || GATE_CONTEXT} success status on ${facts.head}`); }
      catch (e) { console.error(`merge gate: PASS but NOT POSTED (${String(e.stderr || e.message).trim().slice(0, 300)}). Post the comment and the ${facts.gateContext || GATE_CONTEXT} status by hand, or run again.`); process.exit(5); }
    }
  }
  if (a.includes("--confirm")) {
    const url = flag("--confirm");
    if (!shouldConfirm(rec, o)) console.error(`merge gate: --confirm ignored: it applies only to NEEDS CONFIRM (a live Jev merge below the act bar with every gate green), not to this result`);
    else {
      let c, v;
      try { c = readConfirm(facts.nwo, facts.pr, url); v = confirmProblems({ body: c.body, url: c.url, pr: facts.pr, head: facts.head, authorFamily: facts.authorFamily }); }
      catch (e) { console.error(`merge gate: NEEDS CONFIRM, the confirm couldn't be read: ${String(e.stderr || e.message).trim().slice(0, 300)}`); process.exit(3); }
      if (v.problems.length) { console.error(`merge gate: NEEDS CONFIRM, confirm not accepted:\n${v.problems.map((x) => `- ${x}`).join("\n")}`); process.exit(3); }
      if (a.includes("--no-post")) { console.error(`merge gate: confirm by ${v.seat} accepted; not posted (--no-post)`); process.exit(3); }
      try { const s = postConfirmStatus({ facts, rec, seat: v.seat, url: c.url }); console.error(`merge gate: PASS (Jev merge below the act bar; ${v.seat} confirmed at ${facts.head}); posted ${facts.gateContext || GATE_CONTEXT} success: "${s.description}"`); process.exit(0); }
      catch (e) { console.error(`merge gate: confirm accepted but NOT POSTED (${String(e.stderr || e.message).trim().slice(0, 300)}). Post the ${facts.gateContext || GATE_CONTEXT} status by hand, or run again.`); process.exit(5); }
    }
  }
  process.exit(o.code);
}
