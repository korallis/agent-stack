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
    { encoding: "utf8", env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, USER: "t", OPENRIG_URL: "http://127.0.0.1:9" } });
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
  assert.match(fs.readFileSync(join(repo, "bin/agent-project-new"), "utf8"), /--team standard\|full-stack\|build\|small\|core/);
});

// ---- WO21: an EXISTING repo whose trunk isn't main (shop-app: master) ---------------------------------------------
// Real runs in a throwaway HOME on local git repos only: a bare "origin" plus a clone as the project, stub rig and gh (the
// stub `rig config get` already lists the roots, so agent-project-new never cycles the daemon). Never GitHub, never the live
// project.
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } });
function existingRepo(name, trunk) {
  fs.mkdirSync(join(home, "Projects/openrig-workspace"), { recursive: true });
  if (!fs.existsSync(join(home, "Projects/openrig-workspace/workspace.yaml"))) fs.writeFileSync(join(home, "Projects/openrig-workspace/workspace.yaml"), "workspaces:\n");
  const base = fs.mkdtempSync(join(home, "src-")), bare = join(base, "origin.git"), seed = join(base, "seed");
  git(base, "init", "-q", "--bare", "-b", trunk, bare);
  git(base, "init", "-q", "-b", trunk, seed);
  fs.writeFileSync(join(seed, "README.md"), "# app\n"); fs.writeFileSync(join(seed, "AGENTS.md"), "# app's own agents\n");
  fs.writeFileSync(join(seed, ".gitignore"), ".env*\n");
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "app"); git(seed, "remote", "add", "origin", bare); git(seed, "push", "-q", "origin", trunk);
  const proj = join(home, "Projects", name);
  fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(join(home, "Projects", `${name}.worktrees`), { recursive: true, force: true });
  fs.rmSync(join(home, "Projects", `${name}-work`), { recursive: true, force: true });
  git(home, "clone", "-q", bare, proj);
  return { proj, bare, seed };
}
function realRun(name, rig, extra = [], ghMode = "ruleset", env = {}) {
  // ghMode: ruleset (rules exist), none (a confirmed 404 and no rules), 503 (both reads fail)
  const W = join(home, "Projects", `${name}-work`);
  fs.writeFileSync(join(home, "bin/rig"), `#!/bin/bash
echo "rig $*" >> "${home}/rig-calls"
case "$1 $2" in
  "config get") echo "${rig}:${W}" ;;
  "config init-workspace") mkdir -p "$4"; printf 'kind: project\\ninstall:\\n  context: []\\n' > "$4/project.yaml"; printf 'workspaces:\\n  - id: default\\n' > "$4/workspace.yaml" ;;
  "watchdog list") echo "[]" ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(join(home, "bin/gh"), `#!/bin/bash
echo "gh $*" >> "${home}/gh-calls"
case "$*" in
  *"-X PUT"*|*"label create"*) exit 0 ;;
  *"/protection"*) [ "${ghMode}" = 503 ] && { echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1; }; echo "gh: Branch not protected (HTTP 404)" >&2; exit 1 ;;
  *"/rules/branches/"*) [ "${ghMode}" = 503 ] && { echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1; }; [ "${ghMode}" = ruleset ] && echo "deletion, non_fast_forward, pull_request, required_status_checks"; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
  for (const f of ["rig-calls", "gh-calls"]) fs.rmSync(join(home, f), { force: true });
  const r = spawnSync(join(repo, "bin/agent-project-new"), ["--name", name, "--rig", rig, "--github", "korallis", "--team", "small", "--no-up", "--no-deps", ...extra],
    { encoding: "utf8", env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, USER: "t", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), OPENRIG_URL: "http://127.0.0.1:9", ...env } });
  return { ...r, W, gh: fs.existsSync(join(home, "gh-calls")) ? fs.readFileSync(join(home, "gh-calls"), "utf8") : "" };
}

