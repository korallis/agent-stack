#!/usr/bin/env python3
"""agent-proxy-status: per-account availability, cooldowns and quota signals (no secrets).

  agent-proxy-status            table of accounts
  agent-proxy-status --recent N last N routed requests from the redacted routing log
  agent-proxy-status --json     machine-readable (used by the dispatcher for capacity)
"""
import json, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from usage_collector import get, mgmt_key, LOG  # noqa: E402


def pct(v):
    try:
        f = float(v)
        return f"{f*100:.0f}%" if f <= 1.0 else f"{f:.0f}%"
    except (TypeError, ValueError):
        return "-"


def accounts():
    rows = []
    for f in get("/credentials", mgmt_key())["files"]:
        s = (f.get("quota") or {}).get("signals") or {}
        rows.append({
            "label": f.get("note"), "provider": f.get("provider"), "disabled": f.get("disabled"),
            "status": f.get("status"), "unavailable": f.get("unavailable"),
            "cooldowns": f.get("cooldowns") or [], "success": f.get("success"), "failed": f.get("failed"),
            "short_window_used": s.get("Anthropic-Ratelimit-Unified-5h-Utilization") or s.get("X-Codex-Primary-Used-Percent"),
            "weekly_used": s.get("Anthropic-Ratelimit-Unified-7d-Utilization") or s.get("X-Codex-Secondary-Used-Percent"),
            "upstream_status": s.get("Anthropic-Ratelimit-Unified-Status"),
            "quota_observed_at": (f.get("quota") or {}).get("observed_at"),
        })
    return sorted(rows, key=lambda r: r["label"] or "")


def main():
    args = sys.argv[1:]
    if "--recent" in args:
        n = int(args[args.index("--recent") + 1]) if len(args) > args.index("--recent") + 1 else 20
        lines = LOG.read_text().splitlines()[-n:] if LOG.exists() else []
        for l in lines:
            e = json.loads(l)
            print(f"{e['ts'][:19]}  {e['account']:<9} {e['model'] or '-':<18} failed={e['failed']} status={e['status']} {e['latency_ms']}ms  {e['user_agent']}")
        return
    rows = accounts()
    if "--json" in args:
        print(json.dumps(rows, indent=2)); return
    print(f"{'account':<9} {'prov':<7} {'state':<12} {'5h/primary':>10} {'weekly':>7} {'ok':>4} {'fail':>4}  cooldowns")
    for r in rows:
        state = "DISABLED" if r["disabled"] else ("UNAVAILABLE" if r["unavailable"] else r["status"])
        cd = ",".join(c.get("model", "*") + "→" + str(c.get("until", c.get("next_retry_after", "?")))[:19] for c in r["cooldowns"]) or "-"
        print(f"{r['label']:<9} {r['provider']:<7} {state:<12} {pct(r['short_window_used']):>10} {pct(r['weekly_used']):>7} {r['success']:>4} {r['failed']:>4}  {cd}")
    by = {}
    for r in rows:
        ok = not r["disabled"] and not r["unavailable"] and r["status"] == "active"
        by.setdefault(r["provider"], [0, 0]); by[r["provider"]][0] += ok; by[r["provider"]][1] += 1
    print("eligible: " + ", ".join(f"{p} {a}/{t}" for p, (a, t) in by.items()) +
          ("" if all(a for a, _ in by.values()) else "   !! a provider pool has NO eligible accounts"))


if __name__ == "__main__":
    main()
