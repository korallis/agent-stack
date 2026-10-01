// system/seat-tools-rig, run for real against a fake ~/.local/bin/rig: handoff tag carry-forward (A), candidate:
// provenance (B), and no temp body files plus exit-code propagation (C).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "system/seat-tools-rig");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "seatrig-"));
const home = join(root, "home"), tmpdir = join(root, "tmp"), log = join(root, "calls.jsonl");
const work = join(home, "Projects/p-work"), trees = join(home, "Projects/p.worktrees");
fs.mkdirSync(join(home, ".local/bin"), { recursive: true }); fs.mkdirSync(tmpdir); fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(join(work, "workspace.yaml"), "projects:\n  - id: p\n    root: ../p\n");
// The fake rig records each call (argv, and the body when it is piped on stdin) and serves `queue show`.
fs.writeFileSync(join(home, ".local/bin/rig"), `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
if a[:2] == ["queue", "show"]:
    print(os.environ.get("FAKE_SHOW", "{}")); sys.exit(int(os.environ.get("FAKE_SHOW_EXIT", "0")))
stdin = sys.stdin.read() if "-" in a and "--body-file" in a else None
open(os.environ["FAKE_LOG"], "a").write(json.dumps({"argv": a, "stdin": stdin}) + "\\n")
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
`, { mode: 0o755 });

