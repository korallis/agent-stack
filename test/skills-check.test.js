// agent-skills-check (WO28): one line per skill source, WARN on anything missing. A fake repo, a throwaway HOME and
// stub claude/codex; nothing live is read or written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "skillscheck-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const S = join(root, "repo"), H = join(root, "home"), stubs = join(root, "stubs");
const OR = join(H, ".local/share/agent-stack/openrig/lib/node_modules/@openrig/cli");
const skill = (d) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(join(d, "SKILL.md"), "---\nname: x\n---\n"); };
const ln = (target, at) => { fs.mkdirSync(dirname(at), { recursive: true }); fs.rmSync(at, { recursive: true, force: true }); fs.symlinkSync(target, at); };
const DIRS = [join(H, ".claude/skills"), join(H, ".agents/skills")];

// Fake repo: the script, our two skills, two role agents, the openrig-shared link.
fs.mkdirSync(join(S, "bin"), { recursive: true }); fs.copyFileSync(join(repo, "bin/agent-skills-check"), join(S, "bin/agent-skills-check"));
fs.chmodSync(join(S, "bin/agent-skills-check"), 0o755);
for (const n of ["agent-stack", "openrig-project-setup"]) skill(join(S, "skills", n));
for (const [a, list] of [["lead", "orchestration-team, verification-before-completion"], ["qa", "systematic-debugging, dogfood"]]) {
  fs.mkdirSync(join(S, "rig/template/agents", a), { recursive: true });
  fs.writeFileSync(join(S, "rig/template/agents", a, "agent.yaml"), `profiles:\n  default:\n    uses:\n      skills: [${list}]\n`);
}
// Fake installed OpenRig: two core skills, and the shared agent with the role skills.
for (const n of ["queue-handoff", "mission-slice-sop"]) skill(join(OR, "daemon/assets/plugins/openrig-core/skills", n));
const shared = join(OR, "daemon/specs/agents/shared");
const roles = { "orchestration-team": "pods/orchestration-team", "verification-before-completion": "process/verification-before-completion",
  "systematic-debugging": "process/systematic-debugging", dogfood: "process/dogfood" };
fs.mkdirSync(shared, { recursive: true });
fs.writeFileSync(join(shared, "agent.yaml"), "resources:\n  skills:\n" + Object.entries(roles).map(([id, p]) => `    - id: ${id}\n      path: skills/${p}\n`).join(""));
for (const p of Object.values(roles)) skill(join(shared, "skills", p));
ln(shared, join(S, "rig/template/openrig-shared"));
// Stub CLIs.
fs.mkdirSync(stubs);
const claudeList = (vercel) => `Installed plugins:\n  ❯ superpowers@claude-plugins-official\n    Version: 6.4.1\n    Status: ✔ enabled\n  ❯ typesafe@typesafe-ai\n    Status: ✔ enabled\n` +
  (vercel ? `  ❯ vercel@claude-plugins-official\n    Status: ${vercel}\n` : "");
const setClaude = (vercel) => fs.writeFileSync(join(stubs, "claude"), `#!/bin/sh\ncat <<'X'\n${claudeList(vercel)}X\n`, { mode: 0o755 });
fs.writeFileSync(join(stubs, "codex"), "#!/bin/sh\necho 'PLUGIN  STATUS  VERSION'\necho 'superpowers@openai-api-curated  installed, enabled  5fd93af4  /x'\n", { mode: 0o755 });

function setUpAll() {
  setClaude("✔ enabled");
  for (const d of DIRS) {
    for (const n of ["agent-stack", "openrig-project-setup"]) ln(join(S, "skills", n), join(d, n));
    for (const n of ["queue-handoff", "mission-slice-sop"]) ln(join(OR, "daemon/assets/plugins/openrig-core/skills", n), join(d, n));
  }
  for (const n of ["neon", "neon-postgres", "neon-postgres-branches", "neon-postgres-egress-optimizer"]) {
    skill(join(DIRS[1], n)); ln(join(DIRS[1], n), join(DIRS[0], n));
  }
  skill(join(DIRS[1], "typesafe-ai"));
  skill(join(DIRS[0], "synced/acct/pdf")); skill(join(DIRS[0], "synced/acct/morning"));
}
const check = () => {
  const r = spawnSync(join(S, "bin/agent-skills-check"), ["--json"], { encoding: "utf8", env: { PATH: `${stubs}:/usr/bin:/bin`, HOME: H } });
  const rows = JSON.parse(r.stdout);
  return { status: r.status, by: Object.fromEntries(rows.map((x) => [x.source, x])), rows };
};

