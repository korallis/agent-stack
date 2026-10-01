// WO67: OpenRig 0.6.3 sends files.getUploadURLExternal as a JSON body, which Slack answers "invalid_arguments", so a
// local proof screenshot never reached the thread ("text delivered; attachment missing"). Patch 141 sends both upload
// calls form-encoded (as Slack's own client does), widens the local attachments to video and PDF under a size cap, and
// logs a skipped attachment. The pristine 0.6.3 Slack files are vendored (test/fixtures/openrig-0.6.3-slack); the patch
// is applied to a copy with `patch -p1` and run against a fetch stub that behaves like Slack.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "test/fixtures/openrig-0.6.3-slack");
const patchFile = join(repo, "patches/openrig/0.6.3/141-slack-upload-encoding-and-video.patch");
const tmp = fs.mkdtempSync(join(os.tmpdir(), "slack-upload-"));
const SLACK = "daemon/dist/domain/gateway/slack";

function pkgCopy(name, patched) {
  const dir = join(tmp, name);
  fs.cpSync(fixture, dir, { recursive: true });
  fs.writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@openrig/cli", version: "0.6.3", type: "module" }));
  if (patched) {
    const r = spawnSync("patch", ["-p1", "-N", "--no-backup-if-mismatch", "-d", dir, "-i", patchFile], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /offset|fuzz/i, "141 applies to pristine 0.6.3 exactly");
  }
  return dir;
}
const pristine = pkgCopy("pristine", false);
const patched = pkgCopy("patched", true);
const load = async (dir, f) => import(pathToFileURL(join(dir, SLACK, f)).href);

// A fetch that answers like Slack. files.getUploadURLExternal only reads form fields (a JSON body gets
// invalid_arguments, as live); the others accept JSON or form. Calls are recorded, and appended to $SLACK_STUB_LOG.
const STUB = `
export function slackStub(calls = []) {
  return async (url, init = {}) => {
    const u = new URL(url), ct = String(init.headers?.["content-type"] ?? ""), raw = init.body;
    const form = ct.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(String(raw))) : null;
    const json = ct.startsWith("application/json") ? JSON.parse(String(raw)) : null;
    const call = { url: u.origin + u.pathname, method: init.method ?? "GET", ct, auth: init.headers?.authorization ?? null, form, json,
      bytes: raw instanceof Uint8Array ? raw.length : null };
    calls.push(call);
    if (process.env.SLACK_STUB_LOG) (await import("node:fs")).appendFileSync(process.env.SLACK_STUB_LOG, JSON.stringify(call) + "\\n");
    const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    switch (u.pathname) {
      case "/api/files.getUploadURLExternal":
        return form && form.filename && /^\\d+$/.test(form.length ?? "")
          ? reply({ ok: true, upload_url: "https://files.slack.com/upload/v1/ABC", file_id: "F0TEST" })
          : reply({ ok: false, error: "invalid_arguments" });
      case "/upload/v1/ABC": return new Response("OK", { status: 200 });
      case "/api/files.completeUploadExternal": {
        const a = form ? { ...form, files: JSON.parse(form.files ?? "null") } : json ?? {};
        return Array.isArray(a.files) && a.files[0]?.id === "F0TEST" && a.channel_id ? reply({ ok: true }) : reply({ ok: false, error: "invalid_arguments" });
      }
      case "/api/chat.postMessage": return reply({ ok: true, ts: "1700000000.000100" });
      default: return reply({ ok: false, error: "unknown_method" });
    }
  };
}
`;
const stubPath = join(tmp, "slack-stub.mjs");
fs.writeFileSync(stubPath, STUB);
const preloadPath = join(tmp, "slack-stub-preload.mjs");
// SLACK_STUB_MODE makes a step fail in ways that could leak: a transport exception or an error field that echoes the
// bearer token, free diagnostic text, an HTTP 500.
fs.writeFileSync(preloadPath, `import { slackStub } from ${JSON.stringify(pathToFileURL(stubPath).href)};
const base = slackStub(), mode = process.env.SLACK_STUB_MODE;
const bearer = (init) => String(init?.headers?.authorization ?? "").replace(/^Bearer /, "");
const err = (error) => new Response(JSON.stringify({ ok: false, error }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const getUrl = String(url).endsWith("files.getUploadURLExternal"), complete = String(url).endsWith("files.completeUploadExternal");
  if (mode === "echo-transport" && getUrl) throw new Error("connect failed for " + bearer(init));
  if (mode === "echo-error" && getUrl) return err(bearer(init));
  if (mode === "text-error" && complete) return err("upstream diagnostic text: see " + bearer(init));
  if (mode === "http-500" && getUrl) return new Response("<html>oops</html>", { status: 500 });
  if (mode === "upload-transport" && String(url).includes("/upload/")) throw new Error("socket hang up " + (init?.headers?.authorization ?? ""));
  return base(url, init);
};
`);
const { slackStub } = await import(pathToFileURL(stubPath).href);

