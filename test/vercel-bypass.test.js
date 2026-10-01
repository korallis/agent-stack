// WO62: a Vercel project's protection-bypass secrets are the KEYS of its `protectionBypass` object, so printing the
// project JSON (or just those keys) prints the secret. Control checks only: a stub `vercel` whose project carries
// synthetic bypass keys, the real seat guard and read hook, and the summary tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const hookFile = join(repo, "system/credguard-read-hook"), g = require(hookFile);
const root = fs.mkdtempSync(join(os.tmpdir(), "vercel-bypass-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const KEY = "SYNTHETICBYPASSKEY0123456789abcdef", home = join(root, "home"), SEATN = "impl-claude@shop";
const vdir = join(home, ".local/state/agent-stack/vercel", SEATN);
const project = { id: "prj_1", name: "shop-web", ssoProtection: { deploymentType: "preview" }, passwordProtection: null, trustedIps: null,
  protectionBypass: { [KEY]: { createdAt: 1790000000000, createdBy: "u1", scope: "automation-bypass" }, OTHERSYNTHETICKEY987654321xyz: { createdAt: 1780000000000, scope: "automation-bypass" } } };

// The seat guard as installed: seat-bin/credguard with vercel/vc links, then a stub real vercel that records calls.
const seat = join(home, ".local/share/agent-stack/seat-bin"), stubs = join(root, "stubs"), calls = join(root, "calls");
fs.mkdirSync(seat, { recursive: true }); fs.mkdirSync(stubs);
fs.copyFileSync(join(repo, "system/seat-bin-credguard"), join(seat, "credguard")); fs.chmodSync(join(seat, "credguard"), 0o755);
for (const n of ["vercel", "vc"]) fs.symlinkSync(join(seat, "credguard"), join(seat, n));
const linkVc = () => { fs.rmSync(join(stubs, "vc"), { force: true }); fs.symlinkSync(join(stubs, "vercel"), join(stubs, "vc")); };
fs.writeFileSync(join(stubs, "vercel"), `#!/bin/sh
echo "vercel $*" >> "${calls}"
case "$*" in *projects*|*protection-bypass*) echo '${JSON.stringify(project)}' ;; *) echo '{"user":{"id":"u1"}}' ;; esac
`, { mode: 0o755 });
linkVc();
const run = (cmd) => { fs.rmSync(calls, { force: true });
  const r = spawnSync("bash", ["-c", cmd], { cwd: root, encoding: "utf8", env: { PATH: `${seat}:${stubs}:/usr/bin:/bin`, HOME: home, OPENRIG_SESSION_NAME: SEATN } });
  const c = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
  return { ...r, ran: c.split("\n").filter(Boolean) }; };

test("WO62 seat guard: vercel api on project / protection-bypass endpoints never reaches the transcript", () => {
  for (const c of ["vercel api /v9/projects/shop-web", "vercel api /v10/projects/shop-web --raw --scope team", "vercel api /v9/projects",
    "vercel api /v9/projects/shop-web/env", "vercel api /v1/projects/shop-web/protection-bypass -X PATCH", "vc api /v9/projects/shop-web",
    "set -o pipefail; vercel api /v9/projects/shop-web --raw | cat", "vercel api /v9/projects/shop-web > saved.json",
    "vercel api /v9/projects/shop-web --output-file saved.json", `vercel api /v9/projects/shop-web --output-file ${home}/elsewhere/p.json`,
    `vercel api /v9/projects/shop-web --output-file ${vdir}/../other-seat/p.json`,
    "vercel --debug ls", "vercel -d api /v2/user", "vercel api /v2/user --verbose"]) {
    const r = run(c);
    assert.equal(r.status, 2, `${c}: ${r.stderr}`); assert.match(r.stderr, /seat guard\): refused/, c);
    assert.deepEqual(r.ran, [], `${c}: the real CLI never ran`); assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY), c);
  }
  assert.match(run("vercel api /v9/projects/shop-web").stderr, /agent-vercel-protection-status/);
});

