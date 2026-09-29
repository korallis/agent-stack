// agent-heavy: long-lived servers are refused (they held both build slots indefinitely, 2026-09-29), and every job has
// a max runtime so a hung or endless one can't keep a slot. Stub-only: systemd-run is faked (it records its args and
// enforces RuntimeMaxSec with `timeout`); the slot locks live in a throwaway XDG_RUNTIME_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "heavy-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin"), calls = join(root, "calls");
fs.mkdirSync(bin);
fs.writeFileSync(join(bin, "systemd-run"), `#!/usr/bin/env bash
printf '%s\\n' "systemd-run $*" >> "${calls}"
max=""; while [ "$1" != "--" ]; do case $1 in RuntimeMaxSec=*) max=\${1#RuntimeMaxSec=};; esac; shift; done; shift
exec timeout "$max" "$@"
`, { mode: 0o755 });

const heavy = (args, env = {}) => {
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/agent-heavy"), args, { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", ...env } });
  return { ...r, c: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
};

test("obvious servers are refused before taking a slot, with a clear message", () => {
  for (const cmd of [
    ["npm", "run", "start:test"], ["npm", "start"], ["npm", "run", "dev"], ["pnpm", "dev"], ["yarn", "serve"],
    ["bun", "run", "preview"], ["pnpm", "run", "dev:web"], ["npx", "next", "start"], ["npx", "-y", "next", "dev"],
    ["pnpm", "exec", "next", "start"], ["next", "dev"], ["./node_modules/.bin/next", "start"], ["vite"],
    ["npx", "vite", "--port", "3000"], ["vite", "preview"], ["npx", "serve", "dist"], ["http-server", "."],
    ["PORT=3001", "npm", "run", "start:test"], ["env", "PORT=3001", "next", "start"],
  ]) {
    const r = heavy(["build", "--", ...cmd]);
    assert.equal(r.status, 2, cmd.join(" "));
    assert.match(r.stderr, /looks like a long-lived server\. Run servers outside agent-heavy.*re-run with --allow-long/s, cmd.join(" "));
    assert.equal(r.c, "", `${cmd.join(" ")}: no slot taken`);
  }
});

test("finite jobs still run: tests, builds, tsc, eslint, playwright, next build, vite build", () => {
  for (const cmd of [["npm", "test"], ["npm", "run", "build"], ["npm", "run", "test:unit"], ["npx", "tsc", "--noEmit"],
    ["npx", "eslint", "."], ["npx", "playwright", "test"], ["next", "build"], ["npx", "vite", "build"], ["pnpm", "run", "lint"],
    ["npm", "run", "startup-check"], ["vitest", "run"]]) {
    const stubbed = join(bin, cmd[0] === "npx" ? "npx" : cmd[0]);
    if (!fs.existsSync(stubbed)) fs.writeFileSync(stubbed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = heavy(["build", "--", ...cmd]);
    assert.equal(r.status, 0, `${cmd.join(" ")}: ${r.stderr}`);
    assert.match(r.c, /^systemd-run --user --scope/m, cmd.join(" "));
  }
});

test("--allow-long lifts the refusal, but the max runtime still applies", () => {
  const r = heavy(["browser", "--allow-long", "--", "npm", "run", "start:test"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.c, / -p RuntimeMaxSec=1800 /);
});

test("every job gets a max runtime: 45min build, 30min browser, configurable, and --max-runtime per call", () => {
  assert.match(heavy(["build", "--", "true"]).c, / -p RuntimeMaxSec=2700 /);
  assert.match(heavy(["browser", "--", "true"]).c, / -p RuntimeMaxSec=1800 /);
  assert.match(heavy(["build", "--", "true"], { AGENT_HEAVY_BUILD_MAX_RUNTIME: "2h" }).c, / -p RuntimeMaxSec=7200 /);
  assert.match(heavy(["browser", "--max-runtime", "90", "--", "true"]).c, / -p RuntimeMaxSec=90 /);
  assert.match(heavy(["build", "--max-runtime", "10m", "--", "true"]).c, / -p RuntimeMaxSec=600 /);
  const bad = heavy(["build", "--max-runtime", "soon", "--", "true"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad max runtime 'soon'/);
  assert.equal(heavy(["build", "--max-runtime", "0", "--", "true"]).status, 2);
});

test("a job that hits the max runtime is stopped, says so, and frees its slot", () => {
  const t0 = Date.now();
  const r = heavy(["build", "--max-runtime", "1", "--", "sleep", "30"]);
  assert.ok(Date.now() - t0 < 10000, "stopped at the limit, not after the job");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stopped: reached the build max runtime \(1\)/);
  // the slot is free again: two quick jobs run back to back without waiting
  assert.equal(heavy(["build", "--wait", "1", "--", "true"]).status, 0);
  assert.equal(heavy(["build", "--wait", "1", "--", "true"]).status, 0);
  // an ordinary failure is not reported as a timeout
  const fail = heavy(["build", "--", "false"]);
  assert.equal(fail.status, 1);
  assert.doesNotMatch(fail.stderr, /max runtime/);
});

test("the seat rules say servers stay outside agent-heavy and jobs have a max runtime", () => {
  const rules = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8").split(/^## /m).find(s => s.startsWith("Operating rules"));
  assert.match(rules, /Never wrap a server/);
  assert.match(rules, /max runtime \(45min build, 30min browser/);
  const agents = fs.readFileSync(join(repo, "starter-kit/AGENTS.md"), "utf8");
  assert.match(agents, /`npm run start:test`, run directly and never inside agent-heavy/);
});
