// The test guard (in the PreToolUse hook every Claude and Codex seat runs): tests, mutation runs and test scripts run
// only through agent-heavy's sandbox. On 2026-10-04 a mutation run of a test-harness cleanup, started directly as the
// owner, called rmSync('/', {recursive: true}) and deleted ~/.config, ~/.local/share and the dotfiles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(repo, "system/credguard-read-hook");
const run = (command, runtime) => spawnSync("node", [hook, "--runtime", runtime], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
const verdict = (command) => {
  const c = run(command, "codex"), j = run(command, "claude");
  const claude = j.stdout ? JSON.parse(j.stdout).hookSpecificOutput : null;
  assert.equal(c.status === 2, claude?.permissionDecision === "deny", `codex and claude agree on: ${command}`);
  return { denied: c.status === 2, reason: c.stderr };
};

test("a test runner started directly is refused, in both runtimes, nested shells and prefixes included", () => {
  for (const c of [
    "node --test test/x.test.js", "node --test", "node --test-reporter=spec --test x", "node -r ./setup.js --test x", "node --run test",
    "npm test", "npm t", "npm run test:unit", "npm --prefix app test", "pnpm --filter web test", "pnpm test", "yarn test", "yarn test:e2e",
    "bun test", "npx vitest run", "npx -y vitest", "npx jest --maxWorkers=4", "npx playwright test", "pnpm exec vitest", "yarn dlx jest",
    "vitest run", "./node_modules/.bin/jest", "mocha", "pytest -q", "python3 -m pytest -q", "go test ./...", "cargo test", "deno test",
    "cd app && npm test", "bash -c 'node --test test/a.js'", "sh -c \"npm test\"", "env CI=1 npm test", "CI=1 node --test x",
    "timeout 300 npx vitest run", "git stash; node --test x; git stash pop",
  ]) {
    const v = verdict(c);
    assert.ok(v.denied, c);
    assert.match(v.reason.replace(/\s+/g, " "), /agent-stack test guard: blocked, because .* runs tests outside agent-heavy/, c);
    assert.match(v.reason, /agent-heavy test -- <this command>/); assert.match(v.reason, /Docker and sudo don't work inside agent-heavy: bring services up first \(docker compose up\)/);
  }
});

test("the same commands through agent-heavy, and look-alikes that run no tests, stay allowed", () => {
  for (const c of [
    "agent-heavy test -- node --test test/x.test.js", "agent-heavy build -- node --test test/x.test.js", "agent-heavy browser -- npx playwright test",
    "agent-heavy test --priority urgent -- npm test", "~/.cache/x/bin/mutate f.js a b -- agent-heavy test -- node --test test/f.test.js",
    "node script.js --test", "node --run build", "npm run build", "npm install", "npx playwright install chromium", "npx tsc --noEmit",
    "cat test/x.test.js", "git log -- test/", "rg 'node --test' docs", "echo npm test", "go build ./...", "npm run lint",
  ]) assert.equal(verdict(c).denied, false, c);
});

test("the rule is in CULTURE and the hook says why", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8").replace(/\s+/g, " ");
  assert.match(culture, /Run tests through `agent-heavy test -- <cmd>`, builds and lint through `agent-heavy build -- <cmd>`/);
  assert.match(culture, /Tests, mutation runs and test scripts run ONLY there, from their own repo or worktree/);
  assert.match(culture, /Docker and sudo stay outside agent-heavy: bring services up first \(`docker compose up`\), then run the tests in it\./);
  assert.match(verdict("npm test").reason.replace(/\s+/g, " "), /deleted ~\/\.config, ~\/\.local\/share and the dotfiles/);
});