const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
function worktree(member, branch) {
  const dir = join(trees, member);
  fs.mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", branch);
  g(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c");
  return { dir, sha: g(dir, "rev-parse", "HEAD") };
}
const elsewhere = join(root, "other-repo");
fs.mkdirSync(elsewhere); g(elsewhere, "init", "-q"); g(elsewhere, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");

function run(argv, { seat = "coord-lead@r", source = null, cwd = root, exit = 0, input, showExit = 0 } = {}) {
  fs.rmSync(log, { force: true });
  const r = spawnSync("python3", [helper, ...argv], {
    cwd, input, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir, OPENRIG_WORK_ROOT: work, OPENRIG_SESSION_NAME: seat,
      FAKE_LOG: log, FAKE_EXIT: String(exit), FAKE_SHOW_EXIT: String(showExit), FAKE_SHOW: JSON.stringify(source ?? {}) },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const call = calls.at(-1);
  const i = call?.argv.findIndex(a => a === "--tags" || a.startsWith("--tags=")) ?? -1;
  const value = i < 0 ? null : call.argv[i] === "--tags" ? call.argv[i + 1] : call.argv[i].slice("--tags=".length);
  return { status: r.status, stderr: r.stderr, call, tags: value === null ? null : value.split(",") };
}
const row = (tags, body = "do the thing") => ({ qitemId: "q1", tags, body });

test("A: a handoff without --tags keeps every source tag, adding project: only if missing", () => {
  const r = run(["queue", "handoff", "q1", "--to", "qa@r"], { source: row(["mission:m0", "slice:01-t001", "bug", "project:p"]) });
  assert.deepEqual(r.tags, ["mission:m0", "slice:01-t001", "bug", "project:p"]);
  const r2 = run(["queue", "handoff-and-complete", "q1", "--to", "qa@r"], { source: row(["mission:m0", "slice:01-t001"]) });
  assert.deepEqual(r2.tags, ["mission:m0", "slice:01-t001", "project:p"]);
});

test("A: caller --tags still carries the source mission:/slice: unless the caller set their own", () => {
  const r = run(["queue", "handoff", "q1", "--to", "qa@r", "--tags", "review"], { source: row(["mission:m0", "slice:01-t001", "bug"]) });
  assert.deepEqual(r.tags, ["review", "mission:m0", "slice:01-t001", "project:p"]);
  const r2 = run(["queue", "handoff", "q1", "--to", "qa@r", "--tags=slice:02-t002"], { source: row(["mission:m0", "slice:01-t001"]) });
  assert.deepEqual(r2.tags, ["slice:02-t002", "mission:m0", "project:p"]);
});

test("A: the qitem id is found wherever it sits among the options", () => {
  const r = run(["queue", "handoff", "--to", "qa@r", "--note", "n", "q1"], { source: row(["mission:m0", "slice:01-t001"]) });
  assert.deepEqual(r.tags, ["mission:m0", "slice:01-t001", "project:p"]);
});

test("A: when the source row can't be read, no --tags is sent, so OpenRig still inherits the source's tags", () => {
  const r = run(["queue", "handoff", "q1", "--to", "qa@r"], { source: row(["mission:m0"]), showExit: 1 });
  assert.equal(r.tags, null);
  assert.match(r.stderr, /could not read q1/);
});

test("B: a handoff keeps the source row's candidate instead of reading whatever HEAD is checked out", () => {
  const { dir } = worktree("impl-a", "slice-01-t001");
  const r = run(["queue", "handoff", "q1", "--to", "qa@r"], { seat: "impl-a@r", cwd: dir, source: row(["slice:01-t001", "candidate:abc123"]) });
  assert.deepEqual(r.tags.filter(t => t.startsWith("candidate:")), ["candidate:abc123"]);
});

test("B: HEAD becomes the candidate only in the seat's own worktree on the row's slice branch", () => {
  const { dir, sha } = worktree("impl-b", "feat/01-t001-login");
  const own = run(["queue", "handoff", "q1", "--to", "qa@r"], { seat: "impl-b@r", cwd: dir, source: row(["slice:01-t001"]) });
  assert.ok(own.tags.includes(`candidate:${sha}`));
  const other = run(["queue", "handoff", "q1", "--to", "qa@r"], { seat: "impl-b@r", cwd: elsewhere, source: row(["slice:01-t001"]) });
  assert.ok(!other.tags.some(t => t.startsWith("candidate:")));
  assert.match(other.stderr, /no candidate: tag.*own worktree/);
  const wrongSlice = run(["queue", "handoff", "q1", "--to", "qa@r"], { seat: "impl-b@r", cwd: dir, source: row(["slice:02-t002"]) });
  assert.ok(!wrongSlice.tags.some(t => t.startsWith("candidate:")));
  assert.match(wrongSlice.stderr, /not slice 02-t002/);
  const lookalike = worktree("impl-c", "feat/01-t0010-other");
  const near = run(["queue", "handoff", "q1", "--to", "qa@r"], { seat: "impl-c@r", cwd: lookalike.dir, source: row(["slice:01-t001"]) });
  assert.ok(!near.tags.some(t => t.startsWith("candidate:")), "01-t0010 is not slice 01-t001");
  const create = run(["queue", "create", "--destination", "qa@r", "--body", "x"], { seat: "impl-b@r", cwd: dir });
  assert.ok(create.tags.includes(`candidate:${sha}`));
});

test("C: a rewritten body is piped on stdin, leaves no temp files, and rig's exit code is propagated", () => {
  worktree("dev-qa", "main");
  const kept = run(["queue", "handoff", "q1", "--to", "dev-qa@r"], { source: row(["slice:01-t001"], "original body"), exit: 3 });
  assert.equal(kept.status, 3);
  assert.deepEqual(kept.call.argv.slice(-2), ["--body-file", "-"]);
  assert.equal(kept.call.stdin, `original body\n\nworktree_path=${join(trees, "dev-qa")}\n`);
  const piped = run(["queue", "create", "--destination", "dev-qa@r", "--body", "-"], { input: "from stdin\n" });
  assert.equal(piped.status, 0);
  assert.match(piped.call.stdin, /^from stdin\n\nworktree_path=/);
  const file = join(root, "body.md"); fs.writeFileSync(file, "from file\nworktree_path=/already/here\n");
  const fromFile = run(["queue", "create", "--destination", "dev-qa@r", "--body-file", file]);
  assert.equal(fromFile.call.stdin, "from file\nworktree_path=/already/here\n");
  assert.deepEqual(fs.readdirSync(tmpdir), []);
});

test("other commands pass straight through with their exit code", () => {
  const r = run(["queue", "claim", "q1"], { exit: 5 });
  assert.equal(r.status, 5);
  assert.deepEqual(r.call.argv, ["queue", "claim", "q1"]);
});

// WO70: OpenRig posts a row's summary as the Slack message's bold subject ("(no summary)" without one).
const flag = (call, name) => { const i = call.argv.indexOf(name); return i < 0 ? null : call.argv[i + 1]; };

test("D: a row to a human without --summary gets the body's first line, markdown stripped", () => {
  const r = run(["queue", "create", "--destination", "owner@external", "--body", "\n## Ready: **login** works on [staging](https://x.example)\nmore detail"]);
  assert.equal(flag(r.call, "--summary"), "Ready: login works on staging");
  assert.match(r.stderr, /a row to owner@external needs a subject; --summary "Ready: login works on staging"/);
  assert.equal(flag(r.call, "--body"), "\n## Ready: **login** works on [staging](https://x.example)\nmore detail", "body untouched");
});

test("D: skips markdown-only lines, keeps snake_case and code text, caps at 80 characters", () => {
  const cases = [
    ["---\n```\n- [x] `files_write` *now* on _staging_\n", "files_write now on staging"],
    ["> 1. Decision needed: merge PR #12?", "Decision needed: merge PR #12?"],
    ["   \n\n" + "word ".repeat(30), "word ".repeat(16).slice(0, 79).trimEnd() + "…"],
  ];
  for (const [body, want] of cases) {
    const got = flag(run(["queue", "create", "--destination", "owner@external", "--body", body]).call, "--summary");
    assert.equal(got, want); assert.ok(got.length <= 80);
  }
});

test("D: an explicit --summary is never changed; a seat destination gets none added", () => {
  for (const s of [["--summary", "Mine"], ["--summary=Mine"]]) {
    const r = run(["queue", "create", "--destination", "owner@external", ...s, "--body", "# Other"]);
    assert.ok(r.call.argv.includes("Mine") || r.call.argv.includes("--summary=Mine"), r.call.argv.join(" "));
    assert.equal(r.call.argv.filter((a) => a.startsWith("--summary")).length, 1);
  }
  const seat = run(["queue", "create", "--destination", "dev-qa@r", "--body", "# Title"]);
  assert.equal(flag(seat.call, "--summary"), null);
});

test("D: a stdin or file body gives the subject and is passed on unchanged", () => {
  const piped = run(["queue", "create", "--destination", "owner@external", "--body-file", "-"], { input: "Proof: checkout works\n\nsteps\n" });
  assert.equal(flag(piped.call, "--summary"), "Proof: checkout works");
  assert.equal(piped.call.stdin, "Proof: checkout works\n\nsteps\n");
  const f = join(root, "body.md"); fs.writeFileSync(f, "\n**Wave 2 witnessed**\n");
  const fromFile = run(["queue", "create", "--destination", "owner@external", "--body-file", f]);
  assert.equal(flag(fromFile.call, "--summary"), "Wave 2 witnessed"); assert.equal(flag(fromFile.call, "--body-file"), f);
});

test("D: a handoff to a human keeps the source row's summary, else derives one from its body", () => {
  const kept = run(["queue", "handoff", "q1", "--to", "owner@external"], { source: { qitemId: "q1", tags: [], summary: "Original subject", body: "# Other" } });
  assert.equal(flag(kept.call, "--summary"), "Original subject");
  const derived = run(["queue", "handoff", "q1", "--to", "owner@external"], { source: { qitemId: "q1", tags: [], body: "Please approve the plan\nx" } });
  assert.equal(flag(derived.call, "--summary"), "Please approve the plan");
});

test("D: no body and no summary: nothing invented, the gap is said", () => {
  const r = run(["queue", "create", "--destination", "owner@external"]);
  assert.equal(flag(r.call, "--summary"), null);
  assert.match(r.stderr, /has no --summary and no body line to take one from; Slack will show "\(no summary\)"/);
});

test("D: outside a seat (no OpenRig env) a create to a human still gets its subject, and nothing seat-specific", () => {
  fs.rmSync(log, { force: true });
  const r = spawnSync("python3", [helper, "queue", "create", "--destination", "owner@external", "--body", "Operator: upgrade done"], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir, FAKE_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  const call = JSON.parse(fs.readFileSync(log, "utf8").trim());
  assert.deepEqual(call.argv, ["queue", "create", "--destination", "owner@external", "--body", "Operator: upgrade done", "--summary", "Operator: upgrade done"]);
});

test("D: the ~/.local/bin/rig launcher install.sh writes sends create through the helper everywhere, handoffs only in a seat", () => {
  const line = fs.readFileSync(join(dirname(helper), "..", "install.sh"), "utf8").split("\n").find((l) => /^\s*printf '#!\/usr\/bin\/env bash\\n.*seat-tools\/rig/.test(l));
  assert.ok(line, "launcher printf found");
  const L = join(root, "launch"), B = join(L, "bin");
  fs.mkdirSync(join(L, "seat-tools"), { recursive: true }); fs.mkdirSync(join(L, "openrig/bin"), { recursive: true }); fs.mkdirSync(B, { recursive: true });
  fs.writeFileSync(join(L, "seat-tools/rig"), "#!/bin/sh\necho helper \"$@\"\n", { mode: 0o755 });
  fs.writeFileSync(join(L, "openrig/bin/rig"), "#!/bin/sh\necho real \"$@\"\n", { mode: 0o755 });
  const w = spawnSync("bash", ["-c", `L=${L}; B=${B}; node22=/nonexistent; ${line.trim()}`], { encoding: "utf8" });
  assert.equal(w.status, 0, w.stderr);
  const launch = (env, ...a) => spawnSync(join(B, "rig"), a, { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).stdout.trim();
  assert.equal(launch({}, "queue", "create", "--destination", "x@external"), "helper queue create --destination x@external");
  assert.equal(launch({}, "queue", "handoff", "q1"), "real queue handoff q1");
  assert.equal(launch({ OPENRIG_NODE_ID: "n1" }, "queue", "handoff", "q1"), "helper queue handoff q1");
  assert.equal(launch({ OPENRIG_NODE_ID: "n1" }, "queue", "show", "q1"), "real queue show q1");
  assert.equal(launch({ AGENT_STACK_RIG_HELPER: "1" }, "queue", "create"), "real queue create", "the helper's own call never loops");
});

test("D: CULTURE, the agent-stack skill and the kernel operator's guidance say: always give a human row a short subject", () => {
  const repo = join(dirname(helper), "..");
  const flat = (p) => fs.readFileSync(join(repo, p), "utf8").replace(/\s+/g, " ");
  assert.match(flat("rig/template/CULTURE.md"), /Every row to a human \(the owner, any `\*@external`\) gets a short subject: `--summary/);
  assert.match(flat("skills/agent-stack/SKILL.md"), /every row to a human \(`\*@external`\) gets a short `--summary`/);
  assert.match(flat("system/operator-guidance"), /Give every row to a human \(`\*@external`\) a short subject: `--summary/);
});

process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
