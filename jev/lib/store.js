// Shared state for every jev-decide process (CLI, MCP server, dispatcher): cache, circuit
// breaker, local rate limit and the decision log. SQLite in WAL mode so concurrent agents
// can use it safely.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = process.env.AGENT_STACK_STATE || join(homedir(), ".local/state/agent-stack");
const DB_PATH = join(STATE_DIR, "jev.sqlite");
const LOG_PATH = join(STATE_DIR, "jev-decisions.jsonl");

let db;
export function open() {
  if (db) return db;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  db = new DatabaseSync(DB_PATH);
  chmodSync(DB_PATH, 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS breaker (name TEXT PRIMARY KEY, failures INTEGER NOT NULL, open_until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ratelimit (window INTEGER PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY, ts TEXT, decision TEXT, version INTEGER, decided_by TEXT, model TEXT,
      band TEXT, result TEXT, signals TEXT, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      fallback_reason TEXT, state_hash TEXT, caller TEXT, action TEXT);
  `);
  // v2: keep Jev's own signals when a fallback overrode it (needed for threshold tuning).
  const cols = db.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
  if (!cols.includes("jev_signals")) db.exec("ALTER TABLE decisions ADD COLUMN jev_signals TEXT");
  return db;
}

export function cacheGet(key) {
  const row = open().prepare("SELECT value, expires FROM cache WHERE key=?").get(key);
  if (!row || row.expires < Date.now()) return null;
  return JSON.parse(row.value);
}
export function cachePut(key, value, ttlS) {
  if (!ttlS) return;
  open().prepare("INSERT OR REPLACE INTO cache VALUES (?,?,?)").run(key, JSON.stringify(value), Date.now() + ttlS * 1000);
}

// Circuit breaker: `threshold` consecutive service failures open it for `coolMs`; after that a
// single request is allowed through (half-open) and success closes it.
export const BREAKER = { threshold: 5, coolMs: 60_000 };
export function breakerOpen(name = "jev") {
  const row = open().prepare("SELECT failures, open_until FROM breaker WHERE name=?").get(name);
  if (!row || row.open_until <= Date.now()) return false;
  return true;
}
export function breakerRecord(ok, name = "jev") {
  const d = open();
  if (ok) { d.prepare("INSERT OR REPLACE INTO breaker VALUES (?,0,0)").run(name); return; }
  const row = d.prepare("SELECT failures FROM breaker WHERE name=?").get(name) || { failures: 0 };
  const failures = row.failures + 1;
  const openUntil = failures >= BREAKER.threshold ? Date.now() + BREAKER.coolMs : 0;
  d.prepare("INSERT OR REPLACE INTO breaker VALUES (?,?,?)").run(name, failures, openUntil);
}
export function breakerState(name = "jev") {
  return open().prepare("SELECT failures, open_until FROM breaker WHERE name=?").get(name) || { failures: 0, open_until: 0 };
}

// Local rate limit well under TypeSafe's documented 1,200 req/min so bursts from 24 agents
// degrade to fallback instead of 429 storms.
export const RATE_PER_MIN = Number(process.env.JEV_RATE_PER_MIN || 600);
export function rateTake() {
  const d = open(); const w = Math.floor(Date.now() / 60_000);
  d.exec("BEGIN IMMEDIATE");
  try {
    d.prepare("DELETE FROM ratelimit WHERE window < ?").run(w - 1);
    const row = d.prepare("SELECT count FROM ratelimit WHERE window=?").get(w);
    if (row && row.count >= RATE_PER_MIN) { d.exec("COMMIT"); return false; }
    d.prepare("INSERT INTO ratelimit VALUES (?,1) ON CONFLICT(window) DO UPDATE SET count=count+1").run(w);
    d.exec("COMMIT"); return true;
  } catch (e) { d.exec("ROLLBACK"); throw e; }
}

// Decision log: no raw state, only its hash; results are labels/probabilities, not payloads.
export function logDecision(rec) {
  const row = {
    ts: new Date().toISOString(), decision: rec.decision, version: rec.version, decided_by: rec.decided_by,
    model: rec.model ?? null, band: rec.band, result: rec.result, signals: rec.signals ?? null,
    latency_ms: rec.latency_ms, input_tokens: rec.usage?.input_tokens ?? null, output_tokens: rec.usage?.output_tokens ?? null,
    fallback_reason: rec.fallback?.reason ?? null, jev_signals: rec.fallback?.jev?.signals ?? null, state_hash: rec.state_hash, caller: rec.caller ?? null, action: rec.action ?? null,
  };
  open().prepare(`INSERT INTO decisions (ts,decision,version,decided_by,model,band,result,signals,latency_ms,input_tokens,output_tokens,fallback_reason,state_hash,caller,action,jev_signals)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.ts, row.decision, row.version, row.decided_by, row.model, row.band,
    JSON.stringify(row.result), JSON.stringify(row.signals), row.latency_ms, row.input_tokens, row.output_tokens,
    row.fallback_reason, row.state_hash, row.caller, row.action, JSON.stringify(row.jev_signals));
  appendFileSync(LOG_PATH, JSON.stringify(row) + "\n", { mode: 0o600 });
}

export function stats(sinceIso) {
  return open().prepare(`SELECT decision, decided_by, band, COUNT(*) n, ROUND(AVG(latency_ms)) avg_ms,
      SUM(COALESCE(input_tokens,0)) in_tok FROM decisions WHERE ts >= ? GROUP BY 1,2,3 ORDER BY 1,2,3`).all(sinceIso);
}