test("pristine 0.6.3 sends files.getUploadURLExternal as JSON and Slack refuses it (the live failure)", async () => {
  const api = await load(pristine, "slack-api.js"); const calls = [];
  const r = await api.getUploadURLExternal("xoxb-test", "shot.png", 123, slackStub(calls));
  assert.deepEqual([r.ok, r.error], [false, "invalid_arguments"]);
  assert.match(calls[0].ct, /^application\/json/);
});

test("patched: files.getUploadURLExternal is a form POST with filename and length, bearer auth, no JSON", async () => {
  const api = await load(patched, "slack-api.js"); const calls = [];
  const r = await api.getUploadURLExternal("xoxb-test", "clip.mp4", 4096, slackStub(calls));
  assert.deepEqual(r, { ok: true, uploadUrl: "https://files.slack.com/upload/v1/ABC", fileId: "F0TEST" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST"); assert.equal(calls[0].url, "https://slack.com/api/files.getUploadURLExternal");
  assert.equal(calls[0].ct, "application/x-www-form-urlencoded; charset=utf-8");
  assert.deepEqual(calls[0].form, { filename: "clip.mp4", length: "4096" }); assert.equal(calls[0].auth, "Bearer xoxb-test");
});

test("patched: files.completeUploadExternal is form-encoded, files as a JSON string, channel and thread set; other calls stay JSON", async () => {
  const api = await load(patched, "slack-api.js"); const calls = [];
  const r = await api.completeUploadExternal("xoxb-test", { files: [{ id: "F0TEST", title: "proof" }], channelId: "C0TEST", threadTs: "1.2" }, slackStub(calls));
  assert.equal(r.ok, true);
  assert.equal(calls[0].ct, "application/x-www-form-urlencoded; charset=utf-8");
  assert.deepEqual(calls[0].form, { files: JSON.stringify([{ id: "F0TEST", title: "proof" }]), channel_id: "C0TEST", thread_ts: "1.2" });
  await api.postChatMessage("xoxb-test", { channel: "C0TEST", text: "hi" }, slackStub(calls));
  assert.match(calls[1].ct, /^application\/json/, "chat.postMessage is unchanged");
});

test("patched reader: images, video and PDF by absolute path; a PROOF.md or relative path is no attachment; misses say why", async () => {
  const { defaultReadLocalImage, LOCAL_ATTACHMENT_MAX_BYTES } = await load(patched, "slack-delivery.js");
  const d = join(tmp, "reader"); fs.mkdirSync(d);
  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".mov", ".pdf", ".MP4"]) {
    const f = join(d, `a${ext}`); fs.writeFileSync(f, "x");
    const r = defaultReadLocalImage(f);
    assert.equal(r?.filename, `a${ext}`, ext); assert.equal(r.bytes.length, 1);
  }
  fs.writeFileSync(join(d, "PROOF.md"), "x");
  assert.equal(defaultReadLocalImage(join(d, "PROOF.md")), null);
  assert.equal(defaultReadLocalImage("reader/a.png"), null);
  assert.match(defaultReadLocalImage(join(d, "missing.mp4")).skipped, /unreadable \(ENOENT\)/);
  fs.mkdirSync(join(d, "dir.mp4")); assert.equal(defaultReadLocalImage(join(d, "dir.mp4")).skipped, "not a regular file");
  assert.equal(LOCAL_ATTACHMENT_MAX_BYTES, 50 * 1024 * 1024);
  const big = join(d, "big.webm"); fs.writeFileSync(big, ""); fs.truncateSync(big, LOCAL_ATTACHMENT_MAX_BYTES + 1);
  assert.match(defaultReadLocalImage(big).skipped, /over the 52428800-byte attachment cap/);
  fs.truncateSync(big, LOCAL_ATTACHMENT_MAX_BYTES); assert.equal(defaultReadLocalImage(big).bytes.length, LOCAL_ATTACHMENT_MAX_BYTES);
});

