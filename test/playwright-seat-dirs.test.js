// WO83: every seat's Playwright MCP writes to its own dir (agent-playwright-mcp), and an hourly timer ages the files
// out (agent-playwright-retention): 48 h, sooner for client-data rigs. Throwaway HOMEs; npx is never run (dry mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "pwseat-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const home = () => { const h = join(root, `h${++n}`); fs.mkdirSync(h); return h; };
const PW = (h) => join(h, ".local/state/agent-stack/playwright-mcp");
const ARGS = ["-y", "@playwright/mcp@0.0.80", "--headless", "--browser", "chromium", "--secrets", "/s/playwright.env"];
const launch = (h, env = {}, args = ARGS) => spawnSync(join(repo, "bin/agent-playwright-mcp"), args,
  { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h, AGENT_PLAYWRIGHT_MCP_DRY: "1", ...env } });
const mode = (p) => fs.statSync(p).mode & 0o777;

test("launcher: the seat's own output dir (0700, with net/), any --output-dir given replaced, the rest passed on", () => {
  const h = home();
  const r = launch(h, { OPENRIG_SESSION_NAME: "qa-codex-1@shop" }, [...ARGS, "--output-dir", "/shared", "--output-dir=/other"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `npx ${ARGS.join(" ")} --caps devtools --output-dir ${join(PW(h), "qa-codex-1@shop")}`);
  for (const d of [PW(h), join(PW(h), "qa-codex-1@shop"), join(PW(h), "qa-codex-1@shop/net")]) assert.equal(mode(d), 0o700, d);
  assert.match(launch(h, { OPENRIG_SESSION_NAME: "a b/../x@y" }).stdout, /playwright-mcp\/a_b_.._x@y$/m, "a seat name can't leave the dir");
  // QA PR87: dot-only names can't name the parent dirs
  for (const [name, dirName] of [["..", "_."], [".", "_"], [".hidden@x", "_hidden@x"]]) {
    const out = launch(h, { OPENRIG_SESSION_NAME: name }).stdout.trim();
    assert.ok(out.endsWith(`--output-dir ${join(PW(h), dirName)}`), `${name}: ${out}`);
  }
  const noProc = join(root, `noproc${n}`); fs.mkdirSync(noProc);   // no ancestor with a seat (these tests may run inside one)
  assert.match(launch(h, { AGENT_PLAYWRIGHT_MCP_PROC: noProc }).stdout.trim(), /playwright-mcp\/local$/, "no seat (the operator's shell, a human): local");
});

test("launcher: the devtools capability (browser_start_video) is always on; caps already given are kept, devtools once", () => {
  const h = home(), env = { OPENRIG_SESSION_NAME: "witness-codex@shop" };
  const caps = (extra) => launch(h, env, [...ARGS, ...extra]).stdout.trim().match(/ --caps (\S+) --output-dir /)?.[1];
  assert.equal(caps([]), "devtools");
  assert.equal(caps(["--caps", "vision,pdf"]), "vision,pdf,devtools");
  assert.equal(caps(["--caps=pdf"]), "pdf,devtools");
  assert.equal(caps(["--caps", "devtools,vision"]), "devtools,vision");
  assert.equal(launch(h, env, [...ARGS, "--caps", "pdf"]).stdout.match(/--caps/g).length, 1, "one --caps");
});

test("launcher: a runtime that strips the environment (Codex) still gets the seat, from the nearest ancestor that has it", () => {
  const h = home();
  // a real ancestor: the shell has the seat in its environment; the launcher, started with the variable removed, reads it
  const r = spawnSync("sh", ["-c", `env -u OPENRIG_SESSION_NAME ${join(repo, "bin/agent-playwright-mcp")} -y x; true`],   // "; true": sh stays the parent
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h, AGENT_PLAYWRIGHT_MCP_DRY: "1", OPENRIG_SESSION_NAME: "impl-codex-2@shop" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /playwright-mcp\/impl-codex-2@shop$/);
  // and through a /proc stand-in: parent without it, grandparent with it
  // and through a /proc stand-in: the launcher (start 9000) ← its parent without a seat (8000) ← a grandparent with one
  const proc = join(root, `proc${n}`), gp = 424242;
  const stat = (pid, ppid, start) => `${pid} (x) S ${ppid} 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start} 0`;
  const entry = (pid, env, ppid, start) => { fs.mkdirSync(join(proc, String(pid)), { recursive: true }); fs.writeFileSync(join(proc, String(pid), "environ"), env.join("\0") + "\0");
    fs.writeFileSync(join(proc, String(pid), "stat"), stat(pid, ppid, start)); };
  const run2 = (gpStart) => {
    // the launcher's own pid and its parent's are only known at run time: a tiny wrapper writes them, then execs it
    fs.rmSync(proc, { recursive: true, force: true });
    const w = join(root, `wrap${n}.sh`);
    fs.writeFileSync(w, `#!/bin/sh\nmkdir -p ${proc}/$$ ${proc}/$PPID\nprintf '%s (sh) S %s 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 9000 0' $$ $PPID > ${proc}/$$/stat\nprintf 'PATH=/bin\\0' > ${proc}/$$/environ\nprintf '%s (node) S ${gp} 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 8000 0' $PPID > ${proc}/$PPID/stat\nprintf 'PATH=/bin\\0' > ${proc}/$PPID/environ\nexec ${join(repo, "bin/agent-playwright-mcp")} -y x\n`, { mode: 0o755 });
    entry(gp, ["HOME=/h", "OPENRIG_SESSION_NAME=review-claude-1@shop"], 1, gpStart);
    return spawnSync(w, [], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h, AGENT_PLAYWRIGHT_MCP_DRY: "1", AGENT_PLAYWRIGHT_MCP_PROC: proc } }).stdout.trim();
  };
  assert.match(run2(7000), /playwright-mcp\/review-claude-1@shop$/, "an ancestor that started before its child");
  // QA PR87: a pid reused by a newer process (it started after the child that names it as parent) is not an ancestor
  assert.match(run2(9999), /playwright-mcp\/local$/, "a reused pid ends the walk: local, never another process's seat");
});

