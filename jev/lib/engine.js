// Jev decision engine. `decide(id, input)` turns a catalog entry (config/decisions.yaml) plus
// caller-supplied input into a validated, policy-applied, logged decision record.
//
// Responsibilities kept in code (never delegated to Jev): candidate filtering is done by the
// caller before this point; here we enforce size limits, redaction, schema validation,
// thresholds, cache keys, rate limit, circuit breaker, retry/time budgets and fallback order.
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { TypeSafeClient, APIConnectionError, APITimeoutError, RateLimitError, AuthenticationError,
  PermissionDeniedError, InternalServerError, BadRequestError, UnprocessableEntityError, APIError } from "@typesafe-ai/sdk";
import * as store from "./store.js";
import { redactDeep } from "./redact.js";
import { modelFallback } from "./fallback.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const CATALOG_PATH = process.env.JEV_DECISIONS || join(ROOT, "config/decisions.yaml");

let catalog;
export function loadCatalog() {
  if (!catalog) {
    catalog = YAML.parse(readFileSync(CATALOG_PATH, "utf8"));
    if (catalog.schema_version !== 1) throw new Error(`unsupported decisions schema_version ${catalog.schema_version}`);
  }
  return catalog;
}

function apiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const m = readFileSync(join(homedir(), ".config/agent-stack/secrets/typesafe.env"), "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ───────────────────────── request construction ─────────────────────────

export function buildRequest(id, input) {
  const cat = loadCatalog(); const def = cat.decisions[id];
  if (!def) throw new InputError(`unknown decision '${id}'`);
  const d = { ...cat.defaults, ...def };
  const inputs = def.inputs || {};
  for (const f of inputs.required || []) if (input[f] == null || input[f] === "") throw new InputError(`missing required field '${f}'`);
  let candidates = Array.isArray(input.candidates) ? input.candidates : null;
  if (inputs.candidates === "required" && !candidates?.length) throw new InputError("candidates required");
  if (candidates) {
    candidates = candidates.map((c, i) => (typeof c === "string" ? { id: `c${i}`, text: c } : { id: String(c.id ?? `c${i}`), text: String(c.text ?? c.description ?? "") }));
    const ids = new Set(candidates.map((c) => c.id));
    if (ids.size !== candidates.length) throw new InputError("candidate ids must be unique");
    if (def.max_candidates && candidates.length > def.max_candidates) throw new InputError(`too many candidates (${candidates.length} > ${def.max_candidates}); pre-filter with ordinary search first`);
  }
  // State = only declared fields (unknown input keys are dropped, never forwarded).
  const state = {};
  for (const f of [...(inputs.required || []), ...(inputs.optional || [])]) if (input[f] != null) state[f] = input[f];
  if (candidates) state.candidates = candidates;
  const safeState = redactDeep(state, d.max_field_chars);
  const stateJson = canonical(safeState);
  if (stateJson.length > d.max_state_chars) throw new InputError(`state too large (${stateJson.length} chars > ${d.max_state_chars}); send focused evidence`);

  const questions = {}; const plan = {};
  for (const [outName, out] of Object.entries(def.outputs)) {
    if (out.from_candidates && !candidates) { if (out.optional) continue; throw new InputError(`output '${outName}' needs candidates`); }
    const q = out.question || {};
    const mk = (instr, criteria) => {
      if (out.kind === "choice") return { type: "choice", instructions: instr, criteria };
      if (out.kind === "nouls") return { type: "noul", instructions: instr, ...(criteria ? { criteria } : {}) };
      return { type: "score", instructions: instr, criteria };
    };
    const choiceCriteria = out.from_candidates
      ? { ...Object.fromEntries(candidates.map((c) => [c.id, c.text])), ...(out.extra_labels || {}) }
      : q.criteria;
    const fill = (instr, i) => JSON.parse(JSON.stringify(instr).replaceAll("{i}", String(i)));
    if (out.per_candidate) {
      if (!candidates) throw new InputError(`output '${outName}' needs candidates`);
      const tmpl = out.per_candidate === true ? q : out.per_candidate;
      plan[outName] = { out, keys: [] };
      candidates.forEach((c, i) => {
        const key = `${outName}__${i}`;
        questions[key] = mk(fill(tmpl.instructions, i), tmpl.criteria || choiceCriteria);
        plan[outName].keys.push({ key, item: c.id });
      });
    } else if (out.questions) {
      plan[outName] = { out, keys: [] };
      for (const [qn, qd] of Object.entries(out.questions)) {
        const key = `${outName}__${qn}`;
        questions[key] = mk(qd.instructions, qd.criteria);
        plan[outName].keys.push({ key, item: qn });
      }
    } else {
      const key = `${outName}`;
      questions[key] = mk(q.instructions, out.kind === "score" ? q.criteria : choiceCriteria);
      plan[outName] = { out, keys: [{ key, item: null }] };
    }
  }
  return { id, def: d, state: safeState, stateJson, questions, plan, candidates };
}

// ───────────────────────── response validation ─────────────────────────

export class ValidationError extends Error {}
export class InputError extends Error {}

export function validateResponse(req, res) {
  if (!res || typeof res !== "object" || typeof res.model !== "string" || !res.answers || typeof res.answers !== "object")
    throw new ValidationError("response missing model/answers");
  const near1 = (o) => Math.abs(Object.values(o).reduce((a, b) => a + b, 0) - 1) <= 0.02;
  const prob = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  for (const [key, q] of Object.entries(req.questions)) {
    const a = res.answers[key];
    if (!a) throw new ValidationError(`missing answer '${key}'`);
    if (a.type !== q.type) throw new ValidationError(`answer '${key}' type ${a.type} != ${q.type}`);
    if (q.type === "noul") {
      if (!prob(a.noul)) throw new ValidationError(`noul '${key}' out of range`);
      if ("confidence" in a) throw new ValidationError(`noul '${key}' unexpectedly carries confidence`);
    } else if (q.type === "choice") {
      const labels = Object.keys(q.criteria);
      if (!labels.includes(a.choice)) throw new ValidationError(`choice '${key}' label '${a.choice}' not in criteria`);
      if (!prob(a.confidence) || !a.probabilities || !Object.values(a.probabilities).every(prob) || !near1(a.probabilities))
        throw new ValidationError(`choice '${key}' probabilities invalid`);
      if (Object.keys(a.probabilities).some((l) => !labels.includes(l))) throw new ValidationError(`choice '${key}' has unknown labels`);
    } else {
      const n = q.criteria.length;
      if (typeof a.score !== "number" || a.score < -1e-6 || a.score > n - 1 + 1e-6) throw new ValidationError(`score '${key}' out of range`);
      if (!prob(a.confidence) || !a.probabilities || !Object.values(a.probabilities).every(prob) || !near1(a.probabilities))
        throw new ValidationError(`score '${key}' probabilities invalid`);
    }
  }
  return res;
}

// ───────────────────────── policy ─────────────────────────

const BAND_RANK = { act: 0, review: 1, uncertain: 2 };
const worst = (a, b) => (BAND_RANK[a] >= BAND_RANK[b] ? a : b);
function confBand(conf, out) { return conf >= (out.act ?? 0.7) ? "act" : conf >= (out.review ?? 0.4) ? "review" : "uncertain"; }

// Map raw answers → {result, signals, band}. `answers` values follow the Jev schema, or the
// model-fallback schema ({type, choice|noul|score, confidence:null}).
export function applyPolicy(req, answers) {
  const result = {}; const signals = {}; let band = "act";
  for (const [outName, { out, keys }] of Object.entries(req.plan)) {
    if (out.kind === "choice") {
      const perItem = keys.length > 1 || keys[0].item !== null;
      const vals = {};
      for (const { key, item } of keys) {
        const a = answers[key];
        let b = a.confidence == null ? "act" : confBand(a.confidence, out);
        if ((out.uncertain_labels || []).includes(a.choice)) b = "uncertain";
        band = worst(band, b);
        const sig = { choice: a.choice, confidence: a.confidence ?? null, band: b,
          top: a.probabilities ? Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3) : null };
        if (perItem) { vals[item] = a.choice; (signals[outName] ||= {})[item] = sig; } else { result[outName] = a.choice; signals[outName] = sig; }
      }
      if (perItem) result[outName] = vals;
    } else if (out.kind === "nouls") {
      const vals = {}; const sig = {};
      for (const { key, item } of keys) {
        const p = answers[key].noul;
        const v = p == null ? answers[key].value : p >= out.yes_at ? "yes" : p <= out.no_at ? "no" : "uncertain";
        vals[item] = v; sig[item] = p ?? null;
        // Only items marked critical escalate the whole decision; others downgrade it to review.
        const critical = out.critical === "all" || (out.critical || []).includes(item);
        if (v === "uncertain") band = worst(band, critical ? "uncertain" : "review");
      }
      result[outName] = vals; signals[outName] = sig;
    } else if (out.kind === "rank") {
      const scored = keys.map(({ key, item }) => ({ id: item, score: answers[key].score, confidence: answers[key].confidence ?? null }));
      scored.sort((a, b) => b.score - a.score);
      result[outName] = scored.filter((s) => s.score >= (out.min_score ?? 0)).slice(0, out.top_k ?? scored.length).map((s) => s.id);
      signals[outName] = scored;
    } else if (out.kind === "score") {
      const a = answers[keys[0].key];
      const b = a.confidence == null ? "act" : confBand(a.confidence, out);
      band = worst(band, b);
      result[outName] = Math.round(a.score);
      signals[outName] = { score: a.score, confidence: a.confidence ?? null, probabilities: a.probabilities ?? null, band: b };
    }
  }
  return { result, signals, band };
}

