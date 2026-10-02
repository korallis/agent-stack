import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(tmpdir(), "role-effort-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
function settings(session, extra = {}, twice = false) {
  const r = spawnSync("bash", ["-c", `source "$1"\n${twice ? 'source "$1"\n' : ''}python3 -c 'import os,json; print(json.dumps({k:os.environ.get(k) for k in ["CLAUDE_CODE_EFFORT_LEVEL","CLAUDE_CODE_SUBAGENT_MODEL","CLAUDE_CODE_SUBAGENT_MODEL_FORCE","ANTHROPIC_DEFAULT_SONNET_MODEL"]}))'`, "test", join(repo, "system/env.sh")], {
    encoding: "utf8", cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin", ...(session ? { OPENRIG_NODE_ID: "fixture", OPENRIG_SESSION_NAME: session } : {}), ...extra },
  });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
test("implementers default to medium; verification roles and witnesses default to high", () => {
  for (const seat of ["impl-claude-1@demo", "impl-ui@demo", "dev-impl@fix", "dev-impl2@fix"])
    assert.equal(settings(seat).CLAUDE_CODE_EFFORT_LEVEL, "medium", seat);
  for (const seat of ["review-claude@demo", "qa-claude@demo", "tests-claude@demo", "witness-claude@demo", "dev-qa@fix"])
    assert.equal(settings(seat).CLAUDE_CODE_EFFORT_LEVEL, "high", seat);
});
test("unclassified seats keep default effort and direct sessions stay unchanged", () => {
  assert.equal(settings("coord-lead-claude@demo").CLAUDE_CODE_EFFORT_LEVEL, null);
  assert.equal(settings("arch-claude@demo").CLAUDE_CODE_EFFORT_LEVEL, null);
  assert.deepEqual(settings(null), { CLAUDE_CODE_EFFORT_LEVEL: null, CLAUDE_CODE_SUBAGENT_MODEL: null,
    CLAUDE_CODE_SUBAGENT_MODEL_FORCE: null, ANTHROPIC_DEFAULT_SONNET_MODEL: null });
});
test("seat subagents default to sonnet without forcing their explicit model choices", () => {
  const s = settings("impl-claude@demo", {}, true);
  assert.equal(s.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.equal(s.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, null);
  assert.equal(s.ANTHROPIC_DEFAULT_SONNET_MODEL, null, "main-model routing is not changed by these defaults");
});
test("explicit effort and subagent model values survive repeated sourcing", () => {
  const s = settings("impl-claude@demo", { CLAUDE_CODE_EFFORT_LEVEL: "high", CLAUDE_CODE_SUBAGENT_MODEL: "inherit" }, true);
  assert.equal(s.CLAUDE_CODE_EFFORT_LEVEL, "high"); assert.equal(s.CLAUDE_CODE_SUBAGENT_MODEL, "inherit");
});
