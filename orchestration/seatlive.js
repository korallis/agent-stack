// What a seat is really doing right now, for agent-reroute (2026-10-04): OpenRig's node.model is the spec's launch
// model, so a seat switched with /model (a reviewer moved from one Claude model to another) was judged on the old model's
// cooldown and its rows moved to another family. Here: the live model from the seat's own Claude Code transcript, and
// whether a row still points at an open PR and its current head.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, cwd) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, cwd }); } catch { return null; } };

// seat (tmux session name) -> its pane's current directory. Seats run in tmux sessions named after them.
export function paneDirs() {
  const out = run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"]) || "";
  const m = new Map();
  for (const l of out.split("\n")) { const [s, d] = l.split("\t"); if (s && d && !m.has(s)) m.set(s, d); }
  return m;
}

// Pure: the live model in transcript lines (oldest first): the latest of a /model switch that Claude Code confirmed
// ("Set model to") and a real assistant turn's model ("<synthetic>" turns are local errors, never a model). null if none.
export function modelFromTranscript(lines) {
  let model = null, pending = null;
  for (const line of lines) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    const msg = m.message || {};
    if (m.type === "assistant" && msg.model && msg.model !== "<synthetic>") { model = msg.model; pending = null; continue; }
    const c = typeof msg.content === "string" ? msg.content : "";
    const cmd = c.match(/<command-name>\/model<\/command-name>[\s\S]*?<command-args>\s*([^<\s]+)\s*<\/command-args>/);
    if (cmd) { pending = cmd[1]; if (/Set model to/.test(c)) { model = pending; pending = null; } continue; }
    if (pending && /<local-command-stdout>[\s\S]*Set model to/.test(c)) { model = pending; pending = null; }
  }
  return model;
}

// The live model of the Claude Code session running in dir: its newest transcript's last 4 MB. null when unknown.
export function liveModel(dir, { projects = process.env.AGENT_CLAUDE_PROJECTS || join(homedir(), ".claude/projects"), tailBytes = 4 << 20 } = {}) {
  if (!dir) return null;
  const pdir = join(projects, dir.replace(/[^A-Za-z0-9]/g, "-"));
  let files;
  try { files = readdirSync(pdir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, t: statSync(join(pdir, f)).mtimeMs })); } catch { return null; }
  if (!files.length) return null;
  const newest = join(pdir, files.sort((a, b) => b.t - a.t)[0].f);
  const size = statSync(newest).size, len = Math.min(size, tailBytes), buf = Buffer.alloc(len), fd = openSync(newest, "r");
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (size > len) lines.shift();   // a partial first line
  return modelFromTranscript(lines);
}

