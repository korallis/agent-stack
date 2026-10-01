#!/usr/bin/env python3
"""agent-proxy-status: per-account availability, cooldowns and quota signals (no secrets).

  agent-proxy-status            table of accounts
  agent-proxy-status --recent N last N routed requests from the redacted routing log
  agent-proxy-status --json     machine-readable (used by the dispatcher for capacity)
"""
import json, math, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from usage_collector import get, mgmt_key, LOG  # noqa: E402


def used_pct(v, provider):
    """A quota header as a percent. The unit follows the PROVIDER, never the magnitude: Anthropic's unified-utilization
    headers are fractions (0.29; 1.01 when over the limit), Codex's used-percent headers are percents ("100"). Deciding
    by magnitude printed Anthropic's 1.01 as 1% while the account was over its limit (2026-10-01). None when absent."""
    try:
        f = float(v)
    except (TypeError, ValueError, OverflowError):
        return None
    p = f * 100 if provider == "claude" else f
    # NaN, Infinity or an overflow after scaling: no reading (json.dumps would emit bare NaN/Infinity, which isn't JSON)
    return p if math.isfinite(p) else None


def pct(p, over=False):
    """A percent for the table; a used-up window on an account over its limit says OVER (on credits it never does)."""
    if p is None:
        return "-"
    return f"{p:.0f}% OVER" if over and p >= 100 else f"{p:.0f}%"


def minutes(v):
    """A window length in minutes, or None when the header is absent or not a number."""
    try:
        m = int(float(v))
    except (TypeError, ValueError, OverflowError):
        return None
    return m


def codex_windows(s):
    """Codex's two rate-limit windows, sorted into (short, weekly) by their own Window-Minutes headers. Codex used to
    send primary = 5 h and secondary = weekly; now (2026-10) primary is the weekly window (10080 minutes) and secondary
    has a 0-minute window and 0%: no 5-hour limit. A 0-minute window is not a limit. Without Window-Minutes (the older
    shape) primary is the short window and secondary the weekly one, as before. Returns ((used, minutes), (used, minutes))."""
    short, weekly = (None, None), (None, None)
    for i, name in enumerate(("Primary", "Secondary")):
        used, mins = s.get(f"X-Codex-{name}-Used-Percent"), minutes(s.get(f"X-Codex-{name}-Window-Minutes"))
        if used is None:
            continue
        if mins is None:   # the older shape: by position
            slot = "short" if i == 0 else "weekly"
        elif mins <= 0:    # reported, but no window: not a limit
            continue
        else:
            slot = "short" if mins <= 24 * 60 else "weekly"
        if slot == "short" and short[0] is None:
            short = (used, mins)
        elif slot == "weekly" and weekly[0] is None:
            weekly = (used, mins)
    return short, weekly


def flag(v):
    """A "True"/"False" header as a bool; None when absent or anything else."""
    return {"true": True, "false": False}.get(str(v).strip().lower()) if v is not None else None


def accounts():
    rows = []
    for f in get("/credentials", mgmt_key())["files"]:
        s = (f.get("quota") or {}).get("signals") or {}
        (cx_short, cx_short_min), (cx_weekly, cx_weekly_min) = codex_windows(s)
        rows.append({
            "label": f.get("note"), "provider": f.get("provider"), "disabled": f.get("disabled"),
            "status": f.get("status"), "unavailable": f.get("unavailable"),
            "cooldowns": f.get("cooldowns") or [], "success": f.get("success"), "failed": f.get("failed"),
            "short_window_used": s.get("Anthropic-Ratelimit-Unified-5h-Utilization") or cx_short,
            "weekly_used": s.get("Anthropic-Ratelimit-Unified-7d-Utilization") or cx_weekly,
            # Codex only: each window's length as reported (None when the header is absent), and the credits that
            # carry an account past a used-up window ("True" / "False" headers; None when not reported)
            "short_window_minutes": cx_short_min, "weekly_window_minutes": cx_weekly_min,
            "has_credits": flag(s.get("X-Codex-Credits-Has-Credits")), "credits_unlimited": flag(s.get("X-Codex-Credits-Unlimited")),
            "upstream_status": s.get("Anthropic-Ratelimit-Unified-Status"),
            "quota_observed_at": (f.get("quota") or {}).get("observed_at"),
        })
        r = rows[-1]
        # the same readings as percents (additive: the raw header values above are unchanged)
        r["short_window_pct"] = used_pct(r["short_window_used"], r["provider"])
        r["weekly_pct"] = used_pct(r["weekly_used"], r["provider"])
        # a window used up (100%) while credits are reported carries on on credits: still eligible, never "over"
        r["on_credits"] = bool(r["has_credits"] or r["credits_unlimited"]) and any(p is not None and p >= 100 for p in (r["short_window_pct"], r["weekly_pct"]))
        # over its limit: never while on credits, at any reading (QA PR96); otherwise a window strictly above 100%
        # (Anthropic's 1.01), or a Codex window used up with the credits explicitly reported as none (a missing credits
        # header is not evidence either way)
        r["over_limit"] = not r["on_credits"] and (any(p is not None and p > 100 for p in (r["short_window_pct"], r["weekly_pct"])) or (
            r["provider"] == "codex" and r["has_credits"] is False and not r["credits_unlimited"]
            and any(p is not None and p >= 100 for p in (r["short_window_pct"], r["weekly_pct"]))))
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
    print(f"{'account':<9} {'prov':<7} {'state':<12} {'5h':>10} {'weekly':>9} {'credits':>8} {'ok':>4} {'fail':>4}  cooldowns")
    for r in rows:
        state = "DISABLED" if r["disabled"] else ("UNAVAILABLE" if r["unavailable"] else r["status"])
        cd = ",".join(c.get("model", "*") + "→" + str(c.get("until", c.get("next_retry_after", "?")))[:19] for c in r["cooldowns"]) or "-"
        credits = "in use" if r["on_credits"] else "yes" if r["has_credits"] or r["credits_unlimited"] else "none" if r["has_credits"] is False else "-"
        print(f"{r['label']:<9} {r['provider']:<7} {state:<12} {pct(r['short_window_pct'], r['over_limit']):>10} {pct(r['weekly_pct'], r['over_limit']):>9} {credits:>8} {r['success']:>4} {r['failed']:>4}  {cd}")
    by, over = {}, {}
    for r in rows:
        # an account past its limit is not eligible, whatever its proxy status says
        ok = not r["disabled"] and not r["unavailable"] and r["status"] == "active" and not r["over_limit"]
        by.setdefault(r["provider"], [0, 0]); by[r["provider"]][0] += ok; by[r["provider"]][1] += 1
        over[r["provider"]] = over.get(r["provider"], 0) + bool(r["over_limit"])
    print("eligible: " + ", ".join(f"{p} {a}/{t}" + (f" ({over[p]} over limit)" if over.get(p) else "") for p, (a, t) in by.items()) +
          ("" if all(a for a, _ in by.values()) else "   !! a provider pool has NO eligible accounts"))


if __name__ == "__main__":
    main()