test("existing master-trunk repo: dry run names the trunk, the mirror and the kit's new home, and changes nothing", () => {
  const { proj } = existingRepo("shop-dry", "master");
  const before = git(proj, "status", "--porcelain").stdout;
  const r = realRun("shop-dry", "fdry", ["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /repo .*shop-dry \(existing, trunk master: adopted as is; starter kit goes to .*shop-dry-work\/starter-kit\)/);
  assert.match(r.stdout, /would: set refs\/heads\/main := origin\/master/);
  assert.match(r.stdout, /worktrees .* \(one per seat, from origin\/master\)/);
  assert.equal((r.stdout.match(/would: git -C \S+ worktree add -q (--no-track \S+ -b agent\/\S+|--detach \S+) origin\/master/g) || []).length, 10);
  assert.equal(git(proj, "status", "--porcelain").stdout, before);
  assert.equal(git(proj, "rev-parse", "-q", "--verify", "refs/heads/main").status, 1, "no mirror in a dry run");
});

test("existing master-trunk repo, real run: mirror main, pre-push guard, worktrees from origin/master, kit in the workspace, .env.local linked, ruleset kept", () => {
  const { proj } = existingRepo("shop-real", "master");
  fs.writeFileSync(join(proj, ".env.local"), "DATABASE_URL=postgres://dev\n");
  fs.writeFileSync(join(proj, ".env.production.local"), "SECRET=prod\n");
  const r = realRun("shop-real", "freal");
  assert.equal(r.status, 0, "STDERR:"+r.stderr.slice(-600));
  // the repo is untouched: no kit files, same tree
  assert.equal(git(proj, "status", "--porcelain").stdout, "", "no starter-kit files in the working tree");
  assert.equal(fs.readFileSync(join(proj, "AGENTS.md"), "utf8"), "# app's own agents\n");
  // the kit sits in the workspace, substituted
  assert.ok(fs.existsSync(join(r.W, "starter-kit/AGENTS.md")) && fs.existsSync(join(r.W, "starter-kit/scripts/setup-github.sh")));
  assert.doesNotMatch(fs.readFileSync(join(r.W, "starter-kit/AGENTS.md"), "utf8"), /@PROJECT@/);
  assert.match(r.stdout, /Adopting it [\s\S]* is the lead's first slice, as a PR to master/);
  // mirror + marker + hook
  assert.equal(git(proj, "rev-parse", "refs/heads/main").stdout, git(proj, "rev-parse", "origin/master").stdout);
  assert.equal(git(proj, "config", "agent-stack.mainMirror").stdout.trim(), "true");
  assert.equal(git(proj, "branch", "--show-current").stdout.trim(), "master", "main is never checked out");
  assert.match(fs.readFileSync(join(proj, ".git/hooks/pre-push"), "utf8"), /agent-stack.mainMirror/);
  // worktrees from origin/master; implementers on untracked agent/<seat> branches
  const wt = join(home, "Projects", "shop-real.worktrees");
  assert.equal(fs.readdirSync(wt).length, 10);
  assert.equal(git(join(wt, "impl-codex-1"), "rev-parse", "HEAD").stdout, git(proj, "rev-parse", "origin/master").stdout);
  assert.equal(git(join(wt, "impl-codex-1"), "branch", "--show-current").stdout.trim(), "agent/impl-codex-1");
  assert.equal(git(join(wt, "impl-codex-1"), "config", "branch.agent/impl-codex-1.merge").status, 1, "no upstream tracking of master");
  // .env.local (only) linked into every seat
  for (const seat of fs.readdirSync(wt)) {
    assert.equal(fs.readlinkSync(join(wt, seat, ".env.local")), join(proj, ".env.local"), seat);
    assert.ok(!fs.existsSync(join(wt, seat, ".env.production.local")), seat);
  }
  // trunk in the seats' context and the culture
  assert.match(fs.readFileSync(join(r.W, "rig/startup/context.md"), "utf8"), /The trunk is `master`: branch from `origin\/master`, and every pull request targets `master`\./);
  assert.match(fs.readFileSync(join(r.W, "rig/CULTURE.md"), "utf8"), /- Trunk: `master`\. Branch from origin\/master; every PR targets master\./);
  // GitHub: the ruleset is kept, no protection PUT, no push of main
  assert.match(r.stdout, /GitHub: master already protected \(ruleset: deletion, non_fast_forward, pull_request, required_status_checks\); kit protection skipped/);
  assert.doesNotMatch(r.gh, /-X PUT|repos\/korallis\/shop-real\/branches\/main/);
  // idempotent: a second run changes nothing and keeps the links
  const again = realRun("shop-real", "freal");
  assert.equal(again.status, 0, again.stderr);


  assert.equal(git(proj, "status", "--porcelain").stdout, "");
});

test("the pre-push guard refuses pushing the mirrored main; other branches push normally", () => {
  const { proj, bare } = existingRepo("shop-push", "master");
  assert.equal(realRun("shop-push", "fpush").status, 0);
  const pushMain = git(proj, "push", "origin", "main");
  assert.notEqual(pushMain.status, 0);
  assert.match(pushMain.stderr, /pre-push: refusing to push 'main': in this repo it only mirrors origin\/master/);
  assert.equal(git(bare, "rev-parse", "-q", "--verify", "refs/heads/main").status, 1, "no remote main was created");
  git(proj, "checkout", "-q", "-b", "feat");
  assert.equal(git(proj, "push", "-q", "origin", "feat").status, 0);
});

test("an existing repo with no protection at all gets the kit's protection on its trunk (not main)", () => {
  existingRepo("shop-bare", "master");
  const r = realRun("shop-bare", "fbare", [], "none");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.gh, /api -X PUT repos\/korallis\/shop-bare\/branches\/master\/protection/);
});

test("a local main that agent-stack didn't create is never overwritten", () => {
  const { proj } = existingRepo("shop-own-main", "master");
  git(proj, "branch", "main", "HEAD");
  git(proj, "commit", "-q", "--allow-empty", "-m", "own main work");   // on master, so main != origin/master? keep it different:
  git(proj, "update-ref", "refs/heads/main", "HEAD");
  const own = git(proj, "rev-parse", "main").stdout;
  const r = realRun("shop-own-main", "fown");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /a local main exists that agent-stack didn't create; not overwriting it/);
  assert.equal(git(proj, "rev-parse", "main").stdout, own);
});

test("regression: an existing MAIN-trunk repo behaves as before: worktrees from main, no mirror marker, no kit copied in", () => {
  const { proj } = existingRepo("mainapp", "main");
  const r = realRun("mainapp", "mapp");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worktrees .* \(one per seat, from main\)/);
  assert.equal(git(proj, "config", "agent-stack.mainMirror").status, 1);
  assert.equal(git(proj, "status", "--porcelain").stdout, "");
  assert.match(fs.readFileSync(join(r.W, "rig/startup/context.md"), "utf8"), /The trunk is `main`/);
});

test("agent-project-check FAILs a stale main mirror and passes once it matches origin/<trunk>", () => {
  const { proj, seed } = existingRepo("shop-chk", "master");
  assert.equal(realRun("shop-chk", "fchk").status, 0);
  const check = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), "shop-chk", "--json"], { encoding: "utf8", timeout: 120000,
    env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } }).stdout)
    .find((r) => r.check.startsWith("local main mirrors origin/master"));
  assert.equal(check().level, "OK");
  fs.appendFileSync(join(seed, "README.md"), "more\n"); git(seed, "commit", "-qam", "more"); git(seed, "push", "-q", "origin", "master");
  git(proj, "fetch", "-q", "origin");
  const stale = check();
  assert.equal(stale.level, "FAIL");
  assert.match(stale.detail, /main is \w{8}, origin\/master is \w{8}: run agent-repos-sync/);
});

