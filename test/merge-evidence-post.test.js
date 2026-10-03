// agent-merge-evidence --decide posts the gate's result itself on a pass (operator 2026-10-03: integrators kept hitting
// "branch policy blocks merge" after forgetting to): the PR comment (verdict, raw request and response) and then the
// jev-merge success status on the exact head, linked to it. Only for a live Jev merge in the act band with every gate
// green; never for review/uncertain bands, fallback, stubbed answers, HOLD or NEEDS CONFIRM. gh is a stub on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldPost, postGateResult, isGateReport, resolveConfig } from "../orchestration/merge-evidence.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "merge-post-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const HEAD = "a".repeat(40);
const pass = { code: 0, text: `merge gate: PASS (live Jev merge, act band) for ${HEAD}` };
const live = { decided_by: "jev", band: "act", result: { decision: "merge" }, request_id: "req-123" };

test("shouldPost: only a live Jev merge in the act band that passed every gate", () => {
  assert.equal(shouldPost(live, pass), true);
  for (const [why, rec, o] of [
    ["review band", { ...live, band: "review" }, { code: 3 }], ["uncertain band", { ...live, band: "uncertain" }, { code: 3 }],
    ["fallback model", { ...live, decided_by: "fallback_model" }, pass], ["cache", { ...live, decided_by: "cache" }, pass],
    ["stubbed", { ...live, stubbed: true }, pass], ["HOLD", { ...live, result: { decision: "hold" } }, { code: 1 }],
    // the band is checked on its own, not only through the outcome code
    ["review band, code 0", { ...live, band: "review" }, pass], ["uncertain band, code 0", { ...live, band: "uncertain" }, pass],
    ["act band but a gate not green", live, { code: 1 }], ["not decided", live, { code: 4 }], ["no record", null, pass],
  ]) assert.equal(shouldPost(rec, o), false, why);
});

function stubGh({ failComments = false, noUrl = false } = {}) {
  const d = fs.mkdtempSync(join(root, "gh-")), bin = join(d, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "gh"), `#!/bin/sh
n=$(ls "${d}" | grep -c '^call-'); n=$((n + 1))
printf '%s\\n' "$@" > "${d}/call-$n.args"; case "$*" in *--input*) cat > "${d}/call-$n.stdin" ;; esac
case "$*" in
  *issues/7/comments*) ${failComments ? 'echo "HTTP 403: Resource not accessible" >&2; exit 1' : noUrl ? "echo '{}'" : "echo '{\"html_url\":\"https://github.com/o/r/pull/7#issuecomment-99\"}'"} ;;
  *statuses/*) echo '{"state":"success"}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const calls = () => fs.readdirSync(d).filter((f) => /^call-\d+\.args$/.test(f)).sort().map((f) => ({
    args: fs.readFileSync(join(d, f), "utf8").trim().split("\n"), stdin: fs.existsSync(join(d, f.replace("args", "stdin"))) ? fs.readFileSync(join(d, f.replace("args", "stdin")), "utf8") : "" }));
  return { bin, calls };
}
function withPath(bin, fn) { const old = process.env.PATH; process.env.PATH = `${bin}:${old}`; try { return fn(); } finally { process.env.PATH = old; } }
const facts = { nwo: "o/r", pr: 7, head: HEAD, gateContext: "jev-merge" };
const input = { pr: 7, head: HEAD, base: "b".repeat(40), change: "x" };

test("postGateResult: the comment (verdict, raw request and response), then jev-merge success on the exact head linked to it", () => {
  const g = stubGh();
  const r = withPath(g.bin, () => postGateResult({ facts, input, rec: live, verdict: pass.text }));
  assert.equal(r.commentUrl, "https://github.com/o/r/pull/7#issuecomment-99");
  const [c, s] = g.calls();
  assert.deepEqual(c.args.slice(0, 4), ["api", "-X", "POST", "repos/o/r/issues/7/comments"]);
  const body = JSON.parse(c.stdin).body;
  assert.equal(body.split("\n", 1)[0], `${pass.text} at ${HEAD}`);
  assert.match(body, /Jev request \(review\.merge_gate\)[\s\S]*"change": "x"/); assert.match(body, /Jev response[\s\S]*"request_id": "req-123"[\s\S]*"band": "act"|Jev response[\s\S]*"band": "act"[\s\S]*"request_id": "req-123"/);
  assert.deepEqual(s.args.slice(0, 4), ["api", "-X", "POST", `repos/o/r/statuses/${HEAD}`]);
  for (const f of ["state=success", "context=jev-merge", "description=Live Jev merge (act band); request req-123", "target_url=https://github.com/o/r/pull/7#issuecomment-99"])
    assert.ok(s.args.includes(f), `${f} in ${s.args.join(" ")}`);
  assert.equal(g.calls().length, 2);
  // the posted comment is the gate's own report: a later run never reads it as review evidence
  assert.equal(isGateReport({ body, url: r.commentUrl, kind: "comment" }, resolveConfig(null, "o/r")), true);
});

test("postGateResult: no status without its comment (a failed or URL-less comment posts nothing more)", () => {
  for (const opts of [{ failComments: true }, { noUrl: true }]) {
    const g = stubGh(opts);
    assert.throws(() => withPath(g.bin, () => postGateResult({ facts, input, rec: live, verdict: pass.text })));
    assert.ok(!g.calls().some((c) => c.args.some((a) => a.includes("/statuses/"))), JSON.stringify(opts));
  }
});

test("the integrator role says the helper posts on exit 0, --no-post is a dry run, exit 5 means post by hand, and nothing else posts success", () => {
  const r = fs.readFileSync(join(repo, "rig/template/agents/integrator/guidance/role.md"), "utf8");
  assert.match(r, /exit 0 .*the helper itself posts the PR comment .* and the `jev-merge` success status on the exact head/);
  assert.match(r, /exit 5 means the gate passed but posting failed/); assert.match(r, /`--no-post` is a dry run/);
  assert.match(r, /Every other result .*the helper posts nothing/);
  const cli = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(cli, /if \(shouldPost\(rec, o\)\) \{\n\s+if \(a\.includes\("--no-post"\)\)/, "the CLI posts through shouldPost and honours --no-post");
});
