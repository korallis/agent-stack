// agent-project-onboard (WO31): the mechanical onboarding steps from an answers file. A throwaway HOME, stub rig, gh
// and vercel, a local git repo standing in for GitHub; no real GitHub, Vercel or Neon call. The dry run runs the real
// agent-project-new --dry-run; the apply run uses a stub agent-project-new that lays out the workspace as it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "onboard-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const bin = join(home, "bin"), calls = join(home, "calls"), stage = join(home, "stage");
fs.mkdirSync(bin); fs.mkdirSync(stage);
fs.writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = T\n\temail = t@example.invalid\n");
for (const t of ["rig", "gh", "vercel"])
  fs.writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> "${calls}"\ncase "$1 $2" in "watchdog list") echo "[]";; esac\nexit 0\n`, { mode: 0o755 });
// Stub agent-project-new for --apply: the workspace files the real one creates (CULTURE from the template + the
// "<P> specifics" stub, the team spec), and nothing else.
fs.writeFileSync(join(bin, "apn"), `#!/bin/sh
echo "agent-project-new $*" >> "${calls}"
case " $* " in *" --dry-run "*) echo "would: agent-project-new steps"; exit 0;; esac
W="$HOME/Projects/Shop-work"; mkdir -p "$W/rig" "$W/docs"
[ -f "$W/rig/CULTURE.md" ] || { cp "${repo}/rig/template/CULTURE.md" "$W/rig/CULTURE.md"; printf '\\n## Shop specifics\\n- Trunk: \`main\`.\\n' >> "$W/rig/CULTURE.md"; }
cp "${repo}/rig/template/small.yaml" "$W/rig/small.yaml"
`, { mode: 0o755 });
fs.writeFileSync(join(bin, "refresh"), `#!/bin/sh\necho "agent-refresh-guidance $*" >> "${calls}"\n`, { mode: 0o755 });
// The "GitHub" repo: a local one with a commit.
const origin = join(home, "origin-shop");
spawnSync("bash", ["-c", `git init -q -b main ${origin} && cd ${origin} && echo "# shop" > README.md && git add . && git commit -qm init`], { env: { ...process.env, HOME: home } });
fs.writeFileSync(join(stage, "plan.md"), "# Shop: plan\n\n## Goal\nFix issues #12 and #14.\n");
fs.writeFileSync(join(stage, "owner-decisions.md"), "- 2026-09-30: Merges: independent review + live Jev act band; no owner approval per PR.\n- 2026-09-30: Production data changes need the owner's go.\n");
fs.writeFileSync(join(stage, "specifics.md"), "- Package manager is pnpm; heavy runs as `agent-heavy build -- pnpm …`.\n- Required checks: `ci`.\n  Squash merges only.\n");
const answers = (extra = "") => { fs.writeFileSync(join(stage, "answers.env"), `NAME=Shop\nRIG=shop\nREPO=${origin}\nGITHUB=acme\nTEAM=small   # a handful of issues\nIDENTITY=Shop Bot <bot@example.invalid>\nVERCEL_PROJECT=shop\nWORKFLOW=issues\nPLAN=plan.md\nDECISIONS=owner-decisions.md\nSPECIFICS=specifics.md\n${extra}`); return join(stage, "answers.env"); };

function onboard(argv, env = {}) {
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/agent-project-onboard"), argv, { encoding: "utf8", timeout: 120000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, USER: "t", OPENRIG_URL: "http://127.0.0.1:9", OPENRIG_SESSION_NAME: "operator-agent@kernel", ...env } });
  return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
}
const W = join(home, "Projects/Shop-work"), culture = () => fs.readFileSync(join(W, "rig/CULTURE.md"), "utf8");

