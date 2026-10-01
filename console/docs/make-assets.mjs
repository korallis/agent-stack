#!/usr/bin/env node
// Renders the README's rig-console images from the neutral demo fleet (docs/fixtures/demo-fleet.json): the console's
// own frames, drawn cell by cell into HTML (no terminal, no tmux), then screenshotted by a headless Chromium and
// shrunk to a 256-colour palette. Re-run it after a UI change:
//
//   node console/docs/make-assets.mjs            every image and the animated demo into docs/assets/rig-console/
//   node console/docs/make-assets.mjs --check    render every frame (HTML only, no browser) and check the README's
//                                                images and examples against what this script makes; used by tests
//   --only <name,...>  some images only     --out <dir>  somewhere else     --keep-html  leave the HTML next to them
//
// Needs, for the images only: chromium (or $CHROME) and ImageMagick (`magick`). --check needs neither.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { render, handleKey, loadFixture } = await import(path.join(repo, "console/src/main.ts"));
const { History } = await import(path.join(repo, "console/src/history.ts"));

export const FIXTURE = "docs/fixtures/demo-fleet.json";
export const ASSETS = "docs/assets/rig-console";

/** Every image: a name, a caption, a size, how to get there (view state, then keys as a person would press them),
 *  and what the frame must show (`expect`, checked by --check and so by the tests). */
export const SHOTS = [
  { name: "mission-control", caption: "Mission Control: the whole fleet on one screen", size: [176, 50], st: { view: 0 }, expect: /MISSION CONTROL[\s\S]*WORK IN FLIGHT/ },
  { name: "seat-matrix", caption: "Seat Matrix: every seat, context use and activity", size: [176, 50], st: { view: 1 }, expect: /SEAT MATRIX · 93 AGENTS/ },
  { name: "river", caption: "The River: slices flowing through the roles", size: [176, 50], st: { view: 2 }, expect: /THE RIVER/, never: /JOURNEY ·/ },
  // F-055 is the demo slice with its rows' transitions, so worked vs waited are filled in (QA PR98)
  { name: "river-journey", caption: "A slice's journey: who had it, worked vs waited", size: [176, 50], st: { view: 2 }, keys: [":", ..."slice F-055", "\r"], expect: /^(?=[\s\S]*JOURNEY · F-055)(?=[\s\S]*total worked \d)/, never: /loading/ },
  { name: "focus", caption: "Calm Focus: what needs you, then the fleet's pulse", size: [176, 50], st: { view: 3 }, expect: /what needs me\?[\s\S]*FLEET PULSE/ },
  { name: "seat-drill-in", caption: "A seat's drill-in: work, context and its live terminal", size: [176, 50], st: { view: 0, seat: "impl-codex-4@gamma" }, expect: /CURRENT WORK[\s\S]*LIVE TERMINAL/ },
  { name: "pool", caption: "Pool & System: 24 h graphs, the subscription pool, health", size: [176, 50], st: { view: 4 }, expect: /SUBSCRIPTION POOL[\s\S]*SYSTEM/ },
  { name: "command-bar", caption: "The ':' command bar, with completions", size: [176, 50], st: { view: 1 }, keys: [":", "s", "e", "a", "t", " ", "i", "m", "p", "l"], expect: /: seat impl/ },
  { name: "mission-control-120", caption: "Mission Control at 120 columns", size: [120, 40], st: { view: 0 }, expect: /MISSION CONTROL/ },
  { name: "theme-pad39a", caption: "Pad 39A", size: [120, 36], st: { view: 1, theme: "pad39a" }, expect: /theme Pad 39A/ },
  { name: "theme-catppuccin", caption: "Catppuccin", size: [120, 36], st: { view: 1, theme: "catppuccin" }, expect: /theme Catppuccin/ },
  { name: "theme-tokyo-night", caption: "Tokyo Night", size: [120, 36], st: { view: 1, theme: "tokyo-night" }, expect: /theme Tokyo Night/ },
  { name: "theme-nord", caption: "Nord", size: [120, 36], st: { view: 1, theme: "nord" }, expect: /theme Nord/ },
];

