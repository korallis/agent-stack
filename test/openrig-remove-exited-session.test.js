// WO94: patch 143 (0.6.3) lets `rig remove` / `rig shrink` remove a seat whose tmux session has already exited.
// With the delivery guard on, killSession first reads the bound session's panes; native tmux reports a missing session
// to `list-panes` as "can't find window" (not "can't find session"), so 0.6.3 returned that as a kill failure and
// removal stopped with kill_failed. The patch (upstream 48f6cce7, mvschwarz/openrig#431 for #403) confirms absence
// with `has-session` and only then answers session_not_found, which removal treats as already stopped.
// The real 0.6.3 adapter (vendored, test/fixtures/openrig-0.6.3-tmux) with the 0.6.3 patches that touch it, against a
// fake tmux that answers with real tmux 3.7's messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "test/fixtures/openrig-0.6.3-tmux");
const tmp = fs.mkdtempSync(join(os.tmpdir(), "remove-exited-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a copy of the pristine files with each 0.6.3 patch's tmux.js part applied, in order (whole or not at all)
function adapterWith(patches) {
  const dir = fs.mkdtempSync(join(tmp, "pkg-"));
  fs.cpSync(fixture, dir, { recursive: true });
  for (const name of patches) {
    const text = fs.readFileSync(join(repo, "patches/openrig/0.6.3", name), "utf8");
    const part = text.split(/^(?=--- a\/)/m).filter((f) => f.startsWith("--- a/daemon/dist/adapters/tmux.js")).join("");
    const r = spawnSync("patch", ["-p1", "-s", "-d", dir], { input: part, encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
  return join(dir, "daemon/dist/adapters/tmux.js");
}
const BEFORE = ["135-codex-idle-composer.patch", "139-batch-seat-tmux-reads.patch", "142-batched-structural-capture.patch"];

// fake tmux: `live` session names; messages as tmux 3.7 prints them (checked on an isolated server); a pane row in the
// adapter's own "|" format
function fakeTmux(live, { permission = false } = {}) {
  const calls = [];
  const name = (cmd) => cmd.match(/-t '([^']*)'/)?.[1];
  const fail = (cmd, msg) => { throw new Error(`Command failed: ${cmd}\n${msg}`); };
  const exec = async (cmd) => {
    calls.push(cmd.split(" ").slice(0, 2).join(" "));
    const n = name(cmd);
    if (permission) fail(cmd, "error connecting to /tmp/tmux-1000/default (Permission denied)");
    if (cmd.startsWith("tmux list-panes")) return live.has(n) ? "%7|0|/w|80|24|1\n" : fail(cmd, `can't find window: ${n}`);
    if (cmd.startsWith("tmux has-session")) return live.has(n) ? "" : fail(cmd, `can't find session: ${n}`);
    // the guarded kill reads the session's immutable id ($3) and kills by it
    if (cmd.startsWith("tmux display-message")) return "$3\n";
    if (cmd.startsWith("tmux kill-session")) return (n === "$3" ? live.size && (live.clear(), true) : live.delete(n)) ? "" : fail(cmd, `can't find session: ${n}`);
    return "";
  };
  return { exec, calls };
}
// the guard as removal sees it: a node whose seat name resolves (bound or by its canonical name)
const guardFor = (session) => {
  const t = { nodeId: "n1", session, pane: "%7", occupant: "o1" };
  return { maybeTarget: () => t, target: () => t, input: (_id, fn) => fn(), checkInput() {}, ownsLifecycle: () => false };
};

async function kill(file, live, opts) {
  const { TmuxAdapter } = await import(pathToFileURL(file).href + `?${Math.random()}`);
  const t = fakeTmux(live, opts);
  const a = new TmuxAdapter(t.exec);
  a.deliveryGuard = guardFor("impl-codex-4@app");
  return { result: await a.killSession("impl-codex-4@app"), calls: t.calls };
}

test("0.6.3 as published: an exited seat's guarded kill fails, so removal stops with kill_failed (the reported ghost)", async () => {
  const { result } = await kill(adapterWith(BEFORE), new Set());
  assert.notEqual(result.code, "session_not_found");
  assert.match(result.message, /can't find window: impl-codex-4@app/);
});

test("patch 143: an exited seat reads as session_not_found after has-session confirms it; removal goes on", async () => {
  const file = adapterWith([...BEFORE, "143-remove-exited-session.patch"]);
  const gone = await kill(file, new Set());
  assert.equal(gone.result.code, "session_not_found");
  assert.deepEqual(gone.calls, ["tmux list-panes", "tmux has-session"], "absence confirmed before it counts");
  // a live seat is still killed as before
  const live = await kill(file, new Set(["impl-codex-4@app"]));
  assert.deepEqual(live.result, { ok: true });
  assert.ok(live.calls.includes("tmux kill-session"));
  // a permission failure is never absence
  const denied = await kill(file, new Set(), { permission: true });
  assert.notEqual(denied.result.code, "session_not_found");
});

test("patch 143 touches only tmux.js and names its upstream fix", () => {
  const patch = fs.readFileSync(join(repo, "patches/openrig/0.6.3/143-remove-exited-session.patch"), "utf8");
  assert.match(patch, /^--- a\/daemon\/dist\/adapters\/tmux\.js$/m);
  assert.match(patch, /upstream 48f6cce7, mvschwarz\/openrig#431 for #403/);
});
