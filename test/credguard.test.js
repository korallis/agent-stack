// seat-bin/credguard (WO27): seats' neon/neonctl/vercel/vc refuse to print credentials into the seat's output (its
// transcript). Stub CLIs in a throwaway dir stand in for the real ones; the Neon and Vercel APIs are never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "credguard-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const seat = join(root, "home/.local/share/agent-stack/seat-bin"), stubs = join(root, "stubs"), calls = join(root, "calls");
fs.mkdirSync(seat, { recursive: true }); fs.mkdirSync(stubs);
fs.copyFileSync(join(repo, "system/seat-bin-credguard"), join(seat, "credguard")); fs.chmodSync(join(seat, "credguard"), 0o755);
for (const n of ["neon", "neonctl", "vercel", "vc"]) fs.symlinkSync(join(seat, "credguard"), join(seat, n));
const SECRET = "FAKE-OWNER-PW";
// Stub neon (6.3.0's help: only projects/branches create know --no-secrets). Records every call.
fs.writeFileSync(join(stubs, "neon"), `#!/bin/sh
echo "neon $*" >> "${calls}"
case " $* " in *" --help "*)
  case "$1 $2" in "projects create"|"branches create") echo "--secrets  Include connection credentials in command output. Use --no-secrets to omit them";;
  *) echo "neon $1 [options]";; esac; exit 0;; esac
echo "postgresql://owner:${SECRET}@ep.example/db"
`, { mode: 0o755 });
fs.writeFileSync(join(stubs, "vercel"), `#!/bin/sh
echo "vercel $*" >> "${calls}"
echo "DATABASE_URL=postgresql://owner:${SECRET}@ep.example/db"
`, { mode: 0o755 });
fs.symlinkSync(join(stubs, "vercel"), join(stubs, "vc"));
const PATH = `${seat}:${stubs}:/usr/bin:/bin`;

// Runs `cmd` in bash from root; stdout is a pipe unless the command redirects it.
function run(cmd, env = {}) {
  fs.rmSync(calls, { force: true });
  const r = spawnSync("bash", ["-c", cmd], { cwd: root, encoding: "utf8", env: { PATH, HOME: join(root, "home"), ...env } });
  const c = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
  return { status: r.status, out: r.stdout, err: r.stderr, calls: c, ran: c.split("\n").filter((l) => l && !l.includes("--help")) };
}
const refused = (r, re = /refused/) => {
  assert.equal(r.status, 2, r.err); assert.match(r.err, re); assert.equal(r.ran.length, 0, r.calls);
  assert.doesNotMatch(r.out + r.err, new RegExp(SECRET));
};
const passed = (r) => { assert.equal(r.status, 0, r.err); assert.equal(r.ran.length, 1, r.calls); };

test("neon cs / connection-string / neonctl cs to a pipe: refused, nothing printed, the CLI never runs", () => {
  for (const c of ["neon cs", "neon connection-string main", "neonctl cs", "neon --project-id p1 cs --pooled", "neon cs -o json"])
    refused(run(c));
});

test("neon cs to a plain `> file` is refused too (Claude Code captures stdout in a regular file); /dev/null runs", () => {
  refused(run("neon cs main > cs.txt"), /a plain `> file` is not enough/);
  assert.equal(fs.readFileSync(join(root, "cs.txt"), "utf8"), "");
  passed(run("neon cs > /dev/null"));
});

test("--output-file: written 0600 (even over a 0644 file), flag stripped, nothing on stdout", () => {
  fs.writeFileSync(join(root, "old.env"), "x"); fs.chmodSync(join(root, "old.env"), 0o644);
  for (const [f, c] of [["new.env", "neon cs main --output-file new.env"], ["old.env", "neon cs --output-file=old.env"]]) {
    const r = run(c);
    passed(r); assert.equal(r.out, ""); assert.doesNotMatch(r.calls, /output-file/);
    assert.match(r.err, /mode 0600/);
    assert.equal(fs.statSync(join(root, f)).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(join(root, f), "utf8"), new RegExp(SECRET));
  }
});

test("--output-file through a symlink or onto a device: refused, nothing written", () => {
  fs.writeFileSync(join(root, "target"), ""); fs.symlinkSync(join(root, "target"), join(root, "link.env"));
  refused(run("neon cs --output-file link.env"), /symlink/);
  assert.equal(fs.readFileSync(join(root, "target"), "utf8"), "");
  refused(run("neon cs --output-file /dev/stdout"));
});