test("WO62 seat guard: into the seat's protected dir it runs (0600 file, 0700 dir, flag stripped); other endpoints run as before", () => {
  const r = run(`vercel api /v9/projects/shop-web --raw --output-file ${vdir}/shop-web.json`);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ""); assert.doesNotMatch(r.stderr, new RegExp(KEY));
  assert.deepEqual(r.ran, ["vercel api /v9/projects/shop-web --raw"]);
  assert.equal(fs.statSync(join(vdir, "shop-web.json")).mode & 0o777, 0o600); assert.equal(fs.statSync(vdir).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(join(vdir, "shop-web.json"), "utf8"), new RegExp(KEY), "the data is in the file, not the transcript");
  for (const c of ["vercel api /v2/user", "vercel api list", "vercel api /v9/projects/shop-web > /dev/null", "vercel deploy"]) {
    const x = run(c); assert.equal(x.status, 0, `${c}: ${x.stderr}`); assert.equal(x.ran.length, 1, c);
  }
});

test("WO62 read hook: protectionBypass, inline interpreter reads and the protected Vercel dir are refused in both runtimes", () => {
  const work = join(root, "work"); fs.mkdirSync(join(work, "app"), { recursive: true }); fs.writeFileSync(join(work, "app/.env"), "K=v\n");
  fs.mkdirSync(vdir, { recursive: true }); fs.writeFileSync(join(vdir, "p.json"), JSON.stringify(project));
  const hook = (runtime, tool_name, tool_input) => {
    const r = spawnSync(process.execPath, [hookFile, "--runtime", runtime], { encoding: "utf8", input: JSON.stringify({ tool_name, tool_input, cwd: work }),
      env: { PATH: process.env.PATH, HOME: home, AGENT_CREDGUARD_READ_PATHS: join(home, "none") } });
    return runtime === "codex" ? { deny: r.status === 2, reason: r.stderr } : { deny: JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision === "deny", reason: r.stdout };
  };
  for (const runtime of ["claude", "codex"]) {
    for (const c of [
      `vercel api /v9/projects/p --raw | node -e "const x=JSON.parse(require('fs').readFileSync(0));console.log(Object.keys(x.protectionBypass))"`,
      "jq '.protectionBypass | keys' p.json", "jq '.PROTECTIONBYPASS' p.json", "grep -i protection_bypass p.json", "echo protectionbypass",
      `cat ${vdir}/p.json`, `jq . ${vdir}/p.json`, `jq 'keys' ~/.local/state/agent-stack/vercel/*/p.json`,
      `node -e "console.log(require('fs').readFileSync('${vdir}/p.json','utf8'))"`, `python3 -c "print(open('${vdir}/p.json').read())"`,
      `node -e "console.log(require('fs').readFileSync('app/.env','utf8'))"`, `python3 -c "print(open('app/.env').read())"`, "ruby -e 'puts File.read(\".env\")'"]) {
      const r = hook(runtime, "Bash", { command: c });
      assert.equal(r.deny, true, `${runtime}: ${c}`);
    }
    assert.match(hook(runtime, "Bash", { command: "jq '.protectionBypass' p.json" }).reason, /agent-vercel-protection-status <project>/);
    assert.equal(hook(runtime, "Read", { file_path: join(vdir, "p.json") }).deny, true, `${runtime}: Read`);
    assert.equal(hook(runtime, "Grep", { pattern: "protectionBypass", path: work, output_mode: "content" }).deny, true, `${runtime}: Grep content`);
    for (const c of ["agent-vercel-protection-status shop-web --scope team", `vercel api /v9/projects/shop-web --output-file ${vdir}/x.json`,
      `curl -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" https://preview.example.test/`, "node -e 'console.log(1+1)'",
      `python3 -c "import json; print(json.load(open('app/data.json')))"`])
      assert.equal(hook(runtime, "Bash", { command: c }).deny, false, `${runtime}: ${c}`);
  }
});

