// agent-claude-trust (WO22): Claude seats never stop on "Quick safety check: do you trust this folder?". A fixture
// ~/.claude.json in a throwaway HOME; the live ~/.claude.json is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "trust-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const conf = join(home, ".claude.json");
const env = { PATH: process.env.PATH, HOME: home };
const trust = (...a) => spawnSync(join(repo, "bin/agent-claude-trust"), a, { encoding: "utf8", env });
const wt = join(home, "wt"); for (const s of ["coord-lead-claude", "impl-claude-ui", "impl-codex-1", "qa-codex"]) fs.mkdirSync(join(wt, s), { recursive: true });
const spec = join(home, "rig.yaml");
fs.writeFileSync(spec, `name: t
pods:
  - id: coord
    members:
      - { id: lead-claude, runtime: claude-code, cwd: "${wt}/coord-lead-claude" }
  - id: impl
    members:
      - { id: claude-ui, runtime: claude-code, cwd: "${wt}/impl-claude-ui" }
      - { id: codex-1, runtime: codex, cwd: "${wt}/impl-codex-1" }
  - id: qa
    members:
      - { id: codex, runtime: codex, cwd: "${wt}/qa-codex" }
`);
const fixture = () => fs.writeFileSync(conf, JSON.stringify({ numStartups: 7, oauthAccount: { a: 1 },
  projects: { [join(wt, "coord-lead-claude")]: { hasTrustDialogAccepted: true, allowedTools: ["x"] }, "/other": { lastCost: 3 } } }), { mode: 0o600 });

test("--check lists only the untrusted Claude seats (Codex seats ignored) and exits 1", () => {
  fixture();
  const r = trust("--spec", spec, "--check", "--json");
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).untrusted.map((u) => u.seat), ["impl-claude-ui"]);
});

test("pre-trust writes the missing entries atomically and keeps every other key, mode and entry field", () => {
  fixture();
  const r = trust("--spec", spec);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^trusted impl-claude-ui: .*impl-claude-ui$/m);
  const c = JSON.parse(fs.readFileSync(conf, "utf8"));
  assert.equal(c.projects[join(wt, "impl-claude-ui")].hasTrustDialogAccepted, true);
  assert.deepEqual(c.projects[join(wt, "coord-lead-claude")], { hasTrustDialogAccepted: true, allowedTools: ["x"] });
  assert.deepEqual(c.projects["/other"], { lastCost: 3 });
  assert.equal(c.numStartups, 7); assert.deepEqual(c.oauthAccount, { a: 1 });
  assert.equal(c.projects[join(wt, "impl-codex-1")], undefined, "Codex seats aren't touched");
  assert.equal(fs.statSync(conf).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith(".claude.json.") && !f.endsWith(".lock")), [], "no temp file left");
  assert.equal(trust("--spec", spec, "--check").status, 0);
});

test("idempotent: a second run writes nothing (the file is not rewritten)", () => {
  fixture(); trust("--spec", spec);
  const m1 = fs.statSync(conf).mtimeMs, ino = fs.statSync(conf).ino;
  const r = trust("--spec", spec);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /all 2 trusted/);
  assert.equal(fs.statSync(conf).ino, ino); assert.equal(fs.statSync(conf).mtimeMs, m1);
});

test("--dry-run changes nothing; a path is keyed by its real path (symlinks resolved)", () => {
  fixture();
  const before = fs.readFileSync(conf, "utf8");
  assert.match(trust("--spec", spec, "--dry-run").stdout, /^would trust impl-claude-ui: /m);
  assert.equal(fs.readFileSync(conf, "utf8"), before);
  fs.symlinkSync(join(wt, "impl-claude-ui"), join(home, "link-ui"));
  assert.equal(trust(join(home, "link-ui")).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(conf, "utf8")).projects[join(wt, "impl-claude-ui")].hasTrustDialogAccepted, true);
});

test("concurrent runs for different seats never lose each other's entries (the lock)", async () => {
  fs.writeFileSync(conf, "{}", { mode: 0o600 });
  const dirs = Array.from({ length: 8 }, (_, i) => { const d = join(wt, `seat-${i}`); fs.mkdirSync(d, { recursive: true }); return d; });
  await Promise.all(dirs.map((d) => new Promise((res) => spawn(join(repo, "bin/agent-claude-trust"), [d], { env, stdio: "ignore" }).on("exit", res))));
  const pr = JSON.parse(fs.readFileSync(conf, "utf8")).projects;
  for (const d of dirs) assert.equal(pr[d]?.hasTrustDialogAccepted, true, d);
});

test("an unreadable (invalid JSON) config is never overwritten", () => {
  fs.writeFileSync(conf, "{ not json");
  const r = trust("--spec", spec);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not valid JSON .*not touching it/);
  assert.equal(fs.readFileSync(conf, "utf8"), "{ not json");
});

