// bin/openrig-update: reports and raises an upgrade-window queue item, but never upgrades by itself.
// Runs the real script in a throwaway agent-stack copy with fake rig, npm and mise on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "orupdate-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, text, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); };

const stack = join(root, "stack"), bin = join(root, "fakebin"), log = join(root, "calls.log");
write(join(stack, "bin/openrig-update"), fs.readFileSync(join(repo, "bin/openrig-update"), "utf8"), 0o755);
write(join(stack, "config/versions.env"), "NODE_FOR_OPENRIG=22\nOPENRIG_VERSION=0.6.0\n");
write(join(stack, "patches/openrig/0.6.0/131-x.patch"), "");
// Fakes: npm reports LATEST; rig reports INSTALLED and records every other call (an upgrade would show up here).
write(join(bin, "mise"), "#!/bin/sh\necho /nonexistent\n", 0o755);
write(join(bin, "npm"), '#!/bin/sh\necho "$LATEST"\n', 0o755);
write(join(bin, "rig"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "$INSTALLED"; exit 0; }\nprintf '%s\\n' "rig $(echo "$*" | tr '\\n' ' ')" >> ${log}\nexit \${RIG_EXIT:-0}\n`, 0o755);
for (const t of ["notify-send", "logger", "systemctl"]) write(join(bin, t), `#!/bin/sh\nprintf '%s\\n' "${t} $(echo "$*" | tr '\\n' ' ')" >> ${log}\n`, 0o755);
write(join(stack, "bin/openrig-upgrade"), `#!/bin/sh\necho "UPGRADE $*" >> ${log}\n`, 0o755); // must never be called

function run(args, env) {
  fs.rmSync(log, { force: true });
  const r = spawnSync(join(stack, "bin/openrig-update"), args, { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, INSTALLED: "0.6.0 (abc)", LATEST: "0.6.1", ...env } });
  return { status: r.status, out: r.stdout, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
}

test("--check reports the gap and whether patches exist, and touches nothing", () => {
  const r = run(["--check"]);
  assert.equal(r.status, 0);
  assert.match(r.out, /upgrade window due: OpenRig 0\.6\.0 -> 0\.6\.1, patches present\? no \(installed 0\.6\.0 carries 131-x/);
  assert.equal(r.calls, "");
  write(join(stack, "patches/openrig/0.6.1/131-x.patch"), "");
  assert.match(run(["--check"]).out, /patches present\? yes \(131-x\)/);
  assert.match(run(["--check"], { LATEST: "0.6.0" }).out, /OpenRig 0\.6\.0 is current/);
});

test("--notify raises one queue item per version per week and never installs or restarts anything", () => {
  const r = run(["--notify"]);
  assert.equal(r.status, 0);
  const create = r.calls.split("\n").find(l => l.startsWith("rig queue create"));
  assert.ok(create, r.calls);
  assert.match(create, /--id qitem-openrig-upgrade-0\.6\.1-\d{4}-W\d{2} --destination operator-agent@kernel/);
  assert.match(create, /--summary upgrade window due: OpenRig 0\.6\.0 -> 0\.6\.1, patches present\? yes/);
  assert.match(r.calls, /^notify-send /m);
  const invoked = r.calls.split("\n").filter(Boolean).map(l => l.split(" ").slice(0, 2).join(" "));
  assert.deepEqual([...new Set(invoked)].sort(), ["logger -t", "notify-send --app-name=Agent", "rig queue"]);
  const owner = run(["--notify"], { OPENRIG_UPGRADE_OWNER: "ops@kernel" });
  assert.match(owner.calls, /--destination ops@kernel/);
});

test("--notify warns loudly when the queue item can't be created, and still exits 0", () => {
  const r = run(["--notify"], { RIG_EXIT: "1" });
  assert.equal(r.status, 0);
  assert.match(r.calls, /notify-send .*--urgency=critical OpenRig upgrade reminder not queued/);
  assert.deepEqual(fs.readdirSync(root).filter(f => f.startsWith("tmp")), []);
});

test("the timer only runs the notifier, weekly, as its own queue identity", () => {
  const svc = fs.readFileSync(join(repo, "system/systemd/openrig-update.service"), "utf8");
  const timer = fs.readFileSync(join(repo, "system/systemd/openrig-update.timer"), "utf8");
  assert.match(svc, /^ExecStart=%h\/\.local\/bin\/openrig-update --notify$/m);
  assert.match(svc, /^Environment=OPENRIG_SESSION_NAME=openrig-update@agent-stack$/m);
  assert.match(timer, /^OnCalendar=Mon /m);
});

test("--validate covers every team template (each rig/template/*.yaml with pods:)", () => {
  const src = fs.readFileSync(join(repo, "bin/openrig-update"), "utf8");
  const listed = src.match(/rig\/template\/\{([^}]+)\}\.yaml/)[1].split(",").sort();
  const teams = fs.readdirSync(join(repo, "rig/template")).filter((f) => f.endsWith(".yaml"))
    .filter((f) => /^pods:/m.test(fs.readFileSync(join(repo, "rig/template", f), "utf8"))).map((f) => f.replace(/\.yaml$/, "")).sort();
  assert.deepEqual(listed, teams);
});