test("WO62 agent-vercel-protection-status: yes/no and counts only, never a key; errors masked", () => {
  const status = (args, out = JSON.stringify(project), rc = 0) => {
    fs.writeFileSync(join(stubs, "vercel"), `#!/bin/sh\necho "vercel $*" >> "${calls}"\necho '${out}'\n${rc ? `echo 'Error: token ${KEY} rejected' >&2; exit ${rc}` : ""}\n`, { mode: 0o755 });
    fs.rmSync(calls, { force: true });
    const r = spawnSync(join(repo, "bin/agent-vercel-protection-status"), args, { encoding: "utf8", env: { PATH: `${seat}:${stubs}:/usr/bin:/bin`, HOME: home } });
    return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
  };
  let r = status(["shop-web", "--scope", "team"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, ["project: shop-web", "  Vercel Authentication: on (preview)", "  password protection: off", "  trusted IPs: off",
    "  protection bypass: configured, 2 entries (automation-bypass 2); newest created 2026-09-21 14:13 UTC", ""].join("\n"));
  assert.match(r.calls, /^vercel api \/v9\/projects\/shop-web --raw --scope team$/m, "the real CLI, not the seat guard");
  assert.doesNotMatch(r.stdout + r.stderr, /SYNTHETIC/);
  r = status(["shop-web", "--json"]); const j = JSON.parse(r.stdout);
  assert.equal(j.protection_bypass_entries, 2); assert.equal(j.protection_bypass_configured, true); assert.doesNotMatch(r.stdout, /SYNTHETIC/);
  r = status(["shop-web"], JSON.stringify({ ...project, protectionBypass: {} }));
  assert.match(r.stdout, /protection bypass: not configured/);
  r = status(["shop-web"], "", 1);
  assert.equal(r.status, 1); assert.match(r.stderr, /could not read project shop-web: unknown reason \(vercel exit 1\); the CLI's own message is not shown/);
  assert.doesNotMatch(r.stdout + r.stderr, /SYNTHETIC/);
  // QA PR68: whatever shape a secret has in the CLI's error (short, segmented, in JSON), none of it is printed
  for (const [err, why] of [["Error: Project not found (key ab1)", "project not found"], ["403 Forbidden: k-1.2.3", "no access to it"],
    ["Error: not logged in (x.y.z)", "not logged in"], ['{"error":{"code":"x","bypass":"S1-2"}}', "unknown reason"]])
    for (const args of [["shop-web"], ["shop-web", "--json"]]) {
      fs.writeFileSync(join(stubs, "vercel"), `#!/bin/sh\necho ${JSON.stringify(err)} >&2\necho '${err.replace(/'/g, "")}'\nexit 1\n`, { mode: 0o755 });
      const x = spawnSync(join(repo, "bin/agent-vercel-protection-status"), args, { encoding: "utf8", env: { PATH: `${seat}:${stubs}:/usr/bin:/bin`, HOME: home } });
      assert.equal(x.status, 1); assert.match(x.stderr, new RegExp(`: ${why} \\(vercel exit 1\\)`), err);
      for (const bit of ["ab1", "k-1.2.3", "x.y.z", "S1-2"]) assert.doesNotMatch(x.stdout + x.stderr, new RegExp(bit.replace(/[.]/g, "\\.")), `${err}: ${bit}`);
    }
  for (const bad of [[], ["../x"], ["a b"]]) assert.notEqual(status(bad).status, 0, JSON.stringify(bad));
});

test("WO62 (QA PR68): template names get no pass inside the raw Vercel dir; outside it they are still templates", () => {
  const work = join(root, "work2"); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(vdir, { recursive: true });
  const dec = (tool_name, tool_input) => g.decide({ tool_name, tool_input, cwd: work }, { home, pats: g.DEFAULT_PATTERNS }).deny;
  for (const n of [".env.example", ".env.sample", ".env.template"]) {
    fs.writeFileSync(join(vdir, n), "x"); fs.writeFileSync(join(work, n), "x");
    assert.equal(dec("Read", { file_path: join(vdir, n) }), true, `Read ${n} in the Vercel dir`);
    for (const c of [`cat ${join(vdir, n)}`, `jq . ${join(vdir, n)}`]) assert.equal(dec("Bash", { command: c }), true, c);
    assert.equal(dec("Read", { file_path: join(work, n) }), false, `${n} outside: a template`);
    assert.equal(dec("Bash", { command: `cat ${n}` }), false, `cat ${n} outside`);
  }
});
