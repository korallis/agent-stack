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
    print(os.environ.get("FAKE_SHOW", "{}")); sys.exit(0)
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

function run(argv, { seat = "coord-lead@r", source = null, cwd = root, exit = 0, input } = {}) {
  fs.rmSync(log, { force: true });
  const r = spawnSync("python3", [helper, ...argv], {
    cwd, input, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir, OPENRIG_WORK_ROOT: work, OPENRIG_SESSION_NAME: seat,
      FAKE_LOG: log, FAKE_EXIT: String(exit), FAKE_SHOW: JSON.stringify(source ?? {}) },
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

process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
