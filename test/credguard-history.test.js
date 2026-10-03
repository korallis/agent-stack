// The history guard (in the PreToolUse hook every Claude and Codex seat runs): a published PR's history is never
// rewritten. A seat rebased a published PR on 2026-10-03, so force pushes and rebase updates of a PR branch are refused
// in both runtimes, nested shells included; look-alikes that rewrite nothing published stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("force pushes and rebase updates of a PR branch are refused, in both runtimes, nested shells included", () => {
  for (const c of [
    "gh pr update-branch 391 --rebase", "gh pr update-branch --rebase", "gh pr update-branch 391 -r", "gh pr update-branch -R korallis/x 391 --rebase",
    "gh pr update-branch --rebase=true 391",
    "git push --force", "git push -f", "git push origin feature -f", "git push -uf origin feature", "git push --force origin HEAD",
    "git push --force-with-lease", "git push --force-with-lease=feature:abc123 origin feature", "git push origin +feature", "git push origin +HEAD:feature",
    "git -C /tmp/x push -f", "git -c push.default=current push --force", "GIT_TRACE=1 git push -f", "cd repo && git push --force-with-lease",
    "git fetch origin; git push -f origin x", "bash -c 'git push --force'", "sh -c \"gh pr update-branch 5 --rebase\"", "env git push -f",
  ]) {
    const v = verdict(c);
    assert.ok(v.denied, `refused: ${c}`);
    assert.match(v.reason, /agent-stack history guard: blocked/, c);
    assert.match(v.reason, /gh pr update-branch <PR>      \(a merge commit; no --rebase\)/, c);
    assert.match(v.reason, /git merge origin\/main/, c);
  }
});

test("look-alikes that rewrite nothing published are allowed", () => {
  for (const c of [
    "git log --rebase-merges", "git log --oneline -n 5", "gh pr update-branch 391", "gh pr update-branch -R korallis/x 391",
    "git push", "git push -u origin feature", "git push origin feature", "git push --follow-tags origin main", "git push --no-force-with-lease origin x",
    "git push --force-if-includes origin x" /* only meaningful with --force-with-lease; alone it forces nothing */,
    "git pull --rebase", "git rebase origin/main", "git checkout -f main", "git fetch --force", "git branch -f tmp HEAD",
    "echo 'git push --force'", "grep -n 'push -f' notes.md", "gh pr view 391 --json title", "gh pr merge 391 --squash",
  ]) assert.equal(verdict(c).denied, false, `allowed: ${c}`);
});
