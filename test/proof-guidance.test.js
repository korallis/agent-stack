// Seats attach screenshots and video with `rig proof add --media`, never as `--file` (OpenRig 0.6.1 rewrote an image
// passed as --file in place; patch 137 refuses it). The rig template's rules say so where seats read them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => fs.readFileSync(join(repo, p), "utf8");

test("CULTURE and the implementer/QA roles attach images with --media and never as --file", () => {
  for (const p of ["rig/template/CULTURE.md", "rig/template/agents/implementer/guidance/role.md", "rig/template/agents/qa/guidance/role.md"]) {
    const t = read(p);
    assert.match(t, /--media <file>/, p);
    assert.match(t, /never (pass )?an image as `--file`/, p);
  }
});

test("patch 137 ships for 0.6.1 and is documented", () => {
  assert.ok(fs.existsSync(join(repo, "patches/openrig/0.6.1/137-proof-add-binary-file.patch")));
  assert.match(read("patches/openrig/README.md"), /\| `137-proof-add-binary-file` \|/);
});