test("everything in place: one ok line per source, info for synced/host skills, exit 0", () => {
  setUpAll();
  const { status, by, rows } = check();
  assert.equal(status, 0, JSON.stringify(rows, null, 1));
  assert.deepEqual(rows.map((r) => r.level), ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "info", "info"]);
  assert.match(by["OpenRig core skills"].detail, /^2 linked/);
  assert.match(by["OpenRig role skills (seats)"].detail, /4 used by the rig specs/);
  assert.match(by["Claude.ai account-synced skills"].detail, /^2 in/);
});

test("the Vercel plugin missing or disabled: WARN names it, exit 1", () => {
  setUpAll();
  for (const v of [null, "✘ disabled"]) {
    setClaude(v);
    const { status, by } = check();
    assert.equal(status, 1); assert.equal(by["Claude Code plugins"].level, "WARN");
    assert.match(by["Claude Code plugins"].detail, /vercel@claude-plugins-official/);
  }
});

test("each source WARNs on its own gap", () => {
  const cases = [
    ["ours (skills/ in this repo)", () => fs.rmSync(join(DIRS[1], "agent-stack"))],
    ["ours (skills/ in this repo)", () => { fs.rmSync(join(DIRS[0], "openrig-project-setup")); skill(join(DIRS[0], "openrig-project-setup")); }],   // a copy, not the link
    ["OpenRig core skills", () => fs.rmSync(join(DIRS[0], "queue-handoff"))],
    ["OpenRig role skills (seats)", () => fs.rmSync(join(shared, "skills/process/dogfood"), { recursive: true })],
    ["OpenRig role skills (seats)", () => ln(join(root, "elsewhere"), join(S, "rig/template/openrig-shared"))],
    ["Codex plugins", () => fs.writeFileSync(join(stubs, "codex"), "#!/bin/sh\necho 'superpowers@openai-api-curated  not installed'\n", { mode: 0o755 })],
    ["Neon skills", () => fs.rmSync(join(DIRS[0], "neon-postgres"))],
    ["TypeSafe skill for Codex", () => fs.rmSync(join(DIRS[1], "typesafe-ai"), { recursive: true })],
  ];
  for (const [source, breakIt] of cases) {
    setUpAll(); ln(shared, join(S, "rig/template/openrig-shared")); skill(join(shared, "skills/process/dogfood"));
    fs.writeFileSync(join(stubs, "codex"), "#!/bin/sh\necho 'superpowers@openai-api-curated  installed, enabled  x  /x'\n", { mode: 0o755 });
    breakIt();
    const { status, by, rows } = check();
    assert.equal(status, 1, source);
    assert.equal(by[source].level, "WARN", `${source}: ${JSON.stringify(by[source])}`);
    assert.equal(rows.filter((r) => r.level === "WARN").length, 1, `${source}: only that source warns: ${JSON.stringify(rows)}`);
  }
});

test("install.sh installs the Vercel plugin and runs the skills check in both modes", () => {
  const src = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(src, /claude plugin install vercel@claude-plugins-official >\/dev\/null 2>&1 \|\| todo/);
  const step = src.indexOf('step "Skills (one line per source'), plugins = src.indexOf('step "Agent tools');
  assert.ok(step > plugins && src.indexOf('"$S/bin/agent-skills-check"', step) > step);
  assert.ok(!/^if \[ \$CHECK = 0 \]/m.test(src.slice(step, src.indexOf("step ", step + 10))), "the skills step runs with --check too");
});

test("install.sh's skills step: WARN lines become todos and a failing check never stops install.sh (set -e, pipefail)", () => {
  const src = fs.readFileSync(join(repo, "install.sh"), "utf8");
  const a = src.indexOf('step "Skills (one line per source'), b = src.indexOf("\ndone\n", a) + 6;
  fs.writeFileSync(join(S, "bin/agent-skills-check"), "#!/bin/sh\necho 'ok    A: fine'\necho 'WARN  B: missing'\necho 'info  C: x'\nexit 1\n", { mode: 0o755 });
  const script = `set -euo pipefail\nS=${S}\nstep() { echo "== $*"; }\nok() { echo "ok  $*"; }\ntodo() { echo "--  $*"; }\n${src.slice(a, b)}\necho AFTER`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok  A: fine\n--  WARN: B: missing\n   info  C: x\nAFTER/);
});