test("agent-never-prompt-check --spec FAILs an untrusted Claude seat with the fix, and OKs once trusted", () => {
  fixture();
  const chk = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-never-prompt-check"), "--spec", spec, "--json"], { encoding: "utf8", env }).stdout)
    .find((r) => r.check.startsWith("every Claude seat's worktree is trusted"));
  const bad = chk();
  assert.equal(bad.level, "FAIL");
  assert.equal(bad.detail, `untrusted: impl-claude-ui; fix: agent-claude-trust --spec ${spec}`);
  trust("--spec", spec);
  assert.equal(chk().level, "OK");
});

test("a spec without Claude seats needs nothing: exit 0, file untouched", () => {
  fixture(); const before = fs.readFileSync(conf, "utf8");
  const codexOnly = join(home, "codex.yaml");
  fs.writeFileSync(codexOnly, `name: c\npods:\n  - id: qa\n    members:\n      - { id: codex, runtime: codex, cwd: "${wt}/qa-codex" }\n`);
  for (const a of [["--check", "--json"], []]) assert.equal(trust("--spec", codexOnly, ...a).status, 0);
  assert.equal(fs.readFileSync(conf, "utf8"), before);
});

// QA round 1 (PR #24): Claude Code 2.1.284 locks its config with proper-lockfile: the directory `<config>.lock`. The
// helper must use that same lock: wait while a Claude writer holds it, never write through it, and only reclaim a lock
// that is stale by Claude's own rule (10 s).
test("a Claude writer holding the native lock: the helper waits, and the writer's changes survive (no lost update)", async () => {
  fs.writeFileSync(conf, JSON.stringify({ counter: 0, projects: {} }), { mode: 0o600 });
  const lock = conf + ".lock";
  // the "Claude" writer: takes the lock, then (still holding it) re-reads, bumps the counter and adds a key, and releases
  const writer = spawn(process.execPath, ["-e", `
    const fs = require("fs"); fs.mkdirSync(${JSON.stringify(lock)});
    const c = JSON.parse(fs.readFileSync(${JSON.stringify(conf)}, "utf8"));   // read under its lock, save later
    setTimeout(() => {
      c.counter = 1; c.outside_writer = "must survive";
      fs.writeFileSync(${JSON.stringify(conf)}, JSON.stringify(c));
      fs.rmdirSync(${JSON.stringify(lock)});
    }, 1200);`], { stdio: "ignore" });
  const writerDone = new Promise((r) => writer.on("exit", r));
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  const helper = await new Promise((res) => { const p = spawn(join(repo, "bin/agent-claude-trust"), [join(wt, "impl-claude-ui")], { env, stdio: ["ignore", "pipe", "pipe"] }); let e = ""; p.stderr.on("data", (d) => { e += d; }); p.on("exit", (code) => res({ code, e })); });
  await writerDone;
  assert.equal(helper.code, 0, helper.e);
  assert.ok(Date.now() - t0 >= 800, "it waited for the lock");
  const c = JSON.parse(fs.readFileSync(conf, "utf8"));
  assert.equal(c.counter, 1); assert.equal(c.outside_writer, "must survive");
  assert.equal(c.projects[join(wt, "impl-claude-ui")].hasTrustDialogAccepted, true);
  assert.equal(fs.existsSync(lock), false, "lock released");
});

test("a native lock held longer than the wait: nothing is written, exit 1, and the lock is not taken from its holder", () => {
  fixture(); const before = fs.readFileSync(conf, "utf8"); const lock = conf + ".lock";
  fs.mkdirSync(lock);
  try {
    const r = spawnSync(join(repo, "bin/agent-claude-trust"), ["--spec", spec], { encoding: "utf8", env: { ...env, AGENT_CLAUDE_TRUST_WAIT: "1" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\.claude\.json\.lock is held .*nothing written/);
    assert.equal(fs.readFileSync(conf, "utf8"), before);
    assert.ok(fs.existsSync(lock), "the holder's lock stays");
  } finally { fs.rmdirSync(lock); }
});

test("a stale native lock (unrefreshed for over 10 s) is reclaimed, as proper-lockfile does", () => {
  fixture(); const lock = conf + ".lock";
  fs.mkdirSync(lock); const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
  const r = trust("--spec", spec);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(conf, "utf8")).projects[join(wt, "impl-claude-ui")].hasTrustDialogAccepted, true);
  assert.equal(fs.existsSync(lock), false);
});

test("a lock that is fresh when first seen is never reclaimed, even if it ages past 10 s during the wait (fail closed)", () => {
  fixture(); const before = fs.readFileSync(conf, "utf8"); const lock = conf + ".lock";
  fs.mkdirSync(lock); const nine = new Date(Date.now() - 9000); fs.utimesSync(lock, nine, nine);   // stale 1 s into the wait
  try {
    const r = spawnSync(join(repo, "bin/agent-claude-trust"), ["--spec", spec], { encoding: "utf8", env: { ...env, AGENT_CLAUDE_TRUST_WAIT: "3" } });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(fs.readFileSync(conf, "utf8"), before);
    assert.ok(fs.existsSync(lock));
  } finally { fs.rmdirSync(lock); }
});