// ───────────────────────── execution ─────────────────────────

let client;
function getClient(d) {
  const key = apiKey();
  if (!key) return null;
  client ||= new TypeSafeClient({ apiKey: key, defaultModel: d.model, timeout: d.timeout_ms,
    retry: { maxRetries: d.max_retries }, logLevel: "off" });
  return client;
}

function classifyError(e) {
  if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) return { reason: "jev_auth", service: false };
  if (e instanceof RateLimitError) return { reason: "jev_rate_limited", service: true };
  if (e instanceof APITimeoutError || e?.name === "AbortError" || e?.name === "APIUserAbortError") return { reason: "jev_timeout", service: true };
  if (e instanceof APIConnectionError) return { reason: "jev_unavailable", service: true };
  if (e instanceof InternalServerError) return { reason: "jev_server_error", service: true };
  if (e instanceof BadRequestError || e instanceof UnprocessableEntityError) return { reason: "jev_rejected_request", service: false };
  if (e instanceof ValidationError) return { reason: "jev_malformed_response", service: true };
  if (e instanceof APIError) return { reason: `jev_http_${e.status}`, service: true };
  return { reason: "jev_error", service: true };
}

async function callJev(req, opts) {
  const d = req.def;
  if (opts.simulate) return simulate(opts.simulate, req);
  const c = getClient(d);
  if (!c) { const e = new Error("TYPESAFE_API_KEY not configured"); e.reasonOverride = "jev_no_credentials"; throw e; }
  const signal = AbortSignal.timeout(d.total_budget_ms);
  const res = await c.systemOne({ state: req.state, questions: req.questions, model: d.model }, { signal });
  return validateResponse(req, res);
}

