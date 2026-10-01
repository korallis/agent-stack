// WO74: patch 142 (0.6.3) captures every seat's pane for the structural activity sweep with a few tmux calls instead
// of one fork per seat. The adapter method is taken from the patch itself and run against a fake tmux that behaves
// like the real one: single-quoted args, `=name:` exact session targets, and a `\;` chain that stops at its first
// failing command (exit 1). Proof on a real isolated tmux server and the patched sweep is in the PR.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const patch = fs.readFileSync(join(repo, "patches/openrig/0.6.3/142-batched-structural-capture.patch"), "utf8");
const files = patch.split(/^(?=--- a\/)/m);
const addedIn = (file) => files.find((f) => f.startsWith(`--- a/${file}`)).split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
// the patched file's text as far as the hunks show it (context + added lines)
const newSide = (file) => files.find((f) => f.startsWith(`--- a/${file}`)).split("\n")
  .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || l.startsWith(" ")).map((l) => l.slice(1)).join("\n");
const tmuxAdded = addedIn("daemon/dist/adapters/tmux.js");
const constLine = tmuxAdded.find((l) => l.startsWith("const CAPTURE_BATCH"));
const start = tmuxAdded.findIndex((l) => l.includes("async capturePanesContent("));
const end = tmuxAdded.findIndex((l, i) => i > start && l === "    }");
const tmp = fs.mkdtempSync(join(os.tmpdir(), "structural-batch-"));
const mod = join(tmp, "adapter.mjs");
fs.writeFileSync(mod, `import { randomUUID } from "node:crypto";
function shellQuote(s) { return "'" + s.replace(/'/g, "'\\"'\\"'") + "'"; }
${constLine}
export class Adapter { constructor(exec) { this.exec = exec; }
${tmuxAdded.slice(start, end + 1).join("\n")}
}
`);
const { Adapter } = await import(pathToFileURL(mod).href);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake tmux server: `sessions` maps name -> pane text (newline-terminated, as capture-pane prints it).
function tmux(sessions, { failListing = false, vanish = new Set() } = {}) {
  const calls = [];
  const unquote = (s) => s.replace(/'"'"'/g, "\u0000").replace(/^'|'$/g, "").replace(/\u0000/g, "'");
  const exec = async (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith("tmux list-sessions")) {
      if (failListing) throw new Error("no server running");
      return Object.keys(sessions).join("\n") + "\n";
    }
    let out = "";
    for (const part of cmd.replace(/^tmux /, "").split(" \\; ")) {
      const target = unquote(part.match(/-t ('(?:[^']|'"'"')*')/)[1]);
      const name = target.match(/^=(.*):$/)?.[1];
      assert.ok(name !== undefined, `exact =name: target expected, got ${target}`);
      if (!(name in sessions) || vanish.has(name)) throw Object.assign(new Error(`can't find session: ${name}`), { stdout: out });
      if (part.startsWith("display-message")) out += unquote(part.match(/('(?:[^']|'"'"')*')$/)[1]) + "\n";
      else out += part.includes(" -e ") ? `\x1b[2m${sessions[name]}\x1b[0m\n` : sessions[name];
    }
    return out;
  };
  return { exec, calls };
}
const pane = (n) => `• ${n} output\n\n› \n`;

test("live seats in ONE chained call after one listing; text as capture-pane prints it; a missing seat is null and costs no fork", async () => {
  const t = tmux({ alpha: pane("alpha"), "beta.x": pane("beta.x"), "o'q": pane("o'q") });
  const got = await new Adapter(t.exec).capturePanesContent(["alpha", "gone", "beta.x", "o'q"], 20);
  assert.equal(t.calls.length, 2);
  assert.deepEqual(Object.fromEntries(got), { gone: null, alpha: pane("alpha"), "beta.x": pane("beta.x"), "o'q": pane("o'q") });
  assert.match(t.calls[1], /capture-pane -p -t '=alpha:' -S -20/);
});

test("chunks of 24 bound each call; a chunk whose session vanished is left out for the per-seat path, the others kept", async () => {
  const sessions = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}`, pane(`s${i}`)]));
  const t = tmux(sessions, { vanish: new Set(["s30"]) });
  const got = await new Adapter(t.exec).capturePanesContent(Object.keys(sessions), 20);
  assert.equal(t.calls.length, 1 + 3);
  for (const c of t.calls.slice(1)) assert.ok(c.split(" \\; ").length <= 48, "24 seats = 48 chained commands at most");
  for (let i = 0; i < 50; i++) {
    const inFailedChunk = i >= 24 && i < 48;
    assert.equal(got.has(`s${i}`), !inFailedChunk, `s${i}`);
    if (!inFailedChunk) assert.equal(got.get(`s${i}`), pane(`s${i}`));
  }
});

test("tmux can't be listed -> null (the sweep falls back to per-seat); knownLive skips the listing; ansi adds -e", async () => {
  assert.equal(await new Adapter(tmux({ a: pane("a") }, { failListing: true }).exec).capturePanesContent(["a"], 20), null);
  const t = tmux({ a: pane("a") }, { failListing: true });
  const got = await new Adapter(t.exec).capturePanesContent(["a"], 20, true, new Set(["a"]));
  assert.equal(t.calls.length, 1); assert.match(t.calls[0], /capture-pane -p -e -t '=a:'/);
  assert.match(got.get("a"), /\x1b\[2m/);
});

test("a pane that prints another call's marker text can't split the output (markers carry a per-call nonce)", async () => {
  const spoof = "__openrig_capture_00000000000000000000000000000000_1__\n";
  const t = tmux({ a: `x\n${spoof}y\n`, b: pane("b") });
  const got = await new Adapter(t.exec).capturePanesContent(["a", "b"], 20);
  assert.equal(got.get("a"), `x\n${spoof}y\n`); assert.equal(got.get("b"), pane("b"));
  const nonces = new Set(); for (let i = 0; i < 3; i++) {
    const tt = tmux({ a: pane("a") }); await new Adapter(tt.exec).capturePanesContent(["a"], 20);
    nonces.add(tt.calls[1].match(/__openrig_capture_([0-9a-f]+)_0__/)[1]);
  }
  assert.equal(nonces.size, 3);
});

test("the sweep uses the batch (plain, then ANSI for 'unknown' seats with no second listing) and keeps per-seat fallback, MF1, MF2", () => {
  const svc = newSide("daemon/dist/domain/seat-structural-activity-service.js");
  assert.match(svc, /const plain = await this\.tmuxAdapter\.capturePanesContent\(names, this\.captureLines, false\)\.catch\(\(\) => null\);/);
  assert.match(svc, /capturePanesContent\(unknown, this\.captureLines, true, new Set\(unknown\)\)/);
  assert.match(svc, /await this\.pollSeat\(r\.session_name, prefetched\);/);
  assert.match(svc, /if \(prefetched\?\.plain\?\.has\(sessionName\)\) \{\s*content = prefetched\.plain\.get\(sessionName\);\s*\}\s*else \{\s*try \{\s*content = await this\.tmuxAdapter\.capturePaneContent\(sessionName, this\.captureLines\);/);
  const removed = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1).trim());
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim());
  assert.ok(!removed.some((l) => /sweeping/.test(l)), "the single-flight guard is untouched (MF2)");
  for (const l of removed.filter((x) => /latestBySession\.delete/.test(x)))
    assert.ok(added.includes(l), `an invalidation is kept (MF1): ${l}`);
  assert.match(svc, /if \(content === null\) \{\s*this\.latestBySession\.delete\(sessionName\);/, "a null capture still invalidates (MF1)");
});
