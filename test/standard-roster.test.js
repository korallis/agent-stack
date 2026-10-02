// WO88 item 4: the 16-seat standard team, the routing table it pins, and agent-project-check's FAIL on a 1M-window
// ([1m]) model outside the lead and architect seats (a 1M seat re-sends up to a million tokens each turn).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "roster-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, s, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); };

// members of a rig spec as [pod, id, runtime, model, startup text]
function members(yaml) {
  return yaml.split(/\n  - id: /).slice(1).flatMap((pod) => {
    const p = pod.split("\n", 1)[0].trim();
    return pod.split(/\n      - id: /).slice(1).map((m) => [p, m.split("\n", 1)[0].trim(), (m.match(/runtime: (\S+)/) || [])[1],
      (m.match(/model: "([^"]+)"/) || [])[1] ?? null, (m.match(/value: "([^"]+)"/) || [])[1] ?? null]);
  });
}

test("standard.yaml: 16 seats, four families, 1M windows only for the lead and the architect", () => {
  const ms = members(fs.readFileSync(join(repo, "rig/template/standard.yaml"), "utf8"));
  assert.equal(ms.length, 16);
  const count = (pod) => ms.filter((m) => m[0] === pod).length;
  assert.deepEqual(["coord", "arch", "impl", "tests", "review", "qa", "integ", "ops"].map(count), [2, 1, 4, 2, 3, 2, 1, 1]);
  for (const [pod, id, , model, start] of ms) {
    const effective = model ?? (start?.match(/--model (\S+)/) || [])[1];
    if (!["coord", "arch"].includes(pod)) assert.ok(!/\[1m\]/.test(effective ?? ""), `${pod}-${id}: ${effective}`);
  }
  // native seats run agent-native-seat with a real role, and resume through it on restore
  const native = ms.filter((m) => m[2] === "terminal");
  assert.deepEqual(native.map((m) => `${m[0]}-${m[1]}`), ["impl-grok-1", "impl-grok-2", "tests-grok", "review-grok", "review-kimi"]);
  for (const [pod, id, , , start] of native) {
    const [, cli, role, model] = start.match(/^agent-native-seat (grok|kimi) --role (\S+) --model (\S+)$/) ?? [];
    assert.ok(cli && fs.existsSync(join(repo, "rig/template/agents", role, "guidance/role.md")), `${pod}-${id}: ${start}`);
    assert.ok(cli === "grok" ? /^grok-4\.7/.test(model) : model === "kimi-code/k3-256k", model);
  }
  assert.match(fs.readFileSync(join(repo, "rig/template/standard.yaml"), "utf8"), /applies_on: \[fresh_start, restore\], idempotent: true/);
  // reviewers span three families, so every author has two others
  const reviewers = ms.filter((m) => m[0] === "review").map((m) => m[2] === "terminal" ? m[4].split(" ")[1] : m[2]);
  assert.deepEqual(reviewers.sort(), ["codex", "grok", "kimi"]);
});

test("every rig template keeps 1M windows to the lead and architect seats", () => {
  for (const f of fs.readdirSync(join(repo, "rig/template")).filter((f) => f.endsWith(".yaml"))) {
    for (const [pod, id, , model] of members(fs.readFileSync(join(repo, "rig/template", f), "utf8")))
      if (!["coord", "arch"].includes(pod)) assert.ok(!/\[1m\]/.test(model ?? ""), `${f}: ${pod}-${id} ${model}`);
  }
});

test("CULTURE's routing table matches the roster and states the 1M rule", () => {
  const c = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const table = c.slice(c.indexOf("## Models and routing"), c.indexOf("\n## ", c.indexOf("## Models and routing") + 5));
  assert.match(table, /Backend implementation \| Grok 4\.7 Build Fast \(native grok seat\)/);
  assert.match(table, /Review \| Grok 4\.7, Kimi K3 \(256k\) and GPT-6\.1 Sol/);
  assert.match(table, /Only leads and architects use a 1M window[\s\S]*FAILs a\s+`\[1m\]` model/);
  assert.doesNotMatch(table, /Kimi K3 \(1M\)/, "the old 1M Kimi row is gone");
});

// agent-project-check: a workspace with a spec, a fake `rig` that says the rig is running, a fake daemon with live seats
async function check(spec, nodes) {
  const home = fs.mkdtempSync(join(root, "h-")), W = join(home, "Projects/P-work"), bin = join(home, "bin");
  write(join(W, "project.yaml"), "kind: project\n"); write(join(W, "rig/team.yaml"), spec);
  for (const t of ["gh", "systemctl", "curl", "tmux"]) write(join(bin, t), "#!/bin/sh\nexit 1\n", 0o755);
  write(join(bin, "rig"), `#!/bin/sh\ncase "$*" in\n  "ps --json") echo '[{"name":"t"}]' ;;\n  "queue list"*) echo '[]' ;;\n  *) exit 1 ;;\nesac\n`, 0o755);
  const server = http.createServer((req, res) => {
    const body = req.url === "/api/rigs/summary" ? [{ id: "R", name: "t" }] : req.url === "/api/rigs/R/nodes" ? nodes : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = await new Promise((resolve) => {
    let so = "";
    const p = spawn("python3", [join(repo, "bin/agent-project-check"), W, "--json"],
      { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: `http://127.0.0.1:${server.address().port}`, AGENT_OWNER_ADDRESS: "owner@external" } });
    let se = ""; p.stderr.on("data", (d) => (se += d)); p.stdout.on("data", (d) => (so += d)); p.on("close", () => resolve(so || se));
  });
  server.close();
  return JSON.parse(out).find((x) => x.check.startsWith("only leads and architects use a 1M-token window"));
}
const spec = (reviewModel) => `name: t\npods:\n  - id: coord\n    members:\n      - id: lead-claude\n        model: "claude-opus-5-5[1m]"\n` +
  `  - id: review\n    members:\n      - id: kimi\n        model: "${reviewModel}"\n`;

test("agent-project-check FAILs a [1m] model outside the lead and architect seats, in the spec and on live seats", async () => {
  const bad = await check(spec("kimi-k3[1m]"), [
    { canonicalSessionName: "coord-lead-claude@t", podNamespace: "coord", model: "claude-opus-5-5[1m]", nodeKind: "agent" },
    { canonicalSessionName: "impl-claude-1@t", podNamespace: "impl", model: "claude-sonnet-5-5[1m]", nodeKind: "agent" }]);
  assert.equal(bad?.level, "FAIL");
  assert.match(bad.detail, /review-kimi \(spec: kimi-k3\[1m\]\)/); assert.match(bad.detail, /impl-claude-1@t \(live: claude-sonnet-5-5\[1m\]\)/);
  assert.doesNotMatch(bad.detail, /coord/, "the lead may hold 1M");
  assert.match(bad.detail, /rig seat set-model/);
  const good = await check(spec("kimi-k3-256k"), [{ canonicalSessionName: "coord-lead-claude@t", podNamespace: "coord", model: "claude-opus-5-5[1m]", nodeKind: "agent" }]);
  assert.equal(good?.level, "OK");
});
