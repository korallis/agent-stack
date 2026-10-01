// WO69: proof attachments (one file per owner update row, into its Slack thread) are documented and taught: when, how,
// where to save the file (it must outlive the job: the daemon reads it when it posts) and what never to show; and the
// Slack setup covers files:write and the upload check.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(join(repo, p), "utf8");
const flat = (p) => read(p).replace(/\s+/g, " ");

test("CULTURE teaches one file per owner update row: when, how, where (outliving the job) and what never", () => {
  const c = flat("rig/template/CULTURE.md");
  assert.match(c, /update row to the owner \(`--human-intent update`\) can carry ONE file, `--evidence-ref <absolute path>`/);
  assert.match(c, /\.png\/\.jpg\/\.gif\/\.webp, an \.mp4\/\.webm\/\.mov or a \.pdf, at most 50 MiB/);
  assert.match(c, /When: a witness pass, a finished user-visible feature, a fix for a bug the owner reported\. Not every step or PR\./);
  assert.match(c, /page\.screenshot\(/); assert.match(c, /recordVideo/); assert.match(c, /page\.video\(\)\.path\(\)/);
  assert.match(c, /`\$HOME\/\.cache\/<rig>-tmp\/<seat>\/proof\/`/);
  assert.match(c, /Not inside a job's own temp dir: its trap removes it, and the daemon reads the file only when it posts/);
  assert.match(c, /never in `\/tmp`/);
  assert.match(c, /Never on screen: secrets, tokens, passwords or keys, real client or customer data/);
  assert.match(c, /demo or fictional data and test accounts only/);
});

test("QA, lead and the witness slice: QA and the witness hand the lead the path; the lead sends the owner update", () => {
  const qa = flat("rig/template/agents/qa/guidance/role.md");
  assert.match(qa, /`\$HOME\/\.cache\/<rig>-tmp\/<seat>\/proof\/` and put its absolute path in your PASS row to the lead/);
  assert.match(qa, /Demo or fictional data only; no secrets, tokens or real client data on screen/);
  const lead = flat("rig/template/agents/lead/guidance/role.md");
  assert.match(lead, /OWNER PROOF: for a witness pass, a finished user-visible feature or a fix for a bug the owner reported/);
  assert.match(lead, /--human-intent update .*--evidence-ref <absolute path>/); assert.match(lead, /Not every step or PR/);
  assert.doesNotMatch(read("rig/template/agents/lead/guidance/role.md"), /@OWNER@/, "only CULTURE.md gets @OWNER@ substituted");
  const w = flat("rig/template/witness-slice/SPEC.md");
  assert.match(w, /give its absolute path to the lead with the result/); assert.match(w, /never `\/tmp` or a repo/);
  assert.match(w, /demo or fictional data only: no secrets, tokens or real client data/);
});

test("the agent-stack skill teaches the rule and the operator's Slack check", () => {
  const k = flat("skills/agent-stack/SKILL.md");
  assert.match(k, /visual proof for the owner: ONE file per owner update row, `--evidence-ref <absolute path>`/);
  assert.match(k, /not a job's temp dir: the daemon reads it when it posts/);
  assert.match(k, /`rig slack setup --required-scopes chat:write,channels:history,channels:read,files:write`/);
  assert.match(k, /`openrig-slack-upload-check --live`/);
});

test("onboarding's Slack step: files:write, verify that checks it, then the upload check; later steps renumbered", () => {
  const o = read("skills/project-onboarding/SKILL.md");
  assert.match(o, /^3\. \*\*Slack, once per machine\*\*/m);
  assert.match(o, /--required-scopes chat:write,channels:history,channels:read,files:write/);
  assert.match(o, /it requests `files:write` for attachments; an older app adds\s+that bot scope and is reinstalled/);
  assert.match(o, /`openrig-slack-upload-check`, then `openrig-slack-upload-check --live`/);
  const steps = [...o.slice(o.indexOf("## 2. Steps"), o.indexOf("## 3.")).matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("REFERENCE and README: the scope, verify's blind spot, the check tool, and what a missing file means", () => {
  const r = flat("docs/REFERENCE.md");
  assert.match(r, /\*\*Slack proof \(screenshots, video, PDF to the owner\):\*\*/);
  assert.match(r, /bot scope `files:write`/); assert.match(r, /says READY on an app that can't attach files/);
  assert.match(r, /`openrig-slack-upload-check` shows, sending nothing/); assert.match(r, /attachment missing/);
  const md = flat("README.md");
  assert.match(md, /### Can it show me what it built, in Slack\?/); assert.match(md, /`files:write` scope/);
  assert.match(md, /demo or test data only, never secrets or real customer data/);
});