test("WO21 addendum: a bun lockfile installs each new worktree with bun install --frozen-lockfile (npm ci otherwise)", () => {
  const { proj, bare, seed } = existingRepo("shop-bun", "master");
  fs.writeFileSync(join(seed, "bun.lock"), "{}\n"); fs.writeFileSync(join(seed, "package.json"), "{}\n");
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "bun"); git(seed, "push", "-q", "origin", "master"); git(proj, "pull", "-q");
  fs.writeFileSync(join(home, "bin/bun"), `#!/bin/sh\necho "bun $* in $PWD" >> "${home}/bun-calls"\n`, { mode: 0o755 });
  fs.writeFileSync(join(home, "bin/npm"), `#!/bin/sh\necho "npm $*" >> "${home}/npm-calls"\n`, { mode: 0o755 });
  const W = join(home, "Projects", "shop-bun-work");
  fs.writeFileSync(join(home, "bin/rig"), `#!/bin/bash\ncase "$1 $2" in "config get") echo "fbun:${W}";; "config init-workspace") mkdir -p "$4"; printf "kind: project\\ninstall:\\n  context: []\\n" > "$4/project.yaml"; printf "workspaces:\\n  - id: default\\n" > "$4/workspace.yaml";; "watchdog list") echo "[]";; esac\nexit 0\n`, { mode: 0o755 });
  const r = spawnSync(join(repo, "bin/agent-project-new"), ["--name", "shop-bun", "--rig", "fbun", "--team", "small", "--no-up", "--no-github"],
    { encoding: "utf8", env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, USER: "t", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), OPENRIG_URL: "http://127.0.0.1:9" } });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const calls = fs.readFileSync(join(home, "bun-calls"), "utf8").trim().split("\n");
  assert.equal(calls.length, 10);
  for (const c of calls) assert.match(c, /^bun install --frozen-lockfile in .*shop-bun\.worktrees\/[a-z0-9-]+$/);
  assert.ok(!fs.existsSync(join(home, "npm-calls")), "no npm ci for a bun project");
  fs.rmSync(join(home, "bin/bun")); fs.rmSync(join(home, "bin/npm"));
});

