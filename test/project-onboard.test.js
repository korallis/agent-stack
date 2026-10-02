// agent-project-onboard (WO31): the mechanical onboarding steps from an answers file. A throwaway HOME, stub rig, gh
// and vercel, a local git repo standing in for GitHub; no real GitHub, Vercel or Neon call. The dry run runs the real
// agent-project-new --dry-run; the apply run uses a stub agent-project-new that lays out the workspace as it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "onboard-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const bin = join(home, "bin"), calls = join(home, "calls"), stage = join(home, "stage");
fs.mkdirSync(bin); fs.mkdirSync(stage);
fs.writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = T\n\temail = t@example.invalid\n");
for (const t of ["rig", "gh"])
  fs.writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> "${calls}"\ncase "$1 $2" in "watchdog list") echo "[]";; esac\nexit 0\n`, { mode: 0o755 });
// Stub vercel that fails, like the real one, when its --cwd doesn't exist (QA round 1: a new repo was linked before it existed).
fs.writeFileSync(join(bin, "vercel"), `#!/bin/sh
echo "vercel $*" >> "${calls}"
while [ $# -gt 0 ]; do [ "$1" = --cwd ] && { [ -d "$2" ] || { echo "Error: $2 does not exist" >&2; exit 1; }; }; shift; done
exit 0
`, { mode: 0o755 });
// Stub agent-project-new for --apply: the workspace files the real one creates (CULTURE from the template + the
// "<P> specifics" stub, the team spec), and nothing else.
fs.writeFileSync(join(bin, "apn"), `#!/bin/sh
echo "agent-project-new $*" >> "${calls}"
case " $* " in *" --dry-run "*) echo "would: agent-project-new steps"; exit 0;; esac
P=$(echo " $* " | sed -n 's/.* --name \\([^ ]*\\) .*/\\1/p'); W="$HOME/Projects/$P-work"; R="$HOME/Projects/$P"
[ -d "$R/.git" ] || { git init -q -b main "$R"; echo "created new repo $R" >> "${calls}"; }
mkdir -p "$W/rig" "$W/docs"
[ -f "$W/rig/CULTURE.md" ] || { cp "${repo}/rig/template/CULTURE.md" "$W/rig/CULTURE.md"; printf '\\n## %s specifics\\n- Trunk: \`main\`.\\n' "$P" >> "$W/rig/CULTURE.md"; }
cp "${repo}/rig/template/small.yaml" "$W/rig/small.yaml"
case " $* " in *" --no-up "*) ;; *) echo "team started for $P" >> "${calls}";; esac
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
  assert.match(r.stdout, /would: add 4 owner decision\(s\) and 2 specifics line\(s\)/);
  assert.match(r.stdout, /agent-project-new .*--name Shop --rig shop --team small --identity 'Shop Bot <bot@example\.invalid>' --no-github --dry-run/);
  assert.match(r.stdout, /existing repo: its GitHub rules stay as they are/);
  assert.match(r.stdout, /would: .*worktree add/, "the real agent-project-new dry run printed its plan");
  assert.doesNotMatch(r.stdout, /^Next: write /m, "agent-project-new's own Next: block is not echoed (WO34)");
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
  const order = r.calls.split("\n").filter((l) => /^(agent-project-new|vercel|team started)/.test(l)).map((l) => l.replace(/ --identity .*? --/, " --"));
  assert.deepEqual(order.map((l) => l.replace(/ --cwd .*/, "")), [
    "agent-project-new --name Shop --rig shop --team small --no-github --dry-run",
    "agent-project-new --name Shop --rig shop --team small --no-github --no-up",
    "vercel link --yes --project shop", "vercel env pull .env.local --environment=development --yes",
    "agent-project-new --name Shop --rig shop --team small --no-github", "team started for Shop"],
    "dry run, create without seats, Development env, then start the team; an existing repo keeps its GitHub rules");
  assert.equal(fs.readFileSync(join(W, "docs/PLAN.md"), "utf8"), fs.readFileSync(join(stage, "plan.md"), "utf8"));
  const c = culture();
  const section = (h) => c.split(/^## /m).find((s) => s.startsWith(h));
  assert.match(section("Owner decisions"), /no owner approval per PR/);
  assert.match(section("Owner decisions"), /Issue workflow: research, plan, implement, verify\. NEVER close an issue/);
  // the template's own standing decisions keep their source; every decision the onboarding staged ends with its relay
  const standing = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  for (const b of section("Owner decisions").split("\n").filter((l) => /^- \d{4}-/.test(l) && !standing.includes(l)))
    assert.match(b, /\(owner, via operator relay of the onboarding answers\)$/, "every staged owner decision ends with its source (WO41)");
  assert.match(section("Shop specifics"), /Trunk: `main`[\s\S]*pnpm[\s\S]*Required checks: `ci`\.\n  Squash merges only\./);
  const brief = fs.readFileSync(join(W, "docs/lead-brief.md"), "utf8");
  assert.match(brief, /Owner brief for the shop rig, from operator-agent@kernel/);
  assert.match(brief, /Never close an issue/); assert.doesNotMatch(brief, /@[A-Z]+@/, "every placeholder filled");
  assert.match(brief, /then WAIT\. Dispatch no builder until operator-agent@kernel sends "plan approved"/);
  assert.match(section("Owner decisions"), /Plan approval: the owner's\. The operator reviews the plan first, then asks the owner/);
  assert.match(r.stdout, /rig send coord-lead-claude@shop "plan approved"/);
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
  for (const [extra, msg] of [["TEAM=huge\n", /TEAM must be/], ["WORKFLOW=chaos\n", /WORKFLOW must be/], ["RIG=Bad Rig\n", /RIG lower-case/],
    ["NAME=.\n", /NAME must be a plain name/], ["NAME=..\n", /NAME must be a plain name/], ["NAME=.hidden\n", /NAME must be/],
    ["PLAN_APPROVAL=anyone\n", /PLAN_APPROVAL must be/], ["GITHUB_SETUP=maybe\n", /GITHUB_SETUP must be/]]) {
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

test("shipped, not just present: the onboarding templates are tracked by git, and install.sh links every bin/ tool (QA round 1)", () => {
  const tracked = spawnSync("git", ["ls-files", "rig/template/onboarding", "skills/project-onboarding", "bin", "system/operator-guidance"], { cwd: repo, encoding: "utf8" }).stdout;
  for (const f of ["rig/template/onboarding/answers.example.env", "rig/template/onboarding/lead-brief.md", "skills/project-onboarding/SKILL.md",
    "bin/agent-project-onboard", "system/operator-guidance"])
    assert.ok(tracked.split("\n").includes(f), `${f} is not tracked (ignored?)`);
  const install = fs.readFileSync(join(repo, "install.sh"), "utf8");
  const linked = install.match(/^for f in ([^;]+); do link "\$S\/bin\/\$f"/m)[1].split(/\s+/);
  const internal = ["openrig-apply-patches", "semver-cmp"];   // called by path from other tools, never by hand
  const tools = fs.readdirSync(join(repo, "bin")).filter((f) => fs.statSync(join(repo, "bin", f)).isFile() && (fs.statSync(join(repo, "bin", f)).mode & 0o111));
  for (const t of tools) if (!internal.includes(t)) assert.ok(linked.includes(t), `install.sh does not link bin/${t}`);
});


test("a new repo with Vercel: the repo exists before vercel link, and the new repo gets --github (QA round 1)", () => {
  const env = { AGENT_PROJECT_NEW: join(bin, "apn"), AGENT_REFRESH_GUIDANCE: join(bin, "refresh") };
  fs.writeFileSync(join(stage, "new.env"), "NAME=NewShop\nRIG=newshop\nGITHUB=acme\nTEAM=core\nIDENTITY=Shop Bot <bot@example.invalid>\nVERCEL_PROJECT=newshop\nPLAN=plan.md\nPLAN_APPROVAL=operator\n");
  const r = onboard([join(stage, "new.env"), "--apply"], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.calls.split("\n");
  const created = lines.findIndex((l) => l.startsWith("created new repo")), linked = lines.findIndex((l) => l.startsWith("vercel link"));
  assert.ok(created !== -1 && linked > created, `repo created before vercel link:\n${r.calls}`);
  assert.match(r.calls, /agent-project-new --name NewShop --rig newshop --team core --identity .* --github acme --no-up/);
  assert.ok(lines.findIndex((l) => l.startsWith("team started for NewShop")) > linked, "seats start after the env is in place");
  assert.match(fs.readFileSync(join(home, "Projects/NewShop-work/rig/CULTURE.md"), "utf8"), /Plan approval: delegated to the operator/);
});

test("an existing repo gets agent-project-new's GitHub setup only with GITHUB_SETUP=yes (QA round 1)", () => {
  const r = onboard([answers("GITHUB_SETUP=yes\n")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GITHUB_SETUP=yes, the owner agreed/); assert.match(r.stdout, /--github acme --dry-run/);
});

// QA WO41 f1: adding a decision's source must not duplicate a decision already in CULTURE.
test("add_bullets: a decision already present (sourced or not) is never added again; an unsourced one is reported", () => {
  const src = fs.readFileSync(join(repo, "bin/agent-project-onboard"), "utf8");
  const fns = src.slice(src.indexOf("def owner_names"), src.indexOf("def bullets_of"));
  const regex = src.split("\n").filter((l) => /^(OWNER_SOURCE|PROVENANCE) = /.test(l)).join("\n");
  const culturePath = join(fs.mkdtempSync(join(tmpdir(), "onb-")), "CULTURE.md");
  fs.writeFileSync(culturePath, "# x\n\n## Owner decisions (binding)\nintro\n- 2026-09-30: Keep review independent.\n- 2026-09-30: Ship weekly. (owner, Slack 10:00Z)\n" +
    "- 2026-09-30: Owner approved weekly releases (Slack 14:04Z)\n\n## Operating rules\n- r\n");
  const py = `import os, re, subprocess\n__file__ = ${JSON.stringify(join(repo, "bin/agent-project-onboard"))}\n${fns}\n${regex}\nimport sys\nS = " (owner, via operator relay of the onboarding answers)"\n` +
    `bs = ["- 2026-09-30: Keep review independent." + S, "- 2026-09-30: Ship weekly." + S, "- 2026-09-30: New one." + S,\n` +
    `  "- 2026-09-30: Owner approved backup retention (Slack 14:05Z)"]\n` +
    `print(add_bullets(sys.argv[1], "Owner decisions", bs, same=decision_core)); print(add_bullets(sys.argv[1], "Owner decisions", bs, same=decision_core))`;
  const r = spawnSync("python3", ["-c", py, culturePath], { encoding: "utf8", env: { ...process.env, AGENT_OWNER_ADDRESS: "owner@external" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => /^\d+$/.test(l)), ["2", "0"], "only the new decisions, once each");
  assert.match(r.stdout, /note: already in "Owner decisions" without its owner source; add it there by hand: - 2026-09-30: Keep review independent\./);
  const c = fs.readFileSync(culturePath, "utf8");
  assert.equal((c.match(/Keep review independent/g) || []).length, 1); assert.equal((c.match(/Ship weekly/g) || []).length, 1);
  assert.equal((c.match(/backup retention/g) || []).length, 1, "QA WO41: a distinct decision by the owner's name is not taken for another");
  assert.equal((c.match(/weekly releases/g) || []).length, 1);
  assert.match(c, /- 2026-09-30: New one\. \(owner, via operator relay of the onboarding answers\)\n- 2026-09-30: Owner approved backup retention \(Slack 14:05Z\)\n\n## Operating rules/);
  fs.rmSync(dirname(culturePath), { recursive: true, force: true });
});
