// docs/PROJECT-ENV.md "Verify without printing values" (WO26 item 3): the documented pwcheck must compare the decoded
// DATABASE_URL passwords, reject files it can't parse, fail non-zero, and never print a value. The bash block is taken
// from the doc itself and run against fake env files in a temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "pwcheck-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const doc = fs.readFileSync(join(repo, "docs/PROJECT-ENV.md"), "utf8");
const a = doc.indexOf("```bash\n# pwhash"), b = doc.indexOf("\n```", a + 8);
const block = doc.slice(a + 8, b).split("\n").filter((l) => !l.startsWith("pwcheck .env.local")).join("\n");

function check(dev, prod) {
  for (const [f, v] of [["dev", dev], ["prod", prod]]) {
    fs.rmSync(join(root, f), { force: true });
    if (v !== null) fs.writeFileSync(join(root, f), v);
  }
  const r = spawnSync("bash", ["-c", `${block}\npwcheck "${root}/dev" "${root}/prod"`], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}
const url = (pw, host = "ep-dev.example.neon.tech", db = "/app") => `DATABASE_URL=postgresql://app:${pw}@${host}${db}\n`;

test("the doc has the block and calls pwcheck", () => {
  assert.ok(a > 0 && block.includes("pwcheck()") && block.includes("unquote"));
  assert.match(doc, /\npwcheck \.env\.local /);
});

test("different passwords: OK, exit 0", () => {
  const r = check(url("fake-dev"), url("fake-prod", "ep-prod.example.neon.tech"));
  assert.equal(r.status, 0, r.out); assert.match(r.out, /^OK/);
});

test("same password on another host (also when percent-encoded, quoted): FAIL, exit 1", () => {
  for (const dev of [url("fake-one"), url("fake%2Done"), `DATABASE_URL="postgresql://app:fake%2Done@h.example/app"\n`]) {
    const r = check(dev, url("fake-one", "ep-prod.example.neon.tech"));
    assert.equal(r.status, 1, r.out); assert.match(r.out, /same password/);
  }
});

test("missing file, key, host, database, password or wrong scheme: could not compare, exit 1", () => {
  const good = url("fake-prod", "ep-prod.example.neon.tech");
  for (const dev of [null, "OTHER=1\n", "DATABASE_URL=postgresql://app:fake-one@\n", url("fake-one", "h.example", ""),
    "DATABASE_URL=postgresql://app@h.example/app\n", "DATABASE_URL=mysql://app:fake-one@h.example/app\n", "DATABASE_URL=\n"]) {
    const r = check(dev, good);
    assert.equal(r.status, 1, `${dev}: ${r.out}`); assert.match(r.out, /could not compare/);
  }
});

test("no password value is ever printed", () => {
  const outs = [check(url("fake-secret-dev"), url("fake-secret-prod")), check(url("fake-secret-dev"), url("fake-secret-dev")),
    check("DATABASE_URL=postgresql://app:fake-secret-dev@\n", url("fake-secret-prod"))].map((r) => r.out).join("");
  assert.doesNotMatch(outs, /fake-secret/);
});
