// WO30: the adapted workflow skills. Each is ours in skills/<name>/, credits its source, carries that source's licence,
// and has none of the source's Cursor-specific routing, model slugs, subagent spawning, self-merge or bundled scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = {
  "bug-review-board": { licence: /Apache License\s+Version 2\.0/, source: /rayfernando-skills.*Ray Fernando.*commit 952eaaa.*Apache\s+License\s+2\.0/s },
  "verification-guide": { licence: /MIT License[\s\S]*Copyright \(c\) 2026 Lauren Tan/, source: /pstack.*Lauren Tan.*v0\.15\.5.*MIT\s+licence/s },
  "blast-radius": { licence: /MIT License[\s\S]*Copyright \(c\) 2026 Lauren Tan/, source: /pstack.*Lauren Tan.*v0\.15\.5.*MIT\s+licence/s },
  "review-lenses": { licence: /MIT License[\s\S]*Copyright \(c\) 2026 Lauren Tan/, source: /interrogate.*pstack.*Lauren Tan.*MIT\s+licence/s },
  unslop: { licence: /MIT License[\s\S]*Copyright \(c\) 2026 Lauren Tan/, source: /pstack.*Lauren Tan.*MIT\s+licence/s },
  "technical-writing": { licence: /MIT License[\s\S]*Copyright \(c\) 2026 Lauren Tan/, source: /pstack.*Lauren Tan.*MIT\s+licence/s },
};

for (const [name, want] of Object.entries(SKILLS)) {
  test(`${name}: frontmatter, credit, licence, nothing Cursor-specific`, () => {
    const dir = join(repo, "skills", name);
    const md = fs.readFileSync(join(dir, "SKILL.md"), "utf8");
    const fm = md.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(fm, "frontmatter with name and description"); assert.equal(fm[1], name);
    assert.ok(fm[2].length > 60 && /Use (when|for|at|on)/.test(fm[2]), "description says when to use it");
    assert.match(md.slice(md.lastIndexOf("\n---\n")), want.source, "credit footer names source, author, version or commit, licence");
    assert.match(md, /Changes: /, "the footer states what was changed");
    assert.match(fs.readFileSync(join(dir, "LICENSE"), "utf8"), want.licence);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["LICENSE", "SKILL.md"], "no bundled scripts or references");
    for (const bad of [/claude-opus|gpt-\d|grok-\d|model:/i, /cursor-ide-browser|\.cursor\//i, /Task tool|subagent_type/i,
      /self-merge|merge (it|the PR) yourself/i, /disable-model-invocation/, /mcp__/])
      assert.doesNotMatch(md, bad, `${name} contains ${bad}`);
  });
}

test("the workflow skills contain no credential values and point credentials at the secrets file by name", () => {
  const brb = fs.readFileSync(join(repo, "skills/bug-review-board/SKILL.md"), "utf8");
  assert.match(brb, /typed BY NAME through the Playwright\s+MCP's `--secrets`/);
  for (const name of Object.keys(SKILLS)) {
    const md = fs.readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8");
    assert.doesNotMatch(md, /password\s*[:=]\s*\S+|sk-[A-Za-z0-9]{10,}|postgres(ql)?:\/\/\S+:\S+@/i, name);
  }
});