// Fault injection for tests/demos (JEV_SIMULATE or opts.simulate): timeout | unavailable | malformed | uncertain | ratelimit
async function simulate(kind, req) {
  if (kind === "timeout") { const e = new APITimeoutError(req.def.timeout_ms); throw e; }
  if (kind === "unavailable") throw new APIConnectionError({ message: "simulated connection refused" });
  if (kind === "ratelimit") throw Object.assign(new Error("simulated 429"), { reasonOverride: "jev_rate_limited" });
  const answers = {};
  for (const [k, q] of Object.entries(req.questions)) {
    if (kind === "malformed") answers[k] = { type: q.type, choice: "NOT_A_LABEL", noul: 7, score: -3 };
    else if (q.type === "noul") answers[k] = { type: "noul", noul: 0.5 };
    else if (q.type === "choice") { const ls = Object.keys(q.criteria); answers[k] = { type: "choice", choice: ls[0], confidence: 0.02, probabilities: Object.fromEntries(ls.map((l) => [l, 1 / ls.length])) }; }
    else { const n = q.criteria.length; answers[k] = { type: "score", score: (n - 1) / 2, confidence: 0.02, probabilities: Object.fromEntries([...Array(n).keys()].map((i) => [String(i), 1 / n])) }; }
  }
  return validateResponse(req, { model: "jev-1.13.0", answers, usage: { input_tokens: 0, output_tokens: 0 } });
}

