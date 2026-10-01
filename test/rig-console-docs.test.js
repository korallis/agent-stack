// WO86: the README's rig-console section can't rot. Every line of its "Runs from a checkout" block runs here, from the
// repo root, on the demo fleet (interactive ones also with --once, since a test has no terminal); the ':' commands it
// names run against the console's own command handler; and console/docs/make-assets.mjs renders every image and demo
// frame from the fixture (--check: HTML only, no browser) and finds each one the README shows, on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(join(repo, "README.md"), "utf8");
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const console_ = (args) => spawnSync(process.execPath, [join(repo, "console/src/main.ts"), ...args],
  { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: join(repo, "nonexistent-home") }, timeout: 30_000 });

const block = [...readme.matchAll(/```bash\n(# Runs from a checkout[\s\S]*?)```/g)].map((m) => m[1]);
const lines = block.flatMap((b) => b.split("\n")).map((l) => l.replace(/\s+#\s.*$/, "").trim()).filter((l) => l && !l.startsWith("#"));

test("README: the rig-console examples run from a checkout on the demo fleet", () => {
  assert.equal(block.length, 1, "one 'Runs from a checkout' block");
  assert.deepEqual(lines[0], "cd ~/Projects/agent-stack");
  const runs = lines.slice(1);
  assert.ok(runs.length >= 5 && runs.every((l) => l.startsWith("rig-console ")), runs.join("\n"));
  for (const line of runs) {
    const args = line.split(/\s+/).slice(1);
    assert.ok(args.includes("--fixture") && fs.existsSync(join(repo, args[args.indexOf("--fixture") + 1])), `${line}: the demo fleet`);
    const once = args.includes("--once") ? args : [...args, "--once", "--size", "176x50"];
    const r = console_([...once, "--color", "0"]);
    assert.equal(r.status, 0, `${line}\n${r.stderr}`);
    const out = plain(r.stdout);
    assert.match(out, /OPENRIG/, `${line}: a frame`);
    const view = args.includes("--seat") ? null : (args[args.indexOf("--view") + 1] ?? "home");
    const title = { home: "MISSION CONTROL", matrix: "SEAT MATRIX", river: "RIVER", focus: "FOCUS", pool: "POOL" }[view];
    if (title) assert.match(out, new RegExp(title), `${line}: the ${view} view`);
    if (args.includes("--seat")) assert.match(out, /LIVE TERMINAL/, `${line}: the seat's drill-in`);
    if (args.includes("--theme")) assert.match(out, /theme Tokyo Night/, `${line}: the theme`);
  }
});

test("README: the ':' commands it names work", async () => {
  const { runCommand } = await import(join(repo, "console/src/main.ts"));
  const fixture = JSON.parse(fs.readFileSync(join(repo, "docs/fixtures/demo-fleet.json"), "utf8"));
  const named = [...readme.matchAll(/`:(stuck \d+|theme [a-z-]+)`/g)].map((m) => m[1]);
  assert.deepEqual(named.sort(), ["stuck 10", "theme nord"]);
  const st = { view: 0, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, theme: "pad39a" };
  assert.match(runCommand(st, "stuck 10", fixture.raw), /stuck after 10 quiet minutes/); assert.equal(st.stuckMinutes, 10);
  runCommand(st, "theme nord", fixture.raw); assert.equal(st.theme, "nord");
  // the keys table lists only keys the console handles
  for (const k of ["1` to `5", "Tab", "`e`", "`:`", "`⏎`", "`[` `]`", "`esc`", "`r`", "`?`", "`q`"]) assert.ok(readme.includes(`| ${k.startsWith("`") ? k : "`" + k + "`"}`), k);
});

test("docs assets: the script renders every image and demo frame from the fixture, and the README shows each one", async () => {
  const r = spawnSync(process.execPath, [join(repo, "console/docs/make-assets.mjs"), "--check"], { cwd: repo, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^rendered 13 images and 11 demo frames from docs\/fixtures\/demo-fleet\.json$/m);
  // each image and tour frame says what it must show, and --check holds it to that (QA PR98: a "journey" that wasn't)
  const { SHOTS, DEMO } = await import(join(repo, "console/docs/make-assets.mjs"));
  for (const s of [...SHOTS, ...DEMO.steps]) assert.ok(s.expect instanceof RegExp, JSON.stringify(s.keys ?? s.st));
  assert.deepEqual(SHOTS.find((s) => s.name === "river-journey").never, /loading/);
  const dir = join(repo, "docs/assets/rig-console"), files = fs.readdirSync(dir);
  assert.deepEqual(files.filter((f) => !/\.(png|gif)$/.test(f)), [], "images only");
  const bytes = files.reduce((n, f) => n + fs.statSync(join(dir, f)).size, 0);
  assert.ok(bytes < 3 * 1024 * 1024, `assets stay small: ${bytes} bytes`);
  // the images come from the neutral fixture only, which carries no paths, links or addresses
  assert.match(fs.readFileSync(join(repo, "console/docs/make-assets.mjs"), "utf8"), /export const FIXTURE = "docs\/fixtures\/demo-fleet\.json"/);
  assert.doesNotMatch(fs.readFileSync(join(repo, "docs/fixtures/demo-fleet.json"), "utf8"), /\/home\/|\/Users\/|github\.com|@[a-z]+\.(com|io|dev)\b/i);
});
