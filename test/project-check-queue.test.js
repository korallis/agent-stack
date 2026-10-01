// WO77: agent-project-check reads the queue without bodies (`rig queue list` without --full: with every body of every
// rig it timed out on a large queue) and fetches bodies per row over the daemon's HTTP API only where a check needs
// them: wave-map rows, and the newest 200 recent rows for worktree_path=. Fake rig and a fake daemon; no live queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(os.tmpdir(), "pcq-"));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const W = join(home, "Projects/P-work"), bin = join(home, "bin"), args = join(home, "rig-args");
const write = (p, s, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); };
write(join(W, "project.yaml"), "kind: project\n");
write(join(W, "rig/team.yaml"), `name: t\npods:\n  - id: coord\n    members:\n      - id: lead\n        cwd: "${home}"\n`);
for (const t of ["gh", "systemctl", "curl"]) write(join(bin, t), "#!/bin/sh\nexit 1\n", 0o755);

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MAP = '```json\n{"format":"wave-map-v1","mission":"m1","waves":[]}\n```';
const rows = [
  { qitemId: "qitem-map-ok", destinationSession: "lead@t", sourceSession: "lead@t", tsCreated: iso(5 * 86400e3), tags: ["wave-map"], body: "" },
  { qitemId: "qitem-map-bad", destinationSession: "lead@t", sourceSession: "lead@t", tsCreated: iso(5 * 86400e3), tags: ["wave-map"], body: "" },
  { qitemId: "qitem-map-gone", destinationSession: "lead@t", sourceSession: "lead@t", tsCreated: iso(5 * 86400e3), tags: ["wave-map"], body: "" },
  // 210 recent rows, compact (no body); the newest 100 are read; 170 rows carry worktree_path=
  ...Array.from({ length: 210 }, (_, i) => ({ qitemId: `qitem-r${String(i).padStart(3, "0")}`, destinationSession: "impl-a@t", sourceSession: "lead@t",
    tsCreated: iso((i + 1) * 60e3), tags: ["project:P", "mission:m1"], body: "" })),
];
const bodies = { "qitem-map-ok": `wave map\n${MAP}`, "qitem-map-bad": "no block here",
  ...Object.fromEntries(rows.slice(3).map((r, i) => [r.qitemId, i < 170 ? "do it\n\nworktree_path=/w/impl-a\n" : "do it"])) };
write(join(bin, "rig"), `#!/bin/sh\necho "$*" >> ${args}\ncase "$*" in\n  "queue list"*) cat ${join(home, "rows.json")} ;;\n  *) exit 1 ;;\nesac\n`, 0o755);
fs.writeFileSync(join(home, "rows.json"), JSON.stringify(rows));

test("the queue list has no --full; bodies come per row: wave-map rows, and the newest 100 recent rows only", async () => {
  const requested = [];
  const server = http.createServer((req, res) => {
    const m = /^\/api\/queue\/([^/?]+)$/.exec(req.url);
    if (m && bodies[decodeURIComponent(m[1])] !== undefined) {
      requested.push(decodeURIComponent(m[1]));
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ qitemId: m[1], body: bodies[decodeURIComponent(m[1])] }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = await new Promise((resolve) => {
    let so = "", se = "";
    const p = spawn("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: url, AGENT_OWNER_ADDRESS: "owner@external" } });
    p.stdout.on("data", (d) => (so += d)); p.stderr.on("data", (d) => (se += d));
    p.on("close", () => resolve({ so, se }));
  });
  server.close();
  const r = JSON.parse(out.so), find = (pre) => r.filter((x) => x.check.startsWith(pre));
  const listCall = fs.readFileSync(args, "utf8").split("\n").find((l) => l.startsWith("queue list"));
  assert.equal(listCall, "queue list -A -a --json --limit 20000");
  assert.equal(find("could not read the queue").length, 0, out.se.slice(-300));
  assert.equal(find("wave-map row qitem-map-ok").length, 0, "a valid wave map is read from its fetched body");
  assert.equal(find("wave-map row qitem-map-bad")[0]?.level, "FAIL");
  assert.equal(find("could not read the body of wave-map row qitem-map-gone")[0]?.level, "WARN");
  const wtp = find("queue rows carry worktree_path=")[0];
  assert.equal(wtp.level, "OK"); assert.equal(wtp.detail, "100/100 of the newest 100 of 210");
  const recentFetched = requested.filter((id) => id.startsWith("qitem-r"));
  assert.equal(recentFetched.length, 100, "one request per sampled row, none for the rest");
  assert.ok(!recentFetched.includes("qitem-r100") && recentFetched.includes("qitem-r000") && recentFetched.includes("qitem-r099"), "the newest are sampled");
  assert.match(find("queue rows carry mission:/slice: tags")[0].detail, /^210\/210$/);
});
