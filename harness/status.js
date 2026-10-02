#!/usr/bin/env node
// agent-harness-status: Grok (grokbuild) and Kimi quota from those CLIs themselves.
// The CLIProxyAPI usage proxy does not parse either provider; this tool never invents a percent.
//
//   agent-harness-status            table
//   agent-harness-status --json     machine-readable (rig-console)
//
// Each row is a real read: the CLI is missing, it has no usage command, the usage output has no
// quota fields, or a used percent the CLI printed (remaining % becomes used = 100 − remaining
// only when that remaining number is present). A missing read stays null, never 0.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USED_KEYS = ["used_percent", "usedPercent", "percentUsed", "used_pct", "usedPct", "usagePercent", "creditUsagePercent", "percent_used"];
const LEFT_KEYS = ["remaining_percent", "remainingPercent", "percent_left", "percentLeft", "percent_remaining", "left_percent", "remaining_pct"];
const SHORT_NAME = /^(short|short_window|5h|five[-_]?h|five[-_]?hour|rate[-_]?limit|hourly)$/i;
const WEEK_NAME = /^(week|weekly|7d|seven[-_]?d|seven[-_]?day)$/i;
const SHORT_LABEL = /5\s*h|five.?hour|short.?window|rate.?limit/i;
const WEEK_LABEL = /week|7\s*d|seven.?day|grokbuild/i;

export function asNum(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A used percent from one object. Remaining becomes used only when a remaining number is present. */
export function usedPercentFrom(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  for (const k of USED_KEYS) {
    const n = asNum(obj[k]);
    if (n !== null) return n;
  }
  const used = asNum(obj.used), total = asNum(obj.total);
  if (used !== null && total !== null && total > 0) return (used / total) * 100;
  for (const k of LEFT_KEYS) {
    const n = asNum(obj[k]);
    if (n !== null) return 100 - n;
  }
  // a lone remaining in 0..100 with no token total: Kimi Code's "% left"
  const rem = asNum(obj.remaining);
  if (rem !== null && rem >= 0 && rem <= 100 && obj.total == null && obj.used == null) return 100 - rem;
  // "percent" is used only when the object names a window (otherwise it is ambiguous)
  const pct = asNum(obj.percent);
  if (pct !== null && (obj.window != null || obj.period != null)) return pct;
  return null;
}

function nameOf(node, fallback) {
  if (!node || typeof node !== "object") return fallback ?? "";
  return String(node.window ?? node.period ?? node.name ?? node.product ?? node.id ?? fallback ?? "");
}

function slotFor(name) {
  if (SHORT_NAME.test(name) || SHORT_LABEL.test(name)) return "short";
  if (WEEK_NAME.test(name) || WEEK_LABEL.test(name)) return "weekly";
  return null;
}

/** Walk a usage JSON object for a short (5 h) and weekly used percent. Missing stays null. */
export function windowsFrom(obj) {
  let short = null, weekly = null;
  const take = (slot, used) => {
    if (used === null) return;
    if (slot === "short" && short === null) short = used;
    if (slot === "weekly" && weekly === null) weekly = used;
  };
  const visit = (node, label) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, label); return; }
    if (typeof node !== "object") return;
    const name = nameOf(node, label);
    take(slotFor(name), usedPercentFrom(node));
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") visit(v, k);
    }
  };
  visit(obj, "");
  if (short === null && weekly === null) {
    const used = usedPercentFrom(obj);
    if (used !== null) weekly = used;
  }
  return { short, weekly };
}

export function parseUsageJson(text) {
  if (!text || !String(text).trim()) return null;
  const raw = String(text).trim();
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start));
    const { short, weekly } = windowsFrom(obj);
    if (short === null && weekly === null) return null;
    return { short, weekly };
  } catch {
    return null;
  }
}

export function which(name, pathEnv = process.env.PATH) {
  if (!name) return null;
  for (const dir of String(pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function defaultRun(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      });
    });
  });
}

function row({ id, label, provider, harness, command, installed, status, short, weekly, unknown_reason, source }) {
  const pct = (v) => (v === null ? null : Math.round(v));
  return {
    id, label, provider, harness, command, installed, status,
    short_window_used: short, weekly_used: weekly,
    short_window_pct: pct(short), weekly_pct: pct(weekly),
    unknown_reason, source,
  };
}

