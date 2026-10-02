// WO96 pilot (a project lead): `agent-dispatch review-plan --repo <path> --branch origin/agent/impl-grok-1` without --rig gave
// reviewer:null and cross_family:null; and `--repo owner/name` failed with no hint. The rig now defaults to the caller's,
// a remote prefix on the branch still names the author's seat, and a non-checkout --repo says what it wants. A fake
// repo, `rig` and proxy status; Jev stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "review-plan-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const sh = (cwd, ...a) => { const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const app = join(root, "app"); fs.mkdirSync(app);
sh(app, "init", "-q", "-b", "main"); fs.writeFileSync(join(app, "a.txt"), "a\n"); sh(app, "add", "."); sh(app, "commit", "-qm", "base");
sh(app, "checkout", "-qb", "agent/impl-grok-1"); fs.writeFileSync(join(app, "b.txt"), "b\n"); sh(app, "add", "."); sh(app, "commit", "-qm", "F-004 hide the empty table");
sh(app, "update-ref", "refs/remotes/origin/agent/impl-grok-1", "HEAD"); sh(app, "checkout", "-q", "main");
const bin = join(root, "bin"); fs.mkdirSync(bin);
const node = (id, rt, model) => ({ logicalId: id, canonicalSessionName: `${id.replace(".", "-")}@app`, runtime: rt, model, lifecycleState: "running",
  sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 0, pendingWorkCount: 0 });
fs.writeFileSync(join(root, "nodes.json"), JSON.stringify([node("review.grok", "terminal"), node("review.kimi", "claude-code", "kimi-k3-256k"),
  node("review.codex-1", "codex", "gpt-6.1-sol"), node("coord.lead-claude", "claude-code", "claude-opus-5-5")]));
fs.writeFileSync(join(bin, "rig"), `#!/bin/sh\ncase "$*" in "ps --nodes --rig app --json") cat "${join(root, "nodes.json")}" ;; *) echo '[]' ;; esac\n`, { mode: 0o755 });
fs.writeFileSync(join(bin, "agent-proxy-status"), `#!/bin/sh\necho '[{"provider":"claude","status":"active"},{"provider":"codex","status":"active"},{"provider":"kimi-ai","status":"active"}]'\n`, { mode: 0o755 });
fs.writeFileSync(join(root, "jev.json"), JSON.stringify({ "review.change_class": { decided_by: "jev", band: "act", result: { reviews: { security: "no" } } } }));
const plan = (args, seat = "coord-lead-claude@app") => spawnSync(process.execPath, [join(repoRoot, "orchestration/dispatch.js"), "review-plan", ...args], { encoding: "utf8",
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, AGENT_STACK_STATE: join(root, "state"), AGENT_JEV_STUB: join(root, "jev.json"), ...(seat ? { OPENRIG_SESSION_NAME: seat } : {}) } });

test("review-plan from a seat, no --rig, a remote branch: the seat's rig, the grok author's matrix (kimi first), never the author's seat", () => {
  const r = plan(["--repo", app, "--branch", "origin/agent/impl-grok-1"]);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.rig, "app");
  assert.equal(p.reviewer, "review-kimi@app"); assert.equal(p.cross_family, true);
  assert.deepEqual([p.reviewer_matrix.author_family, p.reviewer_matrix.order], ["grok", ["kimi", "codex", "claude"]]);
});

test("outside a seat and without --rig: no reviewer, and the plan says why; --rig still wins", () => {
  const none = JSON.parse(plan(["--repo", app, "--branch", "agent/impl-grok-1"], null).stdout);
  assert.equal(none.reviewer, null); assert.match(none.reviewer_note, /pass --rig/);
  assert.equal(JSON.parse(plan(["--repo", app, "--branch", "agent/impl-grok-1", "--rig", "app"], null).stdout).reviewer, "review-kimi@app");
});

test("--repo owner/name: refused with a hint that it wants a local path", () => {
  const r = plan(["--repo", "korallis/app", "--branch", "agent/impl-grok-1"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--repo korallis\/app: not a local checkout\. Give the repository's path on this machine/);
});

test("a remote prefix still names the author's seat: it never reviews its own branch, even as the only free reviewer", () => {
  const saved = fs.readFileSync(join(root, "nodes.json"), "utf8");
  const busy = (n) => ({ ...n, assignedWorkCount: 1 });
  fs.writeFileSync(join(root, "nodes.json"), JSON.stringify([busy(node("review.grok", "terminal")), busy(node("review.kimi", "claude-code", "kimi-k3-256k")),
    node("review.codex-1", "codex", "gpt-6.1-sol")]));
  try {
    sh(app, "update-ref", "refs/remotes/origin/agent/review-codex-1", "refs/heads/agent/impl-grok-1");
    const p = JSON.parse(plan(["--repo", app, "--branch", "origin/agent/review-codex-1"]).stdout);
    assert.equal(p.reviewer, null, "review-codex-1 wrote it");
  } finally { fs.writeFileSync(join(root, "nodes.json"), saved); }
});
