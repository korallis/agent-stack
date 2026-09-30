// agent-repos-sync per repo trunk (WO21): fetch origin <trunk>, fast-forward the checkout when it is on the trunk and
// clean; for trunk != main also move the main mirror (only one agent-stack created). Main-trunk repos: as before.
// Local git repos in a throwaway dir only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "reposync-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(join(root, ".gitconfig"), "[user]\n\tname = T\n\temail = t@example.com\n");
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, ".gitconfig") };
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env });
const sha = (cwd, ref) => git(cwd, "rev-parse", ref).stdout.trim();

function project(name, trunk) {
  const bare = join(root, `${name}.git`), seed = join(root, `${name}-seed`), r = join(root, name);
  git(root, "init", "-q", "--bare", "-b", trunk, bare); git(root, "init", "-q", "-b", trunk, seed);
  fs.writeFileSync(join(seed, "a"), "1"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "1");
  git(seed, "remote", "add", "origin", bare); git(seed, "push", "-q", "origin", trunk);
  git(root, "clone", "-q", bare, r);
  const advance = () => { fs.appendFileSync(join(seed, "a"), "+"); git(seed, "commit", "-qam", "more"); git(seed, "push", "-q", "origin", trunk); return sha(seed, "HEAD"); };
  return { r, advance };
}
const catalog = join(root, "workspace.yaml");
const sync = (...roots) => { fs.writeFileSync(catalog, "workspaces:\n" + roots.map((r) => `  - id: x\n    root: ${r}-work\n`).join(""));
  return spawnSync(join(repo, "system/agent-repos-sync"), [], { encoding: "utf8", env: { ...env, AGENT_CATALOG: catalog } }); };

test("master trunk: fast-forwards master and moves the main mirror; main is never checked out", () => {
  const p = project("fx", "master");
  git(p.r, "update-ref", "refs/heads/main", "origin/master"); git(p.r, "config", "agent-stack.mainMirror", "true");
  const head = p.advance();
  const r = sync(p.r);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sha(p.r, "master"), head);
  assert.equal(sha(p.r, "main"), head, "mirror moved");
  assert.equal(git(p.r, "branch", "--show-current").stdout.trim(), "master");
  assert.match(r.stdout, /main mirror at \w+/);
  assert.match(r.stdout, /master at \w+/);
});

test("the mirror moves even when the checkout is skipped (dirty or on another branch)", () => {
  const p = project("fy", "master");
  git(p.r, "update-ref", "refs/heads/main", "origin/master"); git(p.r, "config", "agent-stack.mainMirror", "true");
  git(p.r, "checkout", "-q", "-b", "wip");
  const head = p.advance();
  const r = sync(p.r);
  assert.match(r.stdout, /not on master, skipped/);
  assert.equal(sha(p.r, "main"), head);
});

test("a main agent-stack didn't create is never moved", () => {
  const p = project("fz", "master");
  git(p.r, "branch", "main");
  const before = sha(p.r, "main"); p.advance();
  const r = sync(p.r);
  assert.match(r.stdout, /trunk master, no main mirror \(run agent-project-new\)/);
  assert.equal(sha(p.r, "main"), before);
});

test("regression: a main-trunk repo is fast-forwarded as before, and nothing else happens", () => {
  const p = project("fm", "main");
  const head = p.advance();
  const r = sync(p.r);
  assert.equal(sha(p.r, "main"), head);
  assert.match(r.stdout, /main at \w+/);
  assert.doesNotMatch(r.stdout, /mirror/);
  assert.equal(git(p.r, "config", "agent-stack.mainMirror").status, 1);
});
