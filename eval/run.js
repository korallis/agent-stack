#!/usr/bin/env node
// Evaluate Jev decisions on labelled cases and compare: raw Jev, the full system (Jev + thresholds +
// fallback), and a keyword baseline (ordinary code). Writes eval/report.json and prints a summary,
// including a per-decision confidence sweep to tune `act` thresholds on evidence.
//
//   node eval/run.js [--decision ID] [--no-system]
import { readFileSync, writeFileSync } from "node:fs";
import { decide } from "../jev/lib/engine.js";

const args = process.argv.slice(2);
const only = args.includes("--decision") ? args[args.indexOf("--decision") + 1] : null;
const cases = readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((c) => !only || c.decision === only);

// Keyword baseline: what ordinary code alone would do.
const KW = {
  "recovery.classify_error": (i) => {
    const e = i.error.toLowerCase();
    if (/401|unauthori[sz]ed|token has expired|login/.test(e)) return { class: "auth_expired" };
    if (/usage.?limit|weekly limit|quota/.test(e)) return { class: "quota_exhausted" };
    if (/429|rate limit/.test(e)) return { class: "rate_limited" };
    if (/529|overloaded|5\d\d/.test(e)) return { class: "upstream_unavailable" };
    if (/resolve host|econnrefused|econnreset|timed out/.test(e)) return { class: "network" };
    if (/too long|context/.test(e)) return { class: "context_overflow" };
    if (/conflict/.test(e)) return { class: "merge_conflict" };
    if (/# fail [1-9]|not ok/.test(e)) return { class: "test_failure" };
    if (/read-only|denied|permission/.test(e)) return { class: "permission_denied" };
    if (/no output|stalled|idle/.test(e)) return { class: "stalled" };
    if (/err|failed|error/.test(e)) return { class: "tool_failure" };
    return { class: "unclear" };
  },
  "comms.triage_update": (i) => {
    const u = i.update.toLowerCase();
    if (/api key|password|credential|owner|decide|should (we|the)|product/.test(u)) return { kind: "needs_user" };
    if (/blocked|can't|cannot|red|failing/.test(u)) return { kind: "actionable_blocker" };
    return { kind: "routine_progress" };
  },
  "intake.classify": (i) => {
    const t = i.task.toLowerCase();
    for (const [re, type] of [[/readme|docs?\b|documentation/, "docs"], [/compare|recommend|investigate/, "research"], [/migrat|move .* to/, "migration"],
      [/secur|password|vulnerab|rate-limit/, "security"], [/slow|seconds|faster|latency/, "performance"], [/ci\b|github actions|pipeline|deploy/, "infra"],
      [/refactor|split|without changing/, "refactor"], [/throws|crash|error|bug|fails?/, "bugfix"], [/add|new|support/, "feature"]]) if (re.test(t)) return { type };
    return { type: "unclear" };
  },
};

function correct(c, result) {
  const e = c.expect;
  if (c.decision === "context.rerank") {
    const r = result.ranking || [];
    return e.top.every((id) => r.slice(0, e.top.length).includes(id)) && !(e.excluded || []).some((id) => r.includes(id));
  }
  if (c.decision === "intake.classify") return result.type === e.type;
  return Object.entries(e).every(([k, v]) => JSON.stringify(result?.[k]) === JSON.stringify(v));
}
const confOf = (rec) => {
  const s = rec.signals || {};
  const vals = Object.values(s).flatMap((x) => (x && typeof x === "object" && "confidence" in x ? [x.confidence] : []));
  return vals.length ? Math.min(...vals) : null;
};

const rows = [];
for (const c of cases) {
  const raw = await decide(c.decision, c.input, { noCache: true, noFallbackModel: true, caller: "eval" });
  const sys = args.includes("--no-system") ? null : await decide(c.decision, c.input, { noCache: true, caller: "eval-system" });
  const kw = KW[c.decision]?.(c.input) ?? null;
  const row = { id: c.id, decision: c.decision, tags: c.tags,
    jev: { ok: raw.decided_by === "jev" ? correct(c, raw.result) : null, band: raw.band, conf: confOf(raw), result: raw.result, ms: raw.latency_ms, tok: raw.usage?.input_tokens, by: raw.decided_by },
    system: sys ? { ok: correct(c, sys.result), by: sys.decided_by, band: sys.band, result: sys.result } : null,
    keyword: kw ? { ok: correct(c, kw), result: kw } : null };
  rows.push(row);
  console.log(`${c.id.padEnd(7)} ${c.tags.join(",").padEnd(12)} jev:${row.jev.ok ? "✓" : "✗"} ${String(row.jev.band).padEnd(9)} conf=${row.jev.conf?.toFixed(2) ?? " -  "} ` +
    `sys:${sys ? (row.system.ok ? "✓" : "✗") + " " + row.system.by : "-"}  kw:${kw ? (row.keyword.ok ? "✓" : "✗") : "-"}  ${JSON.stringify(raw.result).slice(0, 70)}`);
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const summary = {};
for (const d of [...new Set(rows.map((r) => r.decision))]) {
  const rs = rows.filter((r) => r.decision === d);
  const acted = rs.filter((r) => r.jev.band === "act");
  const sweep = [0.5, 0.6, 0.7, 0.8, 0.9].map((t) => {
    const s = rs.filter((r) => r.jev.conf != null && r.jev.conf >= t);
    return { threshold: t, coverage: pct(s.length, rs.length), accuracy: pct(s.filter((r) => r.jev.ok).length, s.length) };
  });
  const lat = rs.map((r) => r.jev.ms).sort((a, b) => a - b);
  summary[d] = {
    n: rs.length,
    jev_accuracy: pct(rs.filter((r) => r.jev.ok).length, rs.length),
    act_band_coverage: pct(acted.length, rs.length), act_band_accuracy: pct(acted.filter((r) => r.jev.ok).length, acted.length),
    system_accuracy: rs[0].system ? pct(rs.filter((r) => r.system?.ok).length, rs.length) : "-",
    system_fallback_rate: rs[0].system ? pct(rs.filter((r) => r.system?.by !== "jev").length, rs.length) : "-",
    keyword_accuracy: rs[0].keyword ? pct(rs.filter((r) => r.keyword?.ok).length, rs.length) : "-",
    adversarial: `${rs.filter((r) => r.tags.includes("adversarial") && r.jev.ok).length}/${rs.filter((r) => r.tags.includes("adversarial")).length} jev`,
    p50_ms: lat[Math.floor(lat.length / 2)], avg_input_tokens: Math.round(rs.reduce((a, r) => a + (r.jev.tok || 0), 0) / rs.length),
    confidence_sweep: rs.some((r) => r.jev.conf != null) ? sweep : undefined,
  };
}
writeFileSync(new URL("./report.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
console.log("\n" + JSON.stringify(summary, null, 2));
