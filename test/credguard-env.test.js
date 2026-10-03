// 2026-10-02: a seat ran `ps eww` and printed process environments (API keys, tokens) into its transcript. The credential
// guard (Claude and Codex PreToolUse, system/credguard-read-hook) refuses commands that print environment VALUES and
// points at names-only alternatives; names stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = join(repo, "system/credguard-read-hook");
const run = (command, runtime) => spawnSync("node", [hook, "--runtime", runtime], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8" });
const denied = (command) => {
  const c = run(command, "codex"), j = run(command, "claude");
  const claudeDeny = j.stdout ? JSON.parse(j.stdout).hookSpecificOutput?.permissionDecision === "deny" : false;
  assert.equal(c.status === 2, claudeDeny, `codex and claude agree on: ${command}`);
  return c.status === 2 ? c.stderr : null;
};

test("environment dumps are refused, in both runtimes, nested shells included", () => {
  for (const c of ["env | grep PATH" /* grep matches anywhere in a line, values included */, "ps eww", "ps e", "ps auxe", "ps auxwwe", "ps -E", "env", "env | grep KEY", "env -0", "env -u PATH", "printenv", "printenv TYPESAFE_API_KEY",
    "printenv GITHUB_TOKEN", "set", "export -p", "export", "declare -x", "declare -p", "declare", "typeset -x", "declare -p OPENAI_API_KEY",
    "cat /proc/1234/environ", "strings /proc/$$/environ", "xargs -0 -n1 < /proc/1/environ", "tr '\\0' '\\n' < /proc/self/environ",
    "sudo cat /proc/1/environ", "bash -c 'ps eww'", "sh -c env", "FOO=1 printenv", "true && set", "(printenv)"]) {
    const r = denied(c);
    assert.ok(r, `should be refused: ${c}`);
    assert.match(r, /agent-stack credential guard: blocked, because .*Environments hold API keys and tokens/s, c);
    assert.match(r, /compgen -e/); assert.match(r, /agent-credguard-read-hook --env-names <PID>/); assert.match(r, /ps -ef \/ ps aux/);
  }
});

test("ordinary commands and names-only forms pass", () => {
  for (const c of ["ps -ef", "ps aux", "ps -o user,pid", "ps -o user", "ps -p 1 -o etime", "ps axo user,cmd", "ps -eo pid,etime,cmd", "ps --sort=-rss aux",
    "env FOO=1 node x.js", "env -C /tmp ls", "printenv PATH", "printenv HOME USER", "set -euo pipefail", "set -x", "export FOO=1", "export PATH=$PATH:/x",
    "declare -p HOME", "declare -a arr", "ls /proc/1/environ", "test -r /proc/self/environ", "compgen -e", '[ -n "${OPENAI_API_KEY:+x}" ] && echo set',
    "git status", "npm test"]) assert.equal(denied(c), null, `should pass: ${c}`);
});

test("--env-names prints a process's variable names and never a value", () => {
  const r = spawnSync("node", [hook, "--env-names"], { encoding: "utf8", env: { PATH: process.env.PATH, PROBE_SECRET_TOKEN: "s3cr3t-value-123" } });
  assert.equal(r.status, 0, r.stderr);
  const names = r.stdout.trim().split("\n");
  assert.ok(names.includes("PROBE_SECRET_TOKEN")); assert.ok(names.includes("PATH"));
  assert.ok(!r.stdout.includes("s3cr3t-value-123") && !r.stdout.includes("="), "names only");
  assert.equal(spawnSync("node", [hook, "--env-names", "1; ls"], { encoding: "utf8" }).status, 2);
});
