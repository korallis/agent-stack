// Seats gave up on seconds-long 429 bursts with Codex's proxy retries at 4/5 (2026-10-02). install.sh keeps
// request_max_retries and stream_max_retries under [model_providers.cliproxyapi] at 12 or more (system/codex-retries),
// never lowering them, and the pool-*.config.toml role profiles (layered on top by `codex -p`) inherit them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(repo, "system/codex-retries");
const root = fs.mkdtempSync(join(os.tmpdir(), "codex-retries-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const write = (text) => { const d = join(root, `c${n++}`); fs.mkdirSync(d); const f = join(d, "config.toml"); fs.writeFileSync(f, text, { mode: 0o600 }); return f; };
const run = (f, check) => spawnSync("python3", [tool, ...(check ? ["--check"] : []), f], { encoding: "utf8" });
const shipped = fs.readFileSync(join(repo, "system/codex/config.toml"), "utf8");
const old = shipped.replace("request_max_retries = 12", "request_max_retries = 4").replace("stream_max_retries = 12", "stream_max_retries = 5");

test("4/5 become 12/12 in place: only those two lines change, a backup is kept, the mode is kept; --check only reports", () => {
  const f = write(old);
  const c = run(f, true); assert.equal(c.status, 1); assert.match(c.stdout, /needs request_max_retries >= 12 \(now 4\), stream_max_retries >= 12 \(now 5\)/);
  assert.equal(fs.readFileSync(f, "utf8"), old, "--check writes nothing");
  const r = run(f); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /set request_max_retries = 12, stream_max_retries = 12 \(backup config\.toml\.bak-\d+\)/);
  const after = fs.readFileSync(f, "utf8");
  assert.equal(after, old.replace("request_max_retries = 4", "request_max_retries = 12").replace("stream_max_retries = 5", "stream_max_retries = 12"));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dirname(f)).filter((x) => x.startsWith("config.toml.bak-")).length, 1);
  assert.equal(run(f).stdout.trim(), `${f}: request_max_retries = 12, stream_max_retries = 12 (at least 12)`, "idempotent");
});

test("a higher value is kept (never lowered); a missing key is added inside the table; no proxy table is left alone", () => {
  const hi = write(old.replace("request_max_retries = 4", "request_max_retries = 20"));
  assert.equal(run(hi).status, 0);
  const t = fs.readFileSync(hi, "utf8");
  assert.match(t, /request_max_retries = 20\n/); assert.match(t, /stream_max_retries = 12\n/);
  const missing = write(old.replace("request_max_retries = 4\n", "").replace("stream_max_retries = 5\n", ""));
  assert.equal(run(missing).status, 0);
  const m = fs.readFileSync(missing, "utf8");
  const table = m.slice(m.indexOf("[model_providers.cliproxyapi]"), m.indexOf("[model_providers.cliproxyapi.auth]"));
  assert.match(table, /request_max_retries = 12\nstream_max_retries = 12\n/, "added at the end of the provider's own table");
  const none = write('model = "x"\n[tui]\nfoo = 1\n');
  const r = run(none); assert.equal(r.status, 0); assert.match(r.stdout, /no \[model_providers\.cliproxyapi\] table/);
  assert.equal(fs.readFileSync(none, "utf8"), 'model = "x"\n[tui]\nfoo = 1\n');
  const bad = write("model = [\n"); assert.equal(run(bad).status, 1);
});

test("shipped config carries 12/12; the pool profiles set no provider (they inherit it); install.sh manages it", () => {
  assert.match(shipped, /\[model_providers\.cliproxyapi\][^[]*request_max_retries = 12\nstream_max_retries = 12\n/);
  for (const p of ["pool-deep", "pool-impl", "pool-review"]) {
    const t = fs.readFileSync(join(repo, `system/codex/${p}.config.toml`), "utf8");
    assert.doesNotMatch(t, /model_provider|max_retries/, `${p} must not override the provider or its retries`);
  }
  assert.match(fs.readFileSync(join(repo, "install.sh"), "utf8"), /"\$S\/system\/codex-retries" \$\(\[ \$CHECK = 1 \] && echo --check\) "\$HOME\/\.codex\/config\.toml"/);
});