test("dry run: shows every step, runs the real agent-project-new --dry-run, changes nothing", () => {
  const r = onboard([answers()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-- dry run/);
  assert.match(r.stdout, new RegExp(`would: git clone ${origin} .*/Projects/Shop`));
  assert.match(r.stdout, /would: vercel link --project shop and vercel env pull \.env\.local --environment=development \(Development only\)/);
  assert.match(r.stdout, /would: write .*Shop-work\/docs\/PLAN\.md/);
  assert.match(r.stdout, /would: add 3 owner decision\(s\) and 2 specifics line\(s\)/);
  assert.match(r.stdout, /agent-project-new .*--name Shop --rig shop --team small --identity 'Shop Bot <bot@example\.invalid>' --github acme --dry-run/);
  assert.match(r.stdout, /would: .*worktree add/, "the real agent-project-new dry run printed its plan");
  assert.doesNotMatch(r.calls, /^vercel|^gh |rig up|rig send/m, "no provider or rig call in a dry run");
  assert.ok(!fs.existsSync(join(home, "Projects")), "nothing created");
});

test("apply: clones, pulls Development env only, creates the team, stages plan, CULTURE and lead brief, refreshes", () => {
  const env = { AGENT_PROJECT_NEW: join(bin, "apn"), AGENT_REFRESH_GUIDANCE: join(bin, "refresh") };
  const r = onboard([answers(), "--apply"], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(join(home, "Projects/Shop/README.md")), "cloned");
  assert.match(r.calls, /vercel link --yes --project shop --cwd .*\/Projects\/Shop/);
  assert.match(r.calls, /vercel env pull \.env\.local --environment=development --yes --cwd .*\/Projects\/Shop/);
  assert.doesNotMatch(r.calls, /--environment=(production|preview)/);
  assert.match(r.calls, /agent-project-new --name Shop .*--dry-run\nagent-project-new --name Shop --rig shop --team small/, "dry run first, then the real run");
  assert.equal(fs.readFileSync(join(W, "docs/PLAN.md"), "utf8"), fs.readFileSync(join(stage, "plan.md"), "utf8"));
  const c = culture();
  const section = (h) => c.split(/^## /m).find((s) => s.startsWith(h));
  assert.match(section("Owner decisions"), /no owner approval per PR/);
  assert.match(section("Owner decisions"), /Issue workflow: research, plan, implement, verify\. NEVER close an issue/);
  assert.match(section("Shop specifics"), /Trunk: `main`[\s\S]*pnpm[\s\S]*Required checks: `ci`\.\n  Squash merges only\./);
  const brief = fs.readFileSync(join(W, "docs/lead-brief.md"), "utf8");
  assert.match(brief, /Owner brief for the shop rig, from operator-agent@kernel/);
  assert.match(brief, /Never close an issue/); assert.doesNotMatch(brief, /@[A-Z]+@/, "every placeholder filled");
  assert.match(r.calls, /agent-refresh-guidance Shop --apply/);
  assert.match(r.stdout, /rig send coord-lead-claude@shop "\$\(cat .*Shop-work\/docs\/lead-brief\.md\)"/);
  assert.doesNotMatch(r.calls, /rig send/, "the brief is never sent by the helper");
});

test("apply again: nothing duplicated; a changed plan goes to PLAN.md.new; an existing .env.local is not pulled again", () => {
  const env = { AGENT_PROJECT_NEW: join(bin, "apn"), AGENT_REFRESH_GUIDANCE: join(bin, "refresh") };
  fs.writeFileSync(join(home, "Projects/Shop/.env.local"), "DATABASE_URL=postgresql://app:fake@dev.example/app\n");
  const before = culture();
  fs.appendFileSync(join(stage, "plan.md"), "\n## Added later\n");
  const r = onboard([answers(), "--apply"], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(culture(), before, "no bullet added twice");
  assert.match(r.stdout, /0 owner decision\(s\) added/);
  assert.ok(fs.existsSync(join(W, "docs/PLAN.md.new")), "the owner's changed plan is written beside, not over");
  assert.match(r.stdout, /\.env\.local exists: not pulled again/); assert.doesNotMatch(r.calls, /vercel env pull/);
  assert.match(r.stdout, /repo .*\/Projects\/Shop exists: adopted as it is/);
});

test("bad answers are refused before anything runs", () => {
  for (const [extra, msg] of [["TEAM=huge\n", /TEAM must be/], ["WORKFLOW=chaos\n", /WORKFLOW must be/], ["RIG=Bad Rig\n", /RIG lower-case/]]) {
    const r = onboard([answers(extra)]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, msg); assert.equal(r.calls, "");
  }
  fs.writeFileSync(join(stage, "thin.env"), "NAME=Shop\n");
  assert.match(onboard([join(stage, "thin.env")]).stderr, /missing in .*: RIG, TEAM, IDENTITY/);
});

test("operator-guidance: one agent-stack block beside OpenRig's managed blocks; --check; replaced when stale, never duplicated", () => {
  const orHome = join(home, "openrig"), ws = join(orHome, "workspace"); fs.mkdirSync(ws, { recursive: true });
  const managed = "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nYou are the operator.\n<!-- END OpenRig MANAGED BLOCK: role -->\n";
  fs.writeFileSync(join(ws, "CLAUDE.md"), managed); fs.chmodSync(join(ws, "CLAUDE.md"), 0o640);
  const og = (a = []) => spawnSync(join(repo, "system/operator-guidance"), a, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: orHome } });
  let r = og(["--check"]); assert.equal(r.status, 1); assert.match(r.stdout, /pointer missing/);
  assert.equal(fs.readFileSync(join(ws, "CLAUDE.md"), "utf8"), managed, "--check writes nothing");
  r = og(); assert.equal(r.status, 0); assert.match(r.stdout, /pointer added/);
  const once = fs.readFileSync(join(ws, "CLAUDE.md"), "utf8");
  assert.ok(once.startsWith(managed), "OpenRig's blocks untouched");
  assert.match(once, /<!-- BEGIN agent-stack: project onboarding -->\n## Onboarding a project[\s\S]*project-onboarding[\s\S]*agent-project-onboard <answers\.env>[\s\S]*<!-- END agent-stack: project onboarding -->\n$/);
  assert.equal(fs.statSync(join(ws, "CLAUDE.md")).mode & 0o777, 0o640, "mode kept");
  assert.equal(og(["--check"]).status, 0);
  r = og(); assert.match(r.stdout, /pointer present/); assert.equal(fs.readFileSync(join(ws, "CLAUDE.md"), "utf8"), once);
  fs.writeFileSync(join(ws, "CLAUDE.md"), once.replace("Onboarding a project (agent-stack)", "Old wording"));
  assert.match(og(["--check"]).stdout, /pointer stale/);
  r = og(); assert.match(r.stdout, /pointer updated/); assert.equal(fs.readFileSync(join(ws, "CLAUDE.md"), "utf8"), once);
  assert.equal((fs.readFileSync(join(ws, "CLAUDE.md"), "utf8").match(/BEGIN agent-stack/g) || []).length, 1);
  assert.ok(fs.readdirSync(join(home, ".local/share/agent-stack/backups/operator-guidance")).length >= 2, "backed up before each change");
  fs.rmSync(ws, { recursive: true });
  r = og(); assert.equal(r.status, 0); assert.match(r.stdout, /no kernel workspace instruction file/);
});
