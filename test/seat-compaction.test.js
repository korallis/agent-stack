// WO88: seats compact before every turn re-sends half a million tokens. Measured 2026-10-02: Claude models report a 1M
// window here (Sonnet 5.5 too, without [1m]) and compact only near ~967k; with CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000
// Claude Code's own /context reads "27.5k / 400k" with a 33k autocompact buffer (compacts at ~367k), and with 200000
// "27.6k / 200k" (~167k), for Opus and Sonnet alike. Codex has no auto-compact limit unless one is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "compaction-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, text, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); };

function claudeWindow(env) {
  const r = spawnSync("bash", ["-c", `source "$1"; printf %s "\${CLAUDE_CODE_AUTO_COMPACT_WINDOW-unset}"`, "t", join(repo, "system/env.sh")],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: join(root, "home"), ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("Claude seats: leads and architects compact relative to 400k, every other seat 200k; humans and explicit values untouched", () => {
  const seat = (name) => claudeWindow({ OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: name });
  for (const s of ["coord-lead-claude@app", "arch-claude@app"]) assert.equal(seat(s), "400000", s);
  for (const s of ["impl-claude-ui-1@app", "review-claude-1@app", "qa-claude@app", "tests-claude-1@app", "dev-impl@openrig-fix", "integ-claude@app"]) assert.equal(seat(s), "200000", s);
  assert.equal(claudeWindow({}), "unset", "your own interactive claude keeps its own behaviour");
  assert.equal(claudeWindow({ OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: "impl-claude-1@app", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }), "300000", "an explicit value wins");
});

// the Codex seat shim, against a fake Codex that records its argv
const home = join(root, "home"), argvLog = join(root, "codex-argv.json");
write(join(home, ".local/share/mise/installs/codex/latest/bin/codex"), `#!/usr/bin/env python3\nimport json, sys\njson.dump(sys.argv[1:], open(${JSON.stringify(argvLog)}, "w"))\n`, 0o755);
const shim = join(root, "seat-bin/codex");
write(shim, fs.readFileSync(join(repo, "system/seat-bin-codex"), "utf8"), 0o755);
write(join(root, "seat-bin/codex-models.json"), "{}");
function launch(env, ...args) {
  const r = spawnSync("setsid", ["-w", "python3", shim, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(argvLog, "utf8"));
}
const limits = (argv) => argv.flatMap((a, i) => (a === "-c" && /^model_auto_compact_token_limit=/.test(argv[i + 1] ?? "") ? [argv[i + 1].split("=")[1]] : []));

test("Codex seats: an auto-compact limit (300k leads/architects, 200k otherwise) before the subcommand; the caller's own wins", () => {
  assert.deepEqual(limits(launch({ OPENRIG_SESSION_NAME: "impl-codex-1@app" }, "-m", "gpt-6.1-sol")), ["200000"]);
  assert.deepEqual(limits(launch({ OPENRIG_SESSION_NAME: "coord-deputy-codex@app" })), ["300000"]);
  assert.deepEqual(limits(launch({ OPENRIG_SESSION_NAME: "arch-codex@app" })), ["300000"]);
  const resumed = launch({ OPENRIG_SESSION_NAME: "review-codex-1@app" }, "resume", "0199-abc");
  assert.deepEqual(limits(resumed), ["200000"]);
  assert.ok(resumed.indexOf("model_auto_compact_token_limit=200000") < resumed.indexOf("resume"), "a global option, before the subcommand");
  assert.deepEqual(limits(launch({ OPENRIG_SESSION_NAME: "impl-codex-1@app" }, "-c", "model_auto_compact_token_limit=150000")), ["150000"], "never duplicated");
  assert.deepEqual(limits(launch({ OPENRIG_SESSION_NAME: "impl-codex-1@app", AGENT_CODEX_AUTO_COMPACT_TOKENS: "250000" })), ["250000"]);
  assert.deepEqual(limits(launch({ OPENRIG_SESSION_NAME: "impl-codex-1@app", AGENT_CODEX_AUTO_COMPACT_TOKENS: "lots" })), [], "a non-number sets nothing");
});
