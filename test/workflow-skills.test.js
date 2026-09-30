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

// Every rig command the skills tell a seat to copy must be one the installed rig accepts (QA round 1: a queue row
// without --mission/--slice, a proof add without its required --money-evidence).
import { spawnSync } from "node:child_process";
test("the skills' rig commands use real flags, and proof add carries every required option", { skip: spawnSync("bash", ["-c", "command -v rig"]).status !== 0 && "rig not installed" }, () => {
  const help = (subs) => { const r = spawnSync("rig", [...subs, "--help"], { encoding: "utf8", timeout: 30000 }); return (r.stdout || "") + (r.stderr || ""); };
  let checked = 0;
  for (const name of Object.keys(SKILLS)) {
    const md = fs.readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8");
    for (const [, block] of md.matchAll(/```bash\n([\s\S]*?)```/g)) {
      for (const cmd of block.replace(/\\\n\s*/g, " ").split("\n").map((l) => l.replace(/\s+#\s.*$/, "").trim()).filter((l) => l.startsWith("rig "))) {
        const words = cmd.split(/\s+/);
        const subs = words.slice(1, 3).filter((w) => /^[a-z][a-z-]*$/.test(w));
        const text = help(subs);
        const flags = [...cmd.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]);
        for (const f of flags) assert.ok(text.includes(f), `${name}: rig ${subs.join(" ")} has no ${f}`);
        if (subs.join(" ") === "proof add") for (const req of ["--artifact-type", "--verdict", "--candidate-sha", "--money-evidence"]) assert.ok(flags.includes(req), `${name}: proof add lacks ${req}`);
        if (subs.join(" ") === "queue create") for (const req of ["--destination", "--mission", "--slice"]) assert.ok(flags.includes(req), `${name}: queue create lacks ${req}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 4, `checked ${checked}`);
});

test("bug-review-board has a truthful path for CLI and API work, not only the browser", () => {
  const md = fs.readFileSync(join(repo, "skills/bug-review-board/SKILL.md"), "utf8");
  assert.match(md, /\*\*CLI:\*\*/); assert.match(md, /\*\*API:\*\*/);
  assert.match(md, /CLI: the command, stdout, stderr and exit code/);
  assert.match(md, /Never make up browser evidence/);
  assert.match(md, /passed through its user interface \(browser, command or HTTP/);
});

test("the binding guidance agrees with bug-review-board: non-web work has a real path, only P0/P1 block (QA round 2)", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const done = culture.split(/^## /m).find((s) => s.startsWith("Done means a person could use it"));
  assert.match(done, /A web feature: acceptance tests are browser journeys/);
  assert.match(done, /A feature with no UI \(a CLI, or an API that clients call\): acceptance tests run the public command/);
  assert.match(done, /No test that decides "done" for a web feature may call internal functions/, "the strict web rule is kept");
  assert.match(done, /the real UI for web; the released command or the deployed API otherwise/);
  const qa = fs.readFileSync(join(repo, "rig/template/agents/qa/guidance/role.md"), "utf8");
  assert.doesNotMatch(qa, /and open it in the Playwright MCP browser\./, "no unconditional browser step");
  assert.match(qa, /the documented command for a CLI, the public HTTP endpoints for an API/);
  assert.match(qa, /P0 and P1 problems block the PR/); assert.doesNotMatch(qa, /^- Problems block the PR/m);
  assert.match(qa, /for a CLI, each command with its stdout, stderr and exit code/);
  const integ = fs.readFileSync(join(repo, "rig/template/agents/integrator/guidance/role.md"), "utf8");
  assert.match(integ, /proof\/brb-<head>\.md/);
});
