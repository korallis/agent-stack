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
  refused(run("neon cs --no-secrets --output-file cs.txt"), /no --no-secrets\/--secrets in the installed version/);
  refused(run("neon connection-string main --secrets=false"), /no --no-secrets/);
  refused(run("neon branches list --no-secrets"), /no --no-secrets/);
  passed(run("neon projects create --no-secrets"));
  passed(run("neon branches create --name feature-1 --no-secrets"));
  refused(run("neon branches create --name cs --no-secrets"));   // a value equal to a guarded word: guarded side
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


test("booleans read the way yargs reads them (QA round 1): negations, =values, a following true/false, last one wins", () => {
  for (const c of ["neon cs --psql=false", "neon cs --psql false", "neon cs --psql --no-psql", "neon cs --psql=1",
    "neon cs --help=false", "neon cs --version=false", "neon cs --help --no-help", "neon cs --help false",
    "neon projects create --no-secrets --secrets=true", "neon projects create --no-secrets --secrets",
    "neon projects create --no-secrets=false", "neon projects create --secrets=0"])
    refused(run(c));
  for (const c of ["neon cs --psql", "neon cs --psql true", "neon cs --no-psql --psql", "neon projects create --secrets --no-secrets",
    "neon projects create --secrets=false"])
    passed(run(c));
  const h = run("neon cs --help"); assert.equal(h.status, 0); assert.match(h.calls, /cs --help/);
});

test("an option the guard doesn't know can't hide a command word (QA round 1: --client-id projects cs)", () => {
  for (const c of ["neon --client-id projects cs", "neon --whatever x api /projects", "neon role --zzz y create",
    "neon credentials --q z reveal t1"])
    refused(run(c));
});

test("roles create is guarded: -o json/yaml prints the whole role, password included (QA round 1)", () => {
  for (const c of ["neon roles create --name app", "neon role create -o json", "neon roles create --output yaml"]) refused(run(c));
  passed(run("neon roles create --name app --output-file role.json"));
});

test("destinations are checked where the CLI really writes (QA round 1): default env file, --cwd, links to the capture", () => {
  const d = join(root, "wt"); fs.mkdirSync(join(d, "nested"), { recursive: true });
  const cap = join(root, "capture2.output");
  const inHarness = (cmd) => {   // stdout+stderr go to a regular capture file, as in Claude Code's Bash tool
    fs.rmSync(calls, { force: true });
    const fd = fs.openSync(cap, "w");
    const r = spawnSync("bash", ["-c", cmd], { cwd: d, stdio: ["ignore", fd, fd], env: { PATH, HOME: join(root, "home") } });
    fs.closeSync(fd);
    const c = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
    return { status: r.status, out: "", err: fs.readFileSync(cap, "utf8"), calls: c, ran: c.split("\n").filter((l) => l && !l.includes("--help")) };
  };
  fs.symlinkSync(cap, join(d, ".env.local"));
  refused(inHarness("neon env pull"), /open as this command/);            // default target .env.local -> the capture
  fs.symlinkSync("/dev/stdout", join(d, ".env"));
  refused(inHarness("neon env pull"), /open as this command|device|not a regular/);           // .env exists, so it is the default
  fs.symlinkSync(cap, join(d, "nested/vars.env"));
  refused(inHarness("vercel --cwd nested env pull vars.env --yes"), /open as this command/);
  refused(inHarness("vercel env pull --cwd=nested vars.env"), /open as this command/);
  fs.linkSync(cap, join(d, "hard.env"));
  refused(inHarness("neon cs --output-file hard.env"), /open as this command/);
  fs.rmSync(join(d, ".env")); fs.rmSync(join(d, ".env.local"));
  fs.writeFileSync(join(d, ".env.local"), "A=1\n"); fs.symlinkSync(join(d, ".env.local"), join(d, "nested/.env.local"));
  const ok = inHarness("neon env pull; vercel --cwd nested env pull");    // plain files, and a link to one (the worktree case)
  assert.equal(ok.status, 0, ok.err); assert.equal(ok.ran.length, 2, ok.calls);
});

// The installed neon's own yargs-parser as the oracle (QA round 2): whenever it reads an argv so that the command would
// print a secret, the guard must refuse. Every single and pair of boolean spellings. Skipped where neon isn't installed.
const oracleDir = [process.env.CREDGUARD_YARGS_PARSER,
  ...(() => { const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }); return r.status === 0 ? [join(r.stdout.trim(), "neon/node_modules/yargs-parser")] : []; })()]
  .find((p) => p && fs.existsSync(join(p, "package.json")));
test("guard vs the installed yargs-parser: every spelling that would print is refused", { skip: !oracleDir && "no installed yargs-parser" }, async () => {
  const pkg = JSON.parse(fs.readFileSync(join(oracleDir, "package.json"), "utf8"));
  const entry = typeof pkg.exports?.["."] === "object" ? (pkg.exports["."].import?.default ?? pkg.exports["."].import ?? pkg.main) : pkg.main;
  const parser = (await import(join(oracleDir, typeof entry === "string" ? entry : "build/lib/index.js"))).default;
  const cfg = { boolean: ["psql", "secrets", "help", "version"], default: { secrets: true, psql: false } };
  const forms = (x) => [`--${x}`, `--${x} true`, `--${x} false`, `--${x}=true`, `--${x}=false`, `--${x}=1`, `--${x}=0`,
    `--no-${x}`, `--no-${x}=true`, `--no-${x}=false`, `--no-${x} true`, `--no-${x} false`];
  const combos = (x) => { const f = forms(x); return [...f.map((a) => [a]), ...f.flatMap((a) => f.map((b) => [a, b]))]; };
  const cases = [
    ...combos("psql").map((c) => ["cs", ...c.join(" ").split(" ")]),
    ...combos("secrets").map((c) => ["projects", "create", ...c.join(" ").split(" ")]),
    ...forms("help").map((c) => ["cs", ...c.split(" ")]), ...forms("version").map((c) => ["cs", ...c.split(" ")]),
  ];
  const leaks = [];
  for (const argv of cases) {
    const o = parser(argv, cfg);
    const prints = o.help !== true && o.version !== true && (argv[0] === "cs" ? o.psql !== true : o.secrets !== false);
    if (!prints) continue;
    fs.rmSync(calls, { force: true });
    const r = spawnSync(join(seat, "neon"), argv, { cwd: root, encoding: "utf8", env: { PATH, HOME: join(root, "home") } });
    if (r.status !== 2 || new RegExp(SECRET).test(r.stdout + r.stderr)) leaks.push(argv.join(" "));
  }
  assert.deepEqual(leaks, []);
});

test("vercel env pull: words after -- are targets too (QA round 2)", () => {
  for (const c of ["vercel env pull -- /dev/stdout", "vercel env pull -- /proc/self/fd/1", "vc env pull .env.local -- -"])
    refused(run(c));
  passed(run("vercel env pull -- .env.local"));
});

test("post-install canary: --credguard-status answers from the guard and never reaches the CLI", () => {
  for (const t of ["neon", "neonctl", "vercel", "vc"]) {
    const r = run(`${t} --credguard-status --help`);
    assert.equal(r.status, 0); assert.match(r.out, /seat guard\): active/); assert.equal(r.calls, "");
  }
});