// Pure: the PR a row is about and the head it names. The CURRENT ones (QA PR173): the first PR reference in the text
// (owner/repo#N, a /pull/N URL or "PR #N", whichever comes first) and the first head sha that isn't marked as a past one
// ("previous head", "old head", "was", "superseded", "instead of" just before it). A bare PR number takes the
// repository of a full reference to the same number, if the row has one.
const PAST = /\b(previous(ly)?|prior|old|earlier|former(ly)?|was|were|superseded|replaced|instead\s+of|before)\b[^.;\n]{0,24}$/i;
export function prRef(text) {
  const t = String(text || "");
  const refs = [];
  for (const m of t.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) refs.push({ at: m.index, repo: m[1], pr: Number(m[2]) });
  for (const m of t.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) refs.push({ at: m.index, repo: m[1], pr: Number(m[2]) });
  for (const m of t.matchAll(/\bPR\s*#?(\d+)\b/gi)) refs.push({ at: m.index, repo: null, pr: Number(m[1]) });
  const current = refs.sort((a, b) => a.at - b.at).find((r) => !PAST.test(t.slice(Math.max(0, r.at - 40), r.at)));
  if (!current) return null;
  const repo = current.repo || refs.find((r) => r.repo && r.pr === current.pr)?.repo || null;
  let head = null;
  for (const m of t.matchAll(/\b(?:exact[- ]head|current[- ]head|new[- ]head|head(?:\s+sha)?|at)\s*[:=]?\s*`?([0-9a-f]{7,40})\b/gi)) {
    if (PAST.test(t.slice(Math.max(0, m.index - 40), m.index + m[0].length - m[1].length))) continue;
    head = m[1].toLowerCase(); break;
  }
  return { repo, pr: current.pr, head };
}

// Pure: is a review row a refresh or delta of the original reviewer's own earlier review? Those stay with that family.
// Positive wording only (QA PR173): a refresh/delta/re-review of a review or QA, or a reference to "your" earlier
// review; a negated phrase ("not a re-review", "no delta review") doesn't count, and neither does a plain "re-check CI".
const PRIOR = [
  /\b(qa|review)[- ]refresh\b/gi, /\brefresh(ed)?[- ](review|qa)\b/gi, /\bdelta[- ](review|qa)\b/gi, /\b(review|qa)[- ]delta\b/gi,
  /\breview\s+(of\s+)?the\s+delta\b/gi, /\bre-?review\b/gi, /\bfollow-?up\s+review\b/gi,
  /\byour\s+(prior|previous|earlier|last|own)\s+(review|verdict|findings?|block)\b/gi, /\bsince\s+your\s+(review|block|findings?)\b/gi,
  /\b(answer|fix(es)?|response)\s+(to|for)\s+your\s+(review|findings?|block)\b/gi,
  /\bre-?check\s+(your|the)\s+(own\s+)?(review|findings?|block)\b/gi,
];
const NEGATED = /\b(not|no|isn'?t|never|without|nor)\s+(an?\s+|the\s+)?$/i;
export function isPriorReview(text) {
  const t = String(text || "");
  return PRIOR.some((re) => [...t.matchAll(re)].some((m) => !NEGATED.test(t.slice(Math.max(0, m.index - 16), m.index))));
}

// The repo of the checkout in dir ("owner/name" from its origin remote), or null.
export function repoOf(dir) {
  const url = dir && run("git", ["remote", "get-url", "origin"], dir);
  const m = url && url.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// Why a row is no longer actionable (its PR merged or closed, or its named head moved), or null when it still is or
// names no PR. A PR that can't be read is reported as such: the caller leaves the row rather than guessing.
export function staleReason(ref, { repo, ghView = (r, n) => { const o = run("gh", ["pr", "view", String(n), "-R", r, "--json", "state,headRefOid"]); return o ? JSON.parse(o) : null; } } = {}) {
  if (!ref) return null;
  const r = ref.repo || repo;
  if (!r) return `its PR #${ref.pr}'s repository is unknown, so whether it is still open can't be checked`;
  const v = ghView(r, ref.pr);
  if (!v) return `${r}#${ref.pr} couldn't be read, so whether it is still open can't be checked`;
  if (v.state !== "OPEN") return `${r}#${ref.pr} is ${String(v.state).toLowerCase()}`;
  if (ref.head && !String(v.headRefOid || "").toLowerCase().startsWith(ref.head)) return `${r}#${ref.pr}'s head moved (the row names ${ref.head}, the PR is at ${String(v.headRefOid).slice(0, 12)})`;
  return null;
}

// Who already reviewed this PR's exact head (2026-10-04: a third-family review row was rerouted to the PRIMARY
// reviewer of that head). Seats from the independent-review statuses on the head (the description's first word),
// "## review-<seat>" PR comments that name the head, and GitHub reviews on the head commit (the seat from the body's
// first line). Any verdict counts: a seat that blocked the head has reviewed it too. Families from the seat names.
// null when the PR or its head can't be read (callers leave the row rather than guess).
const FAMILY = (seat) => /claude|fable|opus|sonnet/i.test(seat) ? "claude" : /codex|gpt/i.test(seat) ? "codex" : /kimi/i.test(seat) ? "kimi" : /grok/i.test(seat) ? "grok" : null;
export function reviewersFrom({ head, statuses = [], comments = [], reviews = [] }) {
  const h = String(head || "").toLowerCase(), seats = new Set();
  const namesHead = (text) => (String(text || "").match(/\b[0-9a-f]{7,40}\b/gi) || []).some((x) => h.startsWith(x.toLowerCase()));
  for (const s of statuses) if (s.context === "independent-review") { const m = String(s.description || "").match(/^\s*([\w.-]+)/); if (m && /^(review|arch|qa)-/i.test(m[1])) seats.add(m[1].toLowerCase()); }
  for (const c of comments) { const m = String(c.body || "").match(/^#*\s*(?:reviewer\s*:\s*)?((?:review|arch)-[\w.-]+)/i); if (m && namesHead(c.body)) seats.add(m[1].toLowerCase()); }
  for (const r of reviews) { if (String(r.commit_id || "").toLowerCase() !== h) continue; const m = String(r.body || "").match(/^#*\s*(?:reviewer\s*:\s*)?((?:review|arch)-[\w.-]+)/i); if (m) seats.add(m[1].toLowerCase()); }
  return { seats, families: new Set([...seats].map(FAMILY).filter(Boolean)) };
}
export function headReviewers(ref, { repo } = {}) {
  const r = ref?.repo || repo;
  if (!ref || !r) return null;
  const j = (args) => { const o = run("gh", args); try { return o ? JSON.parse(o) : null; } catch { return null; } };
  const pr = j(["pr", "view", String(ref.pr), "-R", r, "--json", "headRefOid"]);
  const head = ref.head || pr?.headRefOid;
  if (!head) return null;
  const full = pr?.headRefOid && pr.headRefOid.toLowerCase().startsWith(head.toLowerCase()) ? pr.headRefOid : head;
  const pages = (path) => { const o = run("gh", ["api", path, "--paginate", "--slurp"]); try { const v = o ? JSON.parse(o) : null; return Array.isArray(v) ? v.flat() : null; } catch { return null; } };
  const statuses = pages(`repos/${r}/commits/${full}/statuses?per_page=100`), comments = pages(`repos/${r}/issues/${ref.pr}/comments?per_page=100`), reviews = pages(`repos/${r}/pulls/${ref.pr}/reviews?per_page=100`);
  if (!statuses || !comments || !reviews) return null;
  return { head: full, ...reviewersFrom({ head: full, statuses, comments, reviews }) };
}

// Pure: a review row that must come from a family that hasn't reviewed the head yet (the third, independent review).
export const isThirdFamilyReview = (text) => /\b(third[- ](family|review|reviewer)|other[- ]family\s+review|independent\s+third|kimi\s+third)\b/i.test(String(text || ""));