/** The animated demo: a short tour, one frame per step, each held for `hold` seconds; `expect` as for SHOTS. */
export const DEMO = { name: "demo", size: [176, 50], hold: 1.8, steps: [
  { st: { view: 0 }, expect: /MISSION CONTROL/ }, { keys: ["l", "l"], expect: /MISSION CONTROL/ }, { keys: ["2"], expect: /SEAT MATRIX/ },
  { keys: ["3"], expect: /THE RIVER/, never: /JOURNEY ·/ }, { keys: [":", ..."slice F-055", "\r"], expect: /^(?=[\s\S]*JOURNEY · F-055)(?=[\s\S]*total worked \d)/, never: /loading/ }, { keys: ["\x1b", "4"], expect: /what needs me\?/ },
  { keys: [":", "s", "e", "a", "t", " ", "i", "m", "p", "l", "-", "c", "o", "d", "e", "x", "-", "4", "@", "g", "a", "m", "m", "a"], expect: /: seat impl-codex-4@gamma/ },
  { keys: ["\r"], expect: /LIVE TERMINAL/ }, { keys: ["5"], expect: /SUBSCRIPTION POOL/ },
  { keys: [":", "t", "h", "e", "m", "e", " ", "t", "o", "k", "y", "o", "-", "n", "i", "g", "h", "t", "\r"], expect: /theme Tokyo Night/ },
  { keys: ["1"], expect: /MISSION CONTROL[\s\S]*theme Tokyo Night/ },
] };
/** Whether a frame shows what its shot or step promises. */
const shows = (screen, { expect, never }) => { const text = screen.lines().join("\n"); return expect.test(text) && !(never && never.test(text)); };

const BASE = { view: 0, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, riverFocus: [0, 0], journey: null,
  pane: 0, expand: false, select: 0, cmd: null, seat: null, theme: "pad39a" };

function fleet() {
  const fx = loadFixture(path.join(repo, FIXTURE));
  const hist = new History(null); hist.samples = fx.history;
  return { raw: fx.raw, hist };
}

/** A shot's screen: its view state, then its keys, drawn at its size. */
export function screenOf(shot, { raw, hist } = fleet(), st = { ...BASE, ...structuredClone(shot.st ?? {}) }) {
  for (const k of shot.keys ?? []) handleKey(st, k, raw);
  return { screen: render(raw, hist, shot.size[0], shot.size[1], st), st };
}

const css = (rgb) => `rgb(${rgb.join(",")})`;
/** One screen as an HTML page: a window frame with a title bar, then the cells as runs of one style. */
export function html(screen, title) {
  const bg = screen.bg ?? [12, 17, 32], rows = [];
  for (let y = 0; y < screen.h; y++) {
    let line = "", run = "", key = "";
    const flush = () => { if (run) line += `<span style="${key}">${run}</span>`; run = ""; };
    for (let x = 0; x < screen.w; x++) {
      const c = screen.cells[y * screen.w + x];
      let fg = c.fg ?? [214, 220, 232], cb = c.bg;
      if (c.inverse) [fg, cb] = [cb ?? bg, fg];
      const k = [`color:${css(fg)}`, cb ? `background:${css(cb)}` : "", c.bold ? "font-weight:700" : "", c.dim ? "opacity:.6" : ""].filter(Boolean).join(";");
      if (k !== key) { flush(); key = k; }
      run += c.ch.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    flush(); rows.push(line);
  }
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>
html,body{margin:0;background:transparent}
.win{display:inline-block;margin:0;border-radius:10px;overflow:hidden;background:${css(bg)};box-shadow:0 0 0 1px rgba(255,255,255,.08)}
.bar{height:30px;display:flex;align-items:center;gap:8px;padding:0 14px;background:rgba(255,255,255,.04);font:12px "JetBrains Mono","DejaVu Sans Mono",monospace;color:rgba(255,255,255,.55)}
.dot{width:12px;height:12px;border-radius:50%}
.t{margin-left:10px}
pre{margin:0;padding:10px 14px 14px;font:14px/17px "JetBrains Mono","DejaVu Sans Mono",monospace;color:rgb(214,220,232);font-variant-ligatures:none}
pre span{white-space:pre}
</style><div class="win" id="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${title}</span></div><pre>${rows.join("\n")}</pre></div>
<script>const r=document.getElementById("win").getBoundingClientRect();document.title=Math.ceil(r.width)+"x"+Math.ceil(r.height)</script>`;
}

const which = (c) => spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout.trim() || null;
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}…: ${(r.stderr || r.stdout || "").trim().slice(-600)}`);
  return r.stdout;
}

