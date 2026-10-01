// WO65 / QA PR72: patch 137-proof-replace-keeps-sources (0.6.3). Upstream #177 made `rig proof add --replace` write
// with flag "w", i.e. THROUGH the name: a proof/x.md symlink or hardlink to a screenshot turned the screenshot into
// Markdown, and `--file proof/self.md --name self.md --replace` overwrote its own source. The patch's helper is taken
// from the patch itself and run against real files: replace renames over the name, the source is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const patch = fs.readFileSync(join(repo, "patches/openrig/0.6.3/137-proof-replace-keeps-sources.patch"), "utf8");
const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
const start = added.findIndex((l) => l.startsWith("export function writeProofArtifact("));
const end = added.indexOf("}", start) + 1; // the helper ends at its first column-0 brace
const tmp = fs.mkdtempSync(join(os.tmpdir(), "proof-replace-"));
const mod = join(tmp, "helper.mjs");
fs.writeFileSync(mod, 'import fs from "node:fs";\nimport path from "node:path";\nimport { randomUUID } from "node:crypto";\n' + added.slice(start, end).join("\n") + "\n");
const { writeProofArtifact } = await import(pathToFileURL(mod).href);
const PNG = Buffer.from("\x89PNG\r\n\x1a\nsynthetic-image", "latin1");
let n = 0;
function fixture() {
  const d = join(tmp, `case-${++n}`); const proof = join(d, "proof");
  fs.mkdirSync(proof, { recursive: true });
  const png = join(d, "shot.png"); fs.writeFileSync(png, PNG);
  return { d, proof, png };
}
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("the patch replaces 0.6.3's write-through (flag 'w') with the helper, and the CLI refuses a self-source drop", () => {
  assert.ok(start >= 0 && end > start, "the helper is in the patch");
  assert.match(patch, /^-.*flag: opts\.replace \? "w" : "wx"/m);
  assert.match(patch, /^\+.*writeProofArtifact\(target, .*\{ replace: opts\.replace === true, source: opts\.file \}\)/m);
  assert.match(patch, /^\+.*written === "is-source"/m); assert.match(patch, /^\+.*written === "exists"/m);
  assert.match(patch, /^\+import \{ randomUUID \} from "node:crypto";/m);
  assert.match(patch, /^--- a\/dist\/commands\/proof\.js$/m);
});

test("--replace over a symlink to a screenshot: the name gets the artifact, the screenshot keeps its bytes", () => {
  const { proof, png } = fixture(); const t = join(proof, "shot.md");
  fs.symlinkSync(png, t);
  assert.equal(writeProofArtifact(t, "artifact", { replace: true }), null);
  assert.ok(!fs.lstatSync(t).isSymbolicLink()); assert.equal(fs.readFileSync(t, "utf8"), "artifact");
  assert.deepEqual(fs.readFileSync(png), PNG); assert.deepEqual(leftovers(proof), []);
});

test("--replace over a hardlink to a screenshot: the other link keeps its bytes", () => {
  const { proof, png } = fixture(); const t = join(proof, "shot.md");
  fs.linkSync(png, t);
  assert.equal(writeProofArtifact(t, "artifact", { replace: true }), null);
  assert.equal(fs.readFileSync(t, "utf8"), "artifact"); assert.deepEqual(fs.readFileSync(png), PNG);
  assert.notEqual(fs.statSync(t).ino, fs.statSync(png).ino);
});

test("the --file source is never the target: same path, a hardlink or a symlink to it are refused, nothing changes", () => {
  const { d, proof } = fixture(); const self = join(proof, "self.md");
  fs.writeFileSync(self, "source evidence\n");
  for (const replace of [true, false]) assert.equal(writeProofArtifact(self, "artifact", { replace, source: self }), "is-source");
  const outside = join(d, "src.md"); fs.writeFileSync(outside, "outside source\n");
  const hl = join(proof, "hl.md"); fs.linkSync(outside, hl);
  const sl = join(proof, "sl.md"); fs.symlinkSync(outside, sl);
  assert.equal(writeProofArtifact(hl, "artifact", { replace: true, source: outside }), "is-source");
  assert.equal(writeProofArtifact(sl, "artifact", { replace: true, source: outside }), "is-source");
  assert.equal(fs.readFileSync(self, "utf8"), "source evidence\n"); assert.equal(fs.readFileSync(outside, "utf8"), "outside source\n");
  assert.deepEqual(leftovers(proof), []);
});

test("a different --file source still replaces; without --replace an existing name (file or link) is refused", () => {
  const { d, proof, png } = fixture(); const t = join(proof, "qa.md");
  const src = join(d, "notes.md"); fs.writeFileSync(src, "notes\n");
  assert.equal(writeProofArtifact(t, "first", { source: src }), null);
  assert.equal(writeProofArtifact(t, "second", { source: src }), "exists"); assert.equal(fs.readFileSync(t, "utf8"), "first");
  assert.equal(writeProofArtifact(t, "second", { replace: true, source: src }), null); assert.equal(fs.readFileSync(t, "utf8"), "second");
  const sl = join(proof, "link.md"); fs.symlinkSync(png, sl);
  assert.equal(writeProofArtifact(sl, "x"), "exists"); assert.deepEqual(fs.readFileSync(png), PNG);
  assert.equal(fs.readFileSync(src, "utf8"), "notes\n");
});

test("a failed replace leaves no temp file behind and the error surfaces", () => {
  const { proof } = fixture(); const t = join(proof, "dir.md");
  fs.mkdirSync(t); fs.writeFileSync(join(t, "keep"), "x");
  assert.throws(() => writeProofArtifact(t, "artifact", { replace: true }));
  assert.deepEqual(leftovers(proof), []); assert.equal(fs.readFileSync(join(t, "keep"), "utf8"), "x");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
