// agent-merge-evidence --decide --confirm <comment-url>: on NEEDS CONFIRM (a live Jev merge below the act bar, every
// gate green) the helper verifies the other-family reviewer's exact-head confirm and posts the gate's success status
// itself (2026-10-04: two PRs hit "branch policy blocks merge" because integrators had to hand-post it). Never on HOLD,
// an act-band pass, fallback, stubbed answers or errors. gh is a stub on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldConfirm, confirmProblems, readConfirm, postConfirmStatus } from "../orchestration/merge-evidence.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "merge-confirm-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const HEAD = "96b7d3a86d1af4b7862f260cc182641ced03de25", PR = 68;
const URL = `https://github.com/o/r/pull/${PR}#issuecomment-5976370520`;
const below = { decided_by: "jev", band: "review", result: { decision: "merge" }, request_id: "req-9" };

test("shouldConfirm: only NEEDS CONFIRM from a live Jev merge below the act bar", () => {
  assert.equal(shouldConfirm(below, { code: 3 }), true);
  assert.equal(shouldConfirm({ ...below, band: "uncertain" }, { code: 3 }), true);
  for (const [why, rec, o] of [["act band (already posts)", { ...below, band: "act" }, { code: 0 }], ["act band, even with code 3", { ...below, band: "act" }, { code: 3 }], ["HOLD", { ...below, result: { decision: "hold" } }, { code: 1 }],
    ["fallback", { ...below, decided_by: "fallback_model" }, { code: 3 }], ["stubbed", { ...below, stubbed: true }, { code: 3 }],
    ["a gate not green", below, { code: 1 }], ["not decided", below, { code: 4 }], ["no record", null, { code: 3 }]])
    assert.equal(shouldConfirm(rec, o), false, why);
});