/** HTML file → PNG of exactly the window: the page measures itself (--dump-dom), then a screenshot at that size. */
function png(browser, htmlFile, out, profile) {
  const common = ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${profile}`,
    "--no-first-run", "--default-background-color=00000000"];
  const dom = run(browser, [...common, "--dump-dom", `file://${htmlFile}`]);
  const [w, h] = (dom.match(/<title>(\d+)x(\d+)<\/title>/) ?? []).slice(1).map(Number);
  if (!w || !h) throw new Error(`could not measure ${htmlFile}`);
  // a taller window than the page (headless keeps some of it for itself), cropped back to the window frame exactly
  run(browser, [...common, `--window-size=${w},${h + 200}`, `--screenshot=${out}`, `file://${htmlFile}`]);
  // then a 256-colour palette: a fraction of the size, and a terminal's few colours survive it
  run("magick", [out, "-crop", `${w}x${h}+0+0`, "+repage", "-strip", "-colors", "256", `PNG8:${out}`]);
}

/** README images and examples must match what this script makes and what the console accepts. */
export function check() {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const want = new Set([...SHOTS.map((s) => `${ASSETS}/${s.name}.png`), `${ASSETS}/${DEMO.name}.gif`]);
  const used = [...readme.matchAll(/(?:src="|\]\()((?:\.\/)?docs\/assets\/rig-console\/[^")]+)/g)].map((m) => m[1].replace(/^\.\//, ""));
  const problems = [];
  for (const u of used) if (!want.has(u)) problems.push(`README shows ${u}, which this script doesn't make`);
  for (const w of want) if (!used.includes(w)) problems.push(`README doesn't show ${w}`);
  for (const w of want) if (!fs.existsSync(path.join(repo, w))) problems.push(`${w} is missing: run node console/docs/make-assets.mjs`);
  return problems;
}

async function main() {
  const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const only = opt("--only")?.split(","), out = path.resolve(opt("--out") ?? path.join(repo, ASSETS));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rig-console-assets-"));
  try {
    const f = fleet(), shots = SHOTS.filter((s) => !only || only.includes(s.name));
    const wrong = [];
    const pages = shots.map((s) => {
      const { screen } = screenOf(s, f), file = path.join(tmp, `${s.name}.html`);
      if (!shows(screen, s)) wrong.push(`${s.name} doesn't show ${s.expect}${s.never ? ` without ${s.never}` : ""}`);
      fs.writeFileSync(file, html(screen, `rig-console · ${s.caption}`));
      return { s, file };
    });
    // the demo's frames: one view state carried through every step
    const st = { ...BASE }, frames = [];
    for (const [i, step] of DEMO.steps.entries()) {
      Object.assign(st, structuredClone(step.st ?? {}));
      const { screen } = screenOf({ size: DEMO.size, keys: step.keys }, f, st);
      if (!shows(screen, step)) wrong.push(`demo frame ${i} doesn't show ${step.expect}${step.never ? ` without ${step.never}` : ""}`);
      const file = path.join(tmp, `demo-${String(i).padStart(2, "0")}.html`);
      fs.writeFileSync(file, html(screen, "rig-console · a tour of the demo fleet")); frames.push(file);
    }
    if (wrong.length) throw new Error(wrong.join("; "));
    if (argv.includes("--check")) {
      const problems = check();
      console.log(`rendered ${pages.length} images and ${frames.length} demo frames from ${FIXTURE}`);
      for (const p of problems) console.log(`problem: ${p}`);
      process.exitCode = problems.length ? 1 : 0;
      return;
    }
    const browser = process.env.CHROME || which("chromium") || which("chromium-browser") || which("google-chrome");
    for (const [tool, path_] of [["a Chromium (chromium, or set CHROME)", browser], ["ImageMagick (magick)", which("magick")]])
      if (!path_) throw new Error(`needs ${tool} for the images (--check needs none)`);
    fs.mkdirSync(out, { recursive: true });
    const profile = path.join(tmp, "profile");
    for (const { s, file } of pages) { png(browser, file, path.join(out, `${s.name}.png`), profile); console.log(`${s.name}.png`); }
    if (!only || only.includes(DEMO.name)) {
      const pngs = frames.map((file, i) => { const p = path.join(tmp, `frame-${String(i).padStart(2, "0")}.png`); png(browser, file, p, profile); return p; });
      // one shared 128-colour palette, no dither, only the changed pixels per frame: a small GIF that stays crisp
      run("magick", ["-delay", String(Math.round(DEMO.hold * 100)), "-loop", "0", ...pngs, "+dither", "-colors", "128", "-layers", "OptimizeTransparency",
        path.join(out, `${DEMO.name}.gif`)]);
      console.log(`${DEMO.name}.gif`);
    }
    if (argv.includes("--keep-html")) for (const { s, file } of pages) fs.copyFileSync(file, path.join(out, `${s.name}.html`));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