function codeFallback(req, fb) {
  if (fb.result) return JSON.parse(JSON.stringify(fb.result));
  const ids = (req.candidates || []).map((c) => c.id);
  const result = {};
  for (const [outName, { out, keys }] of Object.entries(req.plan)) {
    if (fb.strategy === "keep_search_order" && out.kind === "rank") result[outName] = ids.slice(0, out.top_k ?? ids.length);
    else if (fb.strategy === "include_all_candidates") result[outName] = Object.fromEntries(keys.map((k) => [k.item, "yes"]));
    else if (fb.strategy === "all_task_context") result[outName] = Object.fromEntries(keys.map((k) => [k.item, "task_context"]));
    else result[outName] = Object.fromEntries(keys.map((k) => [k.item, "uncertain"]));
  }
  return result;
}

function prepare(id, input, opts) {
  const req = buildRequest(id, input);
  const d = req.def;
  const simulate = opts.simulate || process.env.JEV_SIMULATE || null;
  const cacheKey = sha(canonical({ id, v: d.version, m: d.model, s: req.stateJson, q: req.questions }));
  const base = { request_id: randomUUID(), decision: id, version: d.version, state_hash: cacheKey.slice(0, 16), caller: opts.caller };
  return { req, d, simulate, cacheKey, base };
}

function cached(p, opts) {
  if (opts.noCache || p.simulate) return null;
  const hit = store.cacheGet(p.cacheKey);
  return hit && hit.model === p.d.model ? { ...hit, decided_by: "cache", cached_from: hit.decided_by } : null;
}

// One Jev round trip for one or more prepared requests sharing identical state. Question keys are
// namespaced per decision so answers can be split back out.
async function runJev(preps, simulate) {
  const breaker = simulate ? "jev-sim" : "jev";  // simulated faults never trip the real breaker
  if (store.breakerOpen(breaker)) return { failure: { reason: "jev_circuit_open" } };
  if (!simulate && !store.rateTake()) return { failure: { reason: "jev_local_rate_limit" } };
  const multi = preps.length > 1;
  const merged = { ...preps[0].req, questions: {} };
  for (const p of preps) for (const [k, q] of Object.entries(p.req.questions)) merged.questions[multi ? `${p.base.decision}::${k}` : k] = q;
  try {
    const res = await callJev(merged, { simulate });
    store.breakerRecord(true, breaker);
    const recs = preps.map((p) => {
      const answers = multi ? Object.fromEntries(Object.keys(p.req.questions).map((k) => [k, res.answers[`${p.base.decision}::${k}`]])) : res.answers;
      const rec = { decided_by: "jev", model: res.model, usage: multi ? { ...res.usage, batched_with: preps.length } : res.usage, ...applyPolicy(p.req, answers) };
      if (res.model !== p.d.model) rec.model_mismatch = { pinned: p.d.model, served: res.model };
      return rec;
    });
    return { recs };
  } catch (e) {
    if (e instanceof InputError) throw e;
    const c = e.reasonOverride ? { reason: e.reasonOverride, service: true } : classifyError(e);
    if (c.service) store.breakerRecord(false, breaker);
    return { failure: { reason: c.reason, detail: String(e.message || e).slice(0, 200) } };
  }
}

