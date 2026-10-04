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

// Pure: the PR a row is about and the head it names, from its text: "owner/repo#N" (or a /pull/N URL) wins over "PR #N".
export function prRef(text) {
  const t = String(text || "");
  const full = t.match(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/) || t.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  const bare = t.match(/\bPR\s*#?(\d+)\b/i);
  const head = t.match(/\b(?:exact[- ]head|head(?:\s+sha)?|at)\s*[:=]?\s*`?([0-9a-f]{7,40})\b/i);
  if (!full && !bare) return null;
  return { repo: full ? full[1] : null, pr: Number(full ? full[2] : bare[1]), head: head ? head[1].toLowerCase() : null };
}

// Pure: is a review row a refresh or delta of the original reviewer's own earlier review? Those stay with that family.
export const PRIOR_REVIEW = /\b(re-?review|refresh(ed)?\s+(review|qa)|delta\s+(review|qa)|review\s+(the\s+)?delta|follow-?up\s+review|re-?check|your\s+(prior|previous|earlier|last)\s+(review|verdict|findings?|block)|since\s+your\s+(review|block)|(answer|fix(es)?)\s+(to|for)\s+your\s+(review|findings?|block))\b/i;

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
