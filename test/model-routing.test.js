// WO64: the 2026-10-01 Jev model routing, and every model a seat is pinned to is one the proxy serves.
// config/proxy-models.json is a dated snapshot of the two catalogues seats use: `codex` = the slugs of the Codex catalog
// seat-bin-codex caches (codex-models.json), `ids` = the proxy's /v1/models (what Claude Code seats ask for). Where the
// live cache exists on this machine, Codex models are checked against it too.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cat = JSON.parse(fs.readFileSync(join(repo, "config/proxy-models.json"), "utf8"));
const yamlOf = (f) => JSON.parse(spawnSync("python3", ["-c", "import sys,json,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", f], { encoding: "utf8" }).stdout);
const members = [];
for (const f of fs.readdirSync(join(repo, "rig/template")).filter((n) => /\.ya?ml$/.test(n))) {
  const d = yamlOf(join(repo, "rig/template", f));
  for (const pod of (d && d.pods) || []) for (const m of pod.members || []) members.push({ file: f, pod: pod.id, member: m.id, runtime: m.runtime, model: m.model });
}
const bare = (m) => String(m).replace(/\[1m\]$/, "");

test("every template seat's model is in the proxy catalogue its runtime uses (Codex: the catalog slugs; Claude Code: /v1/models)", () => {
  assert.ok(members.length > 50, "the templates were read");
  const bad = members.filter((x) => x.model && !(x.runtime === "codex" ? cat.codex : cat.ids).includes(bare(x.model)));
  assert.deepEqual(bad, [], "a model the proxy doesn't serve");
  const live = join(os.homedir(), ".local/share/agent-stack/seat-bin/codex-models.json");
  if (fs.existsSync(live)) {
    let slugs = []; try { slugs = JSON.parse(fs.readFileSync(live, "utf8")).models.map((m) => m.slug); } catch { slugs = []; }
    if (slugs.length) assert.deepEqual(members.filter((x) => x.runtime === "codex" && !slugs.includes(x.model)), [], "not in this machine's live Codex catalog");
  }
});

test("the 2026-10-01 routing: every Codex seat gpt-6.1-sol; Claude test authors and UI implementers Sonnet 5.5; leads, Claude reviewers, architects and Kimi unchanged", () => {
  const off = [];
  for (const x of members) {
    const want = x.runtime === "codex" ? (/^kimi/.test(x.model) ? x.model : "gpt-6.1-sol")
      : /^kimi/.test(x.model) ? x.model
      : ["tests", "impl"].includes(x.pod) ? "claude-sonnet-5-5"
      : x.pod === "review" || x.pod === "integ" ? "claude-opus-5-5"
      : x.pod === "coord" ? (bare(x.model) === "claude-opus-5-5" ? x.model : "claude-opus-5-5")
      : x.pod === "arch" ? (["claude-fable-5-1", "claude-opus-5-5"].includes(x.model) ? x.model : "claude-fable-5-1")
      : x.model;
    if (x.model !== want) off.push(`${x.file} ${x.pod}.${x.member} (${x.runtime}): ${x.model}, want ${want}`);
  }
  assert.deepEqual(off, []);
  assert.ok(!members.some((x) => /^gpt-6-(astra|sol)$/.test(x.model)), "no seat left on gpt-6-astra / gpt-6-sol");
});

test("the Codex defaults, the pool configs and Claude's proxy settings follow the routing and are served", () => {
  for (const f of ["config.toml", "pool-impl.config.toml", "pool-review.config.toml", "pool-deep.config.toml"]) {
    const m = fs.readFileSync(join(repo, "system/codex", f), "utf8").match(/^model = "([^"]+)"/m);
    assert.equal(m && m[1], "gpt-6.1-sol", f); assert.ok(cat.codex.includes(m[1]), f);
  }
  const s = JSON.parse(fs.readFileSync(join(repo, "config/claude-proxy-settings.json"), "utf8"));
  assert.equal(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-5-5");
  for (const v of [s.model, ...Object.entries(s.env).filter(([k]) => /^ANTHROPIC_DEFAULT_.*_MODEL$/.test(k)).map(([, v]) => v), ...s.modelPicker.options.map((o) => o.model)])
    assert.ok(cat.ids.includes(bare(v)), `${v} is served`);
  assert.match(fs.readFileSync(join(repo, "system/env.sh"), "utf8"), /export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5\n/);
});

test("escalation is a fresh seat on the same model, not an 'Astra seat'; the docs name the 2026-10-01 decision", () => {
  for (const f of ["docs/REFERENCE.md", "rig/template/CULTURE.md", "rig/template/README.md", "rig/template/agents/lead/guidance/role.md"]) {
    const t = fs.readFileSync(join(repo, f), "utf8");
    assert.doesNotMatch(t, /Astra seat|strongest model \(GPT-6 Astra\)|Astra takes escalations/, f);
  }
  const ref = fs.readFileSync(join(repo, "docs/REFERENCE.md"), "utf8");
  assert.match(ref, /operator:model-routing-2026-10-01/); assert.match(ref, /Codex test author \(0\.69\), Codex architect incl\.\s+`arch\.astra` \(0\.64\) and the Codex lead of `fallback-codex\.yaml` \(0\.60\)/);
  // QA PR71: the guidance names the defaults AND the deliberate exceptions, so a correctly pinned seat isn't told it's wrong
  const start = fs.readFileSync(join(repo, "rig/template/startup/context.md"), "utf8");
  assert.match(start, /the one your rig's spec pins for your seat/); assert.match(start, /Codex `gpt-6\.1-sol`; Claude test authors and UI implementers\s+`claude-sonnet-5-5`/);
  assert.match(start, /`kimi-k3\[1m\]`\s+or `kimi-k3-256k`/); assert.match(start, /team\.yaml's architect is on Opus 5\.5/);
  assert.match(fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8"), /\| Plan decomposition, acceptance criteria, architecture \| Fable 5\.1 \(`team\.yaml` keeps Opus 5\.5\) \|/);
  // QA PR71: the README's full-stack row names the merge owner by the model the template pins (integ.codex: 6.1 Sol)
  const fsRow = fs.readFileSync(join(repo, "rig/template/README.md"), "utf8").split("\n").find((l) => l.startsWith("| `full-stack.yaml`"));
  const integ = members.find((x) => x.file === "full-stack.yaml" && x.pod === "integ");
  assert.equal(integ.model, "gpt-6.1-sol"); assert.match(fsRow, /GPT-6\.1 Sol merge owner/); assert.doesNotMatch(fsRow, /Opus[^,|]*merge owner/);
  for (const f of fs.readdirSync(join(repo, "rig/template")).filter((n) => /\.ya?ml$/.test(n))) {
    const t = fs.readFileSync(join(repo, "rig/template", f), "utf8");
    for (const l of t.split("\n").filter((x) => /^\s*(label:|#)/.test(x)))
      assert.doesNotMatch(l, /Astra (for escalations|second opinion|takes)|Opus for UI|\b8 Opus seats|GPT-6 (Sol|Astra)\b(?!.*case by case)/, `${f}: ${l.trim()}`);
  }
});