// Apply cache write / escalation / fallback order for one decision and log it.
async function resolve(p, jevRec, failure, opts, t0) {
  const { req, d, simulate } = p;
  const finish = (rec) => { rec.latency_ms = Date.now() - t0; store.logDecision({ ...p.base, ...rec }); return { ...p.base, ...rec }; };
  // Bands that trigger escalation are per decision (default: only "uncertain").
  if (jevRec && !(d.escalate_on || ["uncertain"]).includes(jevRec.band)) {
    if (!jevRec.model_mismatch && !simulate) store.cachePut(p.cacheKey, jevRec, d.cache_ttl_s);
    return finish(jevRec);
  }
  const escalate = d.escalate_on_uncertain !== false && !opts.noFallbackModel;
  const reason = failure ? failure.reason : "jev_uncertain";
  for (const fb of d.fallback || []) {
    if (fb.kind === "model") {
      if ((!escalate && !failure) || opts.noFallbackModel) continue;
      try {
        const mres = await modelFallback(req, fb);
        return finish({ decided_by: "fallback_model", model: mres.model, usage: mres.usage, ...applyPolicy(req, mres.answers),
          fallback: { reason, detail: failure?.detail, jev: jevRec ? { result: jevRec.result, signals: jevRec.signals, band: jevRec.band } : null } });
      } catch (e) {
        failure = { reason: `${reason}+model_failed`, detail: String(e.message || e).slice(0, 200) };
      }
    } else if (fb.kind === "code") {
      if (jevRec) break;  // an uncertain Jev answer is more informative than a static default
      return finish({ decided_by: "code", model: null, result: codeFallback(req, fb), signals: null, band: "uncertain",
        fallback: { reason: failure?.reason || reason, detail: failure?.detail } });
    }
  }
  if (jevRec) return finish({ ...jevRec, fallback: { reason: failure ? failure.reason : "jev_uncertain_no_escalation", detail: failure?.detail } });
  return finish({ decided_by: "code", model: null, result: codeFallback(req, {}), signals: null, band: "uncertain", fallback: failure });
}

/**
 * decide(id, input, opts) → decision record
 *   opts.caller   free-text (seat name / workflow step) for the log
 *   opts.noCache  skip cache read
 *   opts.noFallbackModel  never escalate to a model (e.g. inside latency-critical loops)
 *   opts.simulate fault injection (see simulate())
 */
export async function decide(id, input, opts = {}) {
  const t0 = Date.now();
  const p = prepare(id, input, opts);
  const hit = cached(p, opts);
  if (hit) { const rec = { ...p.base, ...hit, latency_ms: Date.now() - t0 }; store.logDecision(rec); return rec; }
  const { recs, failure } = await runJev([p], p.simulate);
  return resolve(p, recs?.[0] ?? null, failure ?? null, opts, t0);
}

/**
 * decideBatch([{id, input}], opts) → records in the same order.
 * Independent decisions whose assembled state is identical share ONE Jev request (the documented
 * way to batch); decisions with different state run as separate requests in parallel. Use only for
 * independent questions — dependent decisions must be sequenced by the caller.
 */
export async function decideBatch(items, opts = {}) {
  const t0 = Date.now();
  const preps = items.map(({ id, input }) => prepare(id, input, opts));
  const out = new Array(preps.length);
  const groups = new Map();
  preps.forEach((p, i) => {
    const hit = cached(p, opts);
    if (hit) { out[i] = { ...p.base, ...hit, latency_ms: Date.now() - t0 }; store.logDecision(out[i]); return; }
    const key = p.req.stateJson + "\u0000" + p.d.model;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  await Promise.all([...groups.values()].map(async (idxs) => {
    const gp = idxs.map((i) => preps[i]);
    const { recs, failure } = await runJev(gp, gp[0].simulate);
    await Promise.all(idxs.map(async (i, j) => { out[i] = await resolve(preps[i], recs?.[j] ?? null, failure ?? null, opts, t0); }));
  }));
  return out;
}

export function listDecisions() {
  const cat = loadCatalog();
  return Object.entries(cat.decisions).map(([id, d]) => ({ id, version: d.version, purpose: d.purpose, inputs: d.inputs,
    outputs: Object.fromEntries(Object.entries(d.outputs).map(([k, o]) => [k, o.kind])) }));
}