const store = () => { const s = new Set(); return { load: () => s, mark: (k) => s.add(k) }; };
async function deliver(dir, evidenceRef, calls, logs) {
  const { subsystemSlackDeliver } = await load(dir, "slack-delivery.js");
  const fn = subsystemSlackDeliver({ botToken: "xoxb-test", channel: "C0TEST", fetchImpl: slackStub(calls), log: (l) => logs.push(l),
    delivered: store(), attempted: store(), outboundSeen: store(), sourceLabel: "openrig" });
  return fn({ decisionId: "d1", payload: { qitemId: "q1", summary: "proof", body: "see attached", evidenceRef } });
}

test("delivery: an update row with a local video posts the text, then uploads the video into that message's thread", async () => {
  const clip = join(tmp, "clip.mp4"); fs.writeFileSync(clip, Buffer.alloc(3000, 1));
  const calls = [], logs = [];
  assert.deepEqual(await deliver(patched, clip, calls, logs), { ok: true });
  assert.deepEqual(calls.map((c) => c.url.replace("https://", "")), ["slack.com/api/chat.postMessage", "slack.com/api/files.getUploadURLExternal",
    "files.slack.com/upload/v1/ABC", "slack.com/api/files.completeUploadExternal"]);
  assert.deepEqual(calls[1].form, { filename: "clip.mp4", length: "3000" }); assert.equal(calls[2].bytes, 3000);
  assert.equal(calls[3].form.thread_ts, "1700000000.000100");
  assert.ok(logs.some((l) => l.startsWith("uploaded clip.mp4 into thread 1700000000.000100 for q1")), logs.join("\n"));
  // The same row on pristine 0.6.3: text only, and the log line the operator saw.
  fs.writeFileSync(join(tmp, "shot.png"), "png");
  const pc2 = [], pl2 = [];
  assert.deepEqual(await deliver(pristine, join(tmp, "shot.png"), pc2, pl2), { ok: true });
  assert.ok(pl2.some((l) => /ATTACHMENT upload-url FAILED for q1: invalid_arguments \(text delivered; attachment missing\)/.test(l)), pl2.join("\n"));
});

test("delivery: an oversized or missing attachment still delivers the text and logs the miss; a PROOF.md ref stays silent", async () => {
  const big = join(tmp, "big.mov"); fs.writeFileSync(big, ""); fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  for (const [ref, why] of [[big, /big\.mov 52428801 bytes is over the 52428800-byte attachment cap/], [join(tmp, "gone.mp4"), /gone\.mp4 unreadable \(ENOENT\)/]]) {
    const calls = [], logs = [];
    assert.deepEqual(await deliver(patched, ref, calls, logs), { ok: true });
    assert.deepEqual(calls.map((c) => c.url), ["https://slack.com/api/chat.postMessage"]);
    const line = logs.find((l) => l.startsWith("ATTACHMENT skipped for q1: "));
    assert.match(line ?? "", why); assert.match(line, /\(text delivered; attachment missing\)$/);
  }
  fs.writeFileSync(join(tmp, "PROOF.md"), "# proof");
  const calls = [], logs = [];
  await deliver(patched, join(tmp, "PROOF.md"), calls, logs);
  assert.equal(calls.length, 1); assert.ok(!logs.some((l) => /ATTACHMENT/.test(l)), logs.join("\n"));
});

