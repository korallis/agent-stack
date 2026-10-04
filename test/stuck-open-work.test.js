// agent-stuck-check asks Jev only about seats holding open work. A parked row (state blocked, on a named blocker) is
// waiting, not work the seat could do: seats whose only rows were parked on external:...:github-auth were flagged as
// stuck (2026-10-04). OpenRig's assigned count includes parked rows, so only work beyond them counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { holdsOpenWork, shouldAsk } from "../orchestration/stuck.js";

const seat = "impl-1@app", other = "qa-1@app";
const row = (state, dest = seat, extra = {}) => ({ qitemId: `q-${Math.random()}`, destinationSession: dest, state, ...extra });

test("parked rows alone are not open work; an active row or assigned work beyond the parked rows is", () => {
  const parked = [row("blocked", seat, { blockedOn: "external:operator@kernel:github-auth" }), row("blocked", seat, { blockedOn: "pr:o/r#5" })];
  assert.equal(holdsOpenWork({ assigned: 2, rows: parked, seat }), false, "assigned 2 = the two parked rows");
  assert.equal(holdsOpenWork({ assigned: 3, rows: parked, seat }), true, "one more assigned than parked (e.g. beyond the list's limit)");
  assert.equal(holdsOpenWork({ assigned: 2, rows: [...parked, row("in-progress")], seat }), true, "an in-progress row");
  assert.equal(holdsOpenWork({ assigned: 0, rows: [row("claimed")], seat }), true, "a claimed row");
  assert.equal(holdsOpenWork({ assigned: 1, rows: [row("in-progress", other)], seat }), true, "assigned work the list doesn't show");
  assert.equal(holdsOpenWork({ assigned: 0, rows: [row("in-progress", other), row("pending")], seat }), false, "another seat's row; a pending one isn't held");
  assert.equal(holdsOpenWork({ assigned: 0, rows: [], seat }), false);
});

test("without the queue list the assigned count decides (never quieter than before)", () => {
  assert.equal(holdsOpenWork({ assigned: 2, rows: null, seat }), true);
  assert.equal(holdsOpenWork({ assigned: 0, rows: undefined, seat }), false);
});

test("a seat whose only rows are parked is never asked about, however still its screen", () => {
  const openWork = holdsOpenWork({ assigned: 1, rows: [row("blocked")], seat });
  assert.equal(shouldAsk({ openWork, hashes: ["a", "a", "a"], repeat: "same line" }), false);
  const live = fs.readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../orchestration/stuck.js"), "utf8");
  assert.match(live, /const openWork = holdsOpenWork\(\{ assigned: s\.assigned, rows: listed, seat: s\.seat \}\);/, "the live run uses it");
});
