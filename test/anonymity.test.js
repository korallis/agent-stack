// The repo is public: it must not name the owner's client projects or people (WO31 privacy). Every tracked text file is
// split into words; a word whose SHA-256 matches one of the names below fails the test with file:line. The names are
// stored only as hashes, so this file doesn't contain them. To add a name: printf %s <word> | sha256sum | cut -c1-16
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = new Set([   // client projects and people (lower-case words)
  "1296caae771fe519", "e0f67474fc1a3036", "850f9ef8d53cf476", "f3787cb0fcafe15c", "fc274819fb7e02e6", "1372c63b35ea72a5",
]);
const hash = (w) => createHash("sha256").update(w).digest("hex").slice(0, 16);

test("no tracked file names the owner's client projects or people", () => {
  const files = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).stdout.split("\0").filter(Boolean)
    .filter((f) => !/(^|\/)(package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock)$/.test(f));
  const hits = [];
  for (const f of files) {
    let text;
    try { const buf = fs.readFileSync(join(repo, f)); if (buf.includes(0)) continue; text = buf.toString("utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      for (const w of line.toLowerCase().match(/[a-z0-9]+/g) || []) if (FORBIDDEN.has(hash(w))) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], "anonymise these lines (a neutral example such as shop-app, or 'project A')");
});

test("the check itself works: a planted word is found", () => {
  assert.ok(FORBIDDEN.has(hash(["h", "c"].join(""))), "the hash list is the one this test checks");
  assert.ok(!FORBIDDEN.has(hash("shop")));
});