test("delivery: a failed upload-url call still delivers the text and keeps the 'attachment missing' log line", async () => {
  const shot = join(tmp, "s2.png"); fs.writeFileSync(shot, "png");
  const { subsystemSlackDeliver } = await load(patched, "slack-delivery.js");
  const logs = [], stub = slackStub();
  const failing = async (url, init) => (String(url).endsWith("files.getUploadURLExternal")
    ? new Response(JSON.stringify({ ok: false, error: "not_authed" }), { status: 200 }) : stub(url, init));
  const fn = subsystemSlackDeliver({ botToken: "x", channel: "C0TEST", fetchImpl: failing, log: (l) => logs.push(l),
    delivered: store(), attempted: store(), outboundSeen: store(), sourceLabel: "openrig" });
  assert.deepEqual(await fn({ decisionId: "d2", payload: { qitemId: "q2", summary: "p", evidenceRef: shot } }), { ok: true });
  assert.ok(logs.includes("ATTACHMENT upload-url FAILED for q2: not_authed (text delivered; attachment missing)"), logs.join("\n"));
});

test("patched: the byte upload's default timeout grows with the size (15 s + 1 s per 512 KiB)", () => {
  const src = fs.readFileSync(join(patched, SLACK, "slack-api.js"), "utf8");
  assert.match(src, /export async function uploadBytesExternal\(uploadUrl, bytes, fetchImpl = defaultFetch, timeoutMs = DEFAULT_TIMEOUT_MS \+ Math\.ceil\(bytes\.length \/ 524_288\) \* 1000\)/);
});

// ── the live check the operator runs: bin/openrig-slack-upload-check ──
const script = join(repo, "bin/openrig-slack-upload-check");
function runCheck(args, { home, env = {}, preload = false } = {}) {
  const nodeArgs = [...(preload ? ["--import", preloadPath] : []), script, ...args];
  return spawnSync(process.execPath, nodeArgs, { encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, OPENRIG_HOME: join(home, ".openrig"), ...env } });
}
function checkHome(name, { mode = 0o600, token = "xoxb-test-SECRETVALUE" } = {}) {
  const home = join(tmp, name); fs.mkdirSync(join(home, ".openrig"), { recursive: true });
  const envFile = join(home, "slack.env");
  fs.writeFileSync(envFile, `# slack\nSLACK_BOT_TOKEN=${token}\n`); fs.chmodSync(envFile, mode);
  fs.writeFileSync(join(home, ".openrig/slack-connector.json"), JSON.stringify({ channel: "C0TEST", secretsEnvFile: envFile }));
  return { home, envFile };
}

test("live check: without --live it sends nothing and says whether 141 is in; the token is read by name and never printed", () => {
  const { home } = checkHome("h-dry");
  const log = join(home, "stub.log");
  for (const [dir, state] of [[patched, "applied"], [pristine, "NOT applied"]]) {
    const r = runCheck(["--pkg", dir], { home, preload: true, env: { SLACK_STUB_LOG: log } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`patch 141 \\(form-encoded upload calls\\): ${state}`));
    assert.match(r.stdout, /package: @openrig\/cli 0\.6\.3/); assert.match(r.stdout, /channel: C0TEST/);
    assert.match(r.stdout, /bot token SLACK_BOT_TOKEN: present \(env file /); assert.match(r.stdout, /dry run: nothing sent/);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRETVALUE/);
  }
  assert.ok(!fs.existsSync(log), "no request was made");
});