async function readUsage(cmd, run) {
  const attempts = [["usage", "--json"], ["usage"]];
  let last = "usage command not available";
  for (const args of attempts) {
    const r = await run(cmd, args, 4000);
    const parsed = parseUsageJson(r.stdout);
    if (parsed) return { short: parsed.short, weekly: parsed.weekly, source: `${path.basename(cmd)} ${args.join(" ")}`, unknown_reason: null };
    const err = `${r.stderr} ${r.stdout}`.trim();
    if (!r.ok) last = err ? err.replace(/\s+/g, " ").slice(0, 120) : "usage command failed";
    else last = "usage output has no quota reading";
    // unknown flag: try the next shape; a hang or TUI is cut by the timeout
    if (/unknown (command|option|flag|argument)|unrecognized/i.test(err) && args.includes("--json")) continue;
    if (args.includes("--json") && !r.ok) continue;
    break;
  }
  return { short: null, weekly: null, source: null, unknown_reason: last };
}

export async function collect(opt = {}) {
  const run = opt.run ?? defaultRun;
  const pathEnv = opt.path ?? process.env.PATH;
  const find = (name) => which(name, pathEnv);
  const grokCmd = find("grok") || find("grokbuild");
  const kimiCmd = find("kimi");
  const grok = grokCmd
    ? { ...(await readUsage(grokCmd, run)), command: grokCmd, installed: true }
    : { short: null, weekly: null, source: null, unknown_reason: "grok / grokbuild not on PATH", command: null, installed: false };
  const kimi = kimiCmd
    ? { ...(await readUsage(kimiCmd, run)), command: kimiCmd, installed: true }
    : { short: null, weekly: null, source: null, unknown_reason: "kimi not on PATH", command: null, installed: false };
  const statusOf = (x) => !x.installed ? "not_installed" : (x.short !== null || x.weekly !== null) ? "ok" : "unavailable";
  return [
    row({
      id: "grok", label: "grokbuild", provider: "grok", harness: "grokbuild",
      command: grok.command, installed: grok.installed, status: statusOf(grok),
      short: grok.short, weekly: grok.weekly, unknown_reason: grok.unknown_reason, source: grok.source,
    }),
    row({
      id: "kimi", label: "kimi", provider: "kimi", harness: "kimi",
      command: kimi.command, installed: kimi.installed, status: statusOf(kimi),
      short: kimi.short, weekly: kimi.weekly, unknown_reason: kimi.unknown_reason, source: kimi.source,
    }),
  ];
}

function pctCell(v) {
  return v === null ? "-" : `${v}%`;
}

function table(rows) {
  const lines = ["harness    prov   state           5h     weekly  note"];
  for (const r of rows) {
    const note = r.status === "ok" ? (r.source ?? "-") : (r.unknown_reason ?? "-");
    lines.push(`${r.label.padEnd(10)} ${r.provider.padEnd(6)} ${r.status.padEnd(15)} ${pctCell(r.short_window_pct).padStart(6)} ${pctCell(r.weekly_pct).padStart(7)}  ${note}`);
  }
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`agent-harness-status: Grok (grokbuild) and Kimi quota from those CLIs.

  agent-harness-status            table
  agent-harness-status --json     machine-readable (used by rig-console)

Looks for grok or grokbuild, and kimi, on PATH. Runs \`usage --json\` (then \`usage\`)
and prints only percents those commands reported. Missing CLIs are not_installed;
a CLI without a quota reading is unavailable. Never invents a used percent.
The CLIProxyAPI usage proxy is a separate source (agent-proxy-status).
`);
    return 0;
  }
  if (argv.some((a) => a !== "--json")) {
    process.stderr.write(`agent-harness-status: unknown argument ${JSON.stringify(argv.find((a) => a !== "--json"))}. Try --help.\n`);
    return 2;
  }
  const harnesses = await collect();
  if (argv.includes("--json")) process.stdout.write(JSON.stringify({ harnesses }, null, 2) + "\n");
  else process.stdout.write(table(harnesses) + "\n");
  return 0;
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(here).href) {
  main().then((code) => process.exit(code), (e) => {
    process.stderr.write(`agent-harness-status: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