// ---- QA round 1 (PR #23) ----
test("QA: failed protection reads (HTTP 503) change nothing on GitHub: no label, no PUT", () => {
  existingRepo("shop-503", "master");
  const r = realRun("shop-503", "f503", [], "503");
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /GitHub: could not read master\x27s protection \(rules: .*HTTP 503.*; branch protection: .*HTTP 503.*\); nothing changed/);
  assert.doesNotMatch(r.gh, /-X PUT|label create/);
});

test("QA: main checked out in a LINKED worktree is never moved, by setup or by sync", () => {
  const { proj, seed } = existingRepo("shop-linked", "master");
  assert.equal(realRun("shop-linked", "flink").status, 0);
  const side = join(home, "linked-main"); fs.rmSync(side, { recursive: true, force: true });
  assert.equal(git(proj, "worktree", "add", "-q", side, "main").status, 0);
  fs.appendFileSync(join(seed, "README.md"), "x\n"); git(seed, "commit", "-qam", "x"); git(seed, "push", "-q", "origin", "master");
  const before = git(proj, "rev-parse", "main").stdout;
  const again = realRun("shop-linked", "flink");
  assert.match(again.stderr, /main is checked out in a worktree; mirror not set/);
  assert.equal(git(proj, "rev-parse", "main").stdout, before);
  const cat = join(home, "sync-cat.yaml"); fs.writeFileSync(cat, `workspaces:\n  - id: x\n    root: ${proj}-work\n`);
  const sync = spawnSync(join(repo, "system/agent-repos-sync"), [], { encoding: "utf8", env: { ...process.env, AGENT_CATALOG: cat, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } });
  assert.match(sync.stdout, /main is checked out in a worktree; mirror not moved/);
  assert.equal(git(proj, "rev-parse", "main").stdout, before);
  assert.equal(git(side, "status", "--porcelain").stdout, "", "the linked checkout is intact");
  git(proj, "worktree", "remove", "--force", side);
});

test("QA: with core.hooksPath (the project\x27s own hooks), nothing is written there and the check FAILs the missing guard", () => {
  const { proj } = existingRepo("shop-hooks", "master");
  fs.mkdirSync(join(proj, ".husky"), { recursive: true }); git(proj, "config", "core.hooksPath", ".husky");
  const r = realRun("shop-hooks", "fhook");
  assert.equal(r.status, 0, r.stderr.slice(-300));
  assert.match(r.stderr, /core\.hooksPath is .*\.husky \(the project\x27s own hooks\): add the agent-stack pre-commit and pre-push checks there by hand/);
  assert.deepEqual(fs.readdirSync(join(proj, ".husky")), []);
  const chk = JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), "shop-hooks", "--json"], { encoding: "utf8", timeout: 120000,
    env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } }).stdout)
    .find((x) => x.check.startsWith("pre-push hook keeps the main mirror"));
  assert.equal(chk.level, "FAIL");
  assert.match(chk.detail, /git runs hooks from .*\.husky/);
  // a guard placed there, executable, passes
  fs.copyFileSync(join(repo, "system/git-hooks/pre-push"), join(proj, ".husky/pre-push")); fs.chmodSync(join(proj, ".husky/pre-push"), 0o755);
  const ok = JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), "shop-hooks", "--json"], { encoding: "utf8", timeout: 120000,
    env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") } }).stdout)
    .find((x) => x.check.startsWith("pre-push hook keeps the main mirror"));
  assert.equal(ok.level, "OK");
});

