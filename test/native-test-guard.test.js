// The test guard for native seats (grok, kimi): their CLIs run no PreToolUse hook of ours, so agent-native-seat puts
// system/native-test-guard/bin first on the CLI's PATH. A test runner started outside agent-heavy is refused with the
// hook's own message; anything else (and anything inside agent-heavy) runs the real program with its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const guard = join(repo, "system/native-test-guard/bin");
const root = fs.mkdtempSync(join(os.tmpdir(), "native-guard-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// stand-ins for the real programs (after the guard on PATH): each prints its name and arguments
const real = join(root, "real"); fs.mkdirSync(real);
const NAMES = ["npm", "npx", "pnpm", "yarn", "bun", "python3", "pytest", "vitest", "jest", "mocha", "go", "cargo", "deno"];
for (const n of NAMES) fs.writeFileSync(join(real, n), `#!/bin/sh\necho "real ${n} $*"\n`, { mode: 0o755 });
const nodeDir = dirname(process.execPath);
const run = (argv, env = {}) => spawnSync(argv[0], argv.slice(1), { encoding: "utf8",
  env: { PATH: `${guard}:${real}:${nodeDir}:/usr/bin:/bin`, ...env } });

test("every guarded name links to the one guard script", () => {
  for (const n of ["node", ...NAMES, "python"]) assert.equal(fs.readlinkSync(join(guard, n)), "../guard", n);
});

test("outside agent-heavy a test run is refused with the hook's message, and the real program never runs", () => {
  for (const argv of [["node", "--test", "x.js"], ["npm", "test"], ["npm", "run", "test:unit"], ["pnpm", "--filter", "web", "test"], ["yarn", "test:e2e"],
    ["bun", "test"], ["npx", "vitest", "run"], ["npx", "playwright", "test"], ["python3", "-m", "pytest", "-q"], ["pytest"], ["vitest", "run"],
    ["jest", "--maxWorkers=2"], ["mocha"], ["go", "test", "./..."], ["cargo", "test"], ["deno", "test"]]) {
    const r = run(argv);
    assert.equal(r.status, 126, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /^real /m, `${argv.join(" ")}: the real program didn't run`);
    assert.match(r.stderr.replace(/\s+/g, " "), /agent-stack test guard: blocked, because .* runs tests outside agent-heavy/, argv.join(" "));
    assert.match(r.stderr, /agent-heavy test -- <this command>/);
  }
});

test("anything else, and every call inside agent-heavy, runs the real program with its arguments", () => {
  for (const argv of [["npm", "run", "build"], ["npm", "install"], ["npx", "tsc", "--noEmit"], ["python3", "-c", "print(1)"], ["go", "build", "./..."],
    ["cargo", "build"], ["npm", "run", "lint", "--", "a b"]]) {
    const r = run(argv);
    assert.equal(r.status, 0, argv.join(" ")); assert.equal(r.stdout.trim(), `real ${argv.join(" ")}`);
  }
  const n = run(["node", "-e", "console.log(process.argv.slice(1).join('|'))", "a", "b c"]);
  assert.equal(n.status, 0); assert.equal(n.stdout.trim(), "a|b c", "node itself, arguments intact");
  const inside = { AGENT_HEAVY_SLOT: "test.1", AGENT_HEAVY_REAL_HOME: "/home/x" };
  for (const argv of [["npm", "test"], ["go", "test", "./..."], ["pytest", "-q"]]) {
    const r = run(argv, inside);
    assert.equal(r.status, 0, argv.join(" ")); assert.equal(r.stdout.trim(), `real ${argv.join(" ")}`);
  }
  // one marker alone (a leaked AGENT_HEAVY_SLOT outside the sandbox) is not enough
  assert.equal(run(["npm", "test"], { AGENT_HEAVY_SLOT: "test.1" }).status, 126);
});

test("a name with no real program behind the guard says so (127), and the guard never finds itself", () => {
  const r = spawnSync(join(guard, "vitest"), ["--version"], { encoding: "utf8", env: { PATH: `${guard}:/nonexistent:/usr/bin:/bin` } });
  assert.equal(r.status, 127); assert.match(r.stderr, /vitest: command not found/);
});

test("agent-native-seat puts the guard first on the CLI's PATH, for grok and kimi", () => {
  for (const cli of ["grok", "kimi"]) {
    const r = spawnSync("python3", [join(repo, "bin/agent-native-seat"), cli, "--role", "implementer", "--no-culture", "--dry-run"],
      { encoding: "utf8", cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, OPENRIG_SESSION_NAME: `${cli}-1@t` } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).env.PATH, `${guard}:/usr/bin:/bin`, cli);
  }
});