// ---- retention ------------------------------------------------------------------------------------------------------
const ret = (h, args = [], env = {}) => spawnSync(join(repo, "bin/agent-playwright-retention"), args, { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h, ...env } });
const put = (p, hoursOld, body = "x") => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, body); const t = Date.now() / 1000 - hoursOld * 3600; fs.utimesSync(p, t, t); return p; };

test("retention: 48 h by default, client-data rigs sooner; seat dirs and their net/ stay; links are removed, never followed", () => {
  const h = home(), pw = PW(h);
  const old = put(join(pw, "qa-1@shop/page-old.yml"), 50), fresh = put(join(pw, "qa-1@shop/page-new.yml"), 10);
  const netOld = put(join(pw, "qa-1@shop/net/requests-1.log"), 49), nested = put(join(pw, "qa-1@shop/sub/deep/shot.png"), 60);
  const client = put(join(pw, "impl-1@clientco/page.yml"), 7), clientFresh = put(join(pw, "impl-1@clientco/page2.yml"), 2);
  const outside = put(join(h, "outside/keep.txt"), 100);
  fs.symlinkSync(outside, join(pw, "qa-1@shop/link")); const t = Date.now() / 1000 - 99 * 3600; fs.lutimesSync(join(pw, "qa-1@shop/link"), t, t);
  const dry = ret(h, ["--dry-run"], { CLIENT_DATA_RIGS: "clientco" });
  assert.equal(dry.status, 0, dry.stderr); assert.match(dry.stdout, /would delete 5 files/);
  assert.ok([old, netOld, nested, client].every((f) => fs.existsSync(f)), "a dry run deletes nothing");
  const r = ret(h, [], { CLIENT_DATA_RIGS: "clientco" });
  assert.equal(r.status, 0, r.stderr);
  for (const f of [old, netOld, nested, client]) assert.ok(!fs.existsSync(f), f);
  for (const f of [fresh, clientFresh, outside]) assert.ok(fs.existsSync(f), f);
  assert.ok(!fs.existsSync(join(pw, "qa-1@shop/link")), "the old link itself is gone; its target is untouched");
  assert.ok(fs.existsSync(join(pw, "qa-1@shop/net")), "the seat's net/ dir stays (the guard allows writes only there)");
  assert.ok(!fs.existsSync(join(pw, "qa-1@shop/sub")), "emptied subdirs go");
  assert.match(r.stdout, /older than 6 h in ~\/.*impl-1@clientco/); assert.match(r.stdout, /keep 48 h, client-data rigs 6 h \(clientco\), unattributed 48 h/);
});

