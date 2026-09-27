#!/usr/bin/env node
// jev-decide — bounded semantic decisions via TypeSafe Jev, with validation, thresholds,
// caching, circuit breaking and recorded fallback. See `jev-decide help`.
import { readFileSync } from "node:fs";
import { decide, listDecisions, InputError } from "../lib/engine.js";
import * as store from "../lib/store.js";

const HELP = `usage:
  jev-decide <decision-id> [--input FILE|-] [--json '{...}'] [--caller NAME] [--no-cache] [--no-model-fallback] [--simulate KIND]
  jev-decide list                 decision catalog (ids, inputs, outputs)
  jev-decide stats [--since ISO]  decisions by decided_by / band (jev | cache | fallback_model | code)
  jev-decide health               key present? breaker state? live /v1/models reachability

Input is a JSON object with the fields listed by 'jev-decide list' (unknown fields are dropped).
Candidates: [{"id": "...", "text": "..."}] built by YOUR code/search — Jev can only pick from them.
Output: one JSON decision record on stdout. Exit 0 = band act|review, 3 = uncertain, 2 = bad input.
The record's decided_by says who decided; 'band' is advisory: it never grants permissions, approves
merges, or overrides user instructions.`;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(n);
const cmd = args[0];

try {
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(HELP); process.exit(0); }
  if (cmd === "list") { console.log(JSON.stringify(listDecisions(), null, 2)); process.exit(0); }
  if (cmd === "stats") { console.table(store.stats(flag("--since") || new Date(Date.now() - 86400e3).toISOString())); process.exit(0); }
  if (cmd === "health") {
    const { TypeSafeClient } = await import("@typesafe-ai/sdk");
    const b = store.breakerState(); let live = "skipped";
    let keyPresent = false;
    try {
      const { readFileSync: r } = await import("node:fs"); const { homedir } = await import("node:os");
      keyPresent = !!(process.env.TYPESAFE_API_KEY || /TYPESAFE_API_KEY=\S+/.test(r(`${homedir()}/.config/agent-stack/secrets/typesafe.env`, "utf8")));
    } catch {}
    if (keyPresent) {
      try {
        const key = process.env.TYPESAFE_API_KEY || readFileSync(`${process.env.HOME}/.config/agent-stack/secrets/typesafe.env`, "utf8").match(/TYPESAFE_API_KEY=(\S+)/)[1];
        const t = Date.now(); const m = await new TypeSafeClient({ apiKey: key, timeout: 5000, logLevel: "off" }).models.list();
        live = `ok (${Date.now() - t}ms, ${(m.models || m.data || m).length ?? "?"} models)`;
      } catch (e) { live = `FAILED: ${e.constructor.name}: ${e.message}`.slice(0, 160); }
    }
    console.log(JSON.stringify({ key_present: keyPresent, breaker: { ...b, open: b.open_until > Date.now() }, live }, null, 2));
    process.exit(keyPresent && live.startsWith("ok") ? 0 : 1);
  }
  let input;
  if (flag("--json")) input = JSON.parse(flag("--json"));
  else if (flag("--input")) input = JSON.parse(readFileSync(flag("--input") === "-" ? 0 : flag("--input"), "utf8"));
  else if (!process.stdin.isTTY) input = JSON.parse(readFileSync(0, "utf8"));
  else throw new InputError("no input: use --json, --input FILE, or stdin");
  const rec = await decide(cmd, input, { caller: flag("--caller") || process.env.OPENRIG_SESSION_NAME || process.env.USER,
    noCache: has("--no-cache"), noFallbackModel: has("--no-model-fallback"), simulate: flag("--simulate") });
  console.log(JSON.stringify(rec, null, 2));
  process.exit(rec.band === "uncertain" ? 3 : 0);
} catch (e) {
  console.error(JSON.stringify({ error: e.constructor.name, message: e.message }));
  process.exit(e instanceof InputError || e instanceof SyntaxError ? 2 : 1);
}