test("WO22: agent-project-new pre-trusts every Claude seat worktree before rig up (the dry run only says so)", () => {
  existingRepo("shop-trust", "master");
  const cj = join(home, ".claude.json"); fs.writeFileSync(cj, JSON.stringify({ numStartups: 1, projects: {} }), { mode: 0o600 });
  const dryR = realRun("shop-trust", "ftrust", ["--dry-run"]);
  assert.match(dryR.stdout, /would: agent-claude-trust --spec \S+small\.yaml/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cj, "utf8")).projects, {});
  const r = realRun("shop-trust", "ftrust");
  assert.equal(r.status, 0, r.stderr.slice(-300));
  const pr = JSON.parse(fs.readFileSync(cj, "utf8")).projects;
  const wt = join(home, "Projects", "shop-trust.worktrees");
  const claude = ["coord-lead-claude", "arch-claude", "tests-claude", "impl-claude-ui", "review-claude", "review-kimi", "integ-claude"];
  for (const s of claude) assert.equal(pr[fs.realpathSync(join(wt, s))]?.hasTrustDialogAccepted, true, s);
  for (const s of ["impl-codex-1", "qa-codex", "review-codex"]) assert.equal(pr[fs.realpathSync(join(wt, s))], undefined, s);
  assert.equal(JSON.parse(fs.readFileSync(cj, "utf8")).numStartups, 1);
});


// WO33: the owner address is per machine. A new rig's CULTURE.md gets it where the template says @OWNER@; a rig whose
// CULTURE.md already exists keeps its own text.
test("a new rig's CULTURE.md names this machine's owner address; an existing CULTURE.md is left as it is", () => {
  existingRepo("shop-owner", "main");
  const r = realRun("shop-owner", "fown", [], "ruleset", { AGENT_OWNER_ADDRESS: "ann@external" });
  assert.equal(r.status, 0, r.stderr);
  const culture = fs.readFileSync(join(r.W, "rig/CULTURE.md"), "utf8");
  for (const doc of ["host-operations.md", "delivery.md", "coordination.md", "lead-loop.md"]) {
    assert.ok(fs.existsSync(join(r.W, "rig/guidance", doc)), `on-demand ${doc} copied`);
  }

  assert.match(culture, /informational row to the owner \(ann@external\)/); assert.doesNotMatch(culture, /@OWNER@/);
  fs.writeFileSync(join(r.W, "rig/CULTURE.md"), culture.replace("ann@external", "someone@external"));
  fs.writeFileSync(join(r.W, "rig/guidance/delivery.md"), "project-specific delivery rules\n");
  const again = realRun("shop-owner", "fown", [], "ruleset", { AGENT_OWNER_ADDRESS: "ann@external" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(join(r.W, "rig/guidance/delivery.md"), "utf8"), "project-specific delivery rules\n");

  assert.match(fs.readFileSync(join(r.W, "rig/CULTURE.md"), "utf8"), /\(someone@external\)/, "an existing rig keeps its text");
});

test("under agent-project-onboard (AGENT_PROJECT_ONBOARD=1) agent-project-new prints no Next: block of its own", () => {
  const run = (env) => spawnSync(join(repo, "bin/agent-project-new"), ["--name", "Demo", "--rig", "demo", "--team", "core", "--no-github", "--dry-run"],
    { encoding: "utf8", env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: home, USER: "t", OPENRIG_URL: "http://127.0.0.1:9", ...env } }).stdout;
  assert.match(run({}), /^Next: write /m);
  assert.doesNotMatch(run({ AGENT_PROJECT_ONBOARD: "1" }), /^Next: write /m);
});