test("retention: settings from its file (overridden by the environment); bad values and unknown arguments refused", () => {
  const h = home(), pw = PW(h);
  fs.mkdirSync(join(h, ".config/agent-stack"), { recursive: true });
  fs.writeFileSync(join(h, ".config/agent-stack/playwright-retention.env"), "KEEP_HOURS=24\nCLIENT_DATA_HOURS=1\nCLIENT_DATA_RIGS=\"alpha beta\"\n");
  const a = put(join(pw, "x@alpha/a.yml"), 2), b = put(join(pw, "x@gamma/b.yml"), 30), c = put(join(pw, "x@gamma/c.yml"), 20);
  assert.equal(ret(h).status, 0);
  assert.deepEqual([a, b, c].map((f) => fs.existsSync(f)), [false, false, true]);
  const d = put(join(pw, "x@gamma/d.yml"), 20);
  assert.equal(ret(h, [], { KEEP_HOURS: "12" }).status, 0); assert.ok(!fs.existsSync(d), "the environment wins");
  assert.notEqual(ret(h, [], { KEEP_HOURS: "soon" }).status, 0);
  assert.notEqual(ret(h, [], { CLIENT_DATA_HOURS: "0" }).status, 0);
  assert.equal(ret(h, ["--force"]).status, 2);
  assert.equal(ret(home()).status, 0, "no MCP dir yet: nothing to do");
});

test("retention --migrate: old top-level files move (never deleted, never into a link); the old net/ tree and recent files stay for running seats", () => {
  const h = home(), pw = PW(h);
  const top = put(join(pw, "page-2026-10-01T10-00-00.yml"), 80, "snapshot"), recent = put(join(pw, "page-just-now.png"), 0.1, "fresh");
  const net = put(join(pw, "net/qa-1@shop/requests-1.log"), 80, "raw"), seat = put(join(pw, "qa-1@shop/page.yml"), 1);
  const r = ret(h, ["--migrate"]);
  assert.equal(r.status, 0, r.stderr);
  const day = new Date().toISOString().slice(0, 10), dest = join(pw, `unattributed-${day}`);
  assert.match(r.stdout, /moved 1 entries into ~\/.*unattributed-/);
  assert.equal(fs.readFileSync(join(dest, "page-2026-10-01T10-00-00.yml"), "utf8"), "snapshot", "moved, not deleted (even though 80 h old)");
  assert.equal(mode(dest), 0o700);
  assert.ok(!fs.existsSync(top) && fs.existsSync(seat));
  assert.ok(fs.existsSync(recent), "a file an old MCP wrote in the last hour stays (its seat may still copy it)");
  assert.ok(fs.existsSync(net), "the old net/ tree stays: seats on an old MCP still write there until they relaunch");
  put(join(pw, "page-later.yml"), 2, "again");
  assert.match(ret(h, ["--migrate"]).stdout, /moved 1 entries/, "re-runnable; an existing name is never overwritten");
  assert.match(ret(h, ["--migrate"]).stdout, /nothing to migrate/);
  // the hourly run ages it all: the moved files, the old net/ tree, stray top-level files an old MCP keeps writing
  const stray = put(join(pw, "page-stray.yml"), 60);
  assert.equal(ret(h).status, 0);
  for (const f of [join(dest, "page-2026-10-01T10-00-00.yml"), net, stray]) assert.ok(!fs.existsSync(f), f);
  assert.ok(fs.existsSync(recent) && fs.existsSync(join(pw, "net")), "recent files and the net/ dir itself stay");
});