test("confirmProblems: on this PR, an other-family seat, its own 'confirm <exact head>' line, no failing verdict", () => {
  const ok = (body, o = {}) => confirmProblems({ body, url: URL, pr: PR, head: HEAD, authorFamily: "claude", ...o });
  assert.deepEqual(ok(`## review-kimi exact-head confirm\nconfirm ${HEAD}`), { seat: "review-kimi", family: "kimi", problems: [] });
  assert.deepEqual(ok(`review-codex-1\nconfirm ${HEAD}`).problems, [], "a plain first line names the seat too");
  // the reviewers' usual layout (seen on real PRs): "Reviewer: <seat> (...). **confirm <sha>.** Basis: ..."
  assert.deepEqual(ok(`Reviewer: review-kimi (Kimi K3). **confirm ${HEAD}.** Basis:\n- merge of main only`), { seat: "review-kimi", family: "kimi", problems: [] });
  assert.deepEqual(ok(`Reviewer: arch-codex (GPT). Author: impl-claude (Opus). **confirm ${HEAD}: clean.**`).problems, []);
  assert.deepEqual(ok(`Reviewer: arch-claude (Opus). **confirm ${HEAD}.**`).problems, ["arch-claude is of the author's family (claude)"]);
  for (const [why, body, o, re] of [
    ["another PR", `## review-kimi\nconfirm ${HEAD}`, { url: "https://github.com/o/r/pull/69#issuecomment-1" }, /not on PR #68/],
    ["the author's family", `## review-claude-1\nconfirm ${HEAD}`, {}, /of the author's family \(claude\)/],
    ["unknown author", `## review-kimi\nconfirm ${HEAD}`, { authorFamily: null }, /author's family is unknown/],
    ["no seat", `confirm ${HEAD}`, {}, /names no seat of a known family/],
    ["another head", `## review-kimi\nconfirm ${"a".repeat(40)}`, {}, /no line of its own reading "confirm 96b7d3a/],
    ["a short sha", `## review-kimi\nconfirm 96b7d3a`, {}, /no line of its own/],
    ["only quoted", `## review-kimi\n> confirm ${HEAD}`, {}, /no line of its own/],
    ["only fenced", `## review-kimi\n\`\`\`\nconfirm ${HEAD}\n\`\`\``, {}, /no line of its own/],
    ["a BLOCK too", `## review-kimi\nconfirm ${HEAD}\nVerdict: BLOCK`, {}, /declares a verdict that isn't success/],
    ["a negation", `## review-kimi\nI cannot confirm ${HEAD} yet`, {}, /no line of its own/],
    ["a longer sha", `## review-kimi\nconfirm ${HEAD}ab`, {}, /no line of its own/],
    ["a bare confirm (no seat: one shared account)", `confirm ${HEAD}`, {}, /names no seat of a known family/],
  ]) assert.match(ok(body, o).problems.join("; "), re, why);
});

function stubGh() {
  const d = fs.mkdtempSync(join(root, "gh-")), bin = join(d, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "gh"), `#!/bin/sh
n=$(ls "${d}" | grep -c '^call-'); printf '%s\\n' "$@" > "${d}/call-$((n + 1))"
case "$*" in
  *issues/comments/5976370520*) echo '{"body":"## review-kimi\\nconfirm ${HEAD}","html_url":"${URL}"}' ;;
  *pulls/68/reviews/77*) echo '{"body":"## review-codex\\nconfirm ${HEAD}"}' ;;
  *statuses/*) echo '{}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  return { bin, calls: () => fs.readdirSync(d).filter((f) => f.startsWith("call-")).sort().map((f) => fs.readFileSync(join(d, f), "utf8").trim().split("\n")) };
}
const withPath = (bin, fn) => { const old = process.env.PATH; process.env.PATH = `${bin}:${old}`; try { return fn(); } finally { process.env.PATH = old; } };

test("readConfirm: an issue comment or a PR review by URL; anything else is refused", () => {
  const g = stubGh();
  const c = withPath(g.bin, () => readConfirm("o/r", PR, URL));
  assert.match(c.body, /^## review-kimi\nconfirm 96b7d3a/); assert.equal(c.url, URL);
  const r = withPath(g.bin, () => readConfirm("o/r", PR, `https://github.com/o/r/pull/${PR}#pullrequestreview-77`));
  assert.match(r.body, /review-codex/);
  assert.throws(() => readConfirm("o/r", PR, "https://example.com/x"), /needs a PR comment or review URL/);
});

test("postConfirmStatus: jev-merge success on the exact head, the request id and seat in the description, linked to the confirm", () => {
  const g = stubGh();
  const s = withPath(g.bin, () => postConfirmStatus({ facts: { nwo: "o/r", head: HEAD, gateContext: "jev-merge" }, rec: below, seat: "review-kimi", url: URL }));
  assert.equal(s.description, "Jev merge below confidence bar (req-9); review-kimi confirmed at 96b7d3a");
  const [call] = g.calls();
  assert.deepEqual(call.slice(0, 4), ["api", "-X", "POST", `repos/o/r/statuses/${HEAD}`]);
  for (const f of ["state=success", "context=jev-merge", `description=${s.description}`, `target_url=${URL}`]) assert.ok(call.includes(f), f);
});

test("the CLI: --confirm only on NEEDS CONFIRM; an unaccepted confirm stays exit 3; --no-post verifies only; the role says so", () => {
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(src, /if \(!shouldConfirm\(rec, o\)\) console\.error\(`merge gate: --confirm ignored/);
  assert.match(src, /if \(v\.problems\.length\) \{[^\n]*process\.exit\(3\); \}/);
  assert.match(src, /if \(a\.includes\("--no-post"\)\) \{ console\.error\(`merge gate: confirm by \$\{v\.seat\} accepted; not posted \(--no-post\)`\); process\.exit\(3\); \}/);
  const role = fs.readFileSync(join(repo, "rig/template/agents/integrator/guidance/role.md"), "utf8");
  assert.match(role, /Confirm → run the gate again with `--confirm <that comment's URL>`: the helper checks it .* and posts jev-merge success itself/);
});
