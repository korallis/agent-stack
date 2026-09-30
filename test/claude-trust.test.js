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