test("retention (QA PR87): never through a link: a symlinked MCP dir and a linked unattributed-* destination are refused; non-finite hours refused", () => {
  const h = home(), outside = join(h, "outside");
  const victim = put(join(outside, "qa@demo/keep.txt"), 70);
  fs.mkdirSync(dirname(PW(h)), { recursive: true }); fs.symlinkSync(outside, PW(h));
  for (const args of [[], ["--migrate"]]) {
    const r = ret(h, args);
    assert.notEqual(r.status, 0, args.join(" ")); assert.match(r.stderr, /is a symbolic link: refusing/);
  }
  assert.ok(fs.existsSync(victim), "nothing outside was deleted");
  const h2 = home(), pw2 = PW(h2), elsewhere = join(h2, "elsewhere");
  fs.mkdirSync(elsewhere, { mode: 0o755 }); fs.chmodSync(elsewhere, 0o755);
  const page = put(join(pw2, "page.yml"), 5);
  fs.symlinkSync(elsewhere, join(pw2, `unattributed-${new Date().toISOString().slice(0, 10)}`));
  const m = ret(h2, ["--migrate"]);
  assert.notEqual(m.status, 0); assert.match(m.stderr, /not a plain directory \(a link\?\): refusing/);
  assert.ok(fs.existsSync(page) && fs.readdirSync(elsewhere).length === 0 && mode(elsewhere) === 0o755, "nothing moved, the link target's mode untouched");
  for (const v of ["nan", "inf", "-inf", "NaN"]) assert.notEqual(ret(home(), [], { KEEP_HOURS: v }).status, 0, v);
  assert.notEqual(ret(home(), [], { CLIENT_DATA_HOURS: "inf" }).status, 0);
});

test("retention: UNATTRIBUTED_HOURS ages what no seat can be told for (top-level files, the old net/ tree, unattributed-*); unset, it is KEEP_HOURS", () => {
  const make = () => {
    const h = home(), pw = PW(h), day = new Date().toISOString().slice(0, 10);
    return { h, files: { top: put(join(pw, "page-old.yml"), 7), net: put(join(pw, "net/x@client/requests-1.log"), 7), moved: put(join(pw, `unattributed-${day}/page.yml`), 7),
      seat: put(join(pw, "qa-1@shop/page.yml"), 7), fresh: put(join(pw, "page-new.yml"), 1) } };
  };
  const a = make();
  assert.equal(ret(a.h).status, 0);
  assert.ok(Object.values(a.files).every((f) => fs.existsSync(f)), "unset: 48 h for everything, 7 h old files stay");
  const b = make();
  const r = ret(b.h, [], { UNATTRIBUTED_HOURS: "6" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.fromEntries(Object.entries(b.files).map(([k, f]) => [k, fs.existsSync(f)])), { top: false, net: false, moved: false, seat: true, fresh: true });
  assert.match(r.stdout, /unattributed 6 h$/m);
  assert.ok(fs.existsSync(join(PW(b.h), "net")), "the old net/ dir itself stays for seats still on an old MCP");
  for (const v of ["nan", "inf", "0", "-1", "soon"]) assert.notEqual(ret(home(), [], { UNATTRIBUTED_HOURS: v }).status, 0, v);
  assert.equal(ret(home(), [], { UNATTRIBUTED_HOURS: "" }).status, 0, "empty means the default");
  // QA PR91: a seat whose name starts with "unattributed-" is a seat: its rig's window, not the unattributed one
  const c = home(), seatish = put(join(PW(c), "unattributed-review@normal/old.yml"), 7), arch = put(join(PW(c), "unattributed-2026-10-01/old.yml"), 7);
  assert.equal(ret(c, [], { KEEP_HOURS: "48", UNATTRIBUTED_HOURS: "6" }).status, 0);
  assert.deepEqual([fs.existsSync(seatish), fs.existsSync(arch)], [true, false]);
});

test("wiring: install.sh links both tools, enables the hourly timer, migrates once per apply; the units and guidance say so", () => {
  const s = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(s, /agent-playwright-mcp agent-playwright-retention; do link "\$S\/bin\/\$f"/);
  assert.match(s, /agent-playwright-retention playwright-browsers; do systemctl --user enable --now/);
  assert.match(s, /"\$B\/agent-playwright-retention" --migrate/);
  assert.match(fs.readFileSync(join(repo, "system/systemd/agent-playwright-retention.timer"), "utf8"), /OnUnitActiveSec=1h/);
  assert.match(fs.readFileSync(join(repo, "system/systemd/agent-playwright-retention.service"), "utf8"), /ExecStart=%h\/\.local\/bin\/agent-playwright-retention$/m);
  const qa = fs.readFileSync(join(repo, "rig/template/agents/qa/guidance/role.md"), "utf8");
  assert.match(qa, /playwright-mcp\/<your seat>\/net\//);
  assert.match(qa, /copy it into the slice's proof dir/);
});