test("an unsupported --no-secrets is refused even to a file; a supported one lets create print to a pipe", () => {
  refused(run("neon cs --no-secrets --output-file cs.txt"), /no --no-secrets in the installed version/);
  refused(run("neon connection-string main --secrets=false"), /no --no-secrets/);
  refused(run("neon branches list --no-secrets"), /no --no-secrets/);
  passed(run("neon projects create --no-secrets"));
  passed(run("neon branches create --name cs --no-secrets"));
});

test("projects/branches create without --no-secrets, and other printing commands: refused on a pipe", () => {
  for (const c of ["neon projects create", "neon branch create --parent main", "neon roles reset-password app",
    "neon role get-password app", "neon credentials reveal t1", "neon credential create", "neon credentials rotate t1",
    "neon api-keys create --name x", "neon api /projects/p1/connection_uri", "neon env pull --file /dev/stdout",
    "neon env pull --file=-", "neon env pull --file /proc/self/fd/1"])
    refused(run(c));
});

test("everything else passes through unchanged", () => {
  for (const c of ["neon branches list", "neon roles list", "neon cs --psql", "neon env pull", "neon env pull --file .env.local",
    "neon me -o json", "neon credentials list", "neon", "neon --help", "neon cs --help"]) {
    const r = run(c);
    assert.equal(r.status, 0, `${c}: ${r.err}`); assert.equal(r.calls.trim().split("\n").length, 1, `${c}: ${r.calls}`);
    assert.equal(r.calls.trim(), c.replace(/^neon/, "neon").trim() || "neon", c);
  }
});

test("vercel/vc: env ls --json / -F json / --decrypt and env pull to stdout refused; normal forms pass", () => {
  for (const c of ["vercel env ls --json", "vercel env list -F json", "vc env ls --format=json", "vercel env ls --decrypt",
    "vercel env pull /dev/stdout", "vc env pull -", "vercel --cwd . env pull /dev/fd/1 --yes"])
    refused(run(c));
  for (const c of ["vercel env ls", "vercel env pull", "vercel env pull .env.local --environment=development", "vercel deploy",
    "vc --version", "vercel env ls --json --output-file vars.json"])
    passed(run(c));
});

test("--output-file on a command that prints no credentials: refused", () => {
  refused(run("neon branches list --output-file x.txt"), /only for commands that print credentials/);
});

test("no real CLI behind the guard: a clear error, no loop", () => {
  const r = spawnSync(join(seat, "neon"), ["branches", "list"], { encoding: "utf8", env: { PATH: `${seat}:/usr/bin:/bin` } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /the real neon is not on PATH/);
});

test("env.sh: seats get neon/vercel functions that win over a PATH where the real CLI comes first; others don't", () => {
  const env = fs.readFileSync(join(repo, "system/env.sh"), "utf8");
  const a = env.indexOf("# Seats: the credential guard"), b = env.indexOf("\nfi\n", a) + 4;
  const block = env.slice(a, b);
  const realFirst = `${stubs}:${seat}:/usr/bin:/bin`;   // as mise-activated shells order it
  const seatRun = run(`${block}\ntype -t neon vercel vc neonctl; neon cs`, { OPENRIG_NODE_ID: "n1", PATH: realFirst });
  assert.match(seatRun.out, /^function\nfunction\nfunction\nfunction\n/);
  refused({ ...seatRun, out: seatRun.out.replace(/function\n/g, "") });
  const own = run(`${block}\ntype -t neon; neon cs`, { PATH: realFirst });
  assert.match(own.out, /^file\n/); assert.equal(own.status, 0);   // the owner's own shell: unchanged
});

test("a harness that captures stdout in a regular file (as Claude Code's Bash tool does): refused, capture stays clean", () => {
  const cap = join(root, "capture.output"); fs.rmSync(calls, { force: true });
  const fd = fs.openSync(cap, "w");
  const r = spawnSync("bash", ["-c", "neon cs main; vercel env ls --json"],
    { cwd: root, stdio: ["ignore", fd, fd], env: { PATH, HOME: join(root, "home") } });
  fs.closeSync(fd);
  const text = fs.readFileSync(cap, "utf8");
  assert.equal(r.status, 2); assert.match(text, /refused/); assert.doesNotMatch(text, new RegExp(SECRET));
  assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l && !l.includes("--help")).length : 0, 0);
});