test("live check --live: uploads a generated PNG through the installed client, removes its scratch, prints no secret", () => {
  const { home } = checkHome("h-live");
  const log = join(home, "stub.log");
  const r = runCheck(["--pkg", patched, "--live"], { home, preload: true, env: { SLACK_STUB_LOG: log } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /files\.getUploadURLExternal: ok\nbyte upload: ok \(\d+ bytes\)\nfiles\.completeUploadExternal: ok \(file F0TEST shared to C0TEST\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRETVALUE/);
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls[0].auth, "Bearer xoxb-test-SECRETVALUE");
  assert.equal(calls[0].form.filename, "openrig-slack-upload-check.png");
  assert.equal(calls[2].form.initial_comment, "openrig-slack-upload-check");
  const scratchRoot = join(home, ".cache/local-tmp");
  assert.deepEqual(fs.existsSync(scratchRoot) ? fs.readdirSync(join(scratchRoot, os.userInfo().username)) : [], [], "scratch removed");
});

test("live check --live against pristine 0.6.3 fails at getUploadURLExternal with Slack's code and the hint", () => {
  const { home } = checkHome("h-old");
  const r = runCheck(["--pkg", pristine, "--live"], { home, preload: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /files\.getUploadURLExternal FAILED: invalid_arguments \(patch 141 is not applied\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRETVALUE/);
});

test("live check: a failed step prints only a Slack code, an HTTP status or a fixed category, never echoed text or the token", () => {
  const cases = [
    ["echo-transport", "xoxb-test-SECRETVALUE", /files\.getUploadURLExternal FAILED: transport error \(no response\)$/m],
    ["echo-error", "xoxb-test-SECRETVALUE", /files\.getUploadURLExternal FAILED: unrecognised error$/m],
    // a token shaped like a Slack code is still never printed
    ["echo-error", "zz_secretvalue_zz", /files\.getUploadURLExternal FAILED: unrecognised error$/m],
    ["text-error", "xoxb-test-SECRETVALUE", /files\.completeUploadExternal FAILED: unrecognised error$/m],
    ["http-500", "xoxb-test-SECRETVALUE", /files\.getUploadURLExternal FAILED: HTTP 500$/m],
    ["upload-transport", "xoxb-test-SECRETVALUE", /byte upload FAILED: transport error \(no response\)$/m],
  ];
  for (const [mode, token, want] of cases) {
    const { home } = checkHome(`h-${mode}-${token.length}`, { token });
    const r = runCheck(["--pkg", patched, "--live"], { home, preload: true, env: { SLACK_STUB_MODE: mode } });
    assert.equal(r.status, 1, `${mode}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, want, mode);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRETVALUE|secretvalue|diagnostic|connect failed|socket hang up|oops/, mode);
    const scratch = join(home, ".cache/local-tmp", os.userInfo().username);
    assert.deepEqual(fs.existsSync(scratch) ? fs.readdirSync(scratch) : [], [], `${mode}: scratch removed`);
  }
  // Slack's own codes still come through, e.g. not_authed on the complete step
  const { home } = checkHome("h-code");
  const r = runCheck(["--pkg", pristine, "--live"], { home, preload: true });
  assert.match(r.stderr, /FAILED: invalid_arguments \(patch 141 is not applied\)/);
});

test("live check refuses a group/world-readable env file, a relative or non-attachment --file, and unknown arguments", () => {
  const { home } = checkHome("h-mode", { mode: 0o644 });
  let r = runCheck(["--pkg", patched], { home });
  assert.equal(r.status, 1); assert.match(r.stderr, /mode 644; it must be 0600/); assert.doesNotMatch(r.stdout + r.stderr, /SECRETVALUE/);
  const ok = checkHome("h-args");
  r = runCheck(["--pkg", patched, "--file", "rel.png"], { home: ok.home }); assert.match(r.stderr, /absolute path/);
  r = runCheck(["--pkg", patched, "--file", join(tmp, "PROOF.md")], { home: ok.home }); assert.match(r.stderr, /must be one of/);
  r = runCheck(["--bogus"], { home: ok.home }); assert.equal(r.status, 2);
});

test("141 is carried for the pin and documented; agents are told how to attach proof", () => {
  const readme = fs.readFileSync(join(repo, "patches/openrig/README.md"), "utf8");
  assert.match(readme, /\| `141-slack-upload-encoding-and-video` \| \*\*kept/);
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  assert.match(culture, /--evidence-ref <absolute path/); assert.match(culture, /\.mp4/);
  assert.match(culture, /never in `\/tmp`/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
