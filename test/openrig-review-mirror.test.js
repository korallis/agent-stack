// WO72: the local 0.6.3 patches carry the fixes upstream review asked for on our PRs (#295 -> 135, #296 -> 140,
// #298 follow-up -> 141). 141 is exercised on the vendored Slack files (openrig-slack-upload.test.js); 135 and 140 touch
// dist files too large to vendor, so their added code is checked here (behaviour proof: the throwaway install, PR body).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const added = (name) => fs.readFileSync(join(repo, "patches/openrig/0.6.3", name), "utf8").split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");

test("135: beyond the last 8 lines only Codex's turn-status row counts as busy (#295 review)", () => {
  const a = added("135-codex-idle-composer.patch");
  assert.match(a, /const recent = plain\.filter\(\(line\) => line !== ""\)\.slice\(-8\)\.join\("\\n"\);/);
  assert.match(a, /plain\.some\(\(line\) => \/\^\[•◦\]\\s\+\\S\.\*\\\(\(\?:\\d\+\[hms\]\\s\*\)\+•\\s\*esc to interrupt\\\)\/\.test\(line\)\)/);
  assert.match(a, /MID_WORK_PATTERNS\.some\(\(pattern\) => pattern\.test\(recent\)\)/);
  assert.doesNotMatch(a, /MID_WORK_PATTERNS\.some\(\(pattern\) => pattern\.test\(everything\)\)/, "no generic Working match over the whole capture");
  const sig = /^[•◦]\s+\S.*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)/;
  for (const busy of ["• Working (1h 09m 39s • esc to interrupt)", "◦ Working (11s • esc to interrupt) · 1 background terminal running", "• Exploring fixtures (2m 03s • esc to interrupt)"])
    assert.match(busy, sig, busy);
  for (const prose of ["• Working directory: /tmp/project", "• Working tree is clean.", "Press esc to interrupt (Working)"])
    assert.doesNotMatch(prose, sig, prose);
});

test("140: judged by the resolved notice's own transition; recipient is the human who closed the row (#296 review)", () => {
  const a = added("140-delivery-outcome-resolved-close.patch");
  assert.match(a, /!\["pending", "in-progress", "blocked"\]\.includes\(transition\.state\)/);
  assert.doesNotMatch(a, /includes\(item\.state\)/, "never the row's current state");
  assert.match(a, /resolvedBy = transition\.actorSession;/);
  assert.match(a, /const humanAddress = resolvedBy !== null\s*\? resolveRegisteredHumanAddress\(resolvedBy, registry\.entities\)/);
});

test("141: the local attachment is opened once, non-blocking, and read through that descriptor (#298 follow-up)", () => {
  const a = added("141-slack-upload-encoding-and-video.patch");
  assert.match(a, /fd = fs\.openSync\(refPath, fs\.constants\.O_RDONLY \| fs\.constants\.O_NONBLOCK\);/);
  assert.match(a, /const st = fs\.fstatSync\(fd\);/); assert.match(a, /fs\.readSync\(fd, bytes, read, bytes\.length - read, read\)/);
  assert.match(a, /fs\.closeSync\(fd\)/);
  assert.doesNotMatch(a, /fs\.statSync\(refPath\)|fs\.readFileSync\(refPath\)/);
});

test("132: Windows scopes, catalog source observation, project identity and the projectRoot pin (#136 review)", () => {
  const a = added("132-project-scoped-proof.patch");
  assert.match(a, /const qualified = rawScope === undefined \|\| path\.win32\.isAbsolute\(rawScope\) \? null : QUALIFIED_SCOPE\.exec\(rawScope\);/);
  assert.match(a, /const observation = \(c, project\) => project \? \{ state: "unavailable", revision: "unverified" \} : proofSourceObservation\(c\);/);
  assert.match(a, /project: \{ id: p\.id, root: p\.root \}/);
  assert.match(a, /new JudgmentError\("project_changed", .*, 409\)/);
  assert.match(a, /target\(c, body\.scope, body\.project, body\.projectRoot\)/);
  assert.match(a, /\.\.\.\(view\.project\?\.root \? \{ projectRoot: view\.project\.root \} : \{\}\)/, "the CLI pins the prepared root");
});

test("132: a catalog project's own root bounds evidence, policy and scope identity (#136 CodeRabbit, CWE-22)", () => {
  const a = added("132-project-scoped-proof.patch");
  assert.match(a, /function policyOf\(dir, io, readManifest = manifest, rootOverride\) \{\n.*\n    const root = rootOverride \?\? workspaceOf\(dir, io, false\);/);
  assert.match(a, /const defaultPolicyRead = \(dir, io, root\) => policyOf\(dir, io, manifest, root\);/);
  assert.match(a, /export function readSliceReadiness\(dir, io = proofFs, readPolicy = defaultPolicyRead, root\) \{/);
  assert.match(a, /const scopeRoot = root \?\? workspaceOf\(dir, io, false\)/);
  assert.match(a, /file = path\.resolve\(scopeRoot, address\.ref\);/); assert.match(a, /contained\(scopeRoot, file\);/);
  assert.match(a, /export function recordJudgment\(missionsRoot, input, actor, provenance, projectRoot\) \{\n    const dir = resolveProofScope\(missionsRoot, input\.scope\), root = projectRoot \? contained\(projectRoot, dir\) && path\.resolve\(projectRoot\) : workspaceOf\(dir, proofFs\);/);
  assert.equal((a.match(/readSliceReadiness\(dir, proofFs, defaultPolicyRead, projectRoot\)/g) || []).length, 3, "the prepared read and both returns");
  assert.match(a, /recordJudgment\(root, \{ \.\.\.input, scope: scope \}, identity\.session, resolveRecordedProvenance\(c, identity\), project\?\.root\)/);
  for (const r of [/readProjectReadiness\(root, undefined, bound\)/, /readMissionReadiness\(dir, undefined, bound\)/, /readSliceReadiness\(dir, undefined, undefined, bound\)/]) assert.match(a, r);
  assert.doesNotMatch(a, /readPolicy = policyOf\b/, "policyOf's third parameter is the manifest reader, never the default ProofPolicyRead");
});
