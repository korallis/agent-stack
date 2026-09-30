// agent-project-new derives seats by ROLE from the team spec (WO20): the merge owner (agents/integrator) gets the merge
// sweep and judges proof; QA seats (agents/qa) judge proof however they are named; the lead (agents/lead). Plus the
// 'small' team template. Dry-run only, in a throwaway HOME with a stub rig: the live project is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "apn-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
fs.mkdirSync(join(home, "bin"));
fs.writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = T\n\temail = t@example.com\n");
fs.writeFileSync(join(home, "bin/rig"), `#!/bin/sh\necho "rig $*" >> "${home}/rig-calls"\ncase "$1 $2" in "watchdog list") echo "[]";; esac\nexit 0\n`, { mode: 0o755 });

function dry(team) {
  fs.rmSync(join(home, "rig-calls"), { force: true });
  const r = spawnSync(join(repo, "bin/agent-project-new"), ["--name", "Demo", "--rig", "demo", "--team", team, "--no-github", "--dry-run"],
    { encoding: "utf8", env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, USER: "t" } });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.replaceAll(home, "~");
  const judges = out.match(/proof judges \[([^\]]*)\]/)[1].split(", ");
  const merge = out.match(/merge owner (\S+),/)[1];
  const worktrees = out.split("\n").filter((l) => l.includes("would: git -C") && l.includes("worktree add")).map((l) => l.match(/Demo\.worktrees\/(\S+)/)[1]);
  const watchdogs = [...out.matchAll(/would: rig watchdog register --spec \S+\/(\S+\.yaml) --target-session (\S+)/g)].map((m) => `${m[1]} -> ${m[2]}`);
  return { out, judges, merge, worktrees, watchdogs, rigCalls: fs.existsSync(join(home, "rig-calls")) ? fs.readFileSync(join(home, "rig-calls"), "utf8") : "" };
}

test("--team small: 10 worktrees, merge sweep on integ-claude, judges [qa-codex, integ-claude, lead]", () => {
  const r = dry("small");
  assert.deepEqual(r.worktrees.sort(), ["arch-claude", "coord-lead-claude", "impl-claude-ui", "impl-codex-1", "integ-claude", "qa-codex",
    "review-claude", "review-codex", "review-kimi", "tests-claude"]);
  assert.equal(r.merge, "integ-claude");
  assert.deepEqual(r.judges, ["qa-codex@demo", "integ-claude@demo", "coord-lead-claude@demo"]);
  assert.deepEqual(r.watchdogs, ["merge-sweep.watchdog.yaml -> integ-claude@demo", "daily-summary.watchdog.yaml -> coord-lead-claude@demo"]);
  assert.doesNotMatch(r.rigCalls, /watchdog register|rig up|config set/, "dry run changes nothing");
});

test("build: corrected (merge owner integ-claude, qa-codex judges); core and full-stack unchanged", () => {
  const build = dry("build");
  assert.equal(build.merge, "integ-claude", "was integ-codex, a seat build.yaml doesn't have");
  assert.deepEqual(build.judges, ["qa-codex@demo", "integ-claude@demo", "coord-lead-claude@demo"], "qa-codex was missed by the qa-*-N pattern");
  assert.equal(build.worktrees.length, 14);
  const core = dry("core");
  assert.equal(core.merge, "integ-claude");
  assert.deepEqual(core.judges, ["integ-claude@demo", "coord-lead-claude@demo"]);
  assert.equal(core.worktrees.length, 4);
  const full = dry("full-stack");
  assert.equal(full.merge, "integ-codex");
  assert.deepEqual(full.judges, ["qa-codex-1@demo", "qa-codex-2@demo", "qa-codex-3@demo", "integ-codex@demo", "coord-lead-claude@demo"]);
  assert.equal(full.worktrees.length, 27);
});

test("small.yaml is build.yaml minus impl.codex-2/-3, impl.astra and tests.codex, with the same policy and startup", () => {
  const seats = (t) => [...fs.readFileSync(join(repo, `rig/template/${t}.yaml`), "utf8").matchAll(/cwd: "@WT@\/([^"]+)"/g)].map((m) => m[1]).sort();
  const small = seats("small"), build = seats("build");
  assert.equal(small.length, 10);
  assert.deepEqual(build.filter((s) => !small.includes(s)).sort(), ["impl-astra", "impl-codex-2", "impl-codex-3", "tests-codex"]);
  const t = fs.readFileSync(join(repo, "rig/template/small.yaml"), "utf8");
  for (const line of ["permission_policy: builtin:yolo", "culture_file: CULTURE.md", "path: startup/context.md"]) assert.ok(t.includes(line), line);
  assert.doesNotMatch(t, /impl\.codex-2|impl\.codex-3|impl\.astra|tests\.codex/, "no edges to removed seats");
  assert.match(fs.readFileSync(join(repo, "bin/agent-project-new"), "utf8"), /--team full-stack\|build\|small\|core/);
});
