// Owner rule 2026-10-02 (20:28Z): when a task is done (fully merged and fully witnessed), a video of the witness goes to
// the owner in Slack. The template says how (operator rule: witness records a screen video; the lead sends one FYI row
// with --evidence-ref), and agent-video-fit makes a video fit the 50 MiB Slack attachment limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(join(repo, f), "utf8");
const fit = join(repo, "bin/agent-video-fit");
const hasFfmpeg = spawnSync("sh", ["-c", "command -v ffmpeg && command -v ffprobe"]).status === 0;
const root = fs.mkdtempSync(join(os.tmpdir(), "video-fit-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (args, max) => spawnSync(fit, args, { encoding: "utf8", env: { PATH: process.env.PATH, ...(max ? { AGENT_VIDEO_FIT_MAX_BYTES: String(max) } : {}) } });

test("template: the owner's words in Owner decisions, the how as an operator rule, and the witness, QA and lead steps", () => {
  const culture = read("rig/template/CULTURE.md");
  const sec = (h) => culture.split(/^## /m).find((s) => s.startsWith(h));
  assert.match(sec("Owner decisions"), /^- 2026-10-02: When a task is done \(fully merged and fully witnessed\), a video showing the witness is provided to the owner in Slack\. \(standing: the default in every rig\) \(owner, Slack 20:28Z\)$/m);
  assert.doesNotMatch(sec("Owner decisions"), /evidence-ref|agent-video-fit|client data/, "the mechanism is the operator's, not the owner's words");
  assert.match(sec("Operator and lead rules"), /^- 2026-10-02: The witness video for the owner .*screen video \(\.mp4\/\.webm\).*`--human-intent update --evidence-ref <video>`, fitted under 50 MiB with `agent-video-fit`\. Witness on staging with test data; if real client data would show, ask the owner first \(a rig may record its own owner choice\)\. \(operator, 20:29Z\)$/m);
  const spec = read("rig/template/witness-slice/SPEC.md");
  assert.match(spec, /record the whole end-to-end check as a screen video \(\.mp4\/\.webm\)/);
  assert.match(spec, /if real client data would show on screen, stop and ask the owner/);
  assert.match(spec, /- \[ \] A screen video of the end-to-end check, attached with `rig proof add --media`/);
  assert.match(read("rig/template/agents/qa/guidance/role.md"), /Witness video .*record the whole end-to-end check as a screen video/s);
  assert.match(read("rig/template/guidance/lead-loop.md"), /OWNER VIDEO: when a task is done \(merged and witnessed: the witness PASS has come in\), send the owner the witness video as one FYI row, `--human-intent update --evidence-ref/);
  assert.match(read("rig/template/agents/lead/guidance/role.md"), /When a task is done \(merged and witnessed\), send the owner the witness video/);
  assert.match(read("install.sh"), /for f in [^;]*\bagent-video-fit\b/);
});

test("agent-video-fit: a video under the limit is printed unchanged; non-videos and missing files are refused", () => {
  const small = join(root, "small.webm"); fs.writeFileSync(small, Buffer.alloc(1000));
  const r = run([small], 5000); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), fs.realpathSync(small));
  assert.deepEqual(fs.readdirSync(root), ["small.webm"], "nothing written");
  const png = join(root, "shot.png"); fs.writeFileSync(png, "x");
  assert.match(run([png]).stderr, /not a video \(\.mp4, \.webm or \.mov\)/); assert.equal(run([png]).status, 1);
  assert.match(run([join(root, "gone.mp4")]).stderr, /not a readable file/);
  assert.match(run([]).stderr, /usage: agent-video-fit VIDEO \[OUT\]/);
});

test("agent-video-fit: a video over the limit becomes a playable .fit.mp4 under it; the original is untouched", { skip: !hasFfmpeg && "ffmpeg not installed" }, () => {
  const big = join(root, "witness.webm");
  const g = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "4", "-c:v", "libvpx-vp9", "-b:v", "8M", "-deadline", "realtime", "-cpu-used", "8", big]);
  assert.equal(g.status, 0, String(g.stderr));
  const before = fs.statSync(big).size, max = Math.floor(before / 3);
  const r = run([big], max);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  assert.equal(out, fs.realpathSync(join(root, "witness.fit.mp4")));
  assert.ok(fs.statSync(out).size <= max, `${fs.statSync(out).size} > ${max}`);
  assert.equal(fs.statSync(big).size, before, "the original is unchanged");
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width", "-show_entries", "format=duration", "-of", "json", out], { encoding: "utf8" });
  const info = JSON.parse(probe.stdout);
  assert.equal(info.streams[0].codec_name, "h264"); assert.equal(info.streams[0].width, 1280);
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.5, info.format.duration);
  assert.equal(fs.readdirSync(root).filter((f) => f.includes(".tmp.")).length, 0, "no temp file left");
  const tiny = run([big], 2000); assert.equal(tiny.status, 1); assert.match(tiny.stderr, /couldn't fit .* trim it/);
});
